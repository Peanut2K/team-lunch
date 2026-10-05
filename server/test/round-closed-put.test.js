'use strict';

// BE-24 · F6 / D2 — PUT order หลัง cutoff ตามเวลา server → 409 ROUND_CLOSED
const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');
const { createFakeClock } = require('../src/clock');

const ROUND = {
  restaurant: 'ข้าวมันไก่ป้าแดง',
  cutoffAt: '2026-10-05T11:00:00+07:00',
  items: [{ name: 'ข้าวมันไก่ต้ม', price: 50 }],
};
const RID = 'r_20261005';
const base = `/api/rounds/${RID}/orders`;
const at = (name) => `${base}/${encodeURIComponent(name)}`;
const order = { name: 'Hi', lines: [{ itemId: 'i1', qty: 2 }] };
const orderCount = (srv) => srv.db.prepare('SELECT COUNT(*) AS n FROM orders').get().n;

function assertClosed(res) {
  assert.equal(res.status, 409);
  assert.deepEqual(Object.keys(res.body.error).sort(), ['code', 'message']); // ไม่มี field (D11)
  assert.equal(res.body.error.code, 'ROUND_CLOSED');
  assert.match(res.body.error.message, /11:00/); // บอกเวลาที่ปิด
}

describe('PUT order — ปิดรับตามเวลา server (BE-24)', () => {
  let srv;
  let clock;
  beforeEach(async () => {
    clock = createFakeClock('2026-10-05T09:00:00+07:00');
    srv = await startServer({ now: clock.now });
    await srv.request('POST', '/api/rounds', ROUND);
  });
  afterEach(() => srv.close());

  test('ก่อนปิด 1 วินาที → 200 สั่งสำเร็จ', async () => {
    clock.set('2026-10-05T10:59:59+07:00');
    const res = await srv.request('PUT', base, order);
    assert.equal(res.status, 200);
    assert.equal(orderCount(srv), 1);
  });

  test('ก่อนปิด 1 ms → ยังสั่งได้', async () => {
    clock.set(new Date(Date.parse('2026-10-05T11:00:00+07:00') - 1));
    assert.equal((await srv.request('PUT', base, order)).status, 200);
  });

  test('ตรงเวลาปิดพอดี → 409 ROUND_CLOSED ("เมื่อถึงเวลาปิดรับ" F6)', async () => {
    clock.set('2026-10-05T11:00:00+07:00');
    assertClosed(await srv.request('PUT', base, order));
    assert.equal(orderCount(srv), 0);
  });

  test('หลังปิด 1 วินาที → 409 ROUND_CLOSED ไม่สร้าง order', async () => {
    clock.set('2026-10-05T11:00:01+07:00');
    assertClosed(await srv.request('PUT', base, order));
    assert.equal(orderCount(srv), 0);
  });

  test('แก้ order หลังปิด → 409 และ order เดิมไม่เปลี่ยน', async () => {
    clock.set('2026-10-05T10:30:00+07:00');
    const before = (await srv.request('PUT', base, order)).body;
    clock.set('2026-10-05T11:00:01+07:00');
    assertClosed(await srv.request('PUT', base, { name: ' hi ', lines: [{ itemId: 'i1', qty: 5 }], note: 'x' }));
    const after = await srv.request('GET', at('Hi'));
    assert.equal(after.status, 200); // GET ยังดูได้หลังปิด (D12)
    assert.deepEqual(after.body, before);
  });

  test('message เป็นเวลาไทยของ cutoff จริง (ไม่ใช่ 11:00 ตายตัว)', async () => {
    const clock2 = createFakeClock('2026-10-06T09:00:00+07:00');
    const srv2 = await startServer({ now: clock2.now });
    try {
      await srv2.request('POST', '/api/rounds', { ...ROUND, cutoffAt: '2026-10-06T04:15:00Z' });
      clock2.set('2026-10-06T11:15:00+07:00');
      const res = await srv2.request('PUT', '/api/rounds/r_20261006/orders', order);
      assert.equal(res.status, 409);
      assert.equal(res.body.error.message, 'ปิดรับ order แล้วเมื่อ 11:15');
    } finally {
      await srv2.close();
    }
  });

  describe('ลำดับ error (D9): NOT_FOUND → VALIDATION → ROUND_CLOSED', () => {
    beforeEach(() => clock.set('2026-10-05T12:00:00+07:00'));

    test('รอบที่ไม่มี → 404 (ไม่ใช่ 409)', async () => {
      const res = await srv.request('PUT', '/api/rounds/r_20990101/orders', order);
      assert.equal(res.status, 404);
      assert.equal(res.body.error.code, 'NOT_FOUND');
    });

    test('ปิดแล้ว + body ผิด → 400 VALIDATION ก่อน 409', async () => {
      const res = await srv.request('PUT', base, { name: '', lines: [] });
      assert.equal(res.status, 400);
      assert.equal(res.body.error.field, 'name');
    });

    test('ปิดแล้ว + body ไม่ใช่ JSON → 400 field null ก่อน 409', async () => {
      const res = await srv.request('PUT', base, '{bad');
      assert.equal(res.status, 400);
      assert.equal(res.body.error.field, null);
    });

    test('ปิดแล้ว + body ถูก → 409', async () => {
      assertClosed(await srv.request('PUT', base, order));
    });
  });
});
