'use strict';

// QA FE-1 — หน้าตาพื้นฐาน + server จำลองตาม API contract
// เกณฑ์: PRD F8 + Design brief + API contract (ไม่ใช่คำอธิบายของ Dev)
//   ส่วน M: server จำลอง (web/mock-server.js) ตอบตาม API contract ทุก endpoint / error code
//   ส่วน U: หน้าเว็บด้วย Chromium (Playwright) จอ 360px และ 1280px · light / dark ตามเครื่อง
//   ส่วน R: (ถ้าตั้ง BE_SERVER_DIR) เสิร์ฟหน้าเว็บผ่าน backend จริง แล้วเทียบ mock กับ API จริง
// รัน: cd qa && npm install && PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node --test fe-1.test.js
// Google Fonts ถูกบล็อกใน environment นี้ — test ตอบ CSS ว่างแทน (ไม่ใช่ defect)

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright');

const WEB = path.join(__dirname, '..', 'web', 'index.html');
const FILE_URL = 'file://' + WEB;
const SHOTS = path.join(__dirname, 'screenshots');
fs.mkdirSync(SHOTS, { recursive: true });

const ISO_BKK = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+07:00$/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let browser;
test.before(async () => { browser = await chromium.launch(); });
test.after(async () => { if (browser) await browser.close(); });

/** เปิดหน้าใหม่ พร้อมเก็บ console error / pageerror และตอบ Google Fonts เป็น CSS ว่าง */
async function openPage({ width = 360, height = 800, scheme = 'light', reducedMotion = 'no-preference', query = '?mock=reset' } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: scheme, reducedMotion, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (route) =>
    route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  if (query !== null) await page.goto(FILE_URL + query);
  return { ctx, page, errors };
}

/** เรียก server จำลองตรงๆ ในหน้า (เหมือนยิง HTTP) */
function mock(page, method, p, body, raw) {
  return page.evaluate(([m, pp, b, r]) => window.TL.mockServer.handle(m, pp, r ? b : (b === undefined ? undefined : JSON.stringify(b))),
    [method, p, body, raw]);
}

function assertError(res, status, code, label = '') {
  assert.equal(res.status, status, `${label} status ควร ${status} ได้ ${res.status} ${JSON.stringify(res.body)}`);
  assert.deepEqual(Object.keys(res.body), ['error'], label);
  assert.deepEqual(Object.keys(res.body.error).sort(), ['code', 'message'], label);
  assert.equal(res.body.error.code, code, label);
  assert.match(res.body.error.message, /[฀-๿]/, `${label} message ต้องเป็นภาษาไทย`);
}

const ROUND_KEYS = ['cutoffAt', 'date', 'id', 'items', 'restaurant', 'serverNow', 'status'];
const ORDER_KEYS = ['id', 'lines', 'name', 'note', 'roundId', 'total', 'updatedAt'];

function assertRound(r) {
  assert.deepEqual(Object.keys(r).sort(), ROUND_KEYS);
  assert.match(r.id, /^r_\d{8}$/);
  assert.equal(r.id, 'r_' + r.date.replace(/-/g, ''));
  assert.match(r.cutoffAt, ISO_BKK);
  assert.match(r.serverNow, ISO_BKK);
  assert.ok(['open', 'closed'].includes(r.status));
  r.items.forEach((it) => {
    assert.deepEqual(Object.keys(it).sort(), ['id', 'name', 'price']);
    assert.ok(Number.isInteger(it.price) && it.price > 0);
  });
}

const futureIso = (sec) => new Date(Date.now() + sec * 1000 + 7 * 3600e3).toISOString().slice(0, 19) + '+07:00';
const MENU = [{ name: 'ข้าวมันไก่ต้ม', price: 50 }, { name: 'ข้าวมันไก่ทอด', price: 55 }, { name: 'เกาเหลา', price: 40 }];

// ───────────────────────── ส่วน M: server จำลอง ─────────────────────────

test('M1 POST /api/rounds + GET /api/rounds/today: 201/200 Round, 404 NO_ROUND, 409 ROUND_EXISTS, 400 VALIDATION', async () => {
  const { ctx, page } = await openPage({ query: '?mock=empty' });
  try {
    await page.evaluate(() => window.TL.mock.setLatency(0));
    assertError(await mock(page, 'GET', '/api/rounds/today'), 404, 'NO_ROUND');

    const ok = { restaurant: 'ร้านป้า', cutoffAt: futureIso(3600), items: MENU };
    const bad = [
      ['ไม่มี restaurant', { ...ok, restaurant: undefined }],
      ['restaurant ช่องว่าง', { ...ok, restaurant: '  ' }],
      ['ไม่มี cutoffAt', { ...ok, cutoffAt: undefined }],
      ['cutoffAt ผิดรูปแบบ', { ...ok, cutoffAt: 'พรุ่งนี้ 11 โมง' }],
      ['cutoffAt ในอดีต', { ...ok, cutoffAt: futureIso(-60) }],
      ['items ว่าง', { ...ok, items: [] }],
      ['items 31', { ...ok, items: Array.from({ length: 31 }, (_, i) => ({ name: 'm' + i, price: 10 })) }],
      ['price 0', { ...ok, items: [{ name: 'a', price: 0 }] }],
      ['price ติดลบ', { ...ok, items: [{ name: 'a', price: -1 }] }],
      ['price ทศนิยม', { ...ok, items: [{ name: 'a', price: 1.5 }] }],
      ['price string', { ...ok, items: [{ name: 'a', price: '50' }] }],
      ['ชื่อเมนูว่าง', { ...ok, items: [{ name: '', price: 10 }] }],
      ['body เป็น array', [ok]],
    ];
    for (const [label, body] of bad) assertError(await mock(page, 'POST', '/api/rounds', body), 400, 'VALIDATION', label);
    assertError(await mock(page, 'POST', '/api/rounds', '{not json', true), 400, 'VALIDATION', 'ไม่ใช่ JSON');
    assertError(await mock(page, 'GET', '/api/rounds/today'), 404, 'NO_ROUND', 'validation ไม่ควรสร้างรอบ');

    const created = await mock(page, 'POST', '/api/rounds', { ...ok, restaurant: '  ร้านป้า  ' });
    assert.equal(created.status, 201);
    assertRound(created.body);
    assert.equal(created.body.restaurant, 'ร้านป้า');
    assert.equal(created.body.status, 'open');
    assert.deepEqual(created.body.items.map((i) => [i.name, i.price]), MENU.map((m) => [m.name, m.price]));
    assert.equal(new Set(created.body.items.map((i) => i.id)).size, 3);

    const today = await mock(page, 'GET', '/api/rounds/today');
    assert.equal(today.status, 200);
    assertRound(today.body);
    assert.equal(today.body.id, created.body.id);

    assertError(await mock(page, 'POST', '/api/rounds', ok), 409, 'ROUND_EXISTS');
  } finally { await ctx.close(); }
});

test('M2 PUT orders: 200 Order (total คิดที่ server), แทนที่ชื่อเดิมแบบไม่สนตัวพิมพ์ + ตัดช่องว่าง, 400 VALIDATION, 404 NOT_FOUND', async () => {
  const { ctx, page } = await openPage({ query: '?mock=empty' });
  try {
    await page.evaluate(() => window.TL.mock.setLatency(0));
    const round = (await mock(page, 'POST', '/api/rounds', { restaurant: 'ร้าน', cutoffAt: futureIso(3600), items: MENU })).body;
    const [i1, i2, i3] = round.items.map((i) => i.id);
    const url = `/api/rounds/${round.id}/orders`;

    assertError(await mock(page, 'PUT', '/api/rounds/r_19990101/orders', { name: 'Hi', lines: [{ itemId: i1, qty: 1 }] }), 404, 'NOT_FOUND', 'รอบไม่มี');

    const o1 = await mock(page, 'PUT', url, { name: 'Hi', lines: [{ itemId: i1, qty: 2 }, { itemId: i3, qty: 1 }], note: 'ไม่เผ็ด' });
    assert.equal(o1.status, 200, JSON.stringify(o1.body));
    assert.deepEqual(Object.keys(o1.body).sort(), ORDER_KEYS);
    assert.equal(o1.body.roundId, round.id);
    assert.equal(o1.body.name, 'Hi');
    assert.equal(o1.body.total, 2 * 50 + 40);
    assert.equal(o1.body.note, 'ไม่เผ็ด');
    assert.deepEqual(o1.body.lines, [{ itemId: i1, qty: 2 }, { itemId: i3, qty: 1 }]);
    assert.match(o1.body.updatedAt, ISO_BKK);

    // F4: " hi " = "Hi" → แทนที่ ไม่เพิ่ม
    const o2 = await mock(page, 'PUT', url, { name: '  hI ', lines: [{ itemId: i2, qty: 1 }] });
    assert.equal(o2.status, 200);
    assert.equal(o2.body.id, o1.body.id);
    assert.equal(o2.body.total, 55);
    const sum = (await mock(page, 'GET', `/api/rounds/${round.id}/summary`)).body;
    assert.equal(sum.orderCount, 1);

    // validation ตาม contract
    const ok = { name: 'Bo', lines: [{ itemId: i1, qty: 1 }] };
    const bad = [
      ['ไม่มีชื่อ', { ...ok, name: undefined }],
      ['ชื่อช่องว่าง', { ...ok, name: '   ' }],
      ['ชื่อ 41 ตัว', { ...ok, name: 'ก'.repeat(41) }],
      ['lines ว่าง', { ...ok, lines: [] }],
      ['ไม่มี lines', { name: 'Bo' }],
      ['itemId ไม่อยู่ในรอบ', { ...ok, lines: [{ itemId: 'i99', qty: 1 }] }],
      ['qty 0', { ...ok, lines: [{ itemId: i1, qty: 0 }] }],
      ['qty 11', { ...ok, lines: [{ itemId: i1, qty: 11 }] }],
      ['qty ทศนิยม', { ...ok, lines: [{ itemId: i1, qty: 1.5 }] }],
      ['qty string', { ...ok, lines: [{ itemId: i1, qty: '2' }] }],
      ['itemId ซ้ำ', { ...ok, lines: [{ itemId: i1, qty: 1 }, { itemId: i1, qty: 2 }] }],
      ['note 101 ตัว', { ...ok, note: 'ก'.repeat(101) }],
    ];
    for (const [label, body] of bad) assertError(await mock(page, 'PUT', url, body), 400, 'VALIDATION', label);
    assertError(await mock(page, 'PUT', url, '{x', true), 400, 'VALIDATION', 'ไม่ใช่ JSON');

    // ขอบที่ต้องผ่าน
    assert.equal((await mock(page, 'PUT', url, { name: 'ก'.repeat(40), lines: [{ itemId: i1, qty: 10 }], note: 'ข'.repeat(100) })).status, 200);
    assert.equal((await mock(page, 'PUT', url, { name: 'ไม่ส่งหมายเหตุ', lines: [{ itemId: i2, qty: 1 }] })).status, 200);
  } finally { await ctx.close(); }
});

test('M3 DELETE orders (URL-encode, ไม่สนตัวพิมพ์) 204 / 404 NOT_FOUND · summary ตัวเลขตรงกันทุกจุด (F7) / 404 NOT_FOUND', async () => {
  const { ctx, page } = await openPage({ query: '?mock=empty' });
  try {
    await page.evaluate(() => window.TL.mock.setLatency(0));
    const round = (await mock(page, 'POST', '/api/rounds', { restaurant: 'ร้าน', cutoffAt: futureIso(3600), items: MENU })).body;
    const [i1, i2, i3] = round.items.map((i) => i.id);
    const put = (name, lines, note) => mock(page, 'PUT', `/api/rounds/${round.id}/orders`, { name, lines, note });
    await put('แพร', [{ itemId: i1, qty: 1 }], 'ไม่เอาหนัง');
    await put('Ton Boss', [{ itemId: i1, qty: 2 }, { itemId: i2, qty: 3 }]);
    await put('มิ้นท์/เอ', [{ itemId: i3, qty: 1 }]);

    const s = await mock(page, 'GET', `/api/rounds/${round.id}/summary`);
    assert.equal(s.status, 200);
    assert.deepEqual(Object.keys(s.body).sort(), ['byItem', 'byPerson', 'grandTotal', 'orderCount']);
    s.body.byItem.forEach((x) => assert.deepEqual(Object.keys(x).sort(), ['amount', 'itemId', 'name', 'qty']));
    s.body.byPerson.forEach((p) => {
      assert.deepEqual(Object.keys(p).sort(), ['lines', 'name', 'note', 'total']);
      p.lines.forEach((l) => assert.deepEqual(Object.keys(l).sort(), ['itemId', 'name', 'qty']));
    });
    const sumPerson = s.body.byPerson.reduce((a, p) => a + p.total, 0);
    const sumItem = s.body.byItem.reduce((a, x) => a + x.amount, 0);
    assert.equal(s.body.grandTotal, 50 + 100 + 165 + 40);
    assert.equal(sumPerson, s.body.grandTotal);
    assert.equal(sumItem, s.body.grandTotal);
    assert.equal(s.body.orderCount, 3);
    assert.deepEqual(s.body.byItem.find((x) => x.itemId === i1), { itemId: i1, name: 'ข้าวมันไก่ต้ม', qty: 3, amount: 150 });

    assertError(await mock(page, 'GET', '/api/rounds/r_19990101/summary'), 404, 'NOT_FOUND');
    // DELETE: ชื่อต้อง URL-encode
    const del = (n) => mock(page, 'DELETE', `/api/rounds/${round.id}/orders/${encodeURIComponent(n)}`);
    assert.equal((await del('  ton boss ')).status, 204);
    assert.equal((await del('มิ้นท์/เอ')).status, 204);
    assertError(await del('ton boss'), 404, 'NOT_FOUND', 'ลบซ้ำ');
    assertError(await mock(page, 'DELETE', `/api/rounds/r_19990101/orders/x`), 404, 'NOT_FOUND', 'รอบไม่มี');
    const s2 = (await mock(page, 'GET', `/api/rounds/${round.id}/summary`)).body;
    assert.equal(s2.orderCount, 1);
    assert.equal(s2.grandTotal, 50);
  } finally { await ctx.close(); }
});

test('M4 ปิดรับ: status open ก่อนปิด 1 วิ → closed หลังปิด · PUT / DELETE → 409 ROUND_CLOSED พร้อมข้อความปิดรับ · summary ยังดูได้', async () => {
  const { ctx, page } = await openPage({ query: '?mock=empty' });
  try {
    await page.evaluate(() => window.TL.mock.setLatency(0));
    const round = (await mock(page, 'POST', '/api/rounds', { restaurant: 'ร้าน', cutoffAt: futureIso(600), items: MENU })).body;
    const i1 = round.items[0].id;
    await mock(page, 'PUT', `/api/rounds/${round.id}/orders`, { name: 'Hi', lines: [{ itemId: i1, qty: 1 }] });
    const cutoffMs = Date.parse(round.cutoffAt);

    // เลื่อนนาฬิกา server ไปก่อนปิด ~1 วินาที
    await page.evaluate((ms) => window.TL.mock.setClockOffset(ms), cutoffMs - Date.now() - 1500);
    let t = await mock(page, 'GET', '/api/rounds/today');
    assert.equal(t.body.status, 'open', t.body.serverNow);
    assert.equal((await mock(page, 'PUT', `/api/rounds/${round.id}/orders`, { name: 'ก่อนปิด', lines: [{ itemId: i1, qty: 1 }] })).status, 200);

    // หลังปิด 1 วินาที
    await page.evaluate((ms) => window.TL.mock.setClockOffset(ms), cutoffMs - Date.now() + 1000);
    t = await mock(page, 'GET', '/api/rounds/today');
    assert.equal(t.body.status, 'closed');
    const p = await mock(page, 'PUT', `/api/rounds/${round.id}/orders`, { name: 'Hi', lines: [{ itemId: i1, qty: 2 }] });
    assertError(p, 409, 'ROUND_CLOSED');
    assert.match(p.body.error.message, /ปิดรับ/);
    assertError(await mock(page, 'DELETE', `/api/rounds/${round.id}/orders/Hi`), 409, 'ROUND_CLOSED');
    const s = await mock(page, 'GET', `/api/rounds/${round.id}/summary`);
    assert.equal(s.status, 200);
    assert.equal(s.body.orderCount, 2);
  } finally { await ctx.close(); }
});

// ───────────────────────── ส่วน U: หน้าเว็บ ─────────────────────────

const VIEWPORTS = [{ w: 360, h: 780 }, { w: 1280, h: 900 }];
const SCHEMES = ['light', 'dark'];

function luminance(rgb) {
  const [r, g, b] = rgb.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number).map((v) => {
    v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

for (const vp of VIEWPORTS) {
  for (const scheme of SCHEMES) {
    test(`U1 ${vp.w}px ${scheme}: ครบทุก component, ไม่มี scroll แนวนอน, ปุ่ม ≥ 44px, สีตามเครื่อง, ไม่มี console error`, async () => {
      const { ctx, page, errors } = await openPage({ width: vp.w, height: vp.h, scheme });
      try {
        await page.waitForSelector('#board .dish');
        await page.waitForSelector('#summary.tally');
        await page.waitForSelector('#sample-notice-error.notice');
        await sleep(300);

        // component ครบ
        const c = await page.evaluate(() => ({
          store: document.querySelector('#store').textContent,
          cutoffState: document.querySelector('#cutoff').getAttribute('data-state'),
          cutoffTime: document.querySelector('#cutoff .cutoff__time').textContent,
          count: document.querySelector('#cutoff .cutoff__count').textContent,
          dishes: document.querySelectorAll('#board .dish').length,
          steppers: document.querySelectorAll('#board .stepper__btn').length,
          name: !!document.querySelector('#name'), note: !!document.querySelector('#note'),
          bar: !document.querySelector('#orderbar').hidden && !!document.querySelector('#orderbar .orderbar__btn'),
          samples: ['#sample-open', '#sample-soon', '#sample-closed'].map((s) => document.querySelector(s).getAttribute('data-state')),
          noticeErr: document.querySelector('#sample-notice-error.notice')?.className,
          noticeClosed: document.querySelector('#sample-notice-closed.notice')?.className,
          done: document.querySelector('#sample-done .done__title')?.textContent,
          empty: document.querySelector('#sample-empty .empty__title')?.textContent,
          summary: !!document.querySelector('#summary .tally__grand'),
          emoji: /\p{Extended_Pictographic}/u.test(document.body.innerText),
        }));
        assert.equal(c.store, 'ข้าวมันไก่ป้าแดง');
        assert.equal(c.cutoffState, 'open');
        assert.match(c.cutoffTime, /^\d{2}:\d{2}$/);
        assert.match(c.count, /^\d{2}:\d{2}$/);
        assert.equal(c.dishes, 6);
        assert.equal(c.steppers, 12);
        assert.ok(c.name && c.note && c.bar);
        assert.deepEqual(c.samples, ['open', 'soon', 'closed']);
        assert.match(c.noticeErr, /notice--error/);
        assert.match(c.noticeClosed, /notice--closed/);
        assert.equal(c.done, 'สั่งแล้ว');
        assert.equal(c.empty, 'วันนี้ยังไม่มีรอบสั่ง');
        assert.ok(c.summary);
        assert.equal(c.emoji, false, 'ไม่ใช้ emoji แทนไอคอน');

        // F8: ไม่มี scroll แนวนอน
        const sw = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
        assert.ok(sw[0] <= sw[1], `scrollWidth ${sw[0]} > clientWidth ${sw[1]}`);

        // ปุ่ม / ช่องกรอกที่มองเห็น สูง ≥ 44px
        const small = await page.evaluate(() => Array.from(document.querySelectorAll('button, input, textarea, a.btn'))
          .filter((el) => el.offsetParent !== null || getComputedStyle(el).position === 'fixed')
          .map((el) => ({ t: el.className + ' ' + (el.textContent || el.id).trim().slice(0, 20), h: el.getBoundingClientRect().height, w: el.getBoundingClientRect().width }))
          .filter((x) => x.h > 0 && (x.h < 44 || x.w < 44)));
        assert.deepEqual(small, [], 'ปุ่ม/ช่องที่เล็กกว่า 44px');

        // สีตามเครื่อง: light = พื้นสว่าง, dark = พื้นเข้ม · contrast ตัวอักษรหลัก ≥ 4.5
        const col = await page.evaluate(() => {
          const cs = (sel, p) => getComputedStyle(document.querySelector(sel))[p];
          return {
            bg: cs('body', 'backgroundColor'), fg: cs('body', 'color'),
            btnBg: cs('.kit__buttons .btn--primary', 'backgroundColor'), btnFg: cs('.kit__buttons .btn--primary', 'color'),
            store: cs('#store', 'color'), time: cs('#cutoff .cutoff__time', 'color'),
            closedBg: cs('#sample-closed', 'backgroundColor'), closedFg: cs('#sample-closed .cutoff__left-label', 'color'),
            font: cs('body', 'fontFamily'),
          };
        });
        const L = luminance(col.bg);
        if (scheme === 'light') assert.ok(L > 0.7, `light bg ควรสว่าง ได้ ${col.bg}`);
        else assert.ok(L < 0.05, `dark bg ควรเข้ม ได้ ${col.bg}`);
        assert.ok(contrast(col.fg, col.bg) >= 4.5, `body text contrast ${contrast(col.fg, col.bg).toFixed(2)}`);
        assert.ok(contrast(col.btnFg, col.btnBg) >= 4.5, `ปุ่มหลัก contrast ${contrast(col.btnFg, col.btnBg).toFixed(2)} (${col.btnFg} on ${col.btnBg})`);
        assert.ok(contrast(col.store, col.bg) >= 4.5);
        assert.match(col.font, /IBM Plex Sans Thai/);

        assert.deepEqual(errors, [], 'console error');
        await page.screenshot({ path: path.join(SHOTS, `fe-1-${vp.w}-${scheme}.png`), fullPage: true });
      } finally { await ctx.close(); }
    });
  }
}

test('U2 ?theme= ไม่จำเป็น: ไม่ตั้ง theme แล้วเปลี่ยน prefers-color-scheme ในหน้าเดิม สีเปลี่ยนตาม', async () => {
  const { ctx, page } = await openPage({ scheme: 'light' });
  try {
    await page.waitForSelector('#board .dish');
    const a = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    await page.emulateMedia({ colorScheme: 'dark' });
    await sleep(300);
    const b = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    assert.notEqual(a, b);
    assert.ok(luminance(b) < 0.05);
  } finally { await ctx.close(); }
});

test('U3 ปุ่ม − / + (0–10), ยอดก่อนยืนยันอัปเดต, ปุ่มยืนยัน disabled เมื่อยังไม่เลือก', async () => {
  const { ctx, page } = await openPage();
  try {
    await page.waitForSelector('#board .dish');
    const btn = page.locator('#orderbar .orderbar__btn');
    assert.equal(await btn.isDisabled(), true);
    const row = page.locator('#board .dish').first();
    const plus = row.locator('[data-step="1"]');
    const minus = row.locator('[data-step="-1"]');
    assert.equal(await minus.isDisabled(), true, '− ต้องกดไม่ได้ที่ 0');
    for (let i = 0; i < 10; i++) await plus.click();
    assert.equal(await row.locator('.stepper__qty').textContent(), '10');
    assert.equal(await plus.isDisabled(), true, '+ ต้องกดไม่ได้ที่ 10');
    assert.equal(await page.locator('#orderbar .orderbar__total .num').textContent(), '500');
    assert.match(await page.locator('#orderbar .orderbar__label').textContent(), /10 จาน/);
    await minus.click();
    assert.equal(await page.locator('#orderbar .orderbar__total .num').textContent(), '450');
    await page.locator('#board .dish').nth(5).locator('[data-step="1"]').click(); // ไข่ต้ม 10 บาท
    assert.equal(await page.locator('#orderbar .orderbar__total .num').textContent(), '460');
    assert.equal(await btn.isDisabled(), false);
    // ไม่มีช่องพิมพ์ตัวเลขจำนวน
    assert.equal(await page.locator('#board input[type="number"]').count(), 0);
  } finally { await ctx.close(); }
});

test('U4 คีย์บอร์ด: skip link, Tab ไปถึงปุ่ม/ช่องทุกตัว และเห็น focus ชัด, Enter/Space กด + ได้', async () => {
  const { ctx, page } = await openPage({ width: 1280, height: 900 });
  try {
    await page.waitForSelector('#board .dish');
    await sleep(300);
    const seen = [];
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press('Tab');
      const f = await page.evaluate(() => {
        const el = document.activeElement;
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return {
          tag: el.tagName, cls: el.className, label: el.getAttribute('aria-label') || el.textContent.trim().slice(0, 15),
          outline: cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) >= 2,
          ring: cs.boxShadow !== 'none',
          visible: r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight,
        };
      });
      if (f.tag !== 'BODY') seen.push(f); // Tab วนออกนอกหน้า
    }
    assert.equal(seen[0].cls, 'skip-link', 'Tab แรกต้องเป็น skip link');
    assert.ok(seen[0].visible, 'skip link ต้องโผล่เมื่อ focus');
    seen.forEach((f, i) => assert.ok(f.outline || f.ring, `focus #${i} (${f.tag} ${f.label}) ไม่มี outline/ring`));
    assert.ok(seen.some((f) => f.cls.includes('stepper__btn')));
    assert.ok(seen.some((f) => f.tag === 'INPUT'));
    assert.ok(seen.some((f) => f.tag === 'TEXTAREA'));
    // focus ต้องไม่ถูกซ่อนหลังแถบยอดติดล่าง
    seen.forEach((f, i) => assert.ok(f.visible, `focus #${i} (${f.tag} ${f.label}) อยู่นอกจอ / ถูกบัง`));

    // กด + ด้วยคีย์บอร์ด
    await page.locator('#board .dish').first().locator('[data-step="1"]').focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Space');
    assert.equal(await page.locator('#board .dish').first().locator('.stepper__qty').textContent(), '2');
  } finally { await ctx.close(); }
});

for (const [w, h] of [[360, 640], [360, 780], [1280, 900]]) {
  test(`U5 ${w}x${h}: element ที่ได้ focus ต้องไม่ถูกแถบยอดติดล่างจอบัง (F8 เห็น focus ชัด)`, async () => {
    const { ctx, page } = await openPage({ width: w, height: h });
    try {
      await page.waitForSelector('#board .dish');
      await sleep(300);
      const hidden = [];
      let shot = false;
      for (let i = 0; i < 25; i++) {
        await page.keyboard.press('Tab');
        const r = await page.evaluate(() => {
          const el = document.activeElement;
          if (el === document.body || el.closest('#orderbar')) return null;
          const a = el.getBoundingClientRect();
          const bar = document.querySelector('#orderbar').getBoundingClientRect();
          const overlap = Math.min(a.bottom, bar.bottom) - Math.max(a.top, bar.top);
          return { label: el.getAttribute('aria-label') || el.id || el.textContent.trim().slice(0, 15), overlapPx: Math.round(overlap), height: Math.round(a.height) };
        });
        if (r && r.overlapPx > 0 && !hidden.some((x) => x.label === r.label)) {
          if (!shot && r.overlapPx >= 40 && (shot = true)) await page.screenshot({ path: path.join(SHOTS, `fe-1-${w}x${h}-focus-under-orderbar.png`) });
          hidden.push(r);
        }
      }
      assert.deepEqual(hidden, [], 'focus ถูกแถบยอดบัง');
    } finally { await ctx.close(); }
  });
}

test('U6 reduced motion: transition / animation ปิดเมื่อเครื่องตั้ง reduce · ปกติไม่เกิน 200ms', async () => {
  for (const rm of ['no-preference', 'reduce']) {
    const { ctx, page } = await openPage({ reducedMotion: rm });
    try {
      await page.waitForSelector('#board .dish');
      const durs = await page.evaluate(() => {
        const out = [];
        for (const el of document.querySelectorAll('*')) {
          const cs = getComputedStyle(el);
          const toMs = (s) => Math.max(...s.split(',').map((x) => (x.trim().endsWith('ms') ? parseFloat(x) : parseFloat(x) * 1000)));
          const t = toMs(cs.transitionDuration), a = toMs(cs.animationDuration);
          if (t > 0 || a > 0) out.push({ el: el.tagName + '.' + el.className, t, a });
        }
        return out;
      });
      if (rm === 'reduce') {
        assert.deepEqual(durs.filter((d) => d.t > 1 || d.a > 1), [], 'reduce ต้องไม่มี transition/animation');
      } else {
        assert.deepEqual(durs.filter((d) => d.t > 200 || d.a > 200), [], 'animation ไม่เกิน 200ms');
      }
      const smooth = await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior);
      if (rm === 'reduce') assert.notEqual(smooth, 'smooth');
    } finally { await ctx.close(); }
  }
});

test('U7 D2: นับถอยหลังจาก serverNow ไม่ใช่นาฬิกาเครื่อง (server ช้ากว่าเครื่อง 1 ชม.)', async () => {
  const { ctx, page } = await openPage({ query: '?mock=empty' });
  try {
    // server จำลองช้ากว่าเครื่อง 1 ชั่วโมง แล้วเปิดรอบปิดรับอีก 25 นาที (ตามเวลา server)
    await page.evaluate(() => { window.TL.mock.setClockOffset(-3600e3); window.TL.mock.reset({ cutoffInSec: 1500 }); });
    await page.goto(FILE_URL);
    await page.waitForSelector('#board .dish');
    await sleep(400);
    const s = await page.evaluate(() => ({
      state: document.querySelector('#cutoff').getAttribute('data-state'),
      count: document.querySelector('#cutoff .cutoff__count').textContent,
      btnDisabled: document.querySelector('#board [data-step="1"]').disabled,
    }));
    assert.equal(s.state, 'open', 'ถ้าใช้นาฬิกาเครื่องจะเห็นว่าปิดไปแล้ว');
    assert.match(s.count, /^2[45]:\d{2}$/);
    assert.equal(s.btnDisabled, false);
    await page.evaluate(() => window.TL.mock.setClockOffset(0));
  } finally { await ctx.close(); }
});

test('U8 แถบเวลาปิดรับ: เหลือ < 10 นาที = soon · ถึงเวลา = ปิดรับแล้วเอง ไม่ต้อง reload (ล็อกปุ่ม)', async () => {
  const { ctx, page, errors } = await openPage({ query: '?mock=cutoff:300' });
  try {
    await page.waitForSelector('#board .dish');
    assert.equal(await page.getAttribute('#cutoff', 'data-state'), 'soon');
    await page.goto(FILE_URL + '?mock=cutoff:3');
    await page.waitForSelector('#board .dish');
    assert.equal(await page.getAttribute('#cutoff', 'data-state'), 'soon');
    await page.locator('#board .dish').first().locator('[data-step="1"]').click();
    const navs = [];
    page.on('framenavigated', () => navs.push(1));
    await page.waitForSelector('#cutoff[data-state="closed"]', { timeout: 6000 });
    await sleep(500);
    const s = await page.evaluate(() => ({
      label: document.querySelector('#cutoff .cutoff__left-label').textContent,
      bar: document.querySelector('#orderbar .orderbar__btn').textContent,
      barDisabled: document.querySelector('#orderbar .orderbar__btn').disabled,
      plusDisabled: Array.from(document.querySelectorAll('#board .stepper__btn')).every((b) => b.disabled),
    }));
    assert.equal(s.label, 'ปิดรับแล้ว');
    assert.equal(s.bar, 'ปิดรับแล้ว');
    assert.equal(s.barDisabled, true);
    assert.equal(s.plusDisabled, true);
    assert.equal(navs.length, 0, 'ต้องไม่ reload');
    assert.deepEqual(errors, []);
    await page.screenshot({ path: path.join(SHOTS, 'fe-1-360-closed.png'), fullPage: false });
  } finally { await ctx.close(); }
});

test('U9 ส่ง order หลังปิดพอดี (server ปิดแล้วแต่หน้ายังนับไม่ถึง) → ข้อความ "ปิดรับแล้ว" ไม่ใช่ error ทั่วไป', async () => {
  const { ctx, page } = await openPage({ query: '?mock=cutoff:600' });
  try {
    await page.waitForSelector('#board .dish');
    await page.locator('#board .dish').first().locator('[data-step="1"]').click();
    await page.fill('#name', 'Hi');
    await page.evaluate(() => window.TL.mock.setClockOffset(601e3)); // server ข้ามเวลาปิดไปแล้ว
    await page.locator('#orderbar .orderbar__btn').click();
    await page.waitForSelector('#order-notice.notice');
    const n = await page.evaluate(() => ({ cls: document.querySelector('#order-notice.notice').className, text: document.querySelector('#order-notice').innerText }));
    assert.match(n.cls, /notice--closed/);
    assert.match(n.text, /ปิดรับ order แล้วเมื่อ \d{2}:\d{2}/);
    await page.waitForSelector('#cutoff[data-state="closed"]', { timeout: 3000 });
    await page.evaluate(() => window.TL.mock.setClockOffset(0));
  } finally { await ctx.close(); }
});

test('U10 ส่ง order แล้วเห็นการ์ด "สั่งแล้ว" พร้อมยอดจาก server และสรุปยอดอัปเดต · ยกเลิกได้', async () => {
  const { ctx, page, errors } = await openPage({ query: '?mock=reset' });
  try {
    await page.waitForSelector('#summary.tally');
    const before = Number((await page.locator('#summary .tally__grand').textContent()).replace(/,/g, ''));
    const row = page.locator('#board .dish').nth(1); // ทอด 55
    await row.locator('[data-step="1"]').click();
    await row.locator('[data-step="1"]').click();
    await page.fill('#name', 'QA ทดสอบ');
    await page.fill('#note', 'ไม่เผ็ด');
    await page.locator('#orderbar .orderbar__btn').click();
    await page.waitForSelector('#order-done:not([hidden]) .done__title');
    const d = await page.evaluate(() => document.querySelector('#order-done').innerText);
    assert.match(d, /สั่งแล้ว/);
    assert.match(d, /QA ทดสอบ/);
    assert.match(d, /110/);
    assert.match(d, /ไม่เผ็ด/);
    await page.waitForFunction((b) => Number(document.querySelector('#summary .tally__grand').textContent.replace(/,/g, '')) === b + 110, before);
    await page.screenshot({ path: path.join(SHOTS, 'fe-1-360-ordered.png'), fullPage: true });
    await page.locator('#order-done [data-act="cancel"]').click();
    await page.waitForSelector('#order-notice.notice--info');
    await page.waitForFunction((b) => Number(document.querySelector('#summary .tally__grand').textContent.replace(/,/g, '')) === b, before);
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test('U11 ไม่มีรอบวันนี้ (NO_ROUND): บอกชัดเจน 360px light/dark', async () => {
  for (const scheme of SCHEMES) {
    const { ctx, page, errors } = await openPage({ query: '?mock=empty', scheme });
    try {
      await page.waitForSelector('#no-round:not([hidden]) .empty__title');
      assert.equal(await page.locator('#no-round .empty__title').textContent(), 'วันนี้ยังไม่มีรอบสั่ง');
      assert.equal(await page.locator('#order').isHidden(), true);
      const sw = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
      assert.ok(sw);
      assert.deepEqual(errors, []);
      await page.screenshot({ path: path.join(SHOTS, `fe-1-360-${scheme}-no-round.png`), fullPage: false });
    } finally { await ctx.close(); }
  }
});

// ─────────────── ส่วน R: เทียบกับ backend จริง (ถ้ามี BE_SERVER_DIR) ───────────────

const BE_DIR = process.env.BE_SERVER_DIR;
function freePort() {
  return new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
}

test('R1 หน้าเว็บผ่าน backend จริง (?api=real อัตโนมัติ) + mock ตอบ code เดียวกับ API จริงสำหรับ POST/GET today', { skip: !BE_DIR && 'ไม่ได้ตั้ง BE_SERVER_DIR' }, async () => {
  const port = await freePort();
  const dbPath = path.join(require('node:os').tmpdir(), `qa-fe1-${port}.db`);
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.js'], { cwd: BE_DIR, env: { ...process.env, PORT: String(port), DB_PATH: dbPath } });
  await new Promise((r, j) => { child.stdout.on('data', (d) => /listening/.test(String(d)) && r()); child.on('exit', j); });
  const base = `http://127.0.0.1:${port}`;
  const http = async (m, p, b) => { const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) }); const t = await r.text(); return { status: r.status, body: t ? JSON.parse(t) : null }; };
  const { ctx, page, errors } = await openPage({ query: null });
  try {
    await page.goto(FILE_URL + '?mock=empty');
    await page.evaluate(() => window.TL.mock.setLatency(0));
    const cases = [
      ['GET', '/api/rounds/today'],
      ['POST', '/api/rounds', { restaurant: '', cutoffAt: futureIso(3600), items: MENU }],
      ['POST', '/api/rounds', { restaurant: 'ร้าน', cutoffAt: futureIso(-5), items: MENU }],
      ['POST', '/api/rounds', { restaurant: 'ร้าน', cutoffAt: futureIso(3600), items: [] }],
      ['POST', '/api/rounds', { restaurant: 'ร้าน', cutoffAt: futureIso(3600), items: [{ name: 'a', price: 1.5 }] }],
      ['POST', '/api/rounds', { restaurant: 'ร้านป้าแดง', cutoffAt: futureIso(3600), items: MENU }],
      ['GET', '/api/rounds/today'],
      ['POST', '/api/rounds', { restaurant: 'ร้านอื่น', cutoffAt: futureIso(3600), items: MENU }],
    ];
    for (const [m, p, b] of cases) {
      const real = await http(m, p, b);
      const fake = await mock(page, m, p, b);
      assert.equal(fake.status, real.status, `${m} ${p} ${JSON.stringify(b)}`);
      if (real.body && real.body.error) assert.equal(fake.body.error.code, real.body.error.code);
      else assert.deepEqual(Object.keys(fake.body).sort(), Object.keys(real.body).sort());
      if (real.status === 200 || real.status === 201) {
        assert.equal(fake.body.id, real.body.id);
        assert.deepEqual(fake.body.items, real.body.items);
        assert.equal(fake.body.cutoffAt.length, real.body.cutoffAt.length);
      }
    }
    // หน้าเว็บเสิร์ฟผ่าน backend ใช้ API จริง
    await page.goto(base + '/');
    await page.waitForSelector('#board .dish');
    assert.equal(await page.locator('#store').textContent(), 'ร้านป้าแดง');
    assert.equal(await page.locator('#mode-chip').isHidden(), true);
    assert.equal(await page.getAttribute('#cutoff', 'data-state'), 'open');
    await page.screenshot({ path: path.join(SHOTS, 'fe-1-1280-real-api.png'), fullPage: false });
    // endpoint ที่ BE ยังไม่ทำ (summary/orders) → 404 จาก API จริง ไม่ใช่ความผิดของ FE-1
    const relevant = errors.filter((e) => !/404 \(Not Found\)/.test(e));
    assert.deepEqual(relevant, []);
  } finally { await ctx.close(); child.kill(); }
});
