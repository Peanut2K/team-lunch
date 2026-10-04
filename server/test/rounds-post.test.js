'use strict';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');
const { createFakeClock } = require('../src/clock');

// 5 ต.ค. 2026 09:00 เวลาไทย
const NOW = '2026-10-05T09:00:00+07:00';

const validBody = (over = {}) => ({
  restaurant: 'ข้าวมันไก่ป้าแดง',
  cutoffAt: '2026-10-05T11:00:00+07:00',
  items: [{ name: 'ข้าวมันไก่ต้ม', price: 50 }, { name: 'ข้าวมันไก่ทอด', price: 55 }],
  ...over,
});

/** 400 VALIDATION รูปแบบ { error: { code, field, message } } (D11) — ถ้าส่ง field มาจะเทียบ field ด้วย */
function assertValidationError(res, label, field) {
  assert.equal(res.status, 400, `${label}: status`);
  assert.equal(res.body.error.code, 'VALIDATION', `${label}: code`);
  assert.deepEqual(Object.keys(res.body.error), ['code', 'field', 'message'], `${label}: keys`);
  assert.ok(typeof res.body.error.message === 'string' && res.body.error.message.length > 0,
    `${label}: ต้องมี message`);
  if (field !== undefined) assert.equal(res.body.error.field, field, `${label}: field`);
}

describe('POST /api/rounds', () => {
  let srv;
  let clock;
  beforeEach(async () => {
    clock = createFakeClock(NOW);
    srv = await startServer({ now: clock.now });
  });
  afterEach(() => srv.close());

  test('201 คืน Round ครบตาม contract (status open, serverNow, item id)', async () => {
    const res = await srv.request('POST', '/api/rounds', validBody());
    assert.equal(res.status, 201);
    assert.deepEqual(res.body, {
      id: 'r_20261005',
      date: '2026-10-05',
      restaurant: 'ข้าวมันไก่ป้าแดง',
      cutoffAt: '2026-10-05T11:00:00+07:00',
      status: 'open',
      serverNow: '2026-10-05T09:00:00+07:00',
      items: [
        { id: 'i1', name: 'ข้าวมันไก่ต้ม', price: 50 },
        { id: 'i2', name: 'ข้าวมันไก่ทอด', price: 55 },
      ],
    });
  });

  test('cutoffAt ที่ส่งเป็น offset อื่นถูกแปลงเป็น +07:00 · ตัดช่องว่างชื่อร้าน/เมนู', async () => {
    const res = await srv.request('POST', '/api/rounds', validBody({
      restaurant: '  ป้าแดง  ',
      cutoffAt: '2026-10-05T04:00:00Z',
      items: [{ name: '  ข้าวมันไก่ต้ม ', price: 50 }],
    }));
    assert.equal(res.status, 201);
    assert.equal(res.body.restaurant, 'ป้าแดง');
    assert.equal(res.body.cutoffAt, '2026-10-05T11:00:00+07:00');
    assert.equal(res.body.items[0].name, 'ข้าวมันไก่ต้ม');
  });

  test('เมนู 1 รายการ และ 30 รายการ ผ่าน', async () => {
    const one = await srv.request('POST', '/api/rounds', validBody({ items: [{ name: 'a', price: 1 }] }));
    assert.equal(one.status, 201);
    clock.set('2026-10-06T09:00:00+07:00');
    const thirty = Array.from({ length: 30 }, (_, i) => ({ name: `เมนู ${i + 1}`, price: 40 + i }));
    const res = await srv.request('POST', '/api/rounds',
      validBody({ cutoffAt: '2026-10-06T11:00:00+07:00', items: thirty }));
    assert.equal(res.status, 201);
    assert.equal(res.body.items.length, 30);
    assert.equal(res.body.items[29].id, 'i30');
  });

  test('D8 ราคาขอบ 1 และ 10,000 ผ่าน', async () => {
    const res = await srv.request('POST', '/api/rounds',
      validBody({ items: [{ name: 'a', price: 1 }, { name: 'b', price: 10000 }] }));
    assert.equal(res.status, 201);
    assert.deepEqual(res.body.items.map((i) => i.price), [1, 10000]);
  });

  test('D8 ชื่อร้าน/ชื่อเมนูยาว 60 code point พอดีผ่าน (นับ code point ไม่ใช่ UTF-16, ไม่นับช่องว่างหัวท้าย)', async () => {
    const thai60 = 'ข้า'.repeat(20); // 60 code point (ข + ้ + า)
    const emoji60 = '🍚'.repeat(60); // 60 code point แต่ String#length = 120
    assert.equal(emoji60.length, 120);
    const res = await srv.request('POST', '/api/rounds', validBody({
      restaurant: `   ${thai60}   `,
      items: [{ name: emoji60, price: 50 }, { name: 'ก', price: 10 }],
    }));
    assert.equal(res.status, 201);
    assert.equal(res.body.restaurant, thai60);
    assert.equal(res.body.items[0].name, emoji60);
  });

  test('QA: ราคาเกิน safe integer → 400 แล้ว GET today และเปิดรอบปกติยังใช้ได้ (DB ไม่เสีย)', async () => {
    const bad = await srv.request('POST', '/api/rounds',
      validBody({ items: [{ name: 'ข้าว', price: 9007199254740992 }] }));
    assertValidationError(bad, 'price 2^53', 'items[0].price');
    assert.equal(bad.body.error.message, 'ราคาเมนู "ข้าว" ต้องเป็นจำนวนเต็ม 1–10,000 บาท');
    assert.equal(srv.roundCount(), 0);
    const today = await srv.request('GET', '/api/rounds/today');
    assert.equal(today.status, 404);
    assert.equal(today.body.error.code, 'NO_ROUND');
    const ok = await srv.request('POST', '/api/rounds', validBody());
    assert.equal(ok.status, 201);
    assert.equal((await srv.request('GET', '/api/rounds/today')).status, 200);
  });

  describe('400 VALIDATION', () => {
    // [label, body, field ที่ต้องได้ (D11)]
    const cases = [
      ['body เป็น array', [], null],
      ['ไม่มี restaurant', validBody({ restaurant: undefined }), 'restaurant'],
      ['restaurant ว่าง', validBody({ restaurant: '' }), 'restaurant'],
      ['restaurant มีแต่ช่องว่าง', validBody({ restaurant: '   ' }), 'restaurant'],
      ['restaurant ไม่ใช่ string', validBody({ restaurant: 123 }), 'restaurant'],
      // D8 · restaurant 1–60 code point หลังตัดช่องว่าง
      ['restaurant 61 ตัวอักษร', validBody({ restaurant: 'ก'.repeat(61) }), 'restaurant'],
      ['restaurant 61 code point (อีโมจิ)', validBody({ restaurant: '🍚'.repeat(61) }), 'restaurant'],
      ['ไม่มี cutoffAt', validBody({ cutoffAt: undefined }), 'cutoffAt'],
      ['cutoffAt ไม่ใช่ ISO', validBody({ cutoffAt: '11:00' }), 'cutoffAt'],
      ['cutoffAt ไม่มี offset', validBody({ cutoffAt: '2026-10-05T11:00:00' }), 'cutoffAt'],
      ['cutoffAt เป็นตัวเลข', validBody({ cutoffAt: 1759636800000 }), 'cutoffAt'],
      ['cutoffAt วันที่ไม่มีจริง', validBody({ cutoffAt: '2026-02-31T11:00:00+07:00' }), 'cutoffAt'],
      ['cutoffAt ในอดีต', validBody({ cutoffAt: '2026-10-05T08:59:59+07:00' }), 'cutoffAt'],
      ['cutoffAt เท่ากับตอนนี้พอดี', validBody({ cutoffAt: NOW }), 'cutoffAt'],
      ['ไม่มี items', validBody({ items: undefined }), 'items'],
      ['items ไม่ใช่ array', validBody({ items: { name: 'a', price: 1 } }), 'items'],
      ['items ว่าง (0 รายการ)', validBody({ items: [] }), 'items'],
      ['items 31 รายการ', validBody({ items: Array.from({ length: 31 }, (_, i) => ({ name: `m${i}`, price: 10 })) }), 'items'],
      ['item ไม่ใช่ object', validBody({ items: ['ข้าวมันไก่'] }), 'items[0]'],
      ['item ไม่มีชื่อ', validBody({ items: [{ price: 50 }] }), 'items[0].name'],
      ['item ชื่อมีแต่ช่องว่าง', validBody({ items: [{ name: '  ', price: 50 }] }), 'items[0].name'],
      // D8 · ชื่อเมนู 1–60 code point หลังตัดช่องว่าง
      ['ชื่อเมนู 61 ตัวอักษร', validBody({ items: [{ name: 'ข้า'.repeat(20) + 'ว', price: 50 }] }), 'items[0].name'],
      ['ชื่อเมนูรายการที่ 2 ยาวเกิน', validBody({ items: [{ name: 'a', price: 1 }, { name: 'x'.repeat(61), price: 1 }] }), 'items[1].name'],
      ['ชื่อเมนูไม่ใช่ string', validBody({ items: [{ name: 5, price: 50 }] }), 'items[0].name'],
      ['ราคา 0', validBody({ items: [{ name: 'a', price: 0 }] }), 'items[0].price'],
      ['ราคาติดลบ', validBody({ items: [{ name: 'a', price: -5 }] }), 'items[0].price'],
      ['ราคาทศนิยม', validBody({ items: [{ name: 'a', price: 50.5 }] }), 'items[0].price'],
      ['ราคาเป็น string', validBody({ items: [{ name: 'a', price: '50' }] }), 'items[0].price'],
      ['ไม่มีราคา', validBody({ items: [{ name: 'a' }] }), 'items[0].price'],
      // D8 · ราคา 1–10,000 (QA: ราคาเกิน safe integer เคยทำ DB เสีย)
      ['ราคา 10,001', validBody({ items: [{ name: 'a', price: 10001 }] }), 'items[0].price'],
      ['ราคาเกิน safe integer (2^53)', validBody({ items: [{ name: 'a', price: 2 ** 53 }] }), 'items[0].price'],
      ['ราคา 1e20', validBody({ items: [{ name: 'a', price: 1e20 }] }), 'items[0].price'],
      ['ราคา 1e308', validBody({ items: [{ name: 'a', price: 1e308 }] }), 'items[0].price'],
      ['รายการที่ 2 ผิด', validBody({ items: [{ name: 'a', price: 10 }, { name: 'b', price: 0 }] }), 'items[1].price'],
      ['รายการที่ 3 ผิด (ตัวอย่าง items[2].price ใน contract)',
        validBody({ items: [{ name: 'a', price: 10 }, { name: 'b', price: 20 }, { name: 'c', price: null }] }),
        'items[2].price'],
    ];
    for (const [label, body, field] of cases) {
      test(label, async () => {
        const res = await srv.request('POST', '/api/rounds', body);
        assertValidationError(res, label, field);
        assert.equal(srv.roundCount(), 0, `${label}: ไม่ควรสร้างรอบ`);
      });
    }

    test('body ไม่ใช่ JSON', async () => {
      assertValidationError(await srv.request('POST', '/api/rounds', 'not json'), 'not json', null);
    });

    test('message เป็นภาษาไทยที่แสดงได้ตรงๆ', async () => {
      const res = await srv.request('POST', '/api/rounds', validBody({ cutoffAt: '2026-10-05T08:00:00+07:00' }));
      assert.equal(res.body.error.message, 'เวลาปิดรับต้องอยู่ในอนาคต');
    });
  });

  describe('409 ROUND_EXISTS', () => {
    test('เปิดรอบซ้ำในวันเดียวกัน → 409 และรอบเดิมไม่เปลี่ยน', async () => {
      assert.equal((await srv.request('POST', '/api/rounds', validBody())).status, 201);
      clock.advance(60 * 60 * 1000); // 10:00 วันเดียวกัน
      const res = await srv.request('POST', '/api/rounds',
        validBody({ restaurant: 'ร้านอื่น', items: [{ name: 'x', price: 10 }] }));
      assert.equal(res.status, 409);
      assert.equal(res.body.error.code, 'ROUND_EXISTS');
      assert.ok(res.body.error.message.length > 0);
      assert.deepEqual(Object.keys(res.body.error), ['code', 'message'], 'error อื่นไม่มี field (D11)');
      assert.equal(srv.roundCount(), 1);
      const row = srv.db.prepare('SELECT restaurant FROM rounds').get();
      assert.equal(row.restaurant, 'ข้าวมันไก่ป้าแดง');
    });

    test('ซ้ำได้ 409 แม้หลังปิดรับของวันนั้นแล้ว', async () => {
      await srv.request('POST', '/api/rounds', validBody());
      clock.set('2026-10-05T12:00:00+07:00');
      const res = await srv.request('POST', '/api/rounds', validBody({ cutoffAt: '2026-10-05T13:00:00+07:00' }));
      assert.equal(res.status, 409);
      assert.equal(res.body.error.code, 'ROUND_EXISTS');
    });

    test('ยิงพร้อมกัน 5 request → สำเร็จ 1 ที่เหลือ 409', async () => {
      const results = await Promise.all(
        Array.from({ length: 5 }, () => srv.request('POST', '/api/rounds', validBody())));
      const statuses = results.map((r) => r.status).sort();
      assert.deepEqual(statuses, [201, 409, 409, 409, 409]);
      assert.equal(srv.roundCount(), 1);
    });

    test('วันถัดไป (ตามเวลาไทย) เปิดรอบใหม่ได้', async () => {
      await srv.request('POST', '/api/rounds', validBody());
      clock.set('2026-10-06T00:00:00+07:00'); // = 2026-10-05T17:00Z ยังเป็นวันที่ 5 ใน UTC
      const res = await srv.request('POST', '/api/rounds', validBody({ cutoffAt: '2026-10-06T11:00:00+07:00' }));
      assert.equal(res.status, 201);
      assert.equal(res.body.id, 'r_20261006');
      assert.equal(res.body.date, '2026-10-06');
    });
  });
});
