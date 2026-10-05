'use strict';

// QA BE-24 — black-box test ของการปิดรับตามเวลา server (409 ROUND_CLOSED) และการส่งพร้อมกัน
// เกณฑ์: PRD F4, F5, F6 + API contract v2 + Decision log D2, D3, D9, D11, D12, D15 (ไม่ใช่ test ของ Dev)
// ส่วน A: start server จริง (`node src/index.js`) เปิดรอบที่ปิดในอีกไม่กี่วินาที แล้วรอให้ถึงเวลาปิดจริง
// ส่วน B: นาฬิกาจำลองผ่าน createApp({ now }) — ขอบเวลา ±1 วินาที, ตรงเวลาปิดพอดี, status/serverNow สอดคล้อง
// ส่วน C: 2 process เปิด DB ไฟล์เดียวกัน ยิงชื่อเดียวกันพร้อมกัน → order เดียว
// หมายเหตุ: GET /summary (BE-23) ยังไม่ merge — ตรวจ "order เดียว" ผ่าน GET order + เปิด SQLite ดูตาราง orders ตรงๆ
// รัน: node --test qa/be-24.test.js   (ต้อง `cd server && npm install` ก่อน)

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SERVER_DIR = path.join(__dirname, '..', 'server');
const ISO_BKK = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+07:00$/;
const OFFSET = 7 * 3600 * 1000;
const toBkkIso = (ms) => new Date(ms + OFFSET).toISOString().slice(0, 19) + '+07:00';
const hhmm = (ms) => new Date(ms + OFFSET).toISOString().slice(11, 16);
const enc = encodeURIComponent;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

function tmpDb() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qa-be24-')), 'test.db');
}

async function startProcess(dbPath = tmpDb()) {
  const port = await freePort();
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.js'],
    { cwd: SERVER_DIR, env: { ...process.env, PORT: String(port), DB_PATH: dbPath } });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server ไม่ start: ' + stderr)), 8000);
    child.stdout.on('data', (d) => { if (/listening/i.test(String(d))) { clearTimeout(t); resolve(); } });
    child.on('exit', (code) => { clearTimeout(t); reject(new Error(`server exit ${code}: ${stderr}`)); });
  });
  const c = client(`http://127.0.0.1:${port}`, () => new Promise((r) => { child.once('exit', r); child.kill(); }), () => stderr);
  c.dbPath = dbPath;
  return c;
}

async function startWithClock(clock) {
  const { createApp } = require(path.join(SERVER_DIR, 'src', 'app'));
  const app = createApp({ dbPath: ':memory:', now: clock.now });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  return client(`http://127.0.0.1:${server.address().port}`, () => new Promise((r) => server.close(r)), () => '');
}

function client(base, close, stderr) {
  async function req(method, p, body, { raw = false } = {}) {
    const init = { method, headers: {} };
    if (body !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.body = raw ? body : JSON.stringify(body);
    }
    const res = await fetch(base + p, init);
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: res.status, body: json, text, type: res.headers.get('content-type') || '' };
  }
  return { base, req, close, stderr };
}

function assertError(r, status, code, field) {
  assert.equal(r.status, status, `status ควรเป็น ${status} ได้ ${r.status}: ${r.text}`);
  assert.match(r.type, /application\/json/);
  assert.deepEqual(Object.keys(r.body || {}).sort(), ['error'], r.text);
  assert.equal(r.body.error.code, code, r.text);
  if (code === 'VALIDATION') {
    assert.deepEqual(Object.keys(r.body.error).sort(), ['code', 'field', 'message'], `VALIDATION ต้องมี field (D11): ${r.text}`);
    if (field !== undefined) assert.equal(r.body.error.field, field, r.text);
  } else {
    assert.deepEqual(Object.keys(r.body.error).sort(), ['code', 'message'], `${code} ต้องไม่มี field (D11): ${r.text}`);
  }
  assert.match(r.body.error.message, /[฀-๿]/, 'message ต้องเป็นภาษาไทย');
}

function assertClosed(r, cutoffMs) {
  assertError(r, 409, 'ROUND_CLOSED');
  assert.match(r.body.error.message, /ปิดรับ/, `F6: ต้องบอกว่าปิดรับแล้ว: ${r.text}`);
  assert.ok(r.body.error.message.includes(hhmm(cutoffMs)), `message ต้องบอกเวลาปิด ${hhmm(cutoffMs)}: ${r.text}`);
}

const MENU = [{ name: 'ข้าวมันไก่ต้ม', price: 50 }, { name: 'ข้าวมันไก่ทอด', price: 55 }, { name: 'ข้าวมันไก่รวม', price: 60 }];

async function openRound(s, cutoffMs) {
  const r = await s.req('POST', '/api/rounds', { restaurant: 'ข้าวมันไก่ป้าแดง', cutoffAt: toBkkIso(cutoffMs), items: MENU });
  assert.equal(r.status, 201, r.text);
  return r.body;
}

function dbOrders(dbPath, roundId) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const orders = db.prepare('SELECT id, name_key, name FROM orders WHERE round_id = ? ORDER BY name_key').all(roundId);
    const lines = db.prepare('SELECT o.name_key AS k, l.item_id AS itemId, l.qty AS qty FROM order_lines l JOIN orders o ON o.id = l.order_id WHERE o.round_id = ?').all(roundId);
    return { orders, lines };
  } finally { db.close(); }
}

// ---------------------------------------------------------------- ส่วน A: server จริง + เวลาจริง
test('A · server จริง: ก่อนปิด → พร้อมกัน → ถึงเวลาปิดจริง → 409', async (t) => {
  const nowMs = Date.now();
  const endOfDay = Date.parse(new Date(nowMs + OFFSET).toISOString().slice(0, 10) + 'T23:59:59+07:00');
  if (endOfDay - nowMs < 60000) { t.skip('ใกล้เที่ยงคืนเกินไป (D10)'); return; }
  const s = await startProcess();
  t.after(() => s.close());
  const cutoffMs = Math.ceil((nowMs + 6000) / 1000) * 1000; // อีก ~6 วินาที (ปัดเป็นวินาทีเต็ม)
  const round = await openRound(s, cutoffMs);
  const [i1, i2, i3] = round.items.map((i) => i.id);
  const R = `/api/rounds/${round.id}/orders`;
  assert.equal(round.status, 'open');

  await t.test('F4 · PUT ชื่อเดียวกัน 10 request พร้อมกัน (ต่างตัวพิมพ์/ช่องว่าง) → order id เดียว, DB มี 1 แถว', async () => {
    const names = ['Bob', 'bob', ' BOB ', 'bOb', 'Bob ', ' bob', 'BOB', 'boB', 'Bob', '  bob  '];
    const rs = await Promise.all(names.map((name, k) => s.req('PUT', R, { name, lines: [{ itemId: [i1, i2, i3][k % 3], qty: (k % 10) + 1 }] })));
    for (const r of rs) assert.equal(r.status, 200, r.text);
    assert.equal(new Set(rs.map((r) => r.body.id)).size, 1, 'ต้องได้ order id เดียว');
    const g = await s.req('GET', `${R}/${enc('BOB')}`);
    assert.equal(g.status, 200);
    assert.equal(g.body.lines.length, 1, `lines ต้องไม่ถูกต่อกัน: ${g.text}`);
    const last = rs.find((r) => r.body.updatedAt && JSON.stringify(r.body.lines) === JSON.stringify(g.body.lines));
    assert.ok(last, 'order สุดท้ายต้องตรงกับ request ใด request หนึ่ง (แทนที่ทั้งก้อน)');
    const { orders, lines } = dbOrders(s.dbPath, round.id);
    assert.deepEqual(orders.filter((o) => o.name_key === 'bob').length, 1, JSON.stringify(orders));
    assert.equal(lines.filter((l) => l.k === 'bob').length, 1, JSON.stringify(lines));
  });

  await t.test('F4 · 2 ชื่อ × 15 request พร้อมกัน → 2 order', async () => {
    const rs = await Promise.all(Array.from({ length: 30 }, (_, k) => s.req('PUT', R, { name: k % 2 ? 'Carol' : 'Dan', lines: [{ itemId: i2, qty: 1 }] })));
    for (const r of rs) assert.equal(r.status, 200, r.text);
    const { orders } = dbOrders(s.dbPath, round.id);
    assert.deepEqual(orders.map((o) => o.name_key).sort(), ['bob', 'carol', 'dan']);
  });

  await t.test('F5 · ก่อนปิด: PUT/DELETE ได้ · PUT+DELETE ชื่อเดียวกันสลับพร้อมกัน ไม่มี 500 และไม่เกิน 1 order', async () => {
    const del = await s.req('DELETE', `${R}/Dan`);
    assert.equal(del.status, 204);
    const rs = await Promise.all(Array.from({ length: 20 }, (_, k) => (k % 2
      ? s.req('DELETE', `${R}/Eve`)
      : s.req('PUT', R, { name: 'eve', lines: [{ itemId: i1, qty: 1 }] }))));
    for (const r of rs) assert.ok([200, 204, 404].includes(r.status), `${r.status} ${r.text}`);
    assert.ok(dbOrders(s.dbPath, round.id).orders.filter((o) => o.name_key === 'eve').length <= 1);
    const p = await s.req('PUT', R, { name: 'Alice', lines: [{ itemId: i1, qty: 2 }], note: 'ไม่เผ็ด' });
    assert.equal(p.status, 200);
  });

  // รอให้เลยเวลาปิดจริง 1 วินาที
  const wait = cutoffMs + 1000 - Date.now();
  if (wait > 0) await sleep(wait);

  await t.test('F6 · หลังปิด 1 วินาที (เวลาจริง): Round status=closed, serverNow เลย cutoff', async () => {
    const r = await s.req('GET', '/api/rounds/today');
    assert.equal(r.status, 200);
    assert.equal(r.body.status, 'closed');
    assert.match(r.body.serverNow, ISO_BKK);
    assert.ok(Date.parse(r.body.serverNow) >= cutoffMs);
  });

  await t.test('F6 · PUT สั่งใหม่หลังปิด → 409 ROUND_CLOSED + message บอกเวลาปิด · ไม่ถูกสร้าง', async () => {
    const r = await s.req('PUT', R, { name: 'Frank', lines: [{ itemId: i1, qty: 1 }] });
    assertClosed(r, cutoffMs);
    assertError(await s.req('GET', `${R}/Frank`), 404, 'NOT_FOUND');
  });

  await t.test('F6 · PUT แก้ order เดิมหลังปิด → 409 · order ไม่เปลี่ยน', async () => {
    const before = await s.req('GET', `${R}/Alice`);
    const r = await s.req('PUT', R, { name: ' ALICE ', lines: [{ itemId: i3, qty: 9 }] });
    assertClosed(r, cutoffMs);
    const after = await s.req('GET', `${R}/alice`);
    assert.equal(after.status, 200, 'D12: GET ดูได้หลังปิด');
    assert.deepEqual(after.body, before.body);
  });

  await t.test('F6 · DELETE หลังปิด → 409 · order ยังอยู่ · ชื่อที่ไม่มี order ก็ 409 (D9: CLOSED ก่อนหา order)', async () => {
    assertClosed(await s.req('DELETE', `${R}/Alice`), cutoffMs);
    assert.equal((await s.req('GET', `${R}/Alice`)).status, 200);
    assertClosed(await s.req('DELETE', `${R}/${enc('ไม่มีคนนี้')}`), cutoffMs);
  });

  await t.test('D9 · หลังปิด: ไม่มีรอบ → 404 ก่อน · ข้อมูลผิด → 400 ก่อน 409', async () => {
    assertError(await s.req('PUT', '/api/rounds/r_19990101/orders', { name: 'x', lines: [{ itemId: i1, qty: 1 }] }), 404, 'NOT_FOUND');
    assertError(await s.req('DELETE', '/api/rounds/r_19990101/orders/x'), 404, 'NOT_FOUND');
    assertError(await s.req('PUT', R, { name: '', lines: [{ itemId: i1, qty: 1 }] }), 400, 'VALIDATION', 'name');
    assertError(await s.req('PUT', R, { name: 'Alice', lines: [{ itemId: i1, qty: 11 }] }), 400, 'VALIDATION', 'lines[0].qty');
    assertError(await s.req('PUT', R, '{oops', { raw: true }), 400, 'VALIDATION', null);
    assertError(await s.req('DELETE', `${R}/${enc('ก'.repeat(41))}`), 400, 'VALIDATION', 'name');
    assertError(await s.req('DELETE', `${R}/%E0%B8`), 400, 'VALIDATION', 'name');
  });

  await t.test('F6 · หลังปิด 10 PUT พร้อมกัน → 409 ทุกตัว · DB ไม่เปลี่ยน', async () => {
    const before = dbOrders(s.dbPath, round.id);
    const rs = await Promise.all(Array.from({ length: 10 }, () => s.req('PUT', R, { name: 'Late', lines: [{ itemId: i1, qty: 1 }] })));
    for (const r of rs) assertClosed(r, cutoffMs);
    assert.deepEqual(dbOrders(s.dbPath, round.id), before);
    assert.equal(s.stderr(), '', 'ไม่ควรมี error ใน stderr');
  });
});

// ---------------------------------------------------------------- ส่วน B: นาฬิกาจำลอง
test('B · นาฬิกาจำลอง: ขอบเวลา ±1 วินาที และความสอดคล้องกับ Round', async (t) => {
  const { createFakeClock } = require(path.join(SERVER_DIR, 'src', 'clock'));
  const cutoffMs = Date.parse('2026-10-05T11:00:00+07:00');
  const clock = createFakeClock('2026-10-05T09:00:00+07:00');
  const s = await startWithClock(clock);
  t.after(() => s.close());
  const round = await openRound(s, cutoffMs);
  const [i1, i2] = round.items.map((i) => i.id);
  const R = `/api/rounds/${round.id}/orders`;

  async function statusAt(ms) {
    clock.set(ms);
    const r = await s.req('GET', '/api/rounds/today');
    assert.equal(r.body.serverNow, toBkkIso(ms));
    return r.body.status;
  }

  await t.test('ก่อนปิด 1 วินาที: PUT 200 · DELETE 204 · status open', async () => {
    assert.equal(await statusAt(cutoffMs - 1000), 'open');
    assert.equal((await s.req('PUT', R, { name: 'A', lines: [{ itemId: i1, qty: 1 }] })).status, 200);
    assert.equal((await s.req('PUT', R, { name: 'B', lines: [{ itemId: i1, qty: 1 }] })).status, 200);
    assert.equal((await s.req('DELETE', `${R}/b`)).status, 204);
    assert.equal((await s.req('PUT', R, { name: 'B', lines: [{ itemId: i2, qty: 2 }] })).status, 200);
  });

  await t.test('ก่อนปิด 1 ms: PUT 200 · status open', async () => {
    assert.equal(await statusAt(cutoffMs - 1), 'open');
    assert.equal((await s.req('PUT', R, { name: 'C', lines: [{ itemId: i1, qty: 1 }] })).status, 200);
  });

  await t.test('ตรงเวลาปิดพอดี: status closed · PUT/DELETE 409 (สอดคล้องกัน)', async () => {
    assert.equal(await statusAt(cutoffMs), 'closed');
    assertClosed(await s.req('PUT', R, { name: 'A', lines: [{ itemId: i2, qty: 3 }] }), cutoffMs);
    assertClosed(await s.req('DELETE', `${R}/A`), cutoffMs);
  });

  await t.test('หลังปิด 1 วินาที: PUT 409 (ใหม่และแก้) · DELETE 409 · order เดิมไม่เปลี่ยน · GET ได้ (D12)', async () => {
    assert.equal(await statusAt(cutoffMs + 1000), 'closed');
    const before = (await s.req('GET', `${R}/A`)).body;
    const r = await s.req('PUT', R, { name: 'A', lines: [{ itemId: i2, qty: 3 }] });
    assertClosed(r, cutoffMs);
    assert.equal(r.body.error.message, 'ปิดรับ order แล้วเมื่อ 11:00');
    assertClosed(await s.req('PUT', R, { name: 'New', lines: [{ itemId: i1, qty: 1 }] }), cutoffMs);
    assertClosed(await s.req('DELETE', `${R}/a`), cutoffMs);
    assertClosed(await s.req('DELETE', `${R}/nobody`), cutoffMs);
    const after = await s.req('GET', `${R}/A`);
    assert.equal(after.status, 200);
    assert.deepEqual(after.body, before);
    assertError(await s.req('GET', `${R}/New`), 404, 'NOT_FOUND');
  });

  await t.test('ไล่เวลา −5s … +5s ทีละ 250ms: status=open ⇔ PUT 200, status=closed ⇔ PUT 409', async () => {
    for (let d = -5000; d <= 5000; d += 250) {
      const st = await statusAt(cutoffMs + d);
      const r = await s.req('PUT', R, { name: 'Sweep', lines: [{ itemId: i1, qty: 1 }] });
      assert.equal(st, d < 0 ? 'open' : 'closed', `d=${d}`);
      assert.equal(r.status, st === 'open' ? 200 : 409, `d=${d} status=${st} PUT=${r.status}`);
    }
  });

  await t.test('cutoff ไม่ลงนาทีเต็ม (11:30:45): message ยังบอกเวลาปิดแบบ HH:mm', async () => {
    // รอบใหม่ในวันถัดไป
    const c2 = Date.parse('2026-10-06T11:30:45+07:00');
    clock.set('2026-10-06T08:00:00+07:00');
    const r2 = await openRound(s, c2);
    clock.set(c2 + 1000);
    const r = await s.req('PUT', `/api/rounds/${r2.id}/orders`, { name: 'A', lines: [{ itemId: r2.items[0].id, qty: 1 }] });
    assertClosed(r, c2);
  });
});

// ---------------------------------------------------------------- ส่วน C: หลาย process ใช้ DB เดียวกัน
test('C · 2 process เปิด DB ไฟล์เดียวกัน: ชื่อเดียวกันพร้อมกัน → order เดียว ไม่มี 500', async (t) => {
  const dbPath = tmpDb();
  const s1 = await startProcess(dbPath);
  t.after(() => s1.close());
  const s2 = await startProcess(dbPath);
  t.after(() => s2.close());
  const nowMs = Date.now();
  const endOfDay = Date.parse(new Date(nowMs + OFFSET).toISOString().slice(0, 10) + 'T23:59:00+07:00');
  const round = await openRound(s1, Math.min(nowMs + 3600 * 1000, endOfDay));
  const R = `/api/rounds/${round.id}/orders`;
  const rs = await Promise.all(Array.from({ length: 20 }, (_, k) => (k % 2 ? s1 : s2).req('PUT', R, { name: k % 3 ? 'Zed' : 'ZED', lines: [{ itemId: round.items[0].id, qty: 1 }] })));
  for (const r of rs) assert.equal(r.status, 200, r.text);
  assert.equal(new Set(rs.map((r) => r.body.id)).size, 1);
  assert.equal(dbOrders(dbPath, round.id).orders.length, 1);
});
