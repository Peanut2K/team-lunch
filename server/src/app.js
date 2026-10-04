'use strict';

const path = require('node:path');
const express = require('express');
const { systemClock } = require('./clock');
const { apiNotFoundHandler, errorHandler, validation } = require('./errors');
const { openDb } = require('./db');
const { createRoundsRepo } = require('./rounds-repo');
const { roundsRouter } = require('./routes/rounds');

/**
 * สร้าง Express app
 * @param {object} [opts]
 * @param {string} [opts.dbPath] path ไฟล์ SQLite (ค่าเริ่มต้น ':memory:')
 * @param {() => Date} [opts.now] นาฬิกา server — test ส่งนาฬิกาจำลอง (createFakeClock) เข้ามาได้
 */
function createApp(opts = {}) {
  const now = opts.now || systemClock;
  const db = openDb(opts.dbPath || ':memory:');
  const repo = createRoundsRepo(db);

  const app = express();
  app.disable('x-powered-by');
  app.locals.now = now;
  app.locals.db = db;

  const api = express.Router();
  api.use(express.json());
  // contract: รับส่ง JSON — body ที่มีเนื้อหาแต่ไม่ใช่ JSON ถือว่า body ทั้งก้อนผิด (D11: field null)
  api.use((req, res, next) => {
    if (['POST', 'PUT', 'PATCH'].includes(req.method) && req.is('application/json') === false) {
      return next(validation(null, 'รูปแบบข้อมูลไม่ถูกต้อง (ต้องเป็น JSON)'));
    }
    return next();
  });
  api.use('/rounds', roundsRouter({ repo, now }));
  api.use(apiNotFoundHandler);
  app.use('/api', api);

  // หน้าเว็บ (ของ FE) เสิร์ฟที่ / ถ้ามีโฟลเดอร์ web/
  app.use(express.static(path.join(__dirname, '..', '..', 'web')));

  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
