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
`;

/** เปิด DB และสร้างตารางถ้ายังไม่มี */
function openDb(dbPath = ':memory:') {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON;');
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
