'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { openDb, isUniqueViolation } = require('../src/db');
const { createRoundsRepo } = require('../src/rounds-repo');

const sample = (over = {}) => ({
  id: 'r_20261005',
  date: '2026-10-05',
  restaurant: 'ข้าวมันไก่ป้าแดง',
  cutoffAt: Date.parse('2026-10-05T11:00:00+07:00'),
  createdAt: Date.parse('2026-10-05T09:00:00+07:00'),
  items: [{ name: 'ข้าวมันไก่ต้ม', price: 50 }, { name: 'ข้าวมันไก่ทอด', price: 55 }],
  ...over,
});

test('บันทึกรอบพร้อมเมนู ได้ item id i1, i2 ตามลำดับ', () => {
  const repo = createRoundsRepo(openDb());
  const r = repo.create(sample());
  assert.equal(r.id, 'r_20261005');
  assert.deepEqual(r.items, [
    { id: 'i1', name: 'ข้าวมันไก่ต้ม', price: 50 },
    { id: 'i2', name: 'ข้าวมันไก่ทอด', price: 55 },
  ]);
  assert.deepEqual(repo.findByDate('2026-10-05'), r);
  assert.deepEqual(repo.findById('r_20261005'), r);
  assert.equal(repo.findByDate('2026-10-06'), null);
});

test('วันเดียวกันบันทึกได้รอบเดียว (UNIQUE) และไม่ทิ้งเมนูค้าง', () => {
  const db = openDb();
  const repo = createRoundsRepo(db);
  repo.create(sample());
  assert.throws(() => repo.create(sample({ id: 'r_other' })), (err) => isUniqueViolation(err));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM items').get().n, 2);
});

test('ราคา <= 0 ถูก DB ปฏิเสธและ rollback ทั้งรอบ', () => {
  const db = openDb();
  const repo = createRoundsRepo(db);
  assert.throws(() => repo.create(sample({ items: [{ name: 'a', price: 10 }, { name: 'b', price: 0 }] })));
  assert.equal(repo.findByDate('2026-10-05'), null);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM items').get().n, 0);
});
