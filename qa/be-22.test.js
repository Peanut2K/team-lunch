'use strict';

// QA BE-22 — black-box test ของ PUT / GET / DELETE /api/rounds/:id/orders[/:name]
// เกณฑ์: PRD F3, F4, F5 + API contract v2 + Decision log D3, D4, D8, D9, D11, D12, D15 (ไม่ใช่ test ของ Dev)
// ROUND_CLOSED (ปิดรับตามเวลา) อยู่นอกขอบเขต — เป็นของ BE-24
// ส่วน A: start server จริง (`node src/index.js`) ด้วย PORT / DB_PATH แล้วยิง HTTP
// ส่วน B: นาฬิกาจำลองผ่าน createApp({ now }) — ขอบเวลา ±1 วินาที (GET ต้องดูได้หลังปิดรับ, D12)
// รัน: node --test qa/be-22.test.js   (ต้อง `cd server && npm install` ก่อน)

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SERVER_DIR = path.join(__dirname, '..', 'server');
const ISO_BKK = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+07:00$/;
const OFFSET = 7 * 3600 * 1000;
const toBkkIso = (ms) => new Date(ms + OFFSET).toISOString().slice(0, 19) + '+07:00';
const enc = encodeURIComponent;

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

async function startProcess() {
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qa-be22-')), 'test.db');
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
  return client(`http://127.0.0.1:${port}`, () => new Promise((r) => { child.once('exit', r); child.kill(); }), () => stderr);
}

async function startWithClock(clock) {
  const { createApp } = require(path.join(SERVER_DIR, 'src', 'app'));
  const app = createApp({ dbPath: ':memory:', now: clock.now });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  return client(`http://127.0.0.1:${server.address().port}`, () => new Promise((r) => server.close(r)), () => '');
}

function client(base, close, stderr) {
  async function req(method, p, body, { raw = false, contentType = 'application/json' } = {}) {
    const init = { method, headers: {} };
    if (body !== undefined) {
      if (contentType) init.headers['content-type'] = contentType;
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
  assert.ok(r.body && r.body.error, `ต้องมี { error }: ${r.text}`);
  assert.deepEqual(Object.keys(r.body).sort(), ['error']);
  assert.equal(r.body.error.code, code, r.text);
  if (code === 'VALIDATION') {
    assert.deepEqual(Object.keys(r.body.error).sort(), ['code', 'field', 'message'], `VALIDATION ต้องมี field (D11): ${r.text}`);
    if (field !== undefined) assert.equal(r.body.error.field, field, `field ควรเป็น ${field}: ${r.text}`);
  } else {
    assert.deepEqual(Object.keys(r.body.error).sort(), ['code', 'message'], `${code} ต้องไม่มี field (D11): ${r.text}`);
  }
  assert.match(r.body.error.message, /[฀-๿]/, 'message ต้องเป็นภาษาไทย');
}

function assertOrder(o, { roundId, name, lines, note, total }) {
  assert.deepEqual(Object.keys(o).sort(), ['id', 'lines', 'name', 'note', 'roundId', 'total', 'updatedAt']);
  assert.equal(typeof o.id, 'string');
  assert.equal(o.roundId, roundId);
  assert.equal(o.name, name);
  assert.deepEqual(o.lines, lines);
  assert.equal(o.note, note);
  assert.equal(o.total, total);
  assert.ok(Number.isInteger(o.total));
  assert.match(o.updatedAt, ISO_BKK);
}

// ราคา i1=50, i2=55, i3=60
const MENU = [{ name: 'ข้าวมันไก่ต้ม', price: 50 }, { name: 'ข้าวมันไก่ทอด', price: 55 }, { name: 'ข้าวมันไก่รวม', price: 60 }];

async function openRound(s, cutoffMs) {
  const r = await s.req('POST', '/api/rounds', { restaurant: 'ข้าวมันไก่ป้าแดง', cutoffAt: toBkkIso(cutoffMs), items: MENU });
  assert.equal(r.status, 201, r.text);
  return r.body;
}

function todayCutoff() {
  // อนาคตแต่ยังอยู่วันเดียวกันตามปฏิทินไทย (D10)
  const now = Date.now();
  const endOfDay = Date.parse(new Date(now + OFFSET).toISOString().slice(0, 10) + 'T23:59:00+07:00');
  return Math.min(now + 2 * 3600 * 1000, endOfDay);
}

// ---------------------------------------------------------------- ส่วน A: server จริง
test('A · server จริง', async (t) => {
  const s = await startProcess();
  t.after(() => s.close());
  const round = await openRound(s, todayCutoff());
  const ids = round.items.map((i) => i.id);
  const [i1, i2, i3] = ids;
  const R = `/api/rounds/${round.id}/orders`;
  const good = (extra = {}) => ({ name: 'Hi', lines: [{ itemId: i1, qty: 2 }], ...extra });

  await t.test('F3 · สั่งใหม่ → 200 Order, total คิดที่ BE (D4), หลายเมนูใน order เดียว', async () => {
    const r = await s.req('PUT', R, { name: 'Alice', lines: [{ itemId: i1, qty: 2 }, { itemId: i3, qty: 1 }], note: 'ไม่เผ็ด', total: 1 });
    assert.equal(r.status, 200, r.text);
    assertOrder(r.body, { roundId: round.id, name: 'Alice', lines: [{ itemId: i1, qty: 2 }, { itemId: i3, qty: 1 }], note: 'ไม่เผ็ด', total: 160 });
  });

  await t.test('F4 · "Hi" กับ " hi " = order เดียวกัน: แทนที่ ไม่เพิ่ม · id เดิม · name ตัวพิมพ์ล่าสุด (D15) · 200 ทั้งคู่', async () => {
    const a = await s.req('PUT', R, { name: 'Hi', lines: [{ itemId: i1, qty: 1 }], note: 'ก' });
    assert.equal(a.status, 200);
    const b = await s.req('PUT', R, { name: ' hi ', lines: [{ itemId: i2, qty: 3 }] });
    assert.equal(b.status, 200);
    assert.equal(b.body.id, a.body.id, 'แทนที่ต้องคง id เดิม (D15)');
    assertOrder(b.body, { roundId: round.id, name: 'hi', lines: [{ itemId: i2, qty: 3 }], note: '', total: 165 });
    const c = await s.req('PUT', R, { name: 'HI', lines: [{ itemId: i1, qty: 1 }] });
    assert.equal(c.body.id, a.body.id);
    assert.equal(c.body.name, 'HI');
    for (const n of ['Hi', 'hi', ' HI ', 'hI']) {
      const g = await s.req('GET', `${R}/${enc(n)}`);
      assert.equal(g.status, 200, `GET ${n}: ${g.text}`);
      assert.equal(g.body.id, a.body.id);
      assertOrder(g.body, { roundId: round.id, name: 'HI', lines: [{ itemId: i1, qty: 1 }], note: '', total: 50 });
    }
  });

  await t.test('note: ไม่ส่ง / null → "" · ตัดช่องว่าง (D15) · 100 code point ผ่าน · 101 ไม่ผ่าน', async () => {
    let r = await s.req('PUT', R, good({ name: 'n1', note: null }));
    assert.equal(r.status, 200); assert.equal(r.body.note, '');
    r = await s.req('PUT', R, good({ name: 'n1', note: '   ไม่เอาหนัง   ' }));
    assert.equal(r.body.note, 'ไม่เอาหนัง');
    r = await s.req('PUT', R, good({ name: 'n1', note: '  ' + '🍚'.repeat(100) + '  ' }));
    assert.equal(r.status, 200, 'emoji 100 ตัว = 100 code point ต้องผ่าน (D8)');
    r = await s.req('PUT', R, good({ name: 'n1', note: 'ข้า'.repeat(33) + 'ว' }));
    assert.equal(r.status, 200, 'ไทย 100 code point ต้องผ่าน');
    assertError(await s.req('PUT', R, good({ name: 'n1', note: 'ก'.repeat(101) })), 400, 'VALIDATION', 'note');
    assertError(await s.req('PUT', R, good({ name: 'n1', note: 5 })), 400, 'VALIDATION', 'note');
  });

  await t.test('name: 1–40 code point หลัง trim (D8)', async () => {
    assertError(await s.req('PUT', R, good({ name: '' })), 400, 'VALIDATION', 'name');
    assertError(await s.req('PUT', R, good({ name: '   ' })), 400, 'VALIDATION', 'name');
    assertError(await s.req('PUT', R, { lines: [{ itemId: i1, qty: 1 }] }), 400, 'VALIDATION', 'name');
    assertError(await s.req('PUT', R, good({ name: 123 })), 400, 'VALIDATION', 'name');
    assertError(await s.req('PUT', R, good({ name: null })), 400, 'VALIDATION', 'name');
    assertError(await s.req('PUT', R, good({ name: 'a'.repeat(41) })), 400, 'VALIDATION', 'name');
    assertError(await s.req('PUT', R, good({ name: '😀'.repeat(41) })), 400, 'VALIDATION', 'name');
    let r = await s.req('PUT', R, good({ name: '  ' + 'a'.repeat(40) + '  ' }));
    assert.equal(r.status, 200); assert.equal(r.body.name, 'a'.repeat(40));
    r = await s.req('PUT', R, good({ name: '😀'.repeat(40) }));
    assert.equal(r.status, 200, 'emoji 40 ตัว = 40 code point ต้องผ่าน');
    r = await s.req('PUT', R, good({ name: 'ก' }));
    assert.equal(r.status, 200);
  });

  await t.test('lines: อย่างน้อย 1 · itemId ในรอบ · ไม่ซ้ำ · qty จำนวนเต็ม 1–10', async () => {
    for (const lines of [undefined, [], null, 'x', {}]) {
      assertError(await s.req('PUT', R, { name: 'L', lines }), 400, 'VALIDATION', 'lines');
    }
    assertError(await s.req('PUT', R, { name: 'L', lines: ['i1'] }), 400, 'VALIDATION', 'lines[0]');
    assertError(await s.req('PUT', R, { name: 'L', lines: [{ itemId: i1, qty: 1 }, null] }), 400, 'VALIDATION', 'lines[1]');
    for (const itemId of ['i999', '', undefined, 1, null]) {
      assertError(await s.req('PUT', R, { name: 'L', lines: [{ itemId, qty: 1 }] }), 400, 'VALIDATION', 'lines[0].itemId');
    }
    assertError(await s.req('PUT', R, { name: 'L', lines: [{ itemId: i1, qty: 1 }, { itemId: i1, qty: 2 }] }), 400, 'VALIDATION', 'lines[1].itemId');
    for (const qty of [0, 11, -1, 1.5, '1', null, undefined, true]) {
      assertError(await s.req('PUT', R, { name: 'L', lines: [{ itemId: i2, qty }] }), 400, 'VALIDATION', 'lines[0].qty');
    }
    assertError(await s.req('PUT', R, { name: 'L', lines: [{ itemId: i1, qty: 1 }, { itemId: i2, qty: 11 }] }), 400, 'VALIDATION', 'lines[1].qty');
    let r = await s.req('PUT', R, { name: 'L', lines: [{ itemId: i1, qty: 1 }, { itemId: i2, qty: 10 }, { itemId: i3, qty: 1 }] });
    assert.equal(r.status, 200); assert.equal(r.body.total, 50 + 550 + 60);
    // validation พลาดแล้วต้องไม่แตะ order เดิม
    await s.req('PUT', R, { name: 'L', lines: [{ itemId: i1, qty: 99 }] });
    r = await s.req('GET', `${R}/L`);
    assert.equal(r.body.total, 660, 'PUT ที่ไม่ผ่าน validation ต้องไม่เปลี่ยน order เดิม');
  });

  await t.test('body ทั้งก้อนผิด → VALIDATION field null (D11)', async () => {
    assertError(await s.req('PUT', R, '{bad json', { raw: true }), 400, 'VALIDATION', null);
    assertError(await s.req('PUT', R, [1, 2]), 400, 'VALIDATION', null);
    assertError(await s.req('PUT', R, 'name=Hi', { raw: true, contentType: 'text/plain' }), 400, 'VALIDATION', null);
    assertError(await s.req('PUT', R, 'null', { raw: true }), 400, 'VALIDATION', null);
    assertError(await s.req('PUT', R), 400, 'VALIDATION', null);
  });

  await t.test('ผิดหลายจุด → ตอบจุดแรกตามลำดับ field: name → lines → note (D9)', async () => {
    assertError(await s.req('PUT', R, { name: '', lines: [], note: 'x'.repeat(200) }), 400, 'VALIDATION', 'name');
    assertError(await s.req('PUT', R, { name: 'ok', lines: [{ itemId: 'zz', qty: 0 }], note: 'x'.repeat(200) }), 400, 'VALIDATION', 'lines[0].itemId');
    assertError(await s.req('PUT', R, { name: 'ok', lines: [{ itemId: i1, qty: 0 }], note: 'x'.repeat(200) }), 400, 'VALIDATION', 'lines[0].qty');
  });

  await t.test('NOT_FOUND (ไม่มีรอบ) มาก่อน VALIDATION (D9) — ทุก method', async () => {
    const X = '/api/rounds/r_19990101/orders';
    assertError(await s.req('PUT', X, good()), 404, 'NOT_FOUND');
    assertError(await s.req('PUT', X, { name: '' }), 404, 'NOT_FOUND');
    assertError(await s.req('PUT', X, '{bad', { raw: true }), 404, 'NOT_FOUND');
    assertError(await s.req('PUT', X, 'x', { raw: true, contentType: 'text/plain' }), 404, 'NOT_FOUND');
    assertError(await s.req('GET', `${X}/Hi`), 404, 'NOT_FOUND');
    assertError(await s.req('DELETE', `${X}/Hi`), 404, 'NOT_FOUND');
    assertError(await s.req('DELETE', `${X}/${enc('   ')}`), 404, 'NOT_FOUND');
    assertError(await s.req('DELETE', `${X}/%E0%A4`), 404, 'NOT_FOUND');
    assertError(await s.req('DELETE', `${X}/${'a'.repeat(41)}`), 404, 'NOT_FOUND');
  });

  await t.test('GET (D12/D15): ไม่มี order / ชื่อผิดรูปแบบ → 404 NOT_FOUND', async () => {
    assertError(await s.req('GET', `${R}/nobody`), 404, 'NOT_FOUND');
    assertError(await s.req('GET', `${R}/${enc('   ')}`), 404, 'NOT_FOUND');
    assertError(await s.req('GET', `${R}/${'a'.repeat(41)}`), 404, 'NOT_FOUND');
    assertError(await s.req('GET', `${R}/%E0%A4%A`), 404, 'NOT_FOUND');
    // ชื่อไทย / ช่องว่างกลาง / มี "/" ใน URL-encode
    for (const name of ['สมชาย ใจดี', 'a/b', 'x%y', 'Ñoño']) {
      const p = await s.req('PUT', R, { name, lines: [{ itemId: i1, qty: 1 }] });
      assert.equal(p.status, 200, p.text);
      const g = await s.req('GET', `${R}/${enc(name)}`);
      assert.equal(g.status, 200, `GET ${name}: ${g.text}`);
      assert.equal(g.body.name, name);
    }
  });

  await t.test('DELETE (F5): 204 ไม่มี body · ไม่มี order → 404 · ชื่อผิดรูปแบบ → 400 field "name" (D15)', async () => {
    await s.req('PUT', R, { name: 'Del', lines: [{ itemId: i1, qty: 1 }] });
    const d = await s.req('DELETE', `${R}/${enc('  dEL ')}`);
    assert.equal(d.status, 204); assert.equal(d.text, '');
    assertError(await s.req('GET', `${R}/Del`), 404, 'NOT_FOUND');
    assertError(await s.req('DELETE', `${R}/Del`), 404, 'NOT_FOUND');
    assertError(await s.req('DELETE', `${R}/${enc('   ')}`), 400, 'VALIDATION', 'name');
    assertError(await s.req('DELETE', `${R}/${'a'.repeat(41)}`), 400, 'VALIDATION', 'name');
    assertError(await s.req('DELETE', `${R}/${'%F0%9F%98%80'.repeat(41)}`), 400, 'VALIDATION', 'name');
    assertError(await s.req('DELETE', `${R}/%E0%A4`), 400, 'VALIDATION', 'name');
    assertError(await s.req('DELETE', `${R}/%ZZ`), 400, 'VALIDATION', 'name');
    // 40 ตัวที่ไม่มี order → 404 ไม่ใช่ 400
    assertError(await s.req('DELETE', `${R}/${'b'.repeat(40)}`), 404, 'NOT_FOUND');
    // ยกเลิกแล้วไม่กระทบคนอื่น
    assert.equal((await s.req('GET', `${R}/Alice`)).status, 200);
  });

  await t.test('ยกเลิกแล้วสั่งใหม่ได้', async () => {
    const a = await s.req('PUT', R, { name: 'Re', lines: [{ itemId: i1, qty: 1 }], note: 'เก่า' });
    assert.equal((await s.req('DELETE', `${R}/re`)).status, 204);
    const b = await s.req('PUT', R, { name: 'RE', lines: [{ itemId: i3, qty: 2 }] });
    assert.equal(b.status, 200, b.text);
    assertOrder(b.body, { roundId: round.id, name: 'RE', lines: [{ itemId: i3, qty: 2 }], note: '', total: 120 });
    const g = await s.req('GET', `${R}/Re`);
    assert.equal(g.status, 200); assert.equal(g.body.id, b.body.id);
    assert.ok(a.body.id);
  });

  await t.test('ส่งพร้อมกัน: ชื่อเดียวกันต่างตัวพิมพ์ 30 request → order เดียว id เดียว', async () => {
    const names = Array.from({ length: 30 }, (_, k) => (k % 3 === 0 ? 'Con' : k % 3 === 1 ? ' con ' : 'CON'));
    const rs = await Promise.all(names.map((name, k) =>
      s.req('PUT', R, { name, lines: [{ itemId: i1, qty: (k % 10) + 1 }] })));
    rs.forEach((r) => assert.equal(r.status, 200, r.text));
    assert.equal(new Set(rs.map((r) => r.body.id)).size, 1, 'ต้องได้ order id เดียว');
    const g = await s.req('GET', `${R}/con`);
    assert.equal(g.status, 200);
    assert.equal(g.body.lines.length, 1, 'lines ต้องไม่ถูกต่อกันจากหลาย request');
    assert.equal(g.body.total, g.body.lines[0].qty * 50);
  });

  await t.test('ส่งพร้อมกัน: PUT + DELETE ชื่อเดียวกันสลับกัน ไม่ 500', async () => {
    const ops = [];
    for (let k = 0; k < 20; k++) {
      ops.push(k % 2 ? s.req('DELETE', `${R}/race`) : s.req('PUT', R, { name: 'Race', lines: [{ itemId: i2, qty: 1 }] }));
    }
    const rs = await Promise.all(ops);
    rs.forEach((r) => assert.ok([200, 204, 404].includes(r.status), r.text));
    const g = await s.req('GET', `${R}/race`);
    assert.ok([200, 404].includes(g.status));
    if (g.status === 200) assert.deepEqual(g.body.lines, [{ itemId: i2, qty: 1 }]);
  });

  await t.test('server ไม่มี error ใน stderr', () => {
    assert.doesNotMatch(s.stderr(), /Error|at .*\.js/);
  });
});

// ---------------------------------------------------------------- ส่วน B: นาฬิกาจำลอง
test('B · ขอบเวลา ±1 วินาทีรอบ cutoff (นาฬิกาจำลอง)', async (t) => {
  const clock = (() => { let c = Date.parse('2026-10-05T09:00:00+07:00'); return { now: () => new Date(c), set: (v) => { c = Date.parse(v); } }; })();
  const s = await startWithClock(clock);
  t.after(() => s.close());
  const r = await s.req('POST', '/api/rounds', { restaurant: 'ร้าน', cutoffAt: '2026-10-05T11:00:00+07:00', items: MENU });
  assert.equal(r.status, 201, r.text);
  const R = `/api/rounds/${r.body.id}/orders`;
  const i1 = r.body.items[0].id;

  await t.test('ก่อนปิด 1 วินาที → PUT 200, updatedAt = เวลา server (+07:00)', async () => {
    clock.set('2026-10-05T10:59:59+07:00');
    const p = await s.req('PUT', R, { name: 'Edge', lines: [{ itemId: i1, qty: 1 }] });
    assert.equal(p.status, 200, p.text);
    assert.equal(p.body.updatedAt, '2026-10-05T10:59:59+07:00');
  });

  await t.test('หลังปิด 1 วินาที → GET ยังดูได้ 200 (D12) · ROUND_CLOSED ของ PUT/DELETE เป็นของ BE-24', async () => {
    clock.set('2026-10-05T11:00:01+07:00');
    const g = await s.req('GET', `${R}/edge`);
    assert.equal(g.status, 200, g.text);
    assert.equal(g.body.updatedAt, '2026-10-05T10:59:59+07:00');
  });
});
