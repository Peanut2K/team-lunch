'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');

test('server เปิดได้และตอบ request', async () => {
  const srv = await startServer();
  try {
    const res = await srv.request('GET', '/api/__nothing__');
    assert.ok(res.status >= 200 && res.status < 600);
  } finally {
    await srv.close();
  }
});
