'use strict';

const { createApp } = require('../src/app');

/**
 * เปิด server จริงบน port สุ่ม (DB ในหน่วยความจำ) สำหรับ test
 * @param {object} [opts] ส่งต่อให้ createApp (เช่น now)
 */
async function startServer(opts = {}) {
  const app = createApp({ dbPath: ':memory:', ...opts });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  async function request(method, path, body) {
    const init = { method, headers: {} };
    if (body !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.body = typeof body === 'string' ? body : JSON.stringify(body);
    }
    const res = await fetch(base + path, init);
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: res.status, body: json, text };
  }

  const db = app.locals.db;
  return {
    app,
    db,
    /** จำนวนรอบที่อยู่ใน DB (ใช้ตรวจว่าไม่ได้สร้างรอบ) */
    roundCount: () => db.prepare('SELECT COUNT(*) AS n FROM rounds').get().n,
    base,
    request,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

module.exports = { startServer };
