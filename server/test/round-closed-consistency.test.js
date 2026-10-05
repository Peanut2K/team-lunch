'use strict';

// BE-24 · Round.status / serverNow ต้องสอดคล้องกับกฎปิดรับของ PUT / DELETE ทุกครั้ง
const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');
const { createFakeClock } = require('../src/clock');

const CUTOFF = '2026-10-05T11:00:00+07:00';
const CUTOFF_MS = Date.parse(CUTOFF);
const ROUND = { restaurant: 'ข้าวมันไก่ป้าแดง', cutoffAt: CUTOFF, items: [{ name: 'ข้าวมันไก่ต้ม', price: 50 }] };
const base = '/api/rounds/r_20261005/orders';
const order = { name: 'Hi', lines: [{ itemId: 'i1', qty: 1 }] };

describe('status / serverNow สอดคล้องกับ ROUND_CLOSED (BE-24)', () => {
  let srv;
  let clock;
  beforeEach(async () => {
    clock = createFakeClock('2026-10-05T09:00:00+07:00');
    srv = await startServer({ now: clock.now });
    const created = await srv.request('POST', '/api/rounds', ROUND);
    assert.equal(created.body.status, 'open');
  });
  afterEach(() => srv.close());

  // จุดเวลารอบ cutoff — ทุกจุด: status=open ⇔ PUT 200 และ DELETE 204 · status=closed ⇔ PUT/DELETE 409
  const offsets = [-60_000, -1000, -1, 0, 1, 999, 1000, 60_000, 3_600_000];
  for (const off of offsets) {
    test(`cutoff ${off >= 0 ? '+' : ''}${off} ms`, async () => {
      clock.set(new Date(CUTOFF_MS + off));
      const round = (await srv.request('GET', '/api/rounds/today')).body;
      const expectOpen = off < 0;
      assert.equal(round.status, expectOpen ? 'open' : 'closed');
      // serverNow = เวลา server ตอนตอบ (ตัดเศษวินาที) รูปแบบ +07:00
      assert.match(round.serverNow, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+07:00$/);
      assert.equal(Date.parse(round.serverNow), Math.floor((CUTOFF_MS + off) / 1000) * 1000);

      const put = await srv.request('PUT', base, order);
      const del = await srv.request('DELETE', `${base}/Hi`);
      if (expectOpen) {
        assert.equal(put.status, 200);
        assert.equal(del.status, 204);
      } else {
        assert.equal(put.status, 409);
        assert.equal(put.body.error.code, 'ROUND_CLOSED');
        assert.equal(del.status, 409);
        assert.equal(del.body.error.code, 'ROUND_CLOSED');
      }
    });
  }

  test('serverNow ที่ FE เห็นยังก่อน cutoff → status open และส่งได้ (ไม่มีช่วงที่ขัดกัน)', async () => {
    clock.set('2026-10-05T10:59:59.999+07:00');
    const round = (await srv.request('GET', '/api/rounds/today')).body;
    assert.equal(round.serverNow, '2026-10-05T10:59:59+07:00');
    assert.equal(round.status, 'open');
    assert.equal((await srv.request('PUT', base, order)).status, 200);
  });
});
