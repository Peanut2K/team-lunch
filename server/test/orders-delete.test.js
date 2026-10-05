'use strict';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');
const { createFakeClock } = require('../src/clock');

const ROUND = {
  restaurant: 'ข้าวมันไก่ป้าแดง',
  cutoffAt: '2026-10-05T11:00:00+07:00',
  items: [{ name: 'ข้าวมันไก่ต้ม', price: 50 }, { name: 'ข้าวมันไก่ทอด', price: 60 }],
};
const RID = 'r_20261005';
const base = `/api/rounds/${RID}/orders`;
const at = (name) => `${base}/${encodeURIComponent(name)}`;
const order = { name: 'Hi', lines: [{ itemId: 'i1', qty: 2 }] };

const orderCount = (srv) => srv.db.prepare('SELECT COUNT(*) AS n FROM orders').get().n;

describe('DELETE /api/rounds/:id/orders/:name', () => {
  let srv;
  beforeEach(async () => {
    const clock = createFakeClock('2026-10-05T09:00:00+07:00');
    srv = await startServer({ now: clock.now });
    await srv.request('POST', '/api/rounds', ROUND);
  });
  afterEach(() => srv.close());

  test('ยกเลิก → 204 ไม่มี body · GET ต่อ → 404', async () => {
    await srv.request('PUT', base, order);
    const res = await srv.request('DELETE', at('Hi'));
    assert.equal(res.status, 204);
    assert.equal(res.text, '');
    assert.equal(orderCount(srv), 0);
    assert.equal((await srv.request('GET', at('Hi'))).status, 404);
  });

  test('ชื่อไม่สนตัวพิมพ์และช่องว่างหัวท้าย (D3)', async () => {
    await srv.request('PUT', base, order);
    assert.equal((await srv.request('DELETE', at('  hI '))).status, 204);
    assert.equal(orderCount(srv), 0);
  });

  test('ชื่อภาษาไทยมีช่องว่างกลาง (URL-encode)', async () => {
    await srv.request('PUT', base, { ...order, name: 'สมชาย ใจดี' });
    assert.equal((await srv.request('DELETE', at('สมชาย ใจดี'))).status, 204);
  });

  test('ยกเลิกของคนหนึ่ง ไม่กระทบคนอื่น', async () => {
    await srv.request('PUT', base, order);
    await srv.request('PUT', base, { ...order, name: 'Bee' });
    await srv.request('DELETE', at('Hi'));
    assert.equal((await srv.request('GET', at('Bee'))).status, 200);
  });

  test('ยกเลิกแล้วสั่งใหม่ได้ (order ใหม่ id ใหม่)', async () => {
    const first = (await srv.request('PUT', base, order)).body;
    await srv.request('DELETE', at('Hi'));
    const again = await srv.request('PUT', base, { name: 'hi', lines: [{ itemId: 'i2', qty: 1 }] });
    assert.equal(again.status, 200);
    assert.notEqual(again.body.id, first.id);
    assert.deepEqual(again.body.lines, [{ itemId: 'i2', qty: 1 }]);
    assert.equal(again.body.total, 60);
    const got = await srv.request('GET', at('Hi'));
    assert.deepEqual(got.body, again.body);
    assert.equal(orderCount(srv), 1);
  });

  test('ชื่อนี้ไม่มี order → 404 NOT_FOUND · ยกเลิกซ้ำ → 404', async () => {
    let res = await srv.request('DELETE', at('Nobody'));
    assert.equal(res.status, 404);
    assert.deepEqual(Object.keys(res.body.error), ['code', 'message']);
    assert.equal(res.body.error.code, 'NOT_FOUND');

    await srv.request('PUT', base, order);
    await srv.request('DELETE', at('Hi'));
    res = await srv.request('DELETE', at('Hi'));
    assert.equal(res.status, 404);
  });

  describe('VALIDATION ของชื่อใน path → 400 field "name" (D9, D11)', () => {
    for (const [title, path] of [
      ['ช่องว่างล้วน', at('   ')],
      ['ยาว 41 code point', at('ก'.repeat(41))],
      ['percent-encoding พัง', `${base}/%E0%B8`],
    ]) {
      test(title, async () => {
        const res = await srv.request('DELETE', path);
        assert.equal(res.status, 400, JSON.stringify(res.body));
        assert.equal(res.body.error.code, 'VALIDATION');
        assert.equal(res.body.error.field, 'name');
      });
    }

    test('ชื่อ 40 code point ผ่าน validation (ไม่มี order → 404)', async () => {
      const res = await srv.request('DELETE', at('ข้'.repeat(20)));
      assert.equal(res.status, 404);
    });
  });

  test('ไม่มีรอบ → 404 NOT_FOUND มาก่อน VALIDATION (D9)', async () => {
    let res = await srv.request('DELETE', `/api/rounds/r_19990101/orders/${encodeURIComponent('Hi')}`);
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'NOT_FOUND');
    res = await srv.request('DELETE', `/api/rounds/r_19990101/orders/${encodeURIComponent('ก'.repeat(41))}`);
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'NOT_FOUND');
  });
});
