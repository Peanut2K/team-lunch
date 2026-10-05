'use strict';

// BE-24 · F5 / F6 / D2 — DELETE order หลัง cutoff ตามเวลา server → 409 ROUND_CLOSED
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
  assert.deepEqual(res.body, { error: { code: 'ROUND_CLOSED', message: 'ปิดรับ order แล้วเมื่อ 11:00' } });
}

describe('DELETE order — ปิดรับตามเวลา server (BE-24)', () => {
  let srv;
  let clock;
  beforeEach(async () => {
    clock = createFakeClock('2026-10-05T09:00:00+07:00');
    srv = await startServer({ now: clock.now });
    await srv.request('POST', '/api/rounds', ROUND);
    await srv.request('PUT', base, order);
  });
  afterEach(() => srv.close());

  test('ก่อนปิด 1 วินาที → 204 ยกเลิกได้', async () => {
    clock.set('2026-10-05T10:59:59+07:00');
    assert.equal((await srv.request('DELETE', at('Hi'))).status, 204);
    assert.equal(orderCount(srv), 0);
  });

  test('ตรงเวลาปิดพอดี → 409', async () => {
    clock.set('2026-10-05T11:00:00+07:00');
    assertClosed(await srv.request('DELETE', at('Hi')));
    assert.equal(orderCount(srv), 1);
  });

  test('หลังปิด 1 วินาที → 409 และ order ยังอยู่', async () => {
    clock.set('2026-10-05T11:00:01+07:00');
    assertClosed(await srv.request('DELETE', at(' hi ')));
    assert.equal(orderCount(srv), 1);
    assert.equal((await srv.request('GET', at('Hi'))).status, 200);
  });

  describe('ลำดับ error (D9): NOT_FOUND (รอบ) → VALIDATION → ROUND_CLOSED → NOT_FOUND (order)', () => {
    beforeEach(() => clock.set('2026-10-05T12:00:00+07:00'));

    test('รอบที่ไม่มี → 404', async () => {
      const res = await srv.request('DELETE', `/api/rounds/r_20990101/orders/Hi`);
      assert.equal(res.status, 404);
      assert.equal(res.body.error.code, 'NOT_FOUND');
    });

    test('ชื่อผิดรูปแบบ → 400 field name ก่อน 409 (ช่องว่างล้วน, เกิน 40, encode พัง)', async () => {
      for (const p of [`${base}/%20%20`, at('a'.repeat(41)), `${base}/%E0%A4`]) {
        const res = await srv.request('DELETE', p);
        assert.equal(res.status, 400, p);
        assert.equal(res.body.error.code, 'VALIDATION');
        assert.equal(res.body.error.field, 'name');
      }
    });

    test('ชื่อที่ไม่มี order + ปิดแล้ว → 409 (ไม่ใช่ 404)', async () => {
      assertClosed(await srv.request('DELETE', at('Nobody')));
    });
  });
});
