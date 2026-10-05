'use strict';

const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS rounds (
  id          TEXT    PRIMARY KEY,                 -- r_YYYYMMDD
  date        TEXT    NOT NULL UNIQUE,             -- YYYY-MM-DD ปฏิทินไทย · วันละ 1 รอบ
  restaurant  TEXT    NOT NULL,
  cutoff_at   INTEGER NOT NULL,                    -- epoch ms
  created_at  INTEGER NOT NULL                     -- epoch ms
);

CREATE TABLE IF NOT EXISTS items (
  round_id    TEXT    NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  id          TEXT    NOT NULL,                    -- i1, i2, ... ไม่ซ้ำภายในรอบ
  position    INTEGER NOT NULL,                    -- ลำดับตามที่คนรับสั่งใส่
  name        TEXT    NOT NULL,
  price       INTEGER NOT NULL CHECK (price > 0),  -- จำนวนเต็มบาท (D4)
  PRIMARY KEY (round_id, id)
);

CREATE TABLE IF NOT EXISTS orders (
  id          TEXT    PRIMARY KEY,                 -- o_xxxxxxxx คงเดิมเมื่อแทนที่ order
  round_id    TEXT    NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  name_key    TEXT    NOT NULL,                    -- ชื่อตัดช่องว่างหัวท้าย + ตัวพิมพ์เล็ก (D3)
  name        TEXT    NOT NULL,                    -- ชื่อที่ส่งมาล่าสุด (ตัดช่องว่างหัวท้าย)
  note        TEXT    NOT NULL DEFAULT '',
  total       INTEGER NOT NULL,                    -- จำนวนเต็มบาท คำนวณที่ BE (D4)
  created_at  INTEGER NOT NULL,                    -- epoch ms
  updated_at  INTEGER NOT NULL,                    -- epoch ms
  UNIQUE (round_id, name_key)                      -- 1 ชื่อ 1 order ต่อรอบ
);

CREATE TABLE IF NOT EXISTS order_lines (
  order_id    TEXT    NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL,
  item_id     TEXT    NOT NULL,
  qty         INTEGER NOT NULL CHECK (qty BETWEEN 1 AND 10),
  PRIMARY KEY (order_id, position),
  UNIQUE (order_id, item_id)
);
`;

/** เปิด DB และสร้างตารางถ้ายังไม่มี */
function openDb(dbPath = ':memory:') {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON;');
  // BE-24: ถ้ามีหลาย process เปิดไฟล์ DB เดียวกัน ให้รอ lock แทนการตอบ SQLITE_BUSY (500) ทันที
  db.exec('PRAGMA busy_timeout = 5000;');
  if (dbPath !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  return db;
}

/** รัน fn ใน transaction (BEGIN IMMEDIATE) — rollback ถ้า throw */
function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function isUniqueViolation(err) {
  return Boolean(err) && /UNIQUE constraint failed/.test(String(err.message));
}

module.exports = { openDb, transaction, isUniqueViolation };
