'use strict';

/**
 * ความยาวข้อความนับเป็น code point (D8) — ไม่ใช่ UTF-16 code unit ของ String#length
 * เช่น '🍚' = 1, 'ข้าว' = 4 (ข + ้ + า + ว)
 */
const codePointLength = (s) => [...s].length;

/** string ที่หลังตัดช่องว่างหัวท้ายแล้วยาว min–max code point หรือไม่ */
const isTextInRange = (v, min, max) => {
  if (typeof v !== 'string') return false;
  const n = codePointLength(v.trim());
  return n >= min && n <= max;
};

module.exports = { codePointLength, isTextInRange };
