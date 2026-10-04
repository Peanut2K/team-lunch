'use strict';

// QA BE-21 — black-box test ของ POST /api/rounds และ GET /api/rounds/today
// เกณฑ์: PRD F1, F2 + API contract (ไม่ใช่ test ของ Dev)
// ส่วน A: start server จริง (`node src/index.js`) ด้วย PORT / DB_PATH แล้วยิง HTTP
// ส่วน B: ใช้นาฬิกาจำลองผ่าน createApp({ now }) เพื่อตรวจขอบเวลา (±1 วินาที, เที่ยงคืนไทย)
// รัน: node --test qa/be-21.test.js   (ต้อง `cd server && npm install` ก่อน)

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

const bkkDate = (ms) => new Date(ms + OFFSET).toISOString().slice(0, 10);
const toBkkIso = (ms) => new Date(ms + OFFSET).toISOString().slice(0, 19) + '+07:00';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-be21-'));
  return path.join(dir, 'test.db');
}

/** start server จริงเป็น process แยก */
async function startProcess(dbPath) {
  const port = await freePort();
  const child = spawn(process.execPath,
    ['--disable-warning=ExperimentalWarning', 'src/index.js'],
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

/** server ใน process เดียวกันพร้อมนาฬิกาจำลอง (ส่วน B) */
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
      init.headers['content-type'] = contentType;
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

function fakeClock(iso) {
  let t = Date.parse(iso);
  return { now: () => new Date(t), set: (v) => { t = Date.parse(v); }, advance: (ms) => { t += ms; } };
}

/** ตรวจรูปแบบ error ตาม contract */
function assertError(r, status, code) {
  assert.equal(r.status, status, `status ควรเป็น ${status} ได้ ${r.status}: ${r.text}`);
  assert.match(r.type, /application\/json/);
  assert.ok(r.body && r.body.error, 'ต้องมี { error }');
  assert.deepEqual(Object.keys(r.body).sort(), ['error']);
  assert.equal(r.body.error.code, code);
  assert.equal(typeof r.body.error.message, 'string');
  assert.match(r.body.error.message, /[฀-๿]/, 'message ต้องเป็นภาษาไทย');
}

/** ตรวจรูปแบบ Round ตาม contract */
function assertRound(round, { restaurant, cutoffMs, items, nowMs, status }) {
  assert.deepEqual(Object.keys(round).sort(),
    ['cutoffAt', 'date', 'id', 'items', 'restaurant', 'serverNow', 'status'].sort());
  const date = bkkDate(nowMs);
  assert.equal(round.date, date);
  assert.equal(round.id, `r_${date.replace(/-/g, '')}`);
  assert.equal(round.restaurant, restaurant);
  assert.match(round.cutoffAt, ISO_BKK);
  assert.equal(Date.parse(round.cutoffAt), Math.floor(cutoffMs / 1000) * 1000);
  assert.match(round.serverNow, ISO_BKK);
  assert.ok(Math.abs(Date.parse(round.serverNow) - nowMs) < 3000, 'serverNow ต้องใกล้เวลาจริงของ server');
  assert.equal(round.status, status);
  assert.equal(round.items.length, items.length);
  const ids = new Set();
  round.items.forEach((it, i) => {
    assert.deepEqual(Object.keys(it).sort(), ['id', 'name', 'price']);
    assert.equal(typeof it.id, 'string');
    ids.add(it.id);
    assert.equal(it.name, items[i].name);
    assert.equal(it.price, items[i].price);
    assert.ok(Number.isInteger(it.price));
  });
  assert.equal(ids.size, items.length, 'id เมนูต้องไม่ซ้ำ');
}

const MENU = [
  { name: 'ข้าวมันไก่ต้ม', price: 50 },
  { name: 'ข้าวมันไก่ทอด', price: 55 },
  { name: 'ข้าวมันไก่รวม', price: 60 },
];
const futureCutoff = (sec = 3600) => toBkkIso(Date.now() + sec * 1000);

// ───────────────────────── ส่วน A: server จริง ─────────────────────────

test('A1 F2: ยังไม่มีรอบวันนี้ → 404 NO_ROUND (รูปแบบ error ตาม contract)', async () => {
  const s = await startProcess(tmpDb());
  try {
    assertError(await s.req('GET', '/api/rounds/today'), 404, 'NO_ROUND');
  } finally { await s.close(); }
});

test('A2 F1/F2: เปิดรอบ 201 Round ครบ field แล้ว GET today คืนรอบเดียวกัน, เปิดซ้ำ 409 ROUND_EXISTS', async () => {
  const s = await startProcess(tmpDb());
  try {
    const cutoff = futureCutoff(3600);
    const r = await s.req('POST', '/api/rounds', { restaurant: 'ข้าวมันไก่ป้าแดง', cutoffAt: cutoff, items: MENU });
    assert.equal(r.status, 201, r.text);
    assertRound(r.body, { restaurant: 'ข้าวมันไก่ป้าแดง', cutoffMs: Date.parse(cutoff), items: MENU, nowMs: Date.now(), status: 'open' });

    await sleep(1100);
    const g = await s.req('GET', '/api/rounds/today');
    assert.equal(g.status, 200, g.text);
    assertRound(g.body, { restaurant: 'ข้าวมันไก่ป้าแดง', cutoffMs: Date.parse(cutoff), items: MENU, nowMs: Date.now(), status: 'open' });
    assert.equal(g.body.id, r.body.id);
    assert.deepEqual(g.body.items, r.body.items);
    assert.ok(Date.parse(g.body.serverNow) > Date.parse(r.body.serverNow), 'serverNow ต้องคำนวณใหม่ทุกครั้งที่ตอบ');

    // วันละ 1 รอบ — ต่างร้าน / ต่างเมนูก็ไม่ได้
    assertError(await s.req('POST', '/api/rounds', { restaurant: 'ร้านอื่น', cutoffAt: futureCutoff(7200), items: [{ name: 'ก๋วยเตี๋ยว', price: 45 }] }), 409, 'ROUND_EXISTS');
    const after = await s.req('GET', '/api/rounds/today');
    assert.equal(after.body.restaurant, 'ข้าวมันไก่ป้าแดง', 'รอบเดิมต้องไม่ถูกแทน');
  } finally { await s.close(); }
});

test('A3 F1: ส่งพร้อมกัน 10 request → 201 หนึ่งครั้ง ที่เหลือ 409 ROUND_EXISTS', async () => {
  const s = await startProcess(tmpDb());
  try {
    const cutoff = futureCutoff(3600);
    const rs = await Promise.all(Array.from({ length: 10 }, (_, i) =>
      s.req('POST', '/api/rounds', { restaurant: `ร้าน ${i}`, cutoffAt: cutoff, items: MENU })));
    assert.equal(rs.filter((r) => r.status === 201).length, 1);
    rs.filter((r) => r.status !== 201).forEach((r) => assertError(r, 409, 'ROUND_EXISTS'));
    const g = await s.req('GET', '/api/rounds/today');
    const winner = rs.find((r) => r.status === 201).body;
    assert.equal(g.body.restaurant, winner.restaurant);
  } finally { await s.close(); }
});

test('A4 F1 + contract: ทุกกรณี validation → 400 VALIDATION และไม่สร้างรอบ', async () => {
  const s = await startProcess(tmpDb());
  const ok = { restaurant: 'ร้าน', cutoffAt: futureCutoff(), items: MENU };
  const cases = [
    ['ไม่มี restaurant', { cutoffAt: ok.cutoffAt, items: MENU }],
    ['restaurant ว่าง', { ...ok, restaurant: '' }],
    ['restaurant มีแต่ช่องว่าง', { ...ok, restaurant: '   ' }],
    ['restaurant ไม่ใช่ string', { ...ok, restaurant: 123 }],
    ['ไม่มี cutoffAt', { restaurant: 'ร้าน', items: MENU }],
    ['cutoffAt ไม่ใช่เวลา', { ...ok, cutoffAt: 'พรุ่งนี้' }],
    ['cutoffAt เป็นตัวเลข', { ...ok, cutoffAt: Date.now() + 3600e3 }],
    ['cutoffAt วันที่ไม่มีจริง', { ...ok, cutoffAt: '2099-02-31T11:00:00+07:00' }],
    ['cutoffAt ในอดีต', { ...ok, cutoffAt: toBkkIso(Date.now() - 60e3) }],
    ['cutoffAt ในอดีต (เมื่อวาน)', { ...ok, cutoffAt: toBkkIso(Date.now() - 86400e3) }],
    ['ไม่มี items', { restaurant: 'ร้าน', cutoffAt: ok.cutoffAt }],
    ['items ไม่ใช่ array', { ...ok, items: { name: 'ก', price: 1 } }],
    ['items ว่าง', { ...ok, items: [] }],
    ['items 31 รายการ', { ...ok, items: Array.from({ length: 31 }, (_, i) => ({ name: `เมนู ${i}`, price: 40 })) }],
    ['item ไม่ใช่ object', { ...ok, items: ['ข้าวผัด'] }],
    ['item ไม่มีชื่อ', { ...ok, items: [{ price: 40 }] }],
    ['item ชื่อว่าง', { ...ok, items: [{ name: ' ', price: 40 }] }],
    ['price = 0', { ...ok, items: [{ name: 'ข้าว', price: 0 }] }],
    ['price ติดลบ', { ...ok, items: [{ name: 'ข้าว', price: -5 }] }],
    ['price ทศนิยม', { ...ok, items: [{ name: 'ข้าว', price: 49.5 }] }],
    ['price เป็น string', { ...ok, items: [{ name: 'ข้าว', price: '50' }] }],
    ['price null', { ...ok, items: [{ name: 'ข้าว', price: null }] }],
    ['ไม่มี price', { ...ok, items: [{ name: 'ข้าว' }] }],
    ['price ผิดในรายการที่ 2', { ...ok, items: [{ name: 'ก', price: 40 }, { name: 'ข', price: 0 }] }],
  ];
  try {
    for (const [label, body] of cases) {
      const r = await s.req('POST', '/api/rounds', body);
      try { assertError(r, 400, 'VALIDATION'); } catch (e) { e.message = `[${label}] ${e.message}`; throw e; }
    }
    // body ไม่ใช่ JSON / เป็น array / ว่าง
    assertError(await s.req('POST', '/api/rounds', '{bad json', { raw: true }), 400, 'VALIDATION');
    assertError(await s.req('POST', '/api/rounds', [ok]), 400, 'VALIDATION');
    assertError(await s.req('POST', '/api/rounds', 'restaurant=x', { raw: true, contentType: 'application/x-www-form-urlencoded' }), 400, 'VALIDATION');
    assertError(await s.req('POST', '/api/rounds'), 400, 'VALIDATION');
    // ไม่มีรอบหลุดถูกสร้าง
    assertError(await s.req('GET', '/api/rounds/today'), 404, 'NO_ROUND');
  } finally { await s.close(); }
});

test('A5 contract: items 30 รายการ (ขอบบน) และ 1 รายการ (ขอบล่าง) ผ่าน · cutoffAt แบบ Z ตอบกลับเป็น +07:00', async () => {
  const s1 = await startProcess(tmpDb());
  try {
    const items = Array.from({ length: 30 }, (_, i) => ({ name: `เมนู ${i + 1}`, price: i + 1 }));
    const cutoffMs = Date.now() + 3600e3;
    const r = await s1.req('POST', '/api/rounds', { restaurant: '  ร้าน 30 เมนู  ', cutoffAt: new Date(cutoffMs).toISOString(), items });
    assert.equal(r.status, 201, r.text);
    assertRound(r.body, { restaurant: 'ร้าน 30 เมนู', cutoffMs, items, nowMs: Date.now(), status: 'open' });
  } finally { await s1.close(); }
  const s2 = await startProcess(tmpDb());
  try {
    const r = await s2.req('POST', '/api/rounds', { restaurant: 'ร้านเดียว', cutoffAt: futureCutoff(60), items: [{ name: 'กะเพรา', price: 1 }] });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.body.items.length, 1);
  } finally { await s2.close(); }
});

test('A6 F2/F6: status เปลี่ยน open → closed เองเมื่อถึงเวลาปิด (เวลา server จริง)', async () => {
  const s = await startProcess(tmpDb());
  try {
    const cutoffMs = Math.ceil((Date.now() + 2000) / 1000) * 1000;
    const r = await s.req('POST', '/api/rounds', { restaurant: 'ร้าน', cutoffAt: toBkkIso(cutoffMs), items: MENU });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.body.status, 'open');
    const before = await s.req('GET', '/api/rounds/today');
    assert.equal(before.body.status, 'open');
    await sleep(Math.max(0, cutoffMs - Date.now()) + 1100);
    const after = await s.req('GET', '/api/rounds/today');
    assert.equal(after.status, 200);
    assert.equal(after.body.status, 'closed');
    assert.ok(Date.parse(after.body.serverNow) >= cutoffMs);
  } finally { await s.close(); }
});

test('A7 รอบเก็บใน SQLite (DB_PATH) — restart server แล้วยังอยู่ และยังเปิดซ้ำไม่ได้', async () => {
  const db = tmpDb();
  const cutoff = futureCutoff();
  let s = await startProcess(db);
  const r = await s.req('POST', '/api/rounds', { restaurant: 'ร้านถาวร', cutoffAt: cutoff, items: MENU });
  assert.equal(r.status, 201);
  await s.close();
  s = await startProcess(db);
  try {
    const g = await s.req('GET', '/api/rounds/today');
    assert.equal(g.status, 200);
    assert.equal(g.body.id, r.body.id);
    assert.deepEqual(g.body.items, r.body.items);
    assertError(await s.req('POST', '/api/rounds', { restaurant: 'ร้านใหม่', cutoffAt: cutoff, items: MENU }), 409, 'ROUND_EXISTS');
  } finally { await s.close(); }
});

test('A8 contract: price จำนวนเต็มที่ใหญ่มาก ต้องได้ 201 หรือ 400 VALIDATION เท่านั้น และรอบวันนี้ต้องยังใช้งานได้', async () => {
  const s = await startProcess(tmpDb());
  try {
    // 2^53 เป็นจำนวนเต็ม > 0 ตาม JSON/JS — contract ไม่ได้กำหนดเพดานราคา
    const r = await s.req('POST', '/api/rounds', { restaurant: 'ร้าน', cutoffAt: futureCutoff(), items: [{ name: 'ข้าว', price: 2 ** 53 }] });
    assert.ok([201, 400].includes(r.status), `POST ได้ ${r.status}: ${r.text}`);
    const g = await s.req('GET', '/api/rounds/today');
    assert.ok([200, 404].includes(g.status), `GET today หลังจากนั้นได้ ${g.status}: ${g.text}`);
    const again = await s.req('POST', '/api/rounds', { restaurant: 'ร้าน', cutoffAt: futureCutoff(), items: MENU });
    assert.ok([201, 409].includes(again.status), `POST รอบปกติหลังจากนั้นได้ ${again.status}: ${again.text}`);
  } finally { await s.close(); }
});

// ─────────────────── ส่วน B: นาฬิกาจำลอง (ขอบเวลา) ───────────────────

test('B1 F1: cutoffAt = now → 400, now − 1s → 400, now + 1s → 201', async () => {
  const clock = fakeClock('2026-10-05T10:59:59+07:00');
  const s = await startWithClock(clock);
  try {
    assertError(await s.req('POST', '/api/rounds', { restaurant: 'ร้าน', cutoffAt: '2026-10-05T10:59:59+07:00', items: MENU }), 400, 'VALIDATION');
    assertError(await s.req('POST', '/api/rounds', { restaurant: 'ร้าน', cutoffAt: '2026-10-05T10:59:58+07:00', items: MENU }), 400, 'VALIDATION');
    const r = await s.req('POST', '/api/rounds', { restaurant: 'ร้าน', cutoffAt: '2026-10-05T11:00:00+07:00', items: MENU });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.body.status, 'open');
    assert.equal(r.body.serverNow, '2026-10-05T10:59:59+07:00');
    assert.equal(r.body.cutoffAt, '2026-10-05T11:00:00+07:00');
  } finally { await s.close(); }
});

test('B2 F2/F6: status ก่อนปิด 1 วินาที = open · ตรงเวลาปิด = closed · หลังปิด 1 วินาที = closed', async () => {
  const clock = fakeClock('2026-10-05T09:00:00+07:00');
  const s = await startWithClock(clock);
  try {
    assert.equal((await s.req('POST', '/api/rounds', { restaurant: 'ร้าน', cutoffAt: '2026-10-05T11:00:00+07:00', items: MENU })).status, 201);
    clock.set('2026-10-05T10:59:59+07:00');
    let g = await s.req('GET', '/api/rounds/today');
    assert.equal(g.body.status, 'open');
    assert.equal(g.body.serverNow, '2026-10-05T10:59:59+07:00');
    clock.set('2026-10-05T10:59:59.999+07:00');
    assert.equal((await s.req('GET', '/api/rounds/today')).body.status, 'open');
    clock.set('2026-10-05T11:00:00+07:00');
    assert.equal((await s.req('GET', '/api/rounds/today')).body.status, 'closed');
    clock.set('2026-10-05T11:00:01+07:00');
    g = await s.req('GET', '/api/rounds/today');
    assert.equal(g.body.status, 'closed');
    assert.equal(g.body.serverNow, '2026-10-05T11:00:01+07:00');
    // ยังเป็นรอบของวันนี้อยู่ (ปิดแล้วก็ยังดูได้) และยังเปิดรอบใหม่วันเดียวกันไม่ได้
    assertError(await s.req('POST', '/api/rounds', { restaurant: 'รอบบ่าย', cutoffAt: '2026-10-05T15:00:00+07:00', items: MENU }), 409, 'ROUND_EXISTS');
  } finally { await s.close(); }
});

test('B3 D2: "วันนี้" นับตามปฏิทินไทย ไม่ใช่ UTC (01:00 ไทย = 18:00Z วันก่อน)', async () => {
  const clock = fakeClock('2026-10-04T18:00:00Z'); // = 2026-10-05 01:00 ไทย
  const s = await startWithClock(clock);
  try {
    const r = await s.req('POST', '/api/rounds', { restaurant: 'ร้าน', cutoffAt: '2026-10-05T11:00:00+07:00', items: MENU });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.body.date, '2026-10-05');
    assert.equal(r.body.id, 'r_20261005');
    assert.equal(r.body.serverNow, '2026-10-05T01:00:00+07:00');
    clock.set('2026-10-05T16:59:59Z'); // 23:59:59 ไทย วันเดียวกัน
    assert.equal((await s.req('GET', '/api/rounds/today')).body.id, 'r_20261005');
    clock.set('2026-10-05T17:00:00Z'); // 00:00 ไทย วันใหม่
    assertError(await s.req('GET', '/api/rounds/today'), 404, 'NO_ROUND');
    const next = await s.req('POST', '/api/rounds', { restaurant: 'ร้านวันใหม่', cutoffAt: '2026-10-06T11:00:00+07:00', items: MENU });
    assert.equal(next.status, 201, next.text);
    assert.equal(next.body.id, 'r_20261006');
    assert.equal((await s.req('GET', '/api/rounds/today')).body.restaurant, 'ร้านวันใหม่');
  } finally { await s.close(); }
});
