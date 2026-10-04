'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { codePointLength, isTextInRange } = require('../src/text');

test('codePointLength นับ code point (D8)', () => {
  assert.equal(codePointLength('ข้าว'), 4);
  assert.equal(codePointLength('🍚'), 1);
  assert.equal(codePointLength(''), 0);
});

test('isTextInRange ตัดช่องว่างหัวท้ายก่อนนับ และไม่รับค่าที่ไม่ใช่ string', () => {
  assert.equal(isTextInRange('  a  ', 1, 1), true);
  assert.equal(isTextInRange('   ', 1, 60), false);
  assert.equal(isTextInRange('🍚'.repeat(60), 1, 60), true);
  assert.equal(isTextInRange('🍚'.repeat(61), 1, 60), false);
  assert.equal(isTextInRange(5, 1, 60), false);
  assert.equal(isTextInRange(null, 1, 60), false);
});
