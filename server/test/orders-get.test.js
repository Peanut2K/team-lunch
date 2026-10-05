'use strict';

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

function assertNotFound(res) {
  assert.equal(res.status, 404, JSON.stringify(res.body));
  assert.equal(res.body.error.code, 'NOT_FOUND');
  assert.deepEqual(Object.keys(res.body.error), ['code', 'message'], 'NOT_FOUND ไม่มี field (D11)');
}

describe('GET /api/rounds/:id/orders/:name (D12)', () => {
  let srv;
  let clock;
  let created;
  beforeEach(async () => {
    clock = createFakeClock('2026-10-05T09:00:00+07:00');
    srv = await startServer({ now: clock.now });
    await srv.request('POST', '/api/rounds', ROUND);
    created = (await srv.request('PUT', base, { name: 'สมชาย Hi', lines: [{ itemId: 'i1', qty: 2 }], note: 'ไม่เอาหนัง' })).body;
  });
  afterEach(() => srv.close());

  test('มี order → 200 Order เดียวกับที่ PUT ตอบ', async () => {
    const res = await srv.request('GET', at('สมชาย Hi'));
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, created);
  });

  test('ชื่อไม่สนตัวพิมพ์และช่องว่างหัวท้าย (D3)', async () => {
    const res = await srv.request('GET', at('  สมชาย HI '));
    assert.equal(res.status, 200);
    assert.equal(res.body.id, created.id);
  });

  test('ดูได้หลังปิดรับ', async () => {
    clock.set('2026-10-05T11:30:00+07:00');
    const res = await srv.request('GET', at('สมชาย Hi'));
    assert.equal(res.status, 200);
    assert.equal(res.body.id, created.id);
  });

  test('ชื่อนี้ยังไม่ได้สั่ง → 404 NOT_FOUND', async () => {
    assertNotFound(await srv.request('GET', at('Bee')));
  });

  test('ไม่มีรอบ → 404 NOT_FOUND', async () => {
    assertNotFound(await srv.request('GET', `/api/rounds/r_19990101/orders/${encodeURIComponent('สมชาย Hi')}`));
  });

  test('ชื่อผิดรูปแบบใน path (ช่องว่างล้วน, > 40, encode พัง) → 404 NOT_FOUND ไม่ใช่ VALIDATION', async () => {
    assertNotFound(await srv.request('GET', at('   ')));
    assertNotFound(await srv.request('GET', at('ก'.repeat(41))));
    assertNotFound(await srv.request('GET', `${base}/%E0%B8`));
  });
});
