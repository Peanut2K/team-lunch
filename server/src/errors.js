'use strict';

/**
 * error ที่ตอบกลับเป็น { error: { code, message } } — message เป็นภาษาไทยให้ FE แสดงได้ตรงๆ
 * เฉพาะ VALIDATION มี `field` เพิ่ม (D11): path ของ field ที่ผิด เช่น `items[2].price` หรือ null ถ้า body ทั้งก้อนผิด
 */
class ApiError extends Error {
  constructor(status, code, message, field) {
    super(message);
    this.status = status;
    this.code = code;
    if (code === 'VALIDATION') this.field = field === undefined ? null : field;
  }
}

/**
 * 400 VALIDATION
 * @param {string|null} field path ของ field ที่ผิด (D11) — null = body ทั้งก้อนผิด
 * @param {string} message ข้อความภาษาไทย
 */
const validation = (field, message) => new ApiError(400, 'VALIDATION', message, field);
const notFound = (message = 'ไม่พบข้อมูลที่ต้องการ') => new ApiError(404, 'NOT_FOUND', message);

function sendError(res, status, code, message, field) {
  const error = code === 'VALIDATION'
    ? { code, field: field === undefined ? null : field, message }
    : { code, message };
  res.status(status).json({ error });
}

/** 404 สำหรับ path ใต้ /api ที่ไม่มีอยู่ */
function apiNotFoundHandler(req, res) {
  sendError(res, 404, 'NOT_FOUND', 'ไม่พบ endpoint นี้');
}

/** error middleware กลาง — ใช้ต่อท้ายทุก route */
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (err instanceof ApiError) {
    return sendError(res, err.status, err.code, err.message, err.field);
  }
  // body JSON พัง / ไม่ใช่ JSON (จาก express.json)
  if (err && (err.type === 'entity.parse.failed' || err instanceof SyntaxError)) {
    return sendError(res, 400, 'VALIDATION', 'รูปแบบข้อมูลไม่ถูกต้อง (ต้องเป็น JSON)', null);
  }
  if (err && err.type === 'entity.too.large') {
    return sendError(res, 400, 'VALIDATION', 'ข้อมูลใหญ่เกินไป', null);
  }
  console.error(err);
  return sendError(res, 500, 'INTERNAL', 'เกิดข้อผิดพลาดในระบบ ลองใหม่อีกครั้ง');
}

module.exports = { ApiError, validation, notFound, sendError, apiNotFoundHandler, errorHandler };
