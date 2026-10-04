'use strict';

const { parseISOWithOffset } = require('./clock');
const { validation } = require('./errors');

const MAX_ITEMS = 30;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;

/**
 * ตรวจ body ของ POST /api/rounds ตาม API contract — throw ApiError(400 VALIDATION) ถ้าผิด
 * @returns {{restaurant: string, cutoffAt: number, items: {name: string, price: number}[]}}
 */
function validateNewRound(body, now) {
  if (!isPlainObject(body)) {
    throw validation('ข้อมูลรอบสั่งต้องเป็น JSON object');
  }

  if (!nonEmptyString(body.restaurant)) {
    throw validation('กรุณาใส่ชื่อร้าน');
  }

  if (body.cutoffAt === undefined || body.cutoffAt === null || body.cutoffAt === '') {
    throw validation('กรุณาใส่เวลาปิดรับ');
  }
  const cutoff = parseISOWithOffset(body.cutoffAt);
  if (!cutoff) {
    throw validation('เวลาปิดรับต้องเป็นรูปแบบ ISO 8601 พร้อม offset เช่น 2026-10-05T11:00:00+07:00');
  }
  // เก็บละเอียดระดับวินาที ให้ตรงกับเวลาที่แสดงใน cutoffAt
  const cutoffAt = Math.floor(cutoff.getTime() / 1000) * 1000;
  if (cutoffAt <= now.getTime()) {
    throw validation('เวลาปิดรับต้องอยู่ในอนาคต');
  }

  if (!Array.isArray(body.items) || body.items.length === 0) {
    throw validation('ต้องมีเมนูอย่างน้อย 1 รายการ');
  }
  if (body.items.length > MAX_ITEMS) {
    throw validation(`เมนูได้ไม่เกิน ${MAX_ITEMS} รายการ`);
  }
  const items = body.items.map((it, idx) => {
    const n = idx + 1;
    if (!isPlainObject(it)) {
      throw validation(`เมนูรายการที่ ${n} ไม่ถูกต้อง`);
    }
    if (!nonEmptyString(it.name)) {
      throw validation(`กรุณาใส่ชื่อเมนูรายการที่ ${n}`);
    }
    if (typeof it.price !== 'number' || !Number.isInteger(it.price) || it.price <= 0) {
      throw validation(`ราคาเมนู "${it.name.trim()}" ต้องเป็นจำนวนเต็มบาทที่มากกว่า 0`);
    }
    return { name: it.name.trim(), price: it.price };
  });

  return { restaurant: body.restaurant.trim(), cutoffAt, items };
}

module.exports = { validateNewRound, MAX_ITEMS };
