'use strict';

// QA BE-23 — black-box test ของ GET /api/rounds/:id/summary (PRD F7)
// เกณฑ์: PRD F4, F5, F7 + API contract v2 (Summary, error format) + Decision log D3, D4, D11, D15, D16 (ไม่ใช่ test ของ Dev)
// - D16: byItem ไม่รวมเมนูที่ไม่มีคนสั่ง · เรียง qty มาก→น้อย (เท่ากันตามลำดับเมนู) · byPerson ตามลำดับสั่งครั้งแรก (แทนที่ไม่เลื่อน)
// ส่วน A: start server จริง (`node src/index.js`) ยิง API ทุกกรณี + รอให้ถึงเวลาปิดจริงแล้วดูสรุปได้
// ส่วน B: นาฬิกาจำลองผ่าน createApp({ now }) — ก่อน/หลังปิด 1 วินาที
// ส่วน C: สุ่มลำดับ สั่ง/แทนที่/ยกเลิก 300 ครั้ง เทียบกับ model ที่ QA คำนวณเอง
// รัน: node --test qa/be-23.test.js   (ต้อง `cd server && npm install` ก่อน)

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SERVER_DIR = path.join(__dirname, '..', 'server');
const OFFSET = 7 * 3600 * 1000;
const toBkkIso = (ms) => new Date(ms + OFFSET).toISOString().slice(0, 19) + '+07:00';
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

async function startProcess() {
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qa-be23-')), 'test.db');
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
  return client(`http://127.0.0.1:${port}`, () => new Promise((r) => { child.once('exit', r); child.kill(); }));
}

async function startWithClock(clock) {
  const { createApp } = require(path.join(SERVER_DIR, 'src', 'app'));
  const app = createApp({ dbPath: ':memory:', now: clock.now });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  return client(`http://127.0.0.1:${server.address().port}`, () => new Promise((r) => server.close(r)));
}

function client(base, close) {
  async function req(method, p, body) {
    const init = { method, headers: {} };
    if (body !== undefined) { init.headers['content-type'] = 'application/json'; init.body = JSON.stringify(body); }
    const res = await fetch(base + p, init);
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: res.status, body: json, text, type: res.headers.get('content-type') || '' };
  }
  return { base, req, close };
}

function assertNotFound(r) {
  assert.equal(r.status, 404, r.text);
  assert.match(r.type, /application\/json/);
  assert.deepEqual(Object.keys(r.body || {}), ['error'], r.text);
  assert.equal(r.body.error.code, 'NOT_FOUND', r.text);
  assert.deepEqual(Object.keys(r.body.error).sort(), ['code', 'message'], 'D11: NOT_FOUND ไม่มี field');
  assert.match(r.body.error.message, /[฀-๿]/, 'message ต้องเป็นภาษาไทย');
}

/** รูปแบบ Summary ตาม API contract + ยอดตรงกันทุกจุด (F7) */
function assertSummaryShape(s) {
  assert.deepEqual(Object.keys(s).sort(), ['byItem', 'byPerson', 'grandTotal', 'orderCount']);
  for (const it of s.byItem) {
    assert.deepEqual(Object.keys(it).sort(), ['amount', 'itemId', 'name', 'qty']);
    assert.ok(Number.isInteger(it.qty) && it.qty > 0, 'D16: byItem ไม่รวมเมนูที่ไม่มีคนสั่ง');
    assert.ok(Number.isInteger(it.amount), 'D4: เงินเป็นจำนวนเต็ม');
  }
  for (const p of s.byPerson) {
    assert.deepEqual(Object.keys(p).sort(), ['lines', 'name', 'note', 'total']);
    assert.equal(typeof p.note, 'string', 'D15: note เป็น string เสมอ');
    for (const l of p.lines) assert.deepEqual(Object.keys(l).sort(), ['itemId', 'name', 'qty']);
  }
  const sumP = s.byPerson.reduce((a, p) => a + p.total, 0);
  const sumI = s.byItem.reduce((a, i) => a + i.amount, 0);
  assert.equal(sumP, s.grandTotal, 'F7: ผลรวม byPerson.total = grandTotal');
  assert.equal(sumI, s.grandTotal, 'F7: ผลรวม byItem.amount = grandTotal');
  assert.equal(s.orderCount, s.byPerson.length, 'orderCount = จำนวนคนที่สั่ง');
  for (let k = 1; k < s.byItem.length; k++) assert.ok(s.byItem[k - 1].qty >= s.byItem[k].qty, 'D16: เรียง qty มาก→น้อย');
}

/** model ของ QA: คำนวณสรุปเองจากรายการ order (ลำดับสั่งครั้งแรก) + เมนู */
function expectedSummary(items, orders) {
  const price = new Map(items.map((i) => [i.id, i]));
  const qty = new Map();
  const byPerson = orders.map((o) => {
    let total = 0;
    const lines = o.lines.map((l) => {
      qty.set(l.itemId, (qty.get(l.itemId) || 0) + l.qty);
      total += l.qty * price.get(l.itemId).price;
      return { itemId: l.itemId, name: price.get(l.itemId).name, qty: l.qty };
    });
    return { name: o.name, lines, note: o.note, total };
  });
  const byItem = items
    .map((it, pos) => ({ it, pos }))
    .filter(({ it }) => qty.has(it.id))
    .sort((a, b) => qty.get(b.it.id) - qty.get(a.it.id) || a.pos - b.pos)
    .map(({ it }) => ({ itemId: it.id, name: it.name, qty: qty.get(it.id), amount: qty.get(it.id) * it.price }));
  return { byItem, byPerson, grandTotal: byPerson.reduce((a, p) => a + p.total, 0), orderCount: byPerson.length };
}

const MENU = [
  { name: 'ข้าวมันไก่ต้ม', price: 50 },
  { name: 'ข้าวมันไก่ทอด', price: 55 },
  { name: 'ข้าวมันไก่รวม', price: 60 },
  { name: 'ไข่ต้ม', price: 10 },
  { name: 'น้ำซุป', price: 1 },
];

async function openRound(s, cutoffMs) {
  const r = await s.req('POST', '/api/rounds', { restaurant: 'ข้าวมันไก่ป้าแดง', cutoffAt: toBkkIso(cutoffMs), items: MENU });
  assert.equal(r.status, 201, r.text);
  return r.body;
}

function endOfTodayMs(nowMs) {
  return Date.parse(new Date(nowMs + OFFSET).toISOString().slice(0, 10) + 'T23:59:59+07:00');
}

// ---------------------------------------------------------------- ส่วน A: server จริง
test('A · server จริง: summary ตาม F7 / contract / D16', async (t) => {
  const nowMs = Date.now();
  if (endOfTodayMs(nowMs) - nowMs < 60000) { t.skip('ใกล้เที่ยงคืนเกินไป (D10)'); return; }
  const s = await startProcess();
  t.after(() => s.close());

  await t.test('404 NOT_FOUND ก่อนมีรอบ / id ไม่มีจริง / id แปลกๆ', async () => {
    assertNotFound(await s.req('GET', '/api/rounds/r_19990101/summary'));
    assertNotFound(await s.req('GET', `/api/rounds/${enc('ไม่มี รอบ')}/summary`));
    assertNotFound(await s.req('GET', '/api/rounds/R_20261005/summary'));
    assertNotFound(await s.req('GET', `/api/rounds/${enc("x' OR 1=1 --")}/summary`));
  });

  const cutoffMs = Math.ceil((Date.now() + 9000) / 1000) * 1000; // ปิดอีก ~9 วินาที
  const round = await openRound(s, cutoffMs);
  const [i1, i2, i3, i4, i5] = round.items.map((i) => i.id);
  const R = `/api/rounds/${round.id}/orders`;
  const S = `/api/rounds/${round.id}/summary`;

  await t.test('รอบว่าง → 200 ยอด 0 ไม่ error', async () => {
    const r = await s.req('GET', S);
    assert.equal(r.status, 200, r.text);
    assert.match(r.type, /application\/json/);
    assert.deepEqual(r.body, { byItem: [], byPerson: [], grandTotal: 0, orderCount: 0 });
  });

  await t.test('id อื่นในรูปแบบเดียวกันยังเป็น 404 (ไม่คืนรอบวันนี้ผิดใบ)', async () => {
    assertNotFound(await s.req('GET', '/api/rounds/r_20000101/summary'));
  });

  let snapshotBeforeClose;
  await t.test('หลายคน หลายเมนู: ค่าทุกช่องตรง model ของ QA', async () => {
    const put = async (name, lines, note) => {
      const r = await s.req('PUT', R, note === undefined ? { name, lines } : { name, lines, note });
      assert.equal(r.status, 200, r.text);
      return r.body;
    };
    await put('Hi', [{ itemId: i1, qty: 2 }], ' ไม่เอาหนัง ');
    await put('Bee', [{ itemId: i3, qty: 1 }, { itemId: i1, qty: 1 }]);
    await put('ต้น', [{ itemId: i2, qty: 3 }], null);
    await put('Gus', [{ itemId: i4, qty: 10 }, { itemId: i3, qty: 2 }], 'ไข่แยก');
    // Bee แทนที่ด้วยชื่อต่างตัวพิมพ์: ตำแหน่งต้องไม่เลื่อน (D16) แต่ name เป็นตัวพิมพ์ล่าสุด (D15)
    await put('  BEE ', [{ itemId: i2, qty: 1 }]);
    // Del สั่งแล้วยกเลิก → ไม่ถูกนับ
    await put('Del', [{ itemId: i5, qty: 10 }]);
    const d = await s.req('DELETE', `${R}/${enc(' dEL ')}`);
    assert.equal(d.status, 204, d.text);

    const r = await s.req('GET', S);
    assert.equal(r.status, 200, r.text);
    assertSummaryShape(r.body);
    const items = round.items;
    const exp = expectedSummary(items, [
      { name: 'Hi', lines: [{ itemId: i1, qty: 2 }], note: 'ไม่เอาหนัง' },
      { name: 'BEE', lines: [{ itemId: i2, qty: 1 }], note: '' },
      { name: 'ต้น', lines: [{ itemId: i2, qty: 3 }], note: '' },
      { name: 'Gus', lines: [{ itemId: i4, qty: 10 }, { itemId: i3, qty: 2 }], note: 'ไข่แยก' },
    ]);
    assert.deepEqual(r.body, exp);
    // ค่าที่คาดแบบเขียนมือ (กัน model ผิดเอง)
    assert.deepEqual(r.body.byItem.map((x) => [x.itemId, x.qty, x.amount]),
      [[i4, 10, 100], [i2, 4, 220], [i1, 2, 100], [i3, 2, 120]], 'D16: เท่ากัน (i1=i3=2) ตามลำดับเมนู · i5 ไม่ปรากฏ');
    assert.equal(r.body.grandTotal, 540);
    assert.equal(r.body.orderCount, 4);
    assert.deepEqual(r.body.byPerson.map((p) => p.name), ['Hi', 'BEE', 'ต้น', 'Gus']);
    // byPerson.total ตรงกับ total ของ Order ที่ BE ตอบ
    for (const p of r.body.byPerson) {
      const g = await s.req('GET', `${R}/${enc(p.name)}`);
      assert.equal(g.status, 200);
      assert.equal(g.body.total, p.total, `total ของ ${p.name} ต้องตรงกับ Order`);
    }
    snapshotBeforeClose = r.body;
  });

  await t.test('ยกเลิกแล้วสั่งใหม่ → นับ 1 ครั้ง', async () => {
    await s.req('PUT', R, { name: 'Zed', lines: [{ itemId: i5, qty: 1 }] });
    assert.equal((await s.req('DELETE', `${R}/zed`)).status, 204);
    await s.req('PUT', R, { name: 'ZED', lines: [{ itemId: i5, qty: 2 }] });
    const r = await s.req('GET', S);
    assertSummaryShape(r.body);
    assert.equal(r.body.byPerson.filter((p) => p.name.toLowerCase() === 'zed').length, 1);
    assert.deepEqual(r.body.byItem.find((x) => x.itemId === i5), { itemId: i5, name: 'น้ำซุป', qty: 2, amount: 2 });
    assert.equal((await s.req('DELETE', `${R}/zed`)).status, 204);
    assert.deepEqual((await s.req('GET', S)).body, snapshotBeforeClose);
  });

  await t.test('ส่งพร้อมกัน: ชื่อเดียวกันต่างตัวพิมพ์ 12 request → orderCount +1 · ยอดตรงกัน', async () => {
    const names = ['Kit', 'kit', ' KIT ', 'kIt', 'Kit ', ' kit', 'KIT', 'kiT', 'Kit', '  kit  ', 'KiT', 'kit'];
    const rs = await Promise.all(names.map((name, k) => s.req('PUT', R, { name, lines: [{ itemId: [i1, i2, i3][k % 3], qty: (k % 10) + 1 }] })));
    for (const r of rs) assert.equal(r.status, 200, r.text);
    const [sum, g] = await Promise.all([s.req('GET', S), s.req('GET', `${R}/kit`)]);
    assertSummaryShape(sum.body);
    assert.equal(sum.body.orderCount, 5);
    const kit = sum.body.byPerson.find((p) => p.name.trim().toLowerCase() === 'kit');
    assert.equal(kit.total, g.body.total);
    assert.equal(kit.lines.length, 1);
    assert.equal((await s.req('DELETE', `${R}/KIT`)).status, 204);
  });

  await t.test('summary กับ PUT พร้อมกัน → ไม่มี 500 และทุกคำตอบยอดตรงกันในตัว', async () => {
    const reqs = [];
    for (let k = 0; k < 20; k++) {
      reqs.push(s.req('PUT', R, { name: `p${k % 4}`, lines: [{ itemId: i4, qty: (k % 10) + 1 }] }));
      reqs.push(s.req('GET', S));
    }
    const rs = await Promise.all(reqs);
    for (const r of rs) assert.equal(r.status, 200, r.text);
    for (const r of rs.filter((x) => x.body && 'byItem' in x.body)) assertSummaryShape(r.body);
    for (let k = 0; k < 4; k++) assert.equal((await s.req('DELETE', `${R}/p${k}`)).status, 204);
    assert.deepEqual((await s.req('GET', S)).body, snapshotBeforeClose);
  });

  const wait = cutoffMs + 1000 - Date.now();
  if (wait > 0) await sleep(wait);

  await t.test('หลังปิดรับจริง 1 วินาที: ดูสรุปได้ 200 ค่าเดิม', async () => {
    const today = await s.req('GET', '/api/rounds/today');
    assert.equal(today.body.status, 'closed');
    const r = await s.req('GET', S);
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.body, snapshotBeforeClose);
    // PUT/DELETE ที่โดน 409 ต้องไม่เปลี่ยนสรุป
    assert.equal((await s.req('PUT', R, { name: 'Late', lines: [{ itemId: i1, qty: 1 }] })).status, 409);
    assert.equal((await s.req('DELETE', `${R}/Hi`)).status, 409);
    assert.deepEqual((await s.req('GET', S)).body, snapshotBeforeClose);
  });
});

// ---------------------------------------------------------------- ส่วน B: นาฬิกาจำลอง ±1 วินาที
test('B · นาฬิกาจำลอง: summary ก่อน/ตรง/หลังปิด 1 วินาที เหมือนกัน · order ที่ส่งหลังปิดไม่ถูกนับ', async () => {
  let fake = Date.parse('2026-10-05T10:00:00+07:00');
  const s = await startWithClock({ now: () => new Date(fake) });
  try {
    const cutoffMs = Date.parse('2026-10-05T11:00:00+07:00');
    const round = await openRound(s, cutoffMs);
    const R = `/api/rounds/${round.id}/orders`;
    const S = `/api/rounds/${round.id}/summary`;
    // สั่งพร้อมกัน created_at เท่ากัน → byPerson ต้องคงที่ตามลำดับที่ถูกบันทึก
    assert.equal((await s.req('PUT', R, { name: 'A', lines: [{ itemId: round.items[0].id, qty: 1 }] })).status, 200);
    assert.equal((await s.req('PUT', R, { name: 'B', lines: [{ itemId: round.items[1].id, qty: 1 }] })).status, 200);
    assert.equal((await s.req('PUT', R, { name: 'C', lines: [{ itemId: round.items[1].id, qty: 1 }] })).status, 200);
    fake = cutoffMs - 1000;
    assert.equal((await s.req('PUT', R, { name: 'a', lines: [{ itemId: round.items[2].id, qty: 3 }] })).status, 200);
    const before = (await s.req('GET', S)).body;
    assertSummaryShape(before);
    assert.deepEqual(before.byPerson.map((p) => p.name), ['a', 'B', 'C'], 'D16: แทนที่ไม่เลื่อน · created_at เท่ากันยังตามลำดับสั่ง');
    assert.deepEqual(before.byItem.map((x) => x.itemId), [round.items[2].id, round.items[1].id]);
    fake = cutoffMs;
    assert.equal((await s.req('PUT', R, { name: 'D', lines: [{ itemId: round.items[0].id, qty: 1 }] })).status, 409);
    const at = await s.req('GET', S);
    assert.equal(at.status, 200);
    assert.deepEqual(at.body, before);
    fake = cutoffMs + 1000;
    assert.deepEqual((await s.req('GET', S)).body, before);
    fake = cutoffMs + 6 * 3600 * 1000;
    assert.deepEqual((await s.req('GET', S)).body, before, 'ดูได้หลังปิดนานๆ');
  } finally { await s.close(); }
});

// ---------------------------------------------------------------- ส่วน C: สุ่มเทียบ model
test('C · สุ่ม 300 ครั้ง (สั่ง/แทนที่/ยกเลิก ชื่อต่างตัวพิมพ์) → summary = model ทุก 25 ครั้ง', async () => {
  const fake = Date.parse('2026-10-05T09:00:00+07:00');
  let tick = 0;
  const s = await startWithClock({ now: () => new Date(fake + tick) });
  try {
    const round = await openRound(s, Date.parse('2026-10-05T11:00:00+07:00'));
    const R = `/api/rounds/${round.id}/orders`;
    const S = `/api/rounds/${round.id}/summary`;
    let seed = 12345;
    const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    const people = ['Ann', 'Bo', 'Cy', 'ดาว', 'Eve', 'Fai', 'Gun', 'ฮิ'];
    const variants = (n) => [n, n.toLowerCase(), n.toUpperCase(), ` ${n} `][rnd(4)];
    const model = new Map(); // key → {name, lines, note} ; Map คงลำดับ insert = ลำดับสั่งครั้งแรก
    for (let step = 1; step <= 300; step++) {
      tick += rnd(3) * 1000;
      const who = people[rnd(people.length)];
      const key = who.toLowerCase();
      if (rnd(4) === 0) {
        const r = await s.req('DELETE', `${R}/${enc(variants(who))}`);
        assert.equal(r.status, model.has(key) ? 204 : 404, r.text);
        model.delete(key);
      } else {
        const ids = round.items.map((i) => i.id).sort(() => rnd(3) - 1);
        const lines = ids.slice(0, 1 + rnd(3)).map((itemId) => ({ itemId, qty: 1 + rnd(10) }));
        const name = variants(who);
        const note = rnd(2) ? `โน้ต${step}` : undefined;
        const r = await s.req('PUT', R, note === undefined ? { name, lines } : { name, lines, note });
        assert.equal(r.status, 200, r.text);
        const prev = model.get(key);
        const entry = { name: name.trim(), lines, note: note || '' };
        if (prev) Object.assign(prev, entry); else model.set(key, entry);
      }
      if (step % 25 === 0) {
        const r = await s.req('GET', S);
        assert.equal(r.status, 200);
        assertSummaryShape(r.body);
        assert.deepEqual(r.body, expectedSummary(round.items, [...model.values()]), `step ${step}`);
      }
    }
  } finally { await s.close(); }
});
