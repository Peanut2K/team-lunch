'use strict';

// QA BE-21 — black-box test ของ POST /api/rounds และ GET /api/rounds/today
// เกณฑ์: PRD F1, F2 + API contract (ไม่ใช่ test ของ Dev)
// ส่วน A: start server จริง (`node src/index.js`) ด้วย PORT / DB_PATH แล้วยิง HTTP
// ส่วน B: ใช้นาฬิกาจำลองผ่าน createApp({ now }) เพื่อตรวจขอบเวลา (±1 วินาที, เที่ยงคืนไทย)
// อัปเดต tick 2: ตาม API contract v2 + Decision log D8–D11 (field ใน VALIDATION, เพดานค่า, ลำดับการตรวจ, cutoffAt วันเดียวกับรอบ)
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

/**
 * ตรวจรูปแบบ error ตาม contract v2 (D11)
 * VALIDATION → { error: { code, field, message } } · field = path หรือ null
 * error อื่น → { error: { code, message } } ไม่มี key field
 * @param {string|null|undefined} field ถ้าส่งมา (รวม null) ต้องตรงทุกตัว
 */
function assertError(r, status, code, field) {
  assert.equal(r.status, status, `status ควรเป็น ${status} ได้ ${r.status}: ${r.text}`);
  assert.match(r.type, /application\/json/);
  assert.ok(r.body && r.body.error, 'ต้องมี { error }');
  assert.deepEqual(Object.keys(r.body).sort(), ['error']);
  assert.equal(r.body.error.code, code);
  if (code === 'VALIDATION') {
    assert.deepEqual(Object.keys(r.body.error).sort(), ['code', 'field', 'message'], `VALIDATION ต้องมี field (D11): ${r.text}`);
    assert.ok(r.body.error.field === null || typeof r.body.error.field === 'string', 'field ต้องเป็น string หรือ null');
    if (field !== undefined) assert.equal(r.body.error.field, field, `field ควรเป็น ${field}: ${r.text}`);
  } else {
    assert.deepEqual(Object.keys(r.body.error).sort(), ['code', 'message'], `error ${code} ต้องไม่มี field (D11): ${r.text}`);
  }
  assert.equal(typeof r.body.error.message, 'string');
  assert.match(r.body.error.message, /[\u0E00-\u0E7F]/, 'message ต้องเป็นภาษาไทย');
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
// D10: cutoffAt ต้องอยู่วันเดียวกับรอบ — ไม่ให้เลยเที่ยงคืนไทย (23:59:59 ของวันนี้)
const endOfBkkDay = (ms = Date.now()) => Date.parse(`${bkkDate(ms)}T23:59:59+07:00`);
const futureCutoff = (sec = 3600) => toBkkIso(Math.min(Date.now() + sec * 1000, endOfBkkDay()));
// ส่วน A ใช้เวลาจริง — ถ้าเหลือไม่ถึง 3 นาทีก่อนเที่ยงคืนไทยให้ข้าม (ส่วน B ครอบขอบเวลาด้วยนาฬิกาจำลองแล้ว)
const NEAR_MIDNIGHT = endOfBkkDay() - Date.now() < 180e3;
const realTest = (name, fn) => test(name, { skip: NEAR_MIDNIGHT && 'ใกล้เที่ยงคืนไทยเกินไปสำหรับ test เวลาจริง' }, fn);

// ───────────────────────── ส่วน A: server จริง ─────────────────────────

realTest('A1 F2: ยังไม่มีรอบวันนี้ → 404 NO_ROUND (รูปแบบ error ตาม contract)', async () => {
  const s = await startProcess(tmpDb());
  try {
    assertError(await s.req('GET', '/api/rounds/today'), 404, 'NO_ROUND');
  } finally { await s.close(); }
});

realTest('A2 F1/F2: เปิดรอบ 201 Round ครบ field แล้ว GET today คืนรอบเดียวกัน, เปิดซ้ำ 409 ROUND_EXISTS', async () => {
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

realTest('A3 F1: ส่งพร้อมกัน 10 request → 201 หนึ่งครั้ง ที่เหลือ 409 ROUND_EXISTS', async () => {
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

realTest('A4 F1 + contract v2: ทุกกรณี validation → 400 VALIDATION พร้อม field ที่ถูก (D11) และไม่สร้างรอบ', async () => {
  const s = await startProcess(tmpDb());
  const ok = { restaurant: 'ร้าน', cutoffAt: futureCutoff(), items: MENU };
  const items31 = Array.from({ length: 31 }, (_, i) => ({ name: `เมนู ${i}`, price: 40 }));
  const cases = [
    ['ไม่มี restaurant', { cutoffAt: ok.cutoffAt, items: MENU }, 'restaurant'],
    ['restaurant ว่าง', { ...ok, restaurant: '' }, 'restaurant'],
    ['restaurant มีแต่ช่องว่าง', { ...ok, restaurant: '   ' }, 'restaurant'],
    ['restaurant ไม่ใช่ string', { ...ok, restaurant: 123 }, 'restaurant'],
    ['ไม่มี cutoffAt', { restaurant: 'ร้าน', items: MENU }, 'cutoffAt'],
    ['cutoffAt null', { ...ok, cutoffAt: null }, 'cutoffAt'],
    ['cutoffAt ไม่ใช่เวลา', { ...ok, cutoffAt: 'พรุ่งนี้' }, 'cutoffAt'],
    ['cutoffAt เป็นตัวเลข', { ...ok, cutoffAt: Date.now() + 60e3 }, 'cutoffAt'],
    ['cutoffAt ไม่มี offset', { ...ok, cutoffAt: ok.cutoffAt.slice(0, 19) }, 'cutoffAt'],
    ['cutoffAt วันที่ไม่มีจริง', { ...ok, cutoffAt: '2099-02-31T11:00:00+07:00' }, 'cutoffAt'],
    ['cutoffAt ในอดีต', { ...ok, cutoffAt: toBkkIso(Date.now() - 60e3) }, 'cutoffAt'],
    ['cutoffAt ในอดีต (เมื่อวาน)', { ...ok, cutoffAt: toBkkIso(Date.now() - 86400e3) }, 'cutoffAt'],
    ['D10 cutoffAt พรุ่งนี้ 11:00', { ...ok, cutoffAt: `${bkkDate(Date.now() + 86400e3)}T11:00:00+07:00` }, 'cutoffAt'],
    ['D10 cutoffAt เที่ยงคืนไทยคืนนี้', { ...ok, cutoffAt: toBkkIso(endOfBkkDay() + 1000) }, 'cutoffAt'],
    ['ไม่มี items', { restaurant: 'ร้าน', cutoffAt: ok.cutoffAt }, 'items'],
    ['items ไม่ใช่ array', { ...ok, items: { name: 'ก', price: 1 } }, 'items'],
    ['items ว่าง', { ...ok, items: [] }, 'items'],
    ['items 31 รายการ', { ...ok, items: items31 }, 'items'],
    ['item ไม่ใช่ object', { ...ok, items: ['ข้าวผัด'] }, 'items[0]'],
    ['item ที่ 2 เป็น null', { ...ok, items: [MENU[0], null] }, 'items[1]'],
    ['item ไม่มีชื่อ', { ...ok, items: [{ price: 40 }] }, 'items[0].name'],
    ['item ชื่อว่าง', { ...ok, items: [{ name: ' ', price: 40 }] }, 'items[0].name'],
    ['item ชื่อไม่ใช่ string', { ...ok, items: [{ name: 5, price: 40 }] }, 'items[0].name'],
    ['price = 0', { ...ok, items: [{ name: 'ข้าว', price: 0 }] }, 'items[0].price'],
    ['price ติดลบ', { ...ok, items: [{ name: 'ข้าว', price: -5 }] }, 'items[0].price'],
    ['price ทศนิยม', { ...ok, items: [{ name: 'ข้าว', price: 49.5 }] }, 'items[0].price'],
    ['price เป็น string', { ...ok, items: [{ name: 'ข้าว', price: '50' }] }, 'items[0].price'],
    ['price boolean', { ...ok, items: [{ name: 'ข้าว', price: true }] }, 'items[0].price'],
    ['price null', { ...ok, items: [{ name: 'ข้าว', price: null }] }, 'items[0].price'],
    ['ไม่มี price', { ...ok, items: [{ name: 'ข้าว' }] }, 'items[0].price'],
    ['D8 price 10,001', { ...ok, items: [{ name: 'ข้าว', price: 10001 }] }, 'items[0].price'],
    ['D8 price 2^53', { ...ok, items: [{ name: 'ข้าว', price: 2 ** 53 }] }, 'items[0].price'],
    ['D8 price 1e20', { ...ok, items: [{ name: 'ข้าว', price: 1e20 }] }, 'items[0].price'],
    ['D8 price 1e308', { ...ok, items: [{ name: 'ข้าว', price: 1e308 }] }, 'items[0].price'],
    ['price ผิดในรายการที่ 3 (index 2)', { ...ok, items: [MENU[0], MENU[1], { name: 'ค', price: 0 }] }, 'items[2].price'],
    ['D8 restaurant 61 code point', { ...ok, restaurant: 'ก'.repeat(61) }, 'restaurant'],
    ['D8 restaurant ไทย 61 code point (สระ/วรรณยุกต์)', { ...ok, restaurant: 'ข้าว'.repeat(15) + 'ก' }, 'restaurant'],
    ['D8 ชื่อเมนู 61 code point ในรายการที่ 2', { ...ok, items: [MENU[0], { name: '🍚'.repeat(61), price: 50 }] }, 'items[1].name'],
  ];
  try {
    for (const [label, body, field] of cases) {
      const r = await s.req('POST', '/api/rounds', body);
      try { assertError(r, 400, 'VALIDATION', field); } catch (e) { e.message = `[${label}] ${e.message}`; throw e; }
    }
    // D11: body ทั้งก้อนผิด → field null
    assertError(await s.req('POST', '/api/rounds', '{bad json', { raw: true }), 400, 'VALIDATION', null);
    assertError(await s.req('POST', '/api/rounds', [ok]), 400, 'VALIDATION', null);
    assertError(await s.req('POST', '/api/rounds', '"ร้าน"', { raw: true }), 400, 'VALIDATION', null);
    assertError(await s.req('POST', '/api/rounds', 'null', { raw: true }), 400, 'VALIDATION', null);
    assertError(await s.req('POST', '/api/rounds', 'restaurant=x', { raw: true, contentType: 'application/x-www-form-urlencoded' }), 400, 'VALIDATION', null);
    assertError(await s.req('POST', '/api/rounds', JSON.stringify(ok), { raw: true, contentType: 'text/plain' }), 400, 'VALIDATION', null);
    // body ว่าง — contract ไม่ได้บอกชัดว่า null หรือ restaurant (หมายเหตุถึง Planner) ตรวจแค่ 400 VALIDATION
    assertError(await s.req('POST', '/api/rounds'), 400, 'VALIDATION');
    // ไม่มีรอบหลุดถูกสร้าง (รวม price ใหญ่ที่เคยทำ DB เสีย)
    assertError(await s.req('GET', '/api/rounds/today'), 404, 'NO_ROUND');
    const good = await s.req('POST', '/api/rounds', ok);
    assert.equal(good.status, 201, `หลัง 400 ทั้งหมดต้องเปิดรอบปกติได้: ${good.text}`);
  } finally { await s.close(); }
});

realTest('A5 contract: items 30 รายการ (ขอบบน) และ 1 รายการ (ขอบล่าง) ผ่าน · cutoffAt แบบ Z ตอบกลับเป็น +07:00', async () => {
  const s1 = await startProcess(tmpDb());
  try {
    const items = Array.from({ length: 30 }, (_, i) => ({ name: `เมนู ${i + 1}`, price: i + 1 }));
    const cutoffMs = Math.min(Date.now() + 3600e3, endOfBkkDay());
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

realTest('A6 F2/F6: status เปลี่ยน open → closed เองเมื่อถึงเวลาปิด (เวลา server จริง)', async () => {
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

realTest('A7 รอบเก็บใน SQLite (DB_PATH) — restart server แล้วยังอยู่ และยังเปิดซ้ำไม่ได้', async () => {
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

realTest('A8 D8: ขอบเพดาน — price 1 / 10,000 ผ่าน · ชื่อร้าน/เมนู 60 code point ผ่าน (นับ code point ไม่ใช่ UTF-16) และอ่านกลับได้', async () => {
  const s = await startProcess(tmpDb());
  try {
    const restaurant = 'ข้าว'.repeat(15); // 60 code point, String#length = 60
    const emoji60 = '🍚'.repeat(60); // 60 code point, String#length = 120
    const thai60 = 'น้ำ'.repeat(20); // น + ้ + ำ = 3 code point × 20
    const items = [
      { name: emoji60, price: 1 },
      { name: `  ${thai60}  `, price: 10000 },
      { name: 'ก', price: 9999 },
    ];
    const r = await s.req('POST', '/api/rounds', { restaurant: `\t ${restaurant} `, cutoffAt: futureCutoff(), items });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.body.restaurant, restaurant);
    assert.deepEqual(r.body.items.map((i) => [i.name, i.price]), [[emoji60, 1], [thai60, 10000], ['ก', 9999]]);
    const g = await s.req('GET', '/api/rounds/today');
    assert.equal(g.status, 200, g.text);
    assert.deepEqual(g.body.items, r.body.items);
  } finally { await s.close(); }
});

realTest('A9 D9: มีรอบแล้วแต่ body ผิด → 400 VALIDATION ไม่ใช่ 409 · ผิดหลายจุดตอบจุดแรกตามลำดับ restaurant → cutoffAt → items', async () => {
  const s = await startProcess(tmpDb());
  try {
    assert.equal((await s.req('POST', '/api/rounds', { restaurant: 'ร้าน', cutoffAt: futureCutoff(), items: MENU })).status, 201);
    // มีรอบแล้ว + body ผิด → VALIDATION ก่อน ROUND_EXISTS
    assertError(await s.req('POST', '/api/rounds', { restaurant: '', cutoffAt: futureCutoff(), items: MENU }), 400, 'VALIDATION', 'restaurant');
    assertError(await s.req('POST', '/api/rounds', '{', { raw: true }), 400, 'VALIDATION', null);
    // ผิดทุกจุด → restaurant
    const allBad = { restaurant: '', cutoffAt: 'x', items: [{ name: '', price: 0 }] };
    assertError(await s.req('POST', '/api/rounds', allBad), 400, 'VALIDATION', 'restaurant');
    assertError(await s.req('POST', '/api/rounds', { ...allBad, restaurant: 'ร้าน' }), 400, 'VALIDATION', 'cutoffAt');
    assertError(await s.req('POST', '/api/rounds', { ...allBad, restaurant: 'ร้าน', cutoffAt: futureCutoff() }), 400, 'VALIDATION', 'items[0].name');
    // ภายในรายการเดียวกัน name ก่อน price · รายการที่ index น้อยก่อน
    assertError(await s.req('POST', '/api/rounds', { restaurant: 'ร้าน', cutoffAt: futureCutoff(), items: [{ name: 'ก', price: 0 }, { name: '', price: 1 }] }), 400, 'VALIDATION', 'items[0].price');
    // body ถูกทั้งหมด → 409 (ไม่มี field)
    assertError(await s.req('POST', '/api/rounds', { restaurant: 'ร้านสอง', cutoffAt: futureCutoff(), items: MENU }), 409, 'ROUND_EXISTS');
    // 404 อื่นๆ ใต้ /api ก็ไม่มี field
    assertError(await s.req('GET', '/api/nope'), 404, 'NOT_FOUND');
  } finally { await s.close(); }
});

// ─────────────────── ส่วน B: นาฬิกาจำลอง (ขอบเวลา) ───────────────────

test('B1 F1: cutoffAt = now → 400, now − 1s → 400, now + 1s → 201', async () => {
  const clock = fakeClock('2026-10-05T10:59:59+07:00');
  const s = await startWithClock(clock);
  try {
    assertError(await s.req('POST', '/api/rounds', { restaurant: 'ร้าน', cutoffAt: '2026-10-05T10:59:59+07:00', items: MENU }), 400, 'VALIDATION', 'cutoffAt');
    assertError(await s.req('POST', '/api/rounds', { restaurant: 'ร้าน', cutoffAt: '2026-10-05T10:59:58+07:00', items: MENU }), 400, 'VALIDATION', 'cutoffAt');
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

test('B4 D10: cutoffAt ต้องอยู่วันเดียวกับรอบตามปฏิทินไทย (ขอบ 23:59:59 / 00:00, offset อื่น)', async () => {
  const body = (cutoffAt) => ({ restaurant: 'ร้าน', cutoffAt, items: MENU });
  // กรณีไม่ผ่าน — server เดียวกัน
  {
    const s = await startWithClock(fakeClock('2026-10-05T09:00:00+07:00'));
    try {
      for (const c of ['2026-10-06T00:00:00+07:00', '2026-10-05T17:00:00Z', '2026-10-06T02:00:00+09:00',
        '2026-10-06T11:00:00+07:00', '2026-10-04T23:00:00+07:00']) {
        const r = await s.req('POST', '/api/rounds', body(c));
        try { assertError(r, 400, 'VALIDATION', 'cutoffAt'); } catch (e) { e.message = `[${c}] ${e.message}`; throw e; }
      }
      assertError(await s.req('GET', '/api/rounds/today'), 404, 'NO_ROUND');
    } finally { await s.close(); }
  }
  // กรณีผ่าน — วันเดียวกันตามปฏิทินไทย แม้ offset / วันที่ใน string จะต่างกัน
  for (const [c, expect] of [
    ['2026-10-05T23:59:59+07:00', '2026-10-05T23:59:59+07:00'],
    ['2026-10-05T16:59:59Z', '2026-10-05T23:59:59+07:00'],
    ['2026-10-06T01:59:59+09:00', '2026-10-05T23:59:59+07:00'],
    ['2026-10-04T23:00:00-05:00', '2026-10-05T11:00:00+07:00'],
  ]) {
    const s = await startWithClock(fakeClock('2026-10-05T09:00:00+07:00'));
    try {
      const r = await s.req('POST', '/api/rounds', body(c));
      assert.equal(r.status, 201, `[${c}] ${r.text}`);
      assert.equal(r.body.cutoffAt, expect);
      assert.equal(r.body.id, 'r_20261005');
    } finally { await s.close(); }
  }
});

test('B5 D10 + F1: เปิดรอบตอน 23:30 ตั้งปิดรับพรุ่งนี้ 11:00 → 400 · ก่อนเที่ยงคืน 1 วินาที', async () => {
  const clock = fakeClock('2026-10-05T23:30:00+07:00');
  const s = await startWithClock(clock);
  try {
    assertError(await s.req('POST', '/api/rounds', { restaurant: 'ร้าน', cutoffAt: '2026-10-06T11:00:00+07:00', items: MENU }), 400, 'VALIDATION', 'cutoffAt');
    clock.set('2026-10-05T23:59:59+07:00');
    assertError(await s.req('POST', '/api/rounds', { restaurant: 'ร้าน', cutoffAt: '2026-10-05T23:59:59+07:00', items: MENU }), 400, 'VALIDATION', 'cutoffAt');
    clock.set('2026-10-05T23:59:58+07:00');
    const r = await s.req('POST', '/api/rounds', { restaurant: 'ร้าน', cutoffAt: '2026-10-05T23:59:59+07:00', items: MENU });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.body.status, 'open');
    clock.set('2026-10-05T23:59:59+07:00');
    assert.equal((await s.req('GET', '/api/rounds/today')).body.status, 'closed');
    clock.set('2026-10-06T00:00:00+07:00');
    assertError(await s.req('GET', '/api/rounds/today'), 404, 'NO_ROUND');
  } finally { await s.close(); }
});
