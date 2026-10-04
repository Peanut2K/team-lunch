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
    assert.deepEqual(Object.keys(res.body.error), ['code', 'message'], 'error อื่นไม่มี field (D11)');
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
    assert.equal(res.body.error.field, null, 'body ทั้งก้อนผิด → field: null (D11)');
  } finally {
    await srv.close();
  }
});

test('body ไม่ใช่ JSON (content-type อื่น) → 400 VALIDATION field: null', async () => {
  const srv = await startServer();
  try {
    const res = await fetch(`${srv.base}/api/rounds`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'restaurant=a',
    });
    const body = await res.json();
    assert.equal(res.status, 400);
    assert.deepEqual(body.error.code, 'VALIDATION');
    assert.equal(body.error.field, null);
  } finally {
    await srv.close();
  }
});
