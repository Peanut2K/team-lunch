'use strict';

// BE-24 · F4 กรณีส่งพร้อมกัน — ชื่อเดียวกันหลาย request พร้อมกันต้องเหลือ order เดียว
// (UNIQUE(round_id, name_key) + upsert ใน BEGIN IMMEDIATE)
// summary (BE-23) ยังไม่มีใน main จึงนับจากตาราง orders / order_lines ที่ summary อ่าน
const { describe, test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer } = require('./helpers');
const { createFakeClock } = require('../src/clock');

const ROUND = {
  restaurant: 'ข้าวมันไก่ป้าแดง',
  cutoffAt: '2026-10-05T11:00:00+07:00',
  items: [{ name: 'ข้าวมันไก่ต้ม', price: 50 }, { name: 'ข้าวมันไก่ทอด', price: 60 }],
};
const base = '/api/rounds/r_20261005/orders';
const count = (srv, table) => srv.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

async function setup(opts = {}) {
  const clock = createFakeClock('2026-10-05T10:00:00+07:00');
  const srv = await startServer({ now: clock.now, ...opts });
  await srv.request('POST', '/api/rounds', ROUND);
  return { srv, clock };
}

describe('ส่งพร้อมกัน (BE-24)', () => {
  let srv;
  let tmp;
  afterEach(async () => {
    if (srv) await srv.close();
    srv = null;
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    tmp = null;
  });

  test('PUT ชื่อเดียวกัน 10 request พร้อมกัน → order เดียว id เดียว', async () => {
    ({ srv } = await setup());
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) =>
      srv.request('PUT', base, { name: 'Hi', lines: [{ itemId: 'i1', qty: i + 1 }] })));
    for (const r of results) assert.equal(r.status, 200);
    assert.equal(new Set(results.map((r) => r.body.id)).size, 1);
    assert.equal(count(srv, 'orders'), 1);
    assert.equal(count(srv, 'order_lines'), 1); // lines ไม่ถูกต่อกัน
    // order ที่เหลือเป็นของ request ใด request หนึ่งทั้งก้อน (qty กับ total ตรงกัน)
    const final = (await srv.request('GET', `${base}/Hi`)).body;
    assert.equal(final.total, final.lines[0].qty * 50);
  });

  test('ชื่อเดียวกันต่างตัวพิมพ์ / ช่องว่าง 10 request พร้อมกัน → order เดียว (D3)', async () => {
    ({ srv } = await setup());
    const names = ['Hi', 'hi', 'HI', ' hi ', 'hI', 'Hi ', ' HI', 'hi', 'Hi', 'HI'];
    const results = await Promise.all(names.map((name) =>
      srv.request('PUT', base, { name, lines: [{ itemId: 'i2', qty: 1 }, { itemId: 'i1', qty: 2 }] })));
    for (const r of results) assert.equal(r.status, 200);
    assert.equal(new Set(results.map((r) => r.body.id)).size, 1);
    assert.equal(count(srv, 'orders'), 1);
    assert.equal(count(srv, 'order_lines'), 2);
  });

  test('10 ชื่อต่างกันพร้อมกัน → 10 order', async () => {
    ({ srv } = await setup());
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) =>
      srv.request('PUT', base, { name: `คน${i}`, lines: [{ itemId: 'i1', qty: 1 }] })));
    for (const r of results) assert.equal(r.status, 200);
    assert.equal(count(srv, 'orders'), 10);
  });

  test('DB ไฟล์จริง (WAL): PUT ชื่อเดียวกัน 10 request พร้อมกัน → order เดียว', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'be24-'));
    ({ srv } = await setup({ dbPath: path.join(tmp, 'lunch.db') }));
    const results = await Promise.all(Array.from({ length: 10 }, () =>
      srv.request('PUT', base, { name: 'Hi', lines: [{ itemId: 'i1', qty: 1 }] })));
    for (const r of results) assert.equal(r.status, 200);
    assert.equal(count(srv, 'orders'), 1);
  });

  test('PUT/DELETE สลับกันพร้อมกัน → ไม่มี 500 · เหลือ order 0 หรือ 1', async () => {
    ({ srv } = await setup());
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2
      ? srv.request('DELETE', `${base}/Hi`)
      : srv.request('PUT', base, { name: 'Hi', lines: [{ itemId: 'i1', qty: 1 }] }))));
    for (const r of results) assert.ok([200, 204, 404].includes(r.status), String(r.status));
    assert.ok(count(srv, 'orders') <= 1);
    assert.equal(count(srv, 'order_lines'), count(srv, 'orders'));
  });

  test('หลังปิด: PUT ชื่อเดียวกัน 10 request พร้อมกัน → 409 ทุกตัว ไม่มี order', async () => {
    let clock;
    ({ srv, clock } = await setup());
    clock.set('2026-10-05T11:00:01+07:00');
    const results = await Promise.all(Array.from({ length: 10 }, () =>
      srv.request('PUT', base, { name: 'Hi', lines: [{ itemId: 'i1', qty: 1 }] })));
    for (const r of results) {
      assert.equal(r.status, 409);
      assert.equal(r.body.error.code, 'ROUND_CLOSED');
    }
    assert.equal(count(srv, 'orders'), 0);
  });
});
