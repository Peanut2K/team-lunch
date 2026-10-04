'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  toBangkokISO, bangkokDate, bangkokTime, parseISOWithOffset, createFakeClock,
} = require('../src/clock');

test('toBangkokISO แปลงเป็นเวลาไทย +07:00 ตัดเศษวินาที', () => {
  assert.equal(toBangkokISO(new Date('2026-10-05T03:42:13.987Z')), '2026-10-05T10:42:13+07:00');
});

test('bangkokDate ใช้ปฏิทินไทย (UTC 17:00 = เที่ยงคืนวันถัดไป)', () => {
  assert.equal(bangkokDate(new Date('2026-10-04T16:59:59Z')), '2026-10-04');
  assert.equal(bangkokDate(new Date('2026-10-04T17:00:00Z')), '2026-10-05');
  assert.equal(bangkokTime(new Date('2026-10-05T04:00:00Z')), '11:00');
});

test('parseISOWithOffset รับเฉพาะ ISO 8601 ที่มี offset และวันที่มีจริง', () => {
  assert.equal(parseISOWithOffset('2026-10-05T11:00:00+07:00').toISOString(), '2026-10-05T04:00:00.000Z');
  assert.equal(parseISOWithOffset('2026-10-05T04:00:00Z').toISOString(), '2026-10-05T04:00:00.000Z');
  assert.equal(parseISOWithOffset('2026-10-05T11:00+07:00').toISOString(), '2026-10-05T04:00:00.000Z');
  for (const bad of ['2026-10-05T11:00:00', '2026-10-05', '11:00', 'พรุ่งนี้', '', '2026-02-31T11:00:00+07:00',
    '2026-10-05T25:00:00+07:00', 1759636800000, null, undefined]) {
    assert.equal(parseISOWithOffset(bad), null, `ควร reject: ${bad}`);
  }
});

test('createFakeClock ตั้งและเลื่อนเวลาได้', () => {
  const clock = createFakeClock('2026-10-05T10:59:59+07:00');
  assert.equal(toBangkokISO(clock.now()), '2026-10-05T10:59:59+07:00');
  clock.advance(2000);
  assert.equal(toBangkokISO(clock.now()), '2026-10-05T11:00:01+07:00');
  clock.set('2026-10-06T09:00:00+07:00');
  assert.equal(bangkokDate(clock.now()), '2026-10-06');
});
