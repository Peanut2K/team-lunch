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
const URL = `/api/rounds/${RID}/orders`;
const ok = { name: 'Hi', lines: [{ itemId: 'i1', qty: 2 }], note: 'ไม่เอาหนัง' };

const orderCount = (srv) => srv.db.prepare('SELECT COUNT(*) AS n FROM orders').get().n;

function assertValidation(res, field) {
  assert.equal(res.status, 400, JSON.stringify(res.body));
  assert.equal(res.body.error.code, 'VALIDATION');
  assert.equal(res.body.error.field, field);
  assert.deepEqual(Object.keys(res.body.error), ['code', 'field', 'message']);
  assert.ok(res.body.error.message.length > 0);
}

describe('PUT /api/rounds/:id/orders', () => {
  let srv;
  let clock;
  beforeEach(async () => {
    clock = createFakeClock('2026-10-05T09:00:00+07:00');
    srv = await startServer({ now: clock.now });
    const r = await srv.request('POST', '/api/rounds', ROUND);
    assert.equal(r.status, 201);
  });
  afterEach(() => srv.close());

  test('สั่งใหม่ → 200 Order ตาม contract · total คำนวณที่ BE', async () => {
    clock.set('2026-10-05T10:40:02+07:00');
    const res = await srv.request('PUT', URL, {
      name: '  Hi ', lines: [{ itemId: 'i1', qty: 2 }, { itemId: 'i2', qty: 1 }], note: ' ไม่เอาหนัง ',
    });
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.body), ['id', 'roundId', 'name', 'lines', 'note', 'total', 'updatedAt']);
    assert.match(res.body.id, /^o_[0-9a-f]{8}$/);
    assert.equal(res.body.roundId, RID);
    assert.equal(res.body.name, 'Hi');
    assert.deepEqual(res.body.lines, [{ itemId: 'i1', qty: 2 }, { itemId: 'i2', qty: 1 }]);
    assert.equal(res.body.note, 'ไม่เอาหนัง');
    assert.equal(res.body.total, 160);
    assert.equal(res.body.updatedAt, '2026-10-05T10:40:02+07:00');
  });

  test('total จาก client ถูกเมิน — ใช้ราคาในรอบเท่านั้น (D4)', async () => {
    const res = await srv.request('PUT', URL, { ...ok, total: 1 });
    assert.equal(res.body.total, 100);
  });

  test('"Hi" กับ " hi " = order เดียวกัน: แทนที่ ไม่เพิ่ม (D3)', async () => {
    const a = await srv.request('PUT', URL, ok);
    clock.advance(60_000);
    const b = await srv.request('PUT', URL, { name: ' hi ', lines: [{ itemId: 'i2', qty: 3 }] });
    assert.equal(b.status, 200);
    assert.equal(b.body.id, a.body.id, 'id เดิม');
    assert.equal(b.body.name, 'hi', 'ชื่อเป็นตามที่ส่งล่าสุด');
    assert.deepEqual(b.body.lines, [{ itemId: 'i2', qty: 3 }]);
    assert.equal(b.body.note, '', 'ไม่ส่ง note = ล้าง note เดิม (แทนที่ทั้งก้อน)');
    assert.equal(b.body.total, 180);
    assert.equal(b.body.updatedAt, '2026-10-05T09:01:00+07:00');
    assert.equal(orderCount(srv), 1);
  });

  test('ชื่อต่างกัน = คนละ order', async () => {
    await srv.request('PUT', URL, ok);
    await srv.request('PUT', URL, { ...ok, name: 'Bee' });
    assert.equal(orderCount(srv), 2);
  });

  test('note ไม่ส่ง / null → ""', async () => {
    let res = await srv.request('PUT', URL, { name: 'A', lines: [{ itemId: 'i1', qty: 1 }] });
    assert.equal(res.body.note, '');
    res = await srv.request('PUT', URL, { name: 'B', lines: [{ itemId: 'i1', qty: 1 }], note: null });
    assert.equal(res.body.note, '');
  });

  test('ขอบเขตที่ผ่าน: ชื่อ 40 code point (ภาษาไทย/emoji), qty 1 และ 10, note 100 code point', async () => {
    const name = 'ข้'.repeat(20); // 40 code point
    const note = '🍚'.repeat(100); // 100 code point (200 UTF-16 unit)
    const res = await srv.request('PUT', URL, { name, lines: [{ itemId: 'i1', qty: 1 }, { itemId: 'i2', qty: 10 }], note });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.total, 650);
  });

  describe('VALIDATION (field ตาม D11)', () => {
    const cases = [
      ['body ไม่ใช่ object', [1, 2], null],
      ['ไม่มี name', { lines: ok.lines }, 'name'],
      ['name ไม่ใช่ string', { ...ok, name: 5 }, 'name'],
      ['name ว่าง', { ...ok, name: '' }, 'name'],
      ['name มีแต่ช่องว่าง', { ...ok, name: '   ' }, 'name'],
      ['name 41 code point', { ...ok, name: 'ก'.repeat(41) }, 'name'],
      ['ไม่มี lines', { name: 'Hi' }, 'lines'],
      ['lines ไม่ใช่ array', { ...ok, lines: { itemId: 'i1', qty: 1 } }, 'lines'],
      ['lines ว่าง', { ...ok, lines: [] }, 'lines'],
      ['บรรทัดไม่ใช่ object', { ...ok, lines: [{ itemId: 'i1', qty: 1 }, 'i2'] }, 'lines[1]'],
      ['itemId ไม่มีในรอบ', { ...ok, lines: [{ itemId: 'i9', qty: 1 }] }, 'lines[0].itemId'],
      ['itemId ไม่ใช่ string', { ...ok, lines: [{ itemId: 1, qty: 1 }] }, 'lines[0].itemId'],
      ['ไม่มี itemId', { ...ok, lines: [{ qty: 1 }] }, 'lines[0].itemId'],
      ['itemId ซ้ำ', { ...ok, lines: [{ itemId: 'i1', qty: 1 }, { itemId: 'i2', qty: 1 }, { itemId: 'i1', qty: 2 }] }, 'lines[2].itemId'],
      ['qty 0', { ...ok, lines: [{ itemId: 'i1', qty: 0 }] }, 'lines[0].qty'],
      ['qty 11', { ...ok, lines: [{ itemId: 'i1', qty: 11 }] }, 'lines[0].qty'],
      ['qty ติดลบ', { ...ok, lines: [{ itemId: 'i1', qty: -1 }] }, 'lines[0].qty'],
      ['qty ทศนิยม', { ...ok, lines: [{ itemId: 'i1', qty: 1.5 }] }, 'lines[0].qty'],
      ['qty เป็น string', { ...ok, lines: [{ itemId: 'i1', qty: '2' }] }, 'lines[0].qty'],
      ['ไม่มี qty', { ...ok, lines: [{ itemId: 'i1' }] }, 'lines[0].qty'],
      ['note ไม่ใช่ string', { ...ok, note: 5 }, 'note'],
      ['note 101 code point', { ...ok, note: 'ก'.repeat(101) }, 'note'],
    ];
    for (const [title, body, field] of cases) {
      test(`${title} → 400 field ${field}`, async () => {
        const res = await srv.request('PUT', URL, body);
        assertValidation(res, field);
        assert.equal(orderCount(srv), 0, 'ไม่บันทึก order');
      });
    }

    test('body JSON พัง → field null', async () => {
      assertValidation(await srv.request('PUT', URL, '{"name": '), null);
    });

    test('ผิดหลายจุด → ตอบจุดแรกตามลำดับ field: name ก่อน lines ก่อน note', async () => {
      assertValidation(await srv.request('PUT', URL, { name: '', lines: [], note: 5 }), 'name');
      assertValidation(await srv.request('PUT', URL, { name: 'Hi', lines: [], note: 5 }), 'lines');
      assertValidation(await srv.request('PUT', URL, {
        name: 'Hi', lines: [{ itemId: 'i1', qty: 99 }, { itemId: 'zz', qty: 1 }], note: 5,
      }), 'lines[0].qty');
    });

    test('VALIDATION ไม่ทับ order เดิม', async () => {
      await srv.request('PUT', URL, ok);
      await srv.request('PUT', URL, { ...ok, lines: [{ itemId: 'i1', qty: 11 }] });
      const row = srv.db.prepare('SELECT total FROM orders').get();
      assert.equal(row.total, 100);
    });
  });

  describe('NOT_FOUND (ไม่มีรอบ) มาก่อน VALIDATION (D9)', () => {
    test('รอบไม่มี + body ถูก → 404 NOT_FOUND ไม่มี field', async () => {
      const res = await srv.request('PUT', '/api/rounds/r_19990101/orders', ok);
      assert.equal(res.status, 404);
      assert.deepEqual(Object.keys(res.body.error), ['code', 'message']);
      assert.equal(res.body.error.code, 'NOT_FOUND');
    });

    test('รอบไม่มี + body ผิด → 404', async () => {
      const res = await srv.request('PUT', '/api/rounds/r_19990101/orders', { name: '' });
      assert.equal(res.status, 404);
      assert.equal(res.body.error.code, 'NOT_FOUND');
    });

    test('รอบไม่มี + body ไม่ใช่ JSON → 404', async () => {
      const res = await srv.request('PUT', '/api/rounds/r_19990101/orders', 'not json');
      assert.equal(res.status, 404);
      assert.equal(res.body.error.code, 'NOT_FOUND');
    });
  });
});
