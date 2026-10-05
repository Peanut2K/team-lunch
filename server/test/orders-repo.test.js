'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { createRoundsRepo } = require('../src/rounds-repo');
const { createOrdersRepo, nameKey } = require('../src/orders-repo');

function setup() {
  const db = openDb(':memory:');
  const rounds = createRoundsRepo(db);
  rounds.create({
    id: 'r_20261005', date: '2026-10-05', restaurant: 'ร้าน', cutoffAt: 1, createdAt: 0,
    items: [{ name: 'ก', price: 50 }, { name: 'ข', price: 60 }],
  });
  return { db, orders: createOrdersRepo(db) };
}

test('nameKey ตัดช่องว่างหัวท้ายและไม่สนตัวพิมพ์ (D3)', () => {
  assert.equal(nameKey('  Hi '), 'hi');
  assert.equal(nameKey('HI'), nameKey(' hi '));
});

test('upsert ชื่อเดิม = แทนที่ (id เดิม, lines ใหม่, ไม่มีแถวเพิ่ม)', () => {
  const { db, orders } = setup();
  const a = orders.upsert({ roundId: 'r_20261005', name: 'Hi', lines: [{ itemId: 'i1', qty: 2 }], note: '', total: 100, at: 1000 });
  assert.equal(a.created, true);
  const b = orders.upsert({ roundId: 'r_20261005', name: 'hi', lines: [{ itemId: 'i2', qty: 1 }], note: 'x', total: 60, at: 2000 });
  assert.equal(b.created, false);
  assert.equal(b.order.id, a.order.id);
  assert.equal(b.order.name, 'hi');
  assert.deepEqual(b.order.lines, [{ itemId: 'i2', qty: 1 }]);
  assert.equal(b.order.createdAt, 1000);
  assert.equal(b.order.updatedAt, 2000);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM orders').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM order_lines').get().n, 1);
});

test('deleteByName ลบ order และ lines · ไม่มี → false', () => {
  const { db, orders } = setup();
  orders.upsert({ roundId: 'r_20261005', name: 'Hi', lines: [{ itemId: 'i1', qty: 2 }], note: '', total: 100, at: 1 });
  assert.equal(orders.deleteByName('r_20261005', ' HI '), true);
  assert.equal(orders.findByName('r_20261005', 'Hi'), null);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM order_lines').get().n, 0);
  assert.equal(orders.deleteByName('r_20261005', 'Hi'), false);
});
