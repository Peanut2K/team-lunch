'use strict';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer } = require('./helpers');
const { createFakeClock } = require('../src/clock');

const body = {
  restaurant: 'ข้าวมันไก่ป้าแดง',
  cutoffAt: '2026-10-05T11:00:00+07:00',
  items: [{ name: 'ข้าวมันไก่ต้ม', price: 50 }],
};

describe('GET /api/rounds/today', () => {
  let srv;
  let clock;
  beforeEach(async () => {
    clock = createFakeClock('2026-10-05T09:00:00+07:00');
    srv = await startServer({ now: clock.now });
  });
  afterEach(() => srv.close());

  test('ยังไม่มีรอบ → 404 NO_ROUND พร้อม message ภาษาไทย', async () => {
    const res = await srv.request('GET', '/api/rounds/today');
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { error: { code: 'NO_ROUND', message: 'วันนี้ยังไม่มีรอบสั่งข้าว' } });
  });

  test('มีรอบ → 200 Round เดียวกับที่ POST ตอบ', async () => {
    const created = await srv.request('POST', '/api/rounds', body);
    const res = await srv.request('GET', '/api/rounds/today');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, created.body);
  });

  test('serverNow มาจากนาฬิกา server (+07:00) และเปลี่ยนตามเวลา', async () => {
    await srv.request('POST', '/api/rounds', body);
    clock.set('2026-10-05T10:42:13+07:00');
    const res = await srv.request('GET', '/api/rounds/today');
    assert.equal(res.body.serverNow, '2026-10-05T10:42:13+07:00');
    assert.equal(res.body.cutoffAt, '2026-10-05T11:00:00+07:00');
  });

  test('status: ก่อนปิด 1 วินาที = open · ถึงเวลาพอดี = closed · หลังปิด = closed', async () => {
    await srv.request('POST', '/api/rounds', body);

    clock.set('2026-10-05T10:59:59+07:00');
    let res = await srv.request('GET', '/api/rounds/today');
    assert.equal(res.body.status, 'open');

    clock.set('2026-10-05T11:00:00+07:00');
    res = await srv.request('GET', '/api/rounds/today');
    assert.equal(res.body.status, 'closed');
    assert.equal(res.body.serverNow, '2026-10-05T11:00:00+07:00');

    clock.set('2026-10-05T11:00:01+07:00');
    res = await srv.request('GET', '/api/rounds/today');
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'closed');
  });

  test('ข้ามเที่ยงคืนเวลาไทย → รอบเมื่อวานไม่ใช่รอบวันนี้ (404 NO_ROUND)', async () => {
    await srv.request('POST', '/api/rounds', body);
    clock.set('2026-10-05T23:59:59+07:00');
    assert.equal((await srv.request('GET', '/api/rounds/today')).status, 200);
    clock.set('2026-10-06T00:00:00+07:00'); // UTC ยังเป็นวันที่ 5
    const res = await srv.request('GET', '/api/rounds/today');
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'NO_ROUND');
  });
});

test('รอบเก็บใน SQLite ไฟล์ — restart server แล้วยังอยู่', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-lunch-'));
  const dbPath = path.join(dir, 'test.db');
  const clock = createFakeClock('2026-10-05T09:00:00+07:00');
  try {
    const a = await startServer({ now: clock.now, dbPath });
    await a.request('POST', '/api/rounds', body);
    await a.close();
    a.db.close();

    const b = await startServer({ now: clock.now, dbPath });
    const res = await b.request('GET', '/api/rounds/today');
    assert.equal(res.status, 200);
    assert.equal(res.body.restaurant, 'ข้าวมันไก่ป้าแดง');
    await b.close();
    b.db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
