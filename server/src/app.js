'use strict';

const path = require('node:path');
const express = require('express');
const { systemClock } = require('./clock');
const { apiNotFoundHandler, errorHandler, validation } = require('./errors');
const { openDb } = require('./db');
const { createRoundsRepo } = require('./rounds-repo');
const { createOrdersRepo } = require('./orders-repo');
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
  const ordersRepo = createOrdersRepo(db);

  const app = express();
  app.disable('x-powered-by');
  app.locals.now = now;
  app.locals.db = db;

  const api = express.Router();
  // contract: รับส่ง JSON — body ที่มีเนื้อหาแต่ไม่ใช่ JSON ถือว่า body ทั้งก้อนผิด (D11: field null)
  // ไม่ตอบ error ทันที แต่เก็บไว้ใน req.bodyError ให้ route ตัดสินตามลำดับ D9
  // (เช่น PUT order ของรอบที่ไม่มี → NOT_FOUND ก่อน VALIDATION) — route อ่าน body ผ่าน readBody(req)
  const jsonParser = express.json();
  api.use((req, res, next) => {
    jsonParser(req, res, (err) => {
      if (err) {
        if (err.type === 'entity.parse.failed' || err instanceof SyntaxError) {
          req.bodyError = validation(null, 'รูปแบบข้อมูลไม่ถูกต้อง (ต้องเป็น JSON)');
        } else if (err.type === 'entity.too.large') {
          req.bodyError = validation(null, 'ข้อมูลใหญ่เกินไป');
        } else {
          return next(err);
        }
      } else if (['POST', 'PUT', 'PATCH'].includes(req.method) && req.is('application/json') === false) {
        req.bodyError = validation(null, 'รูปแบบข้อมูลไม่ถูกต้อง (ต้องเป็น JSON)');
      }
      return next();
    });
  });
  api.use('/rounds', roundsRouter({ repo, ordersRepo, now }));
  api.use(apiNotFoundHandler);
  app.use('/api', api);

  // หน้าเว็บ (ของ FE) เสิร์ฟที่ / ถ้ามีโฟลเดอร์ web/
  app.use(express.static(path.join(__dirname, '..', '..', 'web')));

  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
