'use strict';

const { parseISOWithOffset } = require('./clock');
const { validation } = require('./errors');
const { isTextInRange } = require('./text');

const MAX_ITEMS = 30;
const MIN_PRICE = 1;
const MAX_NAME = 60; // D8 — restaurant และชื่อเมนู 1–60 code point หลังตัดช่องว่าง
const MAX_PRICE = 10000; // D8 — กันค่าที่ใหญ่เกิน safe integer ทำข้อมูลใน SQLite อ่านกลับไม่ได้

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;
const validName = (v) => isTextInRange(v, 1, MAX_NAME);

/**
 * ตรวจ body ของ POST /api/rounds ตาม API contract — throw ApiError(400 VALIDATION) ถ้าผิด
 * @returns {{restaurant: string, cutoffAt: number, items: {name: string, price: number}[]}}
 */
function validateNewRound(body, now) {
  if (!isPlainObject(body)) {
    throw validation(null, 'ข้อมูลรอบสั่งต้องเป็น JSON object');
  }

  if (!nonEmptyString(body.restaurant)) {
    throw validation('restaurant', 'กรุณาใส่ชื่อร้าน');
  }
  if (!validName(body.restaurant)) {
    throw validation('restaurant', `ชื่อร้านยาวได้ไม่เกิน ${MAX_NAME} ตัวอักษร`);
  }

  if (body.cutoffAt === undefined || body.cutoffAt === null || body.cutoffAt === '') {
    throw validation('cutoffAt', 'กรุณาใส่เวลาปิดรับ');
  }
  const cutoff = parseISOWithOffset(body.cutoffAt);
  if (!cutoff) {
    throw validation('cutoffAt', 'เวลาปิดรับต้องเป็นรูปแบบ ISO 8601 พร้อม offset เช่น 2026-10-05T11:00:00+07:00');
  }
  // เก็บละเอียดระดับวินาที ให้ตรงกับเวลาที่แสดงใน cutoffAt
  const cutoffAt = Math.floor(cutoff.getTime() / 1000) * 1000;
  if (cutoffAt <= now.getTime()) {
    throw validation('cutoffAt', 'เวลาปิดรับต้องอยู่ในอนาคต');
  }

  if (!Array.isArray(body.items) || body.items.length === 0) {
    throw validation('items', 'ต้องมีเมนูอย่างน้อย 1 รายการ');
  }
  if (body.items.length > MAX_ITEMS) {
    throw validation('items', `เมนูได้ไม่เกิน ${MAX_ITEMS} รายการ`);
  }
  const items = body.items.map((it, idx) => {
    const n = idx + 1;
    if (!isPlainObject(it)) {
      throw validation(`items[${idx}]`, `เมนูรายการที่ ${n} ไม่ถูกต้อง`);
    }
    if (!nonEmptyString(it.name)) {
      throw validation(`items[${idx}].name`, `กรุณาใส่ชื่อเมนูรายการที่ ${n}`);
    }
    if (!validName(it.name)) {
      throw validation(`items[${idx}].name`, `ชื่อเมนูรายการที่ ${n} ยาวได้ไม่เกิน ${MAX_NAME} ตัวอักษร`);
    }
    if (typeof it.price !== 'number' || !Number.isInteger(it.price)
        || it.price < MIN_PRICE || it.price > MAX_PRICE) {
      throw validation(`items[${idx}].price`, `ราคาเมนู "${it.name.trim()}" ต้องเป็นจำนวนเต็ม 1–10,000 บาท`);
    }
    return { name: it.name.trim(), price: it.price };
  });

  return { restaurant: body.restaurant.trim(), cutoffAt, items };
}

module.exports = { validateNewRound, MAX_ITEMS, MAX_NAME, MIN_PRICE, MAX_PRICE };
