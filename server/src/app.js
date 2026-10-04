'use strict';

const path = require('node:path');
const express = require('express');

/**
 * สร้าง Express app
 * @param {object} [opts]
 * @param {string} [opts.dbPath] path ไฟล์ SQLite (ค่าเริ่มต้น ':memory:')
 * @param {() => Date} [opts.now] นาฬิกา server — test ส่งตัวจำลองเข้ามาได้
 */
function createApp(opts = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());

  // หน้าเว็บ (ของ FE) เสิร์ฟที่ / ถ้ามีโฟลเดอร์ web/
  app.use(express.static(path.join(__dirname, '..', '..', 'web')));

  return app;
}

module.exports = { createApp };
