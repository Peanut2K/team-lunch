'use strict';

const path = require('node:path');
const express = require('express');
const { systemClock } = require('./clock');
const { apiNotFoundHandler, errorHandler } = require('./errors');

/**
 * สร้าง Express app
 * @param {object} [opts]
 * @param {string} [opts.dbPath] path ไฟล์ SQLite (ค่าเริ่มต้น ':memory:')
 * @param {() => Date} [opts.now] นาฬิกา server — test ส่งนาฬิกาจำลอง (createFakeClock) เข้ามาได้
 */
function createApp(opts = {}) {
  const now = opts.now || systemClock;

  const app = express();
  app.disable('x-powered-by');
  app.locals.now = now;

  const api = express.Router();
  api.use(express.json());
  api.use(apiNotFoundHandler);
  app.use('/api', api);

  // หน้าเว็บ (ของ FE) เสิร์ฟที่ / ถ้ามีโฟลเดอร์ web/
  app.use(express.static(path.join(__dirname, '..', '..', 'web')));

  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
