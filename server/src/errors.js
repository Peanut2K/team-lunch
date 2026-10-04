'use strict';

/** error ที่ตอบกลับเป็น { error: { code, message } } — message เป็นภาษาไทยให้ FE แสดงได้ตรงๆ */
class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const validation = (message) => new ApiError(400, 'VALIDATION', message);
const notFound = (message = 'ไม่พบข้อมูลที่ต้องการ') => new ApiError(404, 'NOT_FOUND', message);

function sendError(res, status, code, message) {
  res.status(status).json({ error: { code, message } });
}

/** 404 สำหรับ path ใต้ /api ที่ไม่มีอยู่ */
function apiNotFoundHandler(req, res) {
  sendError(res, 404, 'NOT_FOUND', 'ไม่พบ endpoint นี้');
}

/** error middleware กลาง — ใช้ต่อท้ายทุก route */
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (err instanceof ApiError) {
    return sendError(res, err.status, err.code, err.message);
  }
  // body JSON พัง / ไม่ใช่ JSON (จาก express.json)
  if (err && (err.type === 'entity.parse.failed' || err instanceof SyntaxError)) {
    return sendError(res, 400, 'VALIDATION', 'รูปแบบข้อมูลไม่ถูกต้อง (ต้องเป็น JSON)');
  }
  if (err && err.type === 'entity.too.large') {
    return sendError(res, 400, 'VALIDATION', 'ข้อมูลใหญ่เกินไป');
  }
  console.error(err);
  return sendError(res, 500, 'INTERNAL', 'เกิดข้อผิดพลาดในระบบ ลองใหม่อีกครั้ง');
}

module.exports = { ApiError, validation, notFound, sendError, apiNotFoundHandler, errorHandler };
