'use strict';

const { validation } = require('./errors');
const { codePointLength } = require('./text');

const MAX_PERSON_NAME = 40; // contract: name 1–40 code point หลังตัดช่องว่างหัวท้าย (D8)
const MIN_QTY = 1;
const MAX_QTY = 10;
const MAX_NOTE = 100;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * ตรวจชื่อคนสั่ง (key ของ order, D3) — ใช้ทั้งใน body ของ PUT และชื่อใน path ของ DELETE
 * @returns {string} ชื่อที่ตัดช่องว่างหัวท้ายแล้ว
 */
function validatePersonName(raw) {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw validation('name', 'กรุณาใส่ชื่อของคุณ');
  }
  const name = raw.trim();
  if (codePointLength(name) > MAX_PERSON_NAME) {
    throw validation('name', `ชื่อยาวได้ไม่เกิน ${MAX_PERSON_NAME} ตัวอักษร`);
  }
  return name;
}

/**
 * ตรวจ body ของ PUT /api/rounds/:id/orders ตามลำดับ field ใน API contract (D9):
 * name → lines → lines[i].itemId (อยู่ในรอบ, ไม่ซ้ำ) → lines[i].qty → note
 * แล้วคำนวณ total (จำนวนเต็มบาท, D4) จากราคาในรอบ — throw ApiError(400 VALIDATION) ถ้าผิด
 * @param {unknown} body
 * @param {{items: {id: string, price: number}[]}} round
 * @returns {{name: string, lines: {itemId: string, qty: number}[], note: string, total: number}}
 */
function validateOrder(body, round) {
  if (!isPlainObject(body)) {
    throw validation(null, 'ข้อมูล order ต้องเป็น JSON object');
  }

  const name = validatePersonName(body.name);

  if (!Array.isArray(body.lines) || body.lines.length === 0) {
    throw validation('lines', 'เลือกเมนูอย่างน้อย 1 รายการ');
  }
  const priceById = new Map(round.items.map((it) => [it.id, it.price]));
  const seen = new Set();
  let total = 0;
  const lines = body.lines.map((ln, idx) => {
    const path = `lines[${idx}]`;
    if (!isPlainObject(ln)) {
      throw validation(path, `รายการที่ ${idx + 1} ไม่ถูกต้อง`);
    }
    if (typeof ln.itemId !== 'string' || !priceById.has(ln.itemId)) {
      throw validation(`${path}.itemId`, 'มีเมนูที่ไม่อยู่ในรอบสั่งนี้');
    }
    if (seen.has(ln.itemId)) {
      throw validation(`${path}.itemId`, 'เลือกเมนูเดียวกันซ้ำในหลายบรรทัดไม่ได้');
    }
    seen.add(ln.itemId);
    if (typeof ln.qty !== 'number' || !Number.isInteger(ln.qty) || ln.qty < MIN_QTY || ln.qty > MAX_QTY) {
      throw validation(`${path}.qty`, `จำนวนต่อเมนูต้องเป็นจำนวนเต็ม ${MIN_QTY}–${MAX_QTY}`);
    }
    total += priceById.get(ln.itemId) * ln.qty;
    return { itemId: ln.itemId, qty: ln.qty };
  });

  // note ไม่บังคับ — ไม่ส่ง / null = ไม่มีหมายเหตุ (เก็บเป็น '')
  let note = body.note;
  if (note === undefined || note === null) note = '';
  if (typeof note !== 'string') {
    throw validation('note', 'หมายเหตุต้องเป็นข้อความ');
  }
  note = note.trim();
  if (codePointLength(note) > MAX_NOTE) {
    throw validation('note', `หมายเหตุยาวได้ไม่เกิน ${MAX_NOTE} ตัวอักษร`);
  }

  return { name, lines, note, total };
}

module.exports = { validateOrder, validatePersonName, MAX_PERSON_NAME, MIN_QTY, MAX_QTY, MAX_NOTE };
