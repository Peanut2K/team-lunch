'use strict';

const { transaction } = require('./db');

/** data access ของรอบสั่งและเมนู */
function createRoundsRepo(db) {
  const insertRound = db.prepare(
    'INSERT INTO rounds (id, date, restaurant, cutoff_at, created_at) VALUES (?, ?, ?, ?, ?)');
  const insertItem = db.prepare(
    'INSERT INTO items (round_id, id, position, name, price) VALUES (?, ?, ?, ?, ?)');
  const selectByDate = db.prepare('SELECT * FROM rounds WHERE date = ?');
  const selectById = db.prepare('SELECT * FROM rounds WHERE id = ?');
  const selectItems = db.prepare(
    'SELECT id, name, price FROM items WHERE round_id = ? ORDER BY position');

  function hydrate(row) {
    if (!row) return null;
    return {
      id: row.id,
      date: row.date,
      restaurant: row.restaurant,
      cutoffAt: row.cutoff_at,
      createdAt: row.created_at,
      items: selectItems.all(row.id).map((it) => ({ id: it.id, name: it.name, price: it.price })),
    };
  }

  return {
    /**
     * บันทึกรอบใหม่พร้อมเมนู (atomic) — ถ้าวันนั้นมีรอบแล้วจะ throw UNIQUE constraint
     * @param {{id, date, restaurant, cutoffAt, createdAt, items: {name, price}[]}} round
     */
    create(round) {
      transaction(db, () => {
        insertRound.run(round.id, round.date, round.restaurant, round.cutoffAt, round.createdAt);
        round.items.forEach((it, idx) => {
          insertItem.run(round.id, `i${idx + 1}`, idx, it.name, it.price);
        });
      });
      return hydrate(selectById.get(round.id));
    },
    findByDate(date) {
      return hydrate(selectByDate.get(date));
    },
    findById(id) {
      return hydrate(selectById.get(id));
    },
  };
}

module.exports = { createRoundsRepo };
