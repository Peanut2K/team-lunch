'use strict';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');
const { createFakeClock } = require('../src/clock');

const ROUND = {
  restaurant: 'ข้าวมันไก่ป้าแดง',
  cutoffAt: '2026-10-05T11:00:00+07:00',
  items: [
    { name: 'ข้าวมันไก่ต้ม', price: 50 },  // i1
    { name: 'ข้าวมันไก่ทอด', price: 55 },  // i2
    { name: 'ข้าวมันไก่ผสม', price: 60 },  // i3
    { name: 'น้ำซุปเพิ่ม', price: 10 },     // i4 (ไม่มีใครสั่ง)
  ],
};
const RID = 'r_20261005';
const ORDERS = `/api/rounds/${RID}/orders`;
const SUMMARY = `/api/rounds/${RID}/summary`;

const sum = (xs, f) => xs.reduce((s, x) => s + f(x), 0);

/** ยอดทุกจุดต้องตรงกัน (PRD F7) */
function assertConsistent(s) {
  const personSum = sum(s.byPerson, (p) => p.total);
  const itemSum = sum(s.byItem, (i) => i.amount);
  assert.equal(personSum, s.grandTotal, 'ผลรวม byPerson.total = grandTotal');
  assert.equal(itemSum, s.grandTotal, 'ผลรวม byItem.amount = grandTotal');
  assert.equal(s.orderCount, s.byPerson.length);
  // จำนวนต่อเมนูใน byItem = ผลรวมจาก lines ของทุกคน
  for (const it of s.byItem) {
    const qty = sum(s.byPerson, (p) => sum(p.lines.filter((l) => l.itemId === it.itemId), (l) => l.qty));
    assert.equal(it.qty, qty, `qty ของ ${it.itemId}`);
  }
}

describe('GET /api/rounds/:id/summary (F7)', () => {
  let srv;
  let clock;
  const put = (body) => srv.request('PUT', ORDERS, body);
  const del = (name) => srv.request('DELETE', `${ORDERS}/${encodeURIComponent(name)}`);
  const summary = async () => {
    const res = await srv.request('GET', SUMMARY);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assertConsistent(res.body);
    return res.body;
  };

  beforeEach(async () => {
    clock = createFakeClock('2026-10-05T09:00:00+07:00');
    srv = await startServer({ now: clock.now });
    assert.equal((await srv.request('POST', '/api/rounds', ROUND)).status, 201);
  });
  afterEach(() => srv.close());

  test('รอบที่ยังไม่มีใครสั่ง → ยอด 0 ไม่ error', async () => {
    const s = await summary();
    assert.deepEqual(s, { byItem: [], byPerson: [], grandTotal: 0, orderCount: 0 });
  });

  test('ไม่มีรอบ → 404 NOT_FOUND (ไม่มี field)', async () => {
    const res = await srv.request('GET', '/api/rounds/r_19990101/summary');
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'NOT_FOUND');
    assert.deepEqual(Object.keys(res.body.error), ['code', 'message']);
  });

  test('รูปร่างตาม API contract + ยอดถูกต้อง', async () => {
    clock.set('2026-10-05T09:01:00+07:00');
    await put({ name: 'Hi', lines: [{ itemId: 'i1', qty: 2 }], note: 'ไม่เอาหนัง' });
    clock.set('2026-10-05T09:02:00+07:00');
    await put({ name: 'Bee', lines: [{ itemId: 'i2', qty: 1 }, { itemId: 'i1', qty: 1 }] });

    const s = await summary();
    assert.deepEqual(Object.keys(s), ['byItem', 'byPerson', 'grandTotal', 'orderCount']);
    assert.deepEqual(s.byItem, [
      { itemId: 'i1', name: 'ข้าวมันไก่ต้ม', qty: 3, amount: 150 },
      { itemId: 'i2', name: 'ข้าวมันไก่ทอด', qty: 1, amount: 55 },
    ]);
    assert.deepEqual(s.byPerson, [
      { name: 'Hi', lines: [{ itemId: 'i1', name: 'ข้าวมันไก่ต้ม', qty: 2 }], note: 'ไม่เอาหนัง', total: 100 },
      {
        name: 'Bee',
        lines: [{ itemId: 'i2', name: 'ข้าวมันไก่ทอด', qty: 1 }, { itemId: 'i1', name: 'ข้าวมันไก่ต้ม', qty: 1 }],
        note: '',
        total: 105,
      },
    ]);
    assert.equal(s.grandTotal, 205);
    assert.equal(s.orderCount, 2);
  });

  test('byPerson.total ตรงกับ total ที่ PUT ตอบ', async () => {
    const o = (await put({ name: 'Hi', lines: [{ itemId: 'i3', qty: 3 }, { itemId: 'i2', qty: 2 }] })).body;
    const s = await summary();
    assert.equal(s.byPerson[0].total, o.total);
  });

  test('byItem เรียงจำนวนมากไปน้อย · เท่ากันเรียงตามลำดับเมนู · ไม่แสดงเมนูที่ไม่มีคนสั่ง', async () => {
    await put({ name: 'A', lines: [{ itemId: 'i3', qty: 1 }, { itemId: 'i2', qty: 4 }] });
    await put({ name: 'B', lines: [{ itemId: 'i1', qty: 1 }] });
    const s = await summary();
    assert.deepEqual(s.byItem.map((i) => [i.itemId, i.qty]), [['i2', 4], ['i1', 1], ['i3', 1]]);
    assert.ok(!s.byItem.some((i) => i.itemId === 'i4'));
  });

  test('order ที่ถูกแทนที่ไม่ถูกนับซ้ำ (ชื่อเดิม D3 → นับแค่ order ล่าสุด)', async () => {
    await put({ name: 'Hi', lines: [{ itemId: 'i1', qty: 5 }], note: 'เดิม' });
    await put({ name: ' hi ', lines: [{ itemId: 'i2', qty: 1 }], note: 'ใหม่' });
    const s = await summary();
    assert.equal(s.orderCount, 1);
    assert.deepEqual(s.byPerson, [
      { name: 'hi', lines: [{ itemId: 'i2', name: 'ข้าวมันไก่ทอด', qty: 1 }], note: 'ใหม่', total: 55 },
    ]);
    assert.deepEqual(s.byItem, [{ itemId: 'i2', name: 'ข้าวมันไก่ทอด', qty: 1, amount: 55 }]);
    assert.equal(s.grandTotal, 55);
  });

  test('order ที่ยกเลิกไม่ถูกนับ', async () => {
    await put({ name: 'Hi', lines: [{ itemId: 'i1', qty: 2 }] });
    await put({ name: 'Bee', lines: [{ itemId: 'i3', qty: 1 }] });
    assert.equal((await del('HI')).status, 204);
    const s = await summary();
    assert.equal(s.orderCount, 1);
    assert.deepEqual(s.byPerson.map((p) => p.name), ['Bee']);
    assert.deepEqual(s.byItem, [{ itemId: 'i3', name: 'ข้าวมันไก่ผสม', qty: 1, amount: 60 }]);
    assert.equal(s.grandTotal, 60);
  });

  test('ยกเลิกทุกคน → กลับเป็นยอด 0', async () => {
    await put({ name: 'Hi', lines: [{ itemId: 'i1', qty: 2 }] });
    await del('Hi');
    const s = await summary();
    assert.deepEqual(s, { byItem: [], byPerson: [], grandTotal: 0, orderCount: 0 });
  });

  test('ดูได้หลังปิดรับ และยอดเท่าเดิม', async () => {
    await put({ name: 'Hi', lines: [{ itemId: 'i1', qty: 2 }] });
    const before = await summary();
    clock.set('2026-10-05T11:00:00+07:00');
    assert.equal((await put({ name: 'Late', lines: [{ itemId: 'i1', qty: 1 }] })).status, 409);
    const after = await summary();
    assert.deepEqual(after, before);
  });

  test('ยอดตรงกันทุกจุด — สุ่มสั่ง / แทนที่ / ยกเลิก หลายรอบ', async () => {
    let seed = 42;
    const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    const names = ['Hi', 'Bee', 'Aom', 'Ton', 'May', 'สมชาย'];
    const itemIds = ['i1', 'i2', 'i3', 'i4'];
    const expected = new Map(); // nameKey -> total ที่ PUT ตอบ
    for (let step = 0; step < 60; step++) {
      const name = names[rnd(names.length)];
      if (rnd(4) === 0) {
        await del(name);
        expected.delete(name.toLowerCase());
      } else {
        const pool = [...itemIds];
        const lines = [];
        const n = 1 + rnd(3);
        for (let k = 0; k < n; k++) lines.push({ itemId: pool.splice(rnd(pool.length), 1)[0], qty: 1 + rnd(10) });
        const res = await put({ name: rnd(2) ? name : ` ${name.toUpperCase()} `, lines });
        assert.equal(res.status, 200, JSON.stringify(res.body));
        expected.set(name.toLowerCase(), res.body.total);
      }
      const s = await summary(); // assertConsistent ทุกครั้ง
      assert.equal(s.orderCount, expected.size);
      assert.equal(s.grandTotal, sum([...expected.values()], (t) => t));
    }
  });
});
