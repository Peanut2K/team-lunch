'use strict';

const crypto = require('node:crypto');
const { transaction } = require('./db');

/** key ของ order (D3): ตัดช่องว่างหัวท้าย + ไม่สนตัวพิมพ์ — "Hi" กับ " hi " คือคนเดียวกัน */
const nameKey = (name) => name.trim().toLowerCase();

const newOrderId = () => `o_${crypto.randomBytes(4).toString('hex')}`;

/** data access ของ order ในรอบสั่ง */
function createOrdersRepo(db) {
  const selectByKey = db.prepare('SELECT * FROM orders WHERE round_id = ? AND name_key = ?');
  const selectById = db.prepare('SELECT * FROM orders WHERE id = ?');
  const selectLines = db.prepare(
    'SELECT item_id, qty FROM order_lines WHERE order_id = ? ORDER BY position');
  const insertOrder = db.prepare(
    `INSERT INTO orders (id, round_id, name_key, name, note, total, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const updateOrder = db.prepare(
    'UPDATE orders SET name = ?, note = ?, total = ?, updated_at = ? WHERE id = ?');
  const deleteLines = db.prepare('DELETE FROM order_lines WHERE order_id = ?');
  const insertLine = db.prepare(
    'INSERT INTO order_lines (order_id, position, item_id, qty) VALUES (?, ?, ?, ?)');
  const deleteById = db.prepare('DELETE FROM orders WHERE id = ?');

  function hydrate(row) {
    if (!row) return null;
    return {
      id: row.id,
      roundId: row.round_id,
      name: row.name,
      lines: selectLines.all(row.id).map((l) => ({ itemId: l.item_id, qty: l.qty })),
      note: row.note,
      total: row.total,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  return {
    /**
     * สั่งหรือแทนที่ order ของชื่อนี้ในรอบนี้ (atomic) — ชื่อเดิมตาม nameKey = แทนที่ id เดิม ไม่เพิ่มใหม่
     * @param {{roundId: string, name: string, lines: {itemId: string, qty: number}[], note: string, total: number, at: number}} o
     * @returns {{order: object, created: boolean}}
     */
    upsert(o) {
      return transaction(db, () => {
        const existing = selectByKey.get(o.roundId, nameKey(o.name));
        let id;
        if (existing) {
          id = existing.id;
          updateOrder.run(o.name, o.note, o.total, o.at, id);
          deleteLines.run(id);
        } else {
          id = newOrderId();
          insertOrder.run(id, o.roundId, nameKey(o.name), o.name, o.note, o.total, o.at, o.at);
        }
        o.lines.forEach((l, idx) => insertLine.run(id, idx, l.itemId, l.qty));
        return { order: hydrate(selectById.get(id)), created: !existing };
      });
    },
    findByName(roundId, name) {
      return hydrate(selectByKey.get(roundId, nameKey(name)));
    },
    /** ยกเลิก order ของชื่อนี้ — คืน true ถ้ามีและลบแล้ว */
    deleteByName(roundId, name) {
      const row = selectByKey.get(roundId, nameKey(name));
      if (!row) return false;
      deleteById.run(row.id); // order_lines ลบตามด้วย ON DELETE CASCADE
      return true;
    },
  };
}

module.exports = { createOrdersRepo, nameKey };
