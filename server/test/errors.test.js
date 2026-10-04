'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');

test('path ที่ไม่มีใต้ /api → 404 NOT_FOUND รูปแบบ error กลาง', async () => {
  const srv = await startServer();
  try {
    const res = await srv.request('GET', '/api/does-not-exist');
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'NOT_FOUND');
    assert.equal(typeof res.body.error.message, 'string');
    assert.ok(res.body.error.message.length > 0);
  } finally {
    await srv.close();
  }
});

test('body ไม่ใช่ JSON ที่ถูกต้อง → 400 VALIDATION', async () => {
  const srv = await startServer();
  try {
    const res = await srv.request('POST', '/api/rounds', '{"restaurant": ');
    assert.equal(res.status, 400);
    assert.deepEqual(Object.keys(res.body), ['error']);
    assert.equal(res.body.error.code, 'VALIDATION');
  } finally {
    await srv.close();
  }
});
