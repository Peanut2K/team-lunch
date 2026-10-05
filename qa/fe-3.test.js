'use strict';

// QA FE-3 — หน้าเปิดรอบสั่ง (web/open.html + open.js) + หน้าสรุปยอด (web/summary.html + summary.js) บน API จริง
// เกณฑ์: PRD F1, F7, F8 + DoD "ไม่มี error ใน console" · API contract v2 · Design brief (หน้าสรุปยอด, 44px, dark)
//        · Decision log D2, D8, D10, D11, D16 (ไม่ใช่คำอธิบายของ Dev)
// ทุก scenario start backend จริง (`node src/index.js` ใน server/) บน port ว่าง + DB ชั่วคราว แล้วเปิดหน้าที่ backend เสิร์ฟ
// D16: ไม่นับ "Failed to load resource ... 4xx" ที่เบราว์เซอร์พิมพ์เองเมื่อ API ตอบ 4xx ตาม contract
// Google Fonts ถูกบล็อกใน environment นี้ — ตอบ CSS ว่างแทน (ไม่ใช่ defect)
// รัน: cd server && npm install · cd qa && npm install && PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node --test fe-3.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright');
const { wrapAudit } = require('./lib/wrap-audit');

const SERVER_DIR = path.join(__dirname, '..', 'server');
const SHOTS = path.join(__dirname, 'screenshots');
fs.mkdirSync(SHOTS, { recursive: true });
const OFFSET = 7 * 3600e3;
const toBkk = (ms) => new Date(ms + OFFSET).toISOString().slice(0, 19) + '+07:00';
const hhmm = (ms) => new Date(ms + OFFSET).toISOString().slice(11, 16);
const bkkDate = (ms = Date.now()) => toBkk(ms).slice(0, 10);
const endOfBkkDay = (ms = Date.now()) => Date.parse(bkkDate(ms) + 'T23:59:59+07:00');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (s) => Number(String(s).replace(/[^\d]/g, ''));
const tooLate = (min = 30) => endOfBkkDay() - Date.now() < min * 60e3;
/** เวลา HH:mm ในอนาคตของวันนี้ (ค่าเริ่มต้น 11:00 อาจผ่านไปแล้วตอนรัน test) */
const futureHHmm = () => hhmm(Math.min(Date.now() + 2 * 3600e3, endOfBkkDay() - 60e3));

let browser;
test.before(async () => { browser = await chromium.launch(); });
test.after(async () => { if (browser) await browser.close(); });

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

/** start backend จริง — kill เฉพาะ process ที่ start เอง */
async function startServer() {
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qa-fe3-')), 'test.db');
  const port = await freePort();
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.js'],
    { cwd: SERVER_DIR, env: { ...process.env, PORT: String(port), DB_PATH: dbPath } });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server ไม่ start: ' + stderr)), 8000);
    child.stdout.on('data', (d) => { if (/listening/i.test(String(d))) { clearTimeout(t); resolve(); } });
    child.on('exit', (code) => { clearTimeout(t); reject(new Error(`server exit ${code}: ${stderr}`)); });
  });
  const base = `http://127.0.0.1:${port}`;
  async function api(method, p, body) {
    const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : null };
  }
  const close = () => new Promise((r) => { if (child.exitCode !== null || child.signalCode !== null) return r(); child.once('exit', r); child.kill(); });
  return { base, api, close, stderr: () => stderr };
}

async function newDevice({ width = 360, height = 780, scheme = 'light', init } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: scheme, deviceScaleFactor: 1 });
  if (init) await ctx.addInitScript(init);
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (/Failed to load resource: the server responded with a status of 4\d\d/.test(t)) return; // D16
    errors.push(t);
  });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  return { ctx, page, errors };
}

async function gotoOpen(page, base) {
  await page.goto(base + '/open.html');
  await page.waitForSelector('#menu-rows .menu-row');
  await page.waitForLoadState('networkidle');
}
async function gotoSummary(page, base) {
  await page.goto(base + '/summary.html');
  await page.waitForFunction(() => !/กำลังโหลด/.test(document.querySelector('#store').textContent));
  await page.waitForLoadState('networkidle');
}

const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
const rowsLoc = (page) => page.locator('#menu-rows .menu-row');
const rowName = (page, i) => rowsLoc(page).nth(i).locator('.menu-row__name input');
const rowPrice = (page, i) => rowsLoc(page).nth(i).locator('.menu-row__price input');
const rowError = (page, i) => rowsLoc(page).nth(i).locator('.menu-row__error');

/** กรอกฟอร์มเปิดรอบ: items = [{name, price}] (price เป็น string ตามที่พิมพ์) */
async function fillRound(page, { restaurant, items, time }) {
  if (restaurant !== undefined) await page.fill('#restaurant', restaurant);
  for (let i = 0; i < items.length; i++) {
    if ((await rowsLoc(page).count()) <= i) await page.click('#add-item');
    await rowName(page, i).fill(items[i].name);
    await rowPrice(page, i).fill(String(items[i].price));
  }
  if (time !== undefined) await page.fill('#cutoff-time', time);
}

const activeId = (page) => page.evaluate(() => document.activeElement && document.activeElement.id);

async function focusVisible(page) {
  return page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return { ok: false, tag: 'body' };
    const cs = getComputedStyle(el);
    const ok = (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) >= 2) || (cs.boxShadow && cs.boxShadow !== 'none');
    return { ok, tag: el.tagName + (el.id ? '#' + el.id : '') + ' ' + (el.getAttribute('aria-label') || el.textContent.trim().slice(0, 20)) };
  });
}

/** เทียบภาพก่อน / หลัง focus: นับ pixel ที่เปลี่ยนโดย contrast ระหว่างสองสถานะ ≥ 3:1 */
async function focusDelta(page, beforePng, afterPng) {
  return page.evaluate(async ([a, b]) => {
    const load = (b64) => new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.src = 'data:image/png;base64,' + b64; });
    const [ia, ib] = await Promise.all([load(a), load(b)]);
    const px = (img, w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d'); x.drawImage(img, 0, 0); return x.getImageData(0, 0, w, h).data; };
    const w = Math.min(ia.width, ib.width);
    const h = Math.min(ia.height, ib.height);
    const da = px(ia, w, h);
    const db = px(ib, w, h);
    const L = (r, g, bl) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(bl); };
    let best = 1;
    let strong = 0;
    for (let i = 0; i < da.length; i += 4) {
      const l1 = L(da[i], da[i + 1], da[i + 2]);
      const l2 = L(db[i], db[i + 1], db[i + 2]);
      const c = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      if (c > best) best = c;
      if (c >= 3) strong++;
    }
    return { best, strong };
  }, [beforePng.toString('base64'), afterPng.toString('base64')]);
}

/** ปุ่ม / ลิงก์ปุ่ม / ช่องกรอกที่เห็น ต้องสูง ≥ 44px (Design brief) */
async function smallTargets(page) {
  return page.evaluate(() => [...document.querySelectorAll('button, a.btn, input, textarea, select')]
    .filter((b) => b.offsetParent !== null && !b.closest('[hidden]'))
    .map((b) => { const r = b.getBoundingClientRect(); return { t: (b.id || b.textContent.trim() || b.getAttribute('aria-label') || b.tagName).slice(0, 30), w: Math.round(r.width), h: Math.round(r.height), btn: b.tagName === 'BUTTON' }; })
    .filter((x) => x.h < 44 || (x.btn && x.w < 44)));
}

/** อ่านสรุปยอดบนจอ */
async function readSummary(page) {
  return page.evaluate(() => {
    const t = (el) => (el ? el.textContent.trim() : null);
    const n = (s) => Number(String(s).replace(/[^\d]/g, ''));
    return {
      grandTotal: n(t(document.querySelector('#summary .tally__grand'))),
      orderCount: n(t(document.querySelector('#summary .tally__count .num'))),
      byItem: [...document.querySelectorAll('#summary .tally__item')].map((li) => ({
        name: t(li.querySelector('.tally__name')), qty: n(t(li.querySelector('.tally__qty'))), amount: n(t(li.querySelector('.tally__amount .num'))),
      })),
      byPerson: [...document.querySelectorAll('#summary .person')].map((li) => ({
        name: t(li.querySelector('.person__name')), lines: t(li.querySelector('.person__lines')),
        note: t(li.querySelector('.person__note span')) || '', total: n(t(li.querySelector('.person__total .num'))),
      })),
    };
  });
}

/** สิ่งที่จอควรแสดงจาก Summary ของ API (ไม่คำนวณเอง — แค่แปลงรูป) */
function expectedFromApi(s) {
  return {
    grandTotal: s.grandTotal,
    orderCount: s.orderCount,
    byItem: s.byItem.map((it) => ({ name: it.name, qty: it.qty, amount: it.amount })),
    byPerson: s.byPerson.map((p) => ({ name: p.name, lines: p.lines.map((l) => `${l.name} × ${l.qty}`).join(', '), note: p.note || '', total: p.total })),
  };
}

// ════════════════════════════ F1 · หน้าเปิดรอบ ════════════════════════════

test('F1/D11 · เปิดรอบ: ค่าเริ่มต้น 11:00 · VALIDATION แสดง message ของ API ใต้ช่องตาม field (+focus, aria-invalid) · สำเร็จ → server มีรอบตามที่กรอก', async (t) => {
  if (tooLate(150)) { t.skip('ใกล้เที่ยงคืนเกินไป (D10)'); return; }
  const s = await startServer();
  const d = await newDevice({ width: 360, height: 780 });
  t.after(async () => { await d.ctx.close(); await s.close(); });
  const { page } = d;
  const futureMs = Math.min(Date.now() + 2 * 3600e3, endOfBkkDay() - 60e3);
  const FUTURE = hhmm(futureMs);
  const isoOf = (time) => `${bkkDate()}T${time}:00+07:00`;
  const good = [{ name: 'ข้าวมันไก่ต้ม', price: 50 }, { name: 'ข้าวมันไก่ทอด', price: 55 }];

  /** ส่งฟอร์มแล้วเทียบกับ API ที่ส่ง body เดียวกันตรงๆ (BE เป็นคนตัดสิน) */
  async function expectFieldError(label, body, where) {
    const api = await s.api('POST', '/api/rounds', body);
    assert.equal(api.status, 400, `${label}: API ควรตอบ 400 ${JSON.stringify(api.body)}`);
    assert.equal(api.body.error.code, 'VALIDATION');
    await page.click('#open-submit');
    await page.waitForSelector(`${where.msg}:not([hidden])`);
    assert.equal((await page.locator(where.msg).innerText()).trim(), api.body.error.message, `${label}: ต้องแสดง message ของ API ตรงๆ (field ${api.body.error.field})`);
    if (where.input) {
      assert.equal(await page.locator(where.input).getAttribute('aria-invalid'), 'true', `${label}: aria-invalid`);
      assert.equal(await page.evaluate((sel) => document.activeElement === document.querySelector(sel), where.input), true, `${label}: focus ไปช่องที่ผิด`);
    }
    assert.equal(await page.locator('#form-notice').isHidden(), true, `${label}: ต้องไม่เป็น error รวม`);
    return api.body.error;
  }

  await t.test('ค่าเริ่มต้น: เวลาปิดรับ 11:00 · มีแถวเมนู 1 แถว · ลบแถวสุดท้ายไม่ได้ · ไม่มีรอบ = ไม่มีกล่องรอบเดิม', async () => {
    await gotoOpen(page, s.base);
    assert.equal(await page.inputValue('#cutoff-time'), '11:00');
    assert.equal(await rowsLoc(page).count(), 1);
    assert.equal(await rowsLoc(page).nth(0).locator('.menu-row__remove').isDisabled(), true);
    assert.equal(await page.locator('#existing').isHidden(), true);
    assert.equal(await page.locator('#mode-chip').isHidden(), true, 'เสิร์ฟผ่าน backend ต้องใช้ API จริง');
  });

  await t.test('restaurant ว่าง → ใต้ช่องชื่อร้าน', async () => {
    await fillRound(page, { restaurant: '   ', items: good, time: FUTURE });
    const e = await expectFieldError('ร้านว่าง', { restaurant: '   ', cutoffAt: isoOf(FUTURE), items: good }, { msg: '#restaurant-error', input: '#restaurant' });
    assert.equal(e.field, 'restaurant');
    await page.screenshot({ path: path.join(SHOTS, 'fe-3-open-err-restaurant-360.png'), fullPage: true });
  });

  await t.test('restaurant 61 ตัว (D8) → ใต้ช่องชื่อร้าน · 60 ตัวไม่ error ที่ช่องนี้', async () => {
    await page.fill('#restaurant', 'ร'.repeat(61));
    await expectFieldError('ร้าน 61', { restaurant: 'ร'.repeat(61), cutoffAt: isoOf(FUTURE), items: good }, { msg: '#restaurant-error', input: '#restaurant' });
    await page.fill('#restaurant', 'ข้าวมันไก่ป้าแดง');
    assert.equal(await page.locator('#restaurant-error').isHidden(), true, 'แก้ช่องแล้ว error ต้องหาย');
  });

  await t.test('เวลาปิดรับผ่านไปแล้ว (D10 อนาคต) → ใต้ช่องเวลา', async (tt) => {
    const pastMs = Date.now() - 2 * 60e3;
    if (bkkDate(pastMs) !== bkkDate()) { tt.skip('เพิ่งข้ามวัน'); return; }
    const past = hhmm(pastMs);
    await page.fill('#cutoff-time', past);
    const e = await expectFieldError('เวลาอดีต', { restaurant: 'ข้าวมันไก่ป้าแดง', cutoffAt: isoOf(past), items: good }, { msg: '#cutoff-error', input: '#cutoff-time' });
    assert.equal(e.field, 'cutoffAt');
  });

  await t.test('เวลาปิดรับว่าง → ใต้ช่องเวลา (BE ตัดสิน)', async () => {
    await page.fill('#cutoff-time', '');
    await page.click('#open-submit');
    await page.waitForSelector('#cutoff-error:not([hidden])');
    assert.equal(await page.locator('#cutoff-time').getAttribute('aria-invalid'), 'true');
    assert.equal(await page.locator('#form-notice').isHidden(), true);
    await page.fill('#cutoff-time', FUTURE);
  });

  await t.test('items[1].name ว่าง → ใต้แถวที่ 2', async () => {
    await rowName(page, 1).fill('');
    const e = await expectFieldError('เมนู 2 ว่าง', { restaurant: 'ข้าวมันไก่ป้าแดง', cutoffAt: isoOf(FUTURE), items: [good[0], { name: '', price: 55 }] },
      { msg: '#menu-rows .menu-row:nth-child(2) .menu-row__error', input: '#menu-rows .menu-row:nth-child(2) .menu-row__name input' });
    assert.equal(e.field, 'items[1].name');
    assert.equal(await rowError(page, 0).isHidden(), true, 'แถวแรกไม่มี error');
    await rowName(page, 1).fill('ข้าวมันไก่ทอด');
    assert.equal(await rowError(page, 1).isHidden(), true, 'แก้แล้ว error หาย');
  });

  await t.test('items[1].name 61 ตัว (D8) → ใต้แถวที่ 2', async () => {
    await rowName(page, 1).fill('ก'.repeat(61));
    await expectFieldError('เมนู 61', { restaurant: 'ข้าวมันไก่ป้าแดง', cutoffAt: isoOf(FUTURE), items: [good[0], { name: 'ก'.repeat(61), price: 55 }] },
      { msg: '#menu-rows .menu-row:nth-child(2) .menu-row__error', input: '#menu-rows .menu-row:nth-child(2) .menu-row__name input' });
    await rowName(page, 1).fill('ข้าวมันไก่ทอด');
  });

  for (const [typed, sent] of [['0', 0], ['5.5', 5.5], ['10001', 10001], ['-3', -3], ['ห้าสิบ', 'ห้าสิบ'], ['', null]]) {
    await t.test(`items[1].price "${typed}" → ใต้ช่องราคาแถวที่ 2`, async () => {
      await rowPrice(page, 1).fill(typed);
      const e = await expectFieldError(`ราคา ${typed}`, { restaurant: 'ข้าวมันไก่ป้าแดง', cutoffAt: isoOf(FUTURE), items: [good[0], { name: 'ข้าวมันไก่ทอด', price: sent }] },
        { msg: '#menu-rows .menu-row:nth-child(2) .menu-row__error', input: '#menu-rows .menu-row:nth-child(2) .menu-row__price input' });
      assert.equal(e.field, 'items[1].price');
    });
  }

  await t.test('field: null / field ที่ไม่มีช่อง → แสดงเป็นข้อความรวม (D11)', async () => {
    await rowPrice(page, 1).fill('55');
    await page.route('**/api/rounds', (route) => route.request().method() === 'POST'
      ? route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: { code: 'VALIDATION', field: null, message: 'ข้อมูลรอบสั่งต้องเป็น JSON object' } }) })
      : route.continue());
    await page.click('#open-submit');
    await page.waitForSelector('#form-notice:not([hidden])');
    assert.match(await page.locator('#form-notice').innerText(), /ข้อมูลรอบสั่งต้องเป็น JSON object/);
    await page.unroute('**/api/rounds');
  });

  await t.test('เพิ่ม / ลบเมนู: เพิ่มได้ถึง 30 (contract) แล้วปุ่มเพิ่ม disabled · ลบแถวกลางแล้วส่งเฉพาะที่เหลือ', async () => {
    while ((await rowsLoc(page).count()) < 30) await page.click('#add-item');
    assert.equal(await page.locator('#add-item').isDisabled(), true, 'ครบ 30 แล้วเพิ่มไม่ได้');
    // ลบแถวว่างทิ้งจนเหลือ 3 แล้วลบแถวกลาง
    while ((await rowsLoc(page).count()) > 3) await rowsLoc(page).last().locator('.menu-row__remove').click();
    assert.equal(await page.locator('#add-item').isDisabled(), false);
    await rowName(page, 2).fill('เกาเหลา');
    await rowPrice(page, 2).fill('40');
    await rowsLoc(page).nth(1).locator('.menu-row__remove').click();
    assert.equal(await rowsLoc(page).count(), 2);
    assert.equal(await rowName(page, 1).inputValue(), 'เกาเหลา');
    assert.match(await rowsLoc(page).nth(1).locator('.menu-row__remove').getAttribute('aria-label'), /2/, 'label เลขรายการต้องเรียงใหม่');
  });

  await t.test('สำเร็จ 201 → ไปหน้าสรุป · server มีรอบตรงตามที่กรอก (ตัดช่องว่าง, ราคา 1,000, เวลาปิดวันนี้)', async () => {
    await page.fill('#restaurant', '  ข้าวมันไก่ป้าแดง  ');
    await rowPrice(page, 1).fill('1,000');
    await page.fill('#cutoff-time', FUTURE);
    await Promise.all([page.waitForURL(/summary\.html/), page.click('#open-submit')]);
    const today = await s.api('GET', '/api/rounds/today');
    assert.equal(today.status, 200);
    assert.equal(today.body.restaurant, 'ข้าวมันไก่ป้าแดง');
    assert.deepEqual(today.body.items.map((i) => [i.name, i.price]), [['ข้าวมันไก่ต้ม', 50], ['เกาเหลา', 1000]]);
    assert.equal(today.body.cutoffAt, isoOf(FUTURE));
    await page.waitForSelector('#sum-section:not([hidden])');
    assert.equal(await page.locator('#store').textContent(), 'ข้าวมันไก่ป้าแดง');
    assert.equal(d.errors.length, 0, d.errors.join('\n'));
  });
});

test('F1 · ROUND_EXISTS: message ของ API ตรงๆ แล้วพาไปดูรอบที่มีอยู่ · เปิดพร้อมกัน 2 เครื่อง → รอบเดียว อีกเครื่องเห็น ROUND_EXISTS', async (t) => {
  if (tooLate(150)) { t.skip('ใกล้เที่ยงคืนเกินไป (D10)'); return; }
  const s = await startServer();
  const A = await newDevice({ width: 360 });
  const B = await newDevice({ width: 1280, height: 900, scheme: 'dark' });
  t.after(async () => { await A.ctx.close(); await B.ctx.close(); await s.close(); });
  const FUTURE = hhmm(Math.min(Date.now() + 2 * 3600e3, endOfBkkDay() - 60e3));
  await gotoOpen(A.page, s.base);
  await gotoOpen(B.page, s.base);
  await fillRound(A.page, { restaurant: 'ร้าน A', items: [{ name: 'เมนู A', price: 50 }], time: FUTURE });
  await fillRound(B.page, { restaurant: 'ร้าน B', items: [{ name: 'เมนู B', price: 60 }], time: FUTURE });
  await Promise.all([A.page.click('#open-submit'), B.page.click('#open-submit')]);
  await sleep(1500);
  const today = await s.api('GET', '/api/rounds/today');
  assert.equal(today.status, 200);
  const winner = today.body.restaurant === 'ร้าน A' ? A : B;
  const loser = winner === A ? B : A;
  assert.match(winner.page.url(), /summary\.html/, 'เครื่องที่ชนะไปหน้าสรุป');
  const api = await s.api('POST', '/api/rounds', { restaurant: 'x', cutoffAt: toBkk(Date.now() + 3600e3), items: [{ name: 'y', price: 1 }] });
  assert.equal(api.body.error.code, 'ROUND_EXISTS');
  await loser.page.waitForSelector('#existing:not([hidden])');
  assert.equal((await loser.page.locator('#existing .existing__title').innerText()).trim(), api.body.error.message, 'แสดง message ของ ROUND_EXISTS ตรงๆ');
  await loser.page.waitForFunction(() => document.querySelector('#existing-meta').textContent.length > 0);
  assert.match(await loser.page.locator('#existing-meta').innerText(), new RegExp(today.body.restaurant), 'บอกรอบที่มีอยู่จริง');
  assert.equal(await loser.page.evaluate(() => document.activeElement.classList.contains('existing__go')), true, 'focus ไปที่ปุ่มดูรอบที่มีอยู่');
  await loser.page.screenshot({ path: path.join(SHOTS, `fe-3-open-round-exists-${loser === A ? '360' : '1280-dark'}.png`), fullPage: true });
  await Promise.all([loser.page.waitForURL(/summary\.html/), loser.page.click('#existing .existing__go')]);
  await loser.page.waitForSelector('#sum-section:not([hidden])');
  assert.equal(await loser.page.locator('#store').textContent(), today.body.restaurant, 'พาไปดูรอบที่มีอยู่');
  // เปิดหน้าเปิดรอบตอนมีรอบแล้ว → บอกตั้งแต่แรก
  await gotoOpen(A.page, s.base);
  await A.page.waitForSelector('#existing:not([hidden])');
  assert.equal(await A.page.locator('#existing a.existing__go').getAttribute('href'), 'summary.html');
  assert.deepEqual([...A.errors, ...B.errors], []);
});

test('F1/D10 · เวลาปิดรับต้องอยู่วันเดียวกับรอบตามปฏิทินไทย: 23:59 วันนี้ผ่าน · ส่ง cutoffAt เป็นวันนี้ +07:00 แม้เครื่องตั้ง timezone อื่น', async (t) => {
  if (tooLate(2)) { t.skip('ใกล้เที่ยงคืนเกินไป'); return; }
  const s = await startServer();
  // เครื่องอยู่ timezone นิวยอร์ก (วันที่ในเครื่องอาจคนละวันกับไทย) — วันที่ของรอบต้องเป็นวันไทย
  const ctx = await browser.newContext({ viewport: { width: 360, height: 780 }, timezoneId: 'America/New_York' });
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  t.after(async () => { await ctx.close(); await s.close(); });
  let sent = null;
  page.on('request', (r) => { if (r.method() === 'POST' && r.url().endsWith('/api/rounds')) sent = JSON.parse(r.postData()); });
  await gotoOpen(page, s.base);
  await fillRound(page, { restaurant: 'ร้านดึก', items: [{ name: 'โจ๊ก', price: 40 }], time: '23:59' });
  await Promise.all([page.waitForURL(/summary\.html/), page.click('#open-submit')]);
  assert.equal(sent.cutoffAt, `${bkkDate()}T23:59:00+07:00`);
  const today = await s.api('GET', '/api/rounds/today');
  assert.equal(today.body.cutoffAt, `${bkkDate()}T23:59:00+07:00`);
  assert.equal(today.body.date, bkkDate());
  assert.deepEqual(errors, []);
});

test('F8 · หน้าเปิดรอบ: คีย์บอร์ดอย่างเดียวเปิดรอบได้ · เห็น focus ทุกจุด · ปุ่ม ≥ 44px · 360 light / 1280 dark ไม่มี scroll แนวนอน', async (t) => {
  if (tooLate(150)) { t.skip('ใกล้เที่ยงคืนเกินไป'); return; }
  const s = await startServer();
  t.after(() => s.close());
  for (const [w, scheme] of [[360, 'light'], [1280, 'dark']]) {
    await t.test(`${w} ${scheme}`, async () => {
      const d = await newDevice({ width: w, height: 800, scheme });
      try {
        const { page } = d;
        await gotoOpen(page, s.base);
        assert.equal(await noHScroll(page), true);
        assert.deepEqual(await smallTargets(page), [], 'ปุ่ม/ช่อง ≥ 44px');
        // Tab ตั้งแต่ต้นหน้า (เดินเฉพาะในหน้า: ข้ามจุดที่ focus ออกไปที่ browser) — ทุกจุดต้องเห็น focus ชัด
        // ช่องเวลา (native time input) มีหลายจุด focus ข้างใน (ชั่วโมง / นาที / AM-PM / ปุ่มนาฬิกา) ที่ :focus-visible ใช้ตรวจไม่ได้
        // → วัดจาก pixel: ส่วนที่เปลี่ยนระหว่าง focus กับไม่ focus ต้อง contrast ≥ 3:1 (WCAG 2.4.13 / 1.4.11) อย่างน้อย 40 pixel
        const timeBaseline = await page.locator('.cutoff-field').screenshot();
        const seen = [];
        const bad = [];
        let timeStop = 0;
        for (let k = 0; k < 14; k++) {
          await page.keyboard.press('Tab');
          if ((await activeId(page)) === 'cutoff-time') {
            timeStop++;
            const shot = await page.locator('.cutoff-field').screenshot();
            if (w === 360 || scheme === 'dark') fs.writeFileSync(path.join(SHOTS, `fe-3-open-time-focus-${w}-${scheme}-${timeStop}.png`), shot);
            const ring = await focusDelta(page, timeBaseline, shot);
            seen.push(`#cutoff-time[${timeStop}]`);
            if (ring.strong < 40) bad.push(`#cutoff-time จุดที่ ${timeStop}: pixel ที่ contrast ≥ 3:1 มีแค่ ${ring.strong} (สูงสุด ${ring.best.toFixed(2)}:1)`);
            continue;
          }
          const f = await focusVisible(page);
          seen.push(f.tag);
          if (!f.ok && f.tag !== 'body') bad.push(f.tag);
        }
        for (const id of ['restaurant', 'cutoff-time', 'open-submit', 'add-item']) assert.ok(seen.some((x) => x.includes('#' + id)), `Tab ต้องถึง #${id}: ${seen.join(' | ')}`);
        assert.deepEqual(bad, [], 'focus ต้องเห็นชัด');
        if (w === 360) await page.screenshot({ path: path.join(SHOTS, 'fe-3-open-keyboard-360.png') });
        // เปิดรอบด้วยคีย์บอร์ดอย่างเดียว
        await page.focus('#restaurant');
        await page.keyboard.type('ร้านคีย์บอร์ด');
        await page.keyboard.press('Tab');
        await page.keyboard.type('ข้าวผัด');
        await page.keyboard.press('Tab');
        await page.keyboard.type('60');
        await page.keyboard.press('Tab'); // ปุ่มลบ (disabled → ข้าม) / ปุ่มเพิ่ม
        if ((await activeId(page)) !== 'add-item') await page.keyboard.press('Tab');
        assert.equal(await activeId(page), 'add-item');
        await page.keyboard.press('Enter');
        assert.equal(await rowsLoc(page).count(), 2, 'Enter ที่ปุ่มเพิ่ม = เพิ่มแถว');
        assert.equal(await page.evaluate(() => document.activeElement === document.querySelector('#menu-rows .menu-row:nth-child(2) input')), true, 'focus ไปแถวใหม่');
        await page.keyboard.type('ข้าวผัดกุ้ง');
        await page.keyboard.press('Tab');
        await page.keyboard.type('80');
        await page.keyboard.press('Tab');
        assert.match(await page.evaluate(() => document.activeElement.getAttribute('aria-label') || ''), /ลบเมนูรายการที่ 2/);
        await page.keyboard.press('Space');
        assert.equal(await rowsLoc(page).count(), 1, 'Space ที่ปุ่มลบ = ลบแถว');
        await page.focus('#cutoff-time');
        const fut = new Date(Math.min(Date.now() + 2 * 3600e3, endOfBkkDay() - 60e3) + OFFSET);
        await page.fill('#cutoff-time', fut.toISOString().slice(11, 16)); // ช่องเวลา: ค่าผ่านคีย์บอร์ดของ native control
        await page.focus('#restaurant');
        if (w === 360) {
          await Promise.all([page.waitForURL(/summary\.html/), page.keyboard.press('Enter')]);
          const today = await s.api('GET', '/api/rounds/today');
          assert.equal(today.body.restaurant, 'ร้านคีย์บอร์ด');
          assert.deepEqual(today.body.items.map((i) => [i.name, i.price]), [['ข้าวผัด', 60]]);
        }
        assert.deepEqual(d.errors, []);
      } finally { await d.ctx.close(); }
    });
  }
});

// ════════════════════════════ F7 · หน้าสรุปยอด ════════════════════════════

/** รอบ 4 เมนู + order แบบ D16: เท่ากันตามลำดับเมนู · แทนที่ไม่เลื่อน · ยกเลิกไม่นับ · เมนูไม่มีคนสั่งไม่แสดง */
async function seedSummary(s, cutoffMs) {
  const r = await s.api('POST', '/api/rounds', {
    restaurant: 'ข้าวมันไก่ป้าแดง', cutoffAt: toBkk(cutoffMs),
    items: [{ name: 'ข้าวมันไก่ต้ม', price: 50 }, { name: 'ข้าวมันไก่ทอด', price: 55 }, { name: 'เกาเหลา', price: 40 }, { name: 'น้ำซุป', price: 10 }],
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const R = `/api/rounds/${r.body.id}`;
  const put = async (name, lines, note) => {
    const x = await s.api('PUT', `${R}/orders`, { name, lines: lines.map(([i, q]) => ({ itemId: `i${i}`, qty: q })), note });
    assert.equal(x.status, 200, JSON.stringify(x.body));
  };
  await put('Hi', [[2, 1]], 'ไม่เอาหนัง');                 // แทนที่ทีหลัง
  await put('บอม', [[3, 2]], '');
  await put('แนน', [[1, 1], [3, 1]], 'น้ำจิ้มแยก');
  await put('ต้น', [[1, 5]], '');                          // ยกเลิกทีหลัง
  await put(' hi ', [[1, 1], [2, 2]], 'ไม่เผ็ด');           // แทนที่ Hi — ลำดับคงเดิม, ชื่อตัวพิมพ์ล่าสุด (D15)
  assert.equal((await s.api('DELETE', `${R}/orders/${encodeURIComponent('ต้น')}`)).status, 204);
  return { round: r.body, R, put };
}

test('F7/D16 · สรุปยอดบนจอตรงกับ GET /summary ทุกจุด (ยอดรวม, จำนวนคน, ยอดต่อเมนูตามลำดับ API, ยอดต่อคน) · ไม่คำนวณ/เรียงเอง', async (t) => {
  if (tooLate(60)) { t.skip('ใกล้เที่ยงคืนเกินไป'); return; }
  const s = await startServer();
  const { R } = await seedSummary(s, Math.min(Date.now() + 2 * 3600e3, endOfBkkDay()));
  t.after(() => s.close());
  const api = (await s.api('GET', `${R}/summary`)).body;
  // จำนวน: ต้ม 1+1=2, ทอด 2, เกาเหลา 2+1=3 → เกาเหลา, ต้ม, ทอด (เท่ากันตามลำดับเมนู) · น้ำซุปไม่มี
  assert.deepEqual(api.byItem.map((x) => x.name), ['เกาเหลา', 'ข้าวมันไก่ต้ม', 'ข้าวมันไก่ทอด'], 'precondition D16 ของ API');
  assert.deepEqual(api.byPerson.map((x) => x.name), ['hi', 'บอม', 'แนน']);
  for (const [w, scheme] of [[360, 'light'], [1280, 'dark']]) {
    await t.test(`${w} ${scheme}`, async () => {
      const d = await newDevice({ width: w, height: 900, scheme });
      try {
        await gotoSummary(d.page, s.base);
        await d.page.waitForSelector('#summary .tally__item');
        assert.deepEqual(await readSummary(d.page), expectedFromApi(api));
        assert.equal(await d.page.locator('#store').textContent(), 'ข้าวมันไก่ป้าแดง');
        assert.equal(await d.page.locator('#summary').getByText('น้ำซุป').count(), 0, 'เมนูที่ไม่มีคนสั่งไม่แสดง (D16)');
        assert.equal(await d.page.locator('#summary').getByText('ต้น', { exact: true }).count(), 0, 'order ที่ยกเลิกไม่แสดง');
        // ยอดต่อเมนูตัวใหญ่ (Design brief) — ใหญ่กว่าตัวหนังสือรายคนชัดเจน
        const sizes = await d.page.evaluate(() => ({
          qty: parseFloat(getComputedStyle(document.querySelector('.tally__qty')).fontSize),
          body: parseFloat(getComputedStyle(document.querySelector('.person__lines')).fontSize),
        }));
        assert.ok(sizes.qty >= 1.5 * sizes.body && sizes.qty >= 24, `ยอดต่อเมนูต้องตัวใหญ่: qty ${sizes.qty}px vs ${sizes.body}px`);
        assert.equal(await noHScroll(d.page), true);
        await d.page.screenshot({ path: path.join(SHOTS, `fe-3-summary-${w}-${scheme}.png`), fullPage: true });
        assert.deepEqual(d.errors, []);
      } finally { await d.ctx.close(); }
    });
  }
});

test('F7 · รอบยังไม่มีใครสั่ง → 0 บาท / 0 คน / "ยังไม่มีใครสั่ง" · NO_ROUND → message ของ API + ทางไปหน้าเปิดรอบ', async (t) => {
  if (tooLate(60)) { t.skip('ใกล้เที่ยงคืนเกินไป'); return; }
  const s = await startServer();
  const d = await newDevice({ width: 360 });
  t.after(async () => { await d.ctx.close(); await s.close(); });
  const nr = await s.api('GET', '/api/rounds/today');
  assert.equal(nr.body.error.code, 'NO_ROUND');
  await gotoSummary(d.page, s.base);
  await d.page.waitForSelector('#no-round:not([hidden])');
  assert.ok((await d.page.locator('#no-round').innerText()).includes(nr.body.error.message), 'message ของ NO_ROUND ตรงๆ');
  assert.equal(await d.page.locator('#sum-section').isHidden(), true);
  await d.page.screenshot({ path: path.join(SHOTS, 'fe-3-summary-no-round-360.png'), fullPage: true });
  await Promise.all([d.page.waitForURL(/open\.html/), d.page.locator('#no-round button, #no-round a').first().click()]);
  const r = await s.api('POST', '/api/rounds', { restaurant: 'ร้านว่าง', cutoffAt: toBkk(Math.min(Date.now() + 3600e3, endOfBkkDay())), items: [{ name: 'ก', price: 1 }] });
  await gotoSummary(d.page, s.base);
  await d.page.waitForSelector('#sum-section:not([hidden])');
  const api = (await s.api('GET', `/api/rounds/${r.body.id}/summary`)).body;
  assert.deepEqual(await readSummary(d.page), expectedFromApi(api));
  assert.equal(await d.page.locator('#summary .tally__none').count(), 2, 'ยังไม่มีใครสั่ง ทั้งสองส่วน');
  assert.deepEqual(d.errors, []);
});

test('F7 · อัปเดตสด: ปุ่มรีเฟรช + รีเฟรชเองภายใน ~20 วิ · ถึงเวลาปิด → "ปิดรับแล้ว" + ยอดสุดท้ายตรง API โดยไม่ reload', async (t) => {
  if (tooLate(5)) { t.skip('ใกล้เที่ยงคืนเกินไป'); return; }
  const s = await startServer();
  const cutoffMs = Date.now() + 40e3;
  const { R, put } = await seedSummary(s, cutoffMs);
  const d = await newDevice({ width: 360, height: 800 });
  t.after(async () => { await d.ctx.close(); await s.close(); });
  const { page } = d;
  await gotoSummary(page, s.base);
  await page.waitForSelector('#summary .tally__item');
  await page.evaluate(() => { window.__noReload = 1; });
  assert.equal(await page.getAttribute('#cutoff', 'data-state'), 'soon', '< 10 นาที');

  await t.test('ปุ่มรีเฟรช → ตัวเลขตรง API ใหม่', async () => {
    await put('ใหม่', [[4, 3]], '');
    await page.click('#refresh');
    await page.waitForFunction(() => document.querySelectorAll('#summary .person').length === 4);
    assert.deepEqual(await readSummary(page), expectedFromApi((await s.api('GET', `${R}/summary`)).body));
  });

  await t.test('รีเฟรชเองโดยไม่ต้องกด (≤ 25 วิ)', async () => {
    await put('ออโต้', [[2, 1]], 'auto');
    await page.waitForFunction(() => document.querySelectorAll('#summary .person').length === 5, null, { timeout: 25e3 });
    assert.deepEqual(await readSummary(page), expectedFromApi((await s.api('GET', `${R}/summary`)).body));
  });

  await t.test('ถึงเวลาปิด → ปิดรับแล้วเอง + ยอดสุดท้าย (order ที่เข้ามาก่อนปิด 2 วิ อยู่ในยอด)', async () => {
    const wait = cutoffMs - Date.now() - 2500;
    if (wait > 0) await sleep(wait);
    await put('ทันเวลา', [[1, 2]], '');
    await page.waitForFunction(() => document.querySelector('#cutoff').getAttribute('data-state') === 'closed', null, { timeout: 10e3 });
    await page.waitForFunction(() => /ยอดสุดท้าย/.test(document.querySelector('#updated').textContent), null, { timeout: 10e3 });
    const api = (await s.api('GET', `${R}/summary`)).body;
    assert.ok(api.byPerson.some((p) => p.name === 'ทันเวลา'));
    assert.deepEqual(await readSummary(page), expectedFromApi(api));
    assert.equal(await page.evaluate(() => window.__noReload), 1, 'ต้องไม่ reload');
    assert.match(await page.locator('#cutoff').innerText(), /ปิดรับแล้ว/);
    await page.screenshot({ path: path.join(SHOTS, 'fe-3-summary-closed-360.png'), fullPage: true });
    assert.deepEqual(d.errors, []);
  });
});

test('F7/D2 · หน้าสรุปนับถอยหลังจาก serverNow (นาฬิกาเครื่องเร็ว 3 ชม. ยังเห็นเปิดอยู่)', async (t) => {
  if (tooLate(60)) { t.skip('ใกล้เที่ยงคืนเกินไป'); return; }
  const s = await startServer();
  const cutoffMs = Math.min(Date.now() + 30 * 60e3, endOfBkkDay());
  await seedSummary(s, cutoffMs);
  const d = await newDevice({ init: () => { const off = 3 * 3600e3; const N = Date.now; Date.now = () => N() + off; const D = Date; globalThis.Date = class extends D { constructor(...a) { if (a.length) super(...a); else super(N() + off); } static now() { return N() + off; } }; } });
  t.after(async () => { await d.ctx.close(); await s.close(); });
  await gotoSummary(d.page, s.base);
  await d.page.waitForSelector('#summary .tally__item');
  assert.notEqual(await d.page.getAttribute('#cutoff', 'data-state'), 'closed');
  const txt = (await d.page.locator('.cutoff__count').textContent()).trim();
  const sec = txt.split(':').map(Number).reduce((a, n) => a * 60 + n, 0);
  assert.ok(Math.abs(sec - (cutoffMs - Date.now()) / 1000) <= 5, `นับ ${txt} ควรใกล้ ${(cutoffMs - Date.now()) / 1000}s`);
  assert.deepEqual(d.errors, []);
});

// ════════════════════════════ F8 / ความปลอดภัย ════════════════════════════

test('F8 · 360px ค่ายาวสุดตาม D8 (ร้าน/เมนู 60 ไม่มีวรรค, ราคา 10,000, ชื่อ 40, หมายเหตุ 100, ยอดหลักล้าน) ไม่มี scroll แนวนอน ทั้งสองหน้า + สถานะ error', async (t) => {
  if (tooLate(60)) { t.skip('ใกล้เที่ยงคืนเกินไป'); return; }
  const s = await startServer();
  t.after(() => s.close());
  const items = Array.from({ length: 30 }, (_, i) => ({ name: (i % 2 ? 'W' : 'ก').repeat(57) + String(i).padStart(3, '0'), price: 10000 }));
  const r = await s.api('POST', '/api/rounds', { restaurant: 'R'.repeat(60), cutoffAt: toBkk(Math.min(Date.now() + 3600e3, endOfBkkDay())), items });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  for (let k = 0; k < 12; k++) {
    const x = await s.api('PUT', `/api/rounds/${r.body.id}/orders`, { name: String.fromCharCode(65 + k).repeat(40), lines: [0, 1, 2].map((j) => ({ itemId: `i${(k + j) % 30 + 1}`, qty: 10 })), note: 'N'.repeat(100) });
    assert.equal(x.status, 200, JSON.stringify(x.body));
  }
  const api = (await s.api('GET', `/api/rounds/${r.body.id}/summary`)).body;
  assert.ok(api.grandTotal >= 1e6);
  for (const scheme of ['light', 'dark']) {
    const d = await newDevice({ width: 360, height: 640, scheme });
    try {
      const { page } = d;
      await gotoSummary(page, s.base);
      await page.waitForSelector('#summary .tally__item');
      assert.deepEqual(await readSummary(page), expectedFromApi(api), 'ค่ายาวยังตรงกับ API');
      assert.equal(await noHScroll(page), true, `summary ${scheme}: scrollWidth ${await page.evaluate(() => document.documentElement.scrollWidth)}`);
      assert.deepEqual(await smallTargets(page), []);
      await page.screenshot({ path: path.join(SHOTS, `fe-3-summary-long-360-${scheme}.png`), fullPage: true });
      // หน้าเปิดรอบ: ค่ายาว + error ยาว (message มีชื่อเมนู 60 ตัว) + กล่องรอบเดิม
      await gotoOpen(page, s.base);
      await page.waitForSelector('#existing:not([hidden])');
      await page.waitForFunction(() => document.querySelector('#existing-meta').textContent.length > 0);
      await fillRound(page, { restaurant: 'R'.repeat(61), items: [{ name: 'W'.repeat(60), price: '10001' }, { name: 'ก'.repeat(60), price: '10000' }], time: futureHHmm() });
      await page.click('#open-submit');
      await page.waitForSelector('#restaurant-error:not([hidden])');
      assert.equal(await noHScroll(page), true, `open (error ร้าน) ${scheme}`);
      await page.fill('#restaurant', 'R'.repeat(60));
      await page.click('#open-submit');
      await page.waitForSelector('#menu-rows .menu-row:nth-child(1) .menu-row__error:not([hidden])');
      assert.match(await rowError(page, 0).innerText(), /W{60}/, 'message ราคาของ API มีชื่อเมนูยาว');
      assert.equal(await noHScroll(page), true, `open (error ราคา) ${scheme}`);
      assert.deepEqual(await smallTargets(page), []);
      await page.screenshot({ path: path.join(SHOTS, `fe-3-open-long-360-${scheme}.png`), fullPage: true });
      assert.deepEqual(d.errors, []);
    } finally { await d.ctx.close(); }
  }
});

test('F8 · ค่าปกติ (ไทยมีวรรค, ราคา/ยอดหลักหมื่น-แสน) ตัดบรรทัดเหมือนไม่มี overflow-wrap ไม่ตัดกลางตัวเลข · 360 light / 1280 dark', async (t) => {
  if (tooLate(60)) { t.skip('ใกล้เที่ยงคืนเกินไป'); return; }
  const s = await startServer();
  t.after(() => s.close());
  const r = await s.api('POST', '/api/rounds', {
    restaurant: 'ข้าวมันไก่เจ้าเก่าประตูน้ำ สาขาสีลม ซอย 5', cutoffAt: toBkk(Math.min(Date.now() + 3600e3, endOfBkkDay())),
    items: [{ name: 'ข้าวมันไก่ต้ม + ไก่ทอด (พิเศษ) เพิ่มเลือด', price: 10000 }, { name: 'ก๋วยเตี๋ยวเรือน้ำตกหมูตุ๋น เส้นเล็ก', price: 9999 }, { name: 'เกาเหลา', price: 45 }],
  });
  for (const [n, lines, note] of [['สมศักดิ์ รักษ์ศรีสวัสดิ์', [[1, 10], [2, 10]], 'ไม่เผ็ด ไม่ใส่ผักชี ขอน้ำจิ้มแยก 2 ถุง โทร 081-234-5678'], ['แนน', [[3, 1]], ''], ['Hi', [[2, 3], [3, 2]], 'ไม่เอาหนัง']]) {
    await s.api('PUT', `/api/rounds/${r.body.id}/orders`, { name: n, lines: lines.map(([i, q]) => ({ itemId: `i${i}`, qty: q })), note });
  }
  for (const [w, scheme] of [[360, 'light'], [1280, 'dark']]) {
    const d = await newDevice({ width: w, height: 900, scheme });
    try {
      const problems = [];
      const check = async (label) => {
        const a = await wrapAudit(d.page);
        if (a.scrollWidth > w) problems.push(`${label}: scrollWidth ${a.scrollWidth}`);
        if (a.baselineOverflow) problems.push(`${label}: ล้นจอแม้ไม่มี overflow-wrap`);
        for (const x of a.diffs) problems.push(`${label}: ${x}`);
        for (const x of a.brokenNums) problems.push(`${label}: ตัวเลขถูกตัด ${x}`);
      };
      await gotoSummary(d.page, s.base);
      await d.page.waitForSelector('#summary .tally__item');
      await check('summary');
      await gotoOpen(d.page, s.base);
      await d.page.waitForFunction(() => document.querySelector('#existing-meta') && document.querySelector('#existing-meta').textContent.length > 0);
      await fillRound(d.page, { restaurant: 'ข้าวแกงป้าศรี', items: [{ name: 'แกงเขียวหวานไก่', price: '10,000' }, { name: 'ผัดกะเพราหมูสับ', price: '0' }], time: futureHHmm() });
      await d.page.click('#open-submit');
      await d.page.waitForSelector('#menu-rows .menu-row:nth-child(2) .menu-row__error:not([hidden])');
      await check('open + error');
      await d.page.screenshot({ path: path.join(SHOTS, `fe-3-open-err-${w}-${scheme}.png`), fullPage: true });
      assert.deepEqual(problems, []);
      assert.deepEqual(d.errors, []);
    } finally { await d.ctx.close(); }
  }
});

test('F8 · dark mode ตามเครื่อง ทั้งสองหน้า (สีพื้น/ตัวหนังสือเปลี่ยน, contrast พอ) · หน้าสรุปใช้คีย์บอร์ดได้ เห็น focus', async (t) => {
  if (tooLate(60)) { t.skip('ใกล้เที่ยงคืนเกินไป'); return; }
  const s = await startServer();
  await seedSummary(s, Math.min(Date.now() + 2 * 3600e3, endOfBkkDay()));
  t.after(() => s.close());
  const lum = (rgb) => { const [r, g, b] = rgb.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const colors = {};
  for (const scheme of ['light', 'dark']) {
    const d = await newDevice({ width: 360, scheme });
    try {
      for (const [pg, go] of [['summary', gotoSummary], ['open', gotoOpen]]) {
        await go(d.page, s.base);
        colors[`${pg}-${scheme}`] = await d.page.evaluate(() => ({ bg: getComputedStyle(document.body).backgroundColor, fg: getComputedStyle(document.body).color }));
      }
      // คีย์บอร์ดบนหน้าสรุป
      await gotoSummary(d.page, s.base);
      await d.page.waitForSelector('#summary .tally__item');
      const seen = [];
      const bad = [];
      for (let k = 0; k < 8; k++) {
        await d.page.keyboard.press('Tab');
        const f = await focusVisible(d.page);
        seen.push(f.tag);
        if (!f.ok && f.tag !== 'body') bad.push(f.tag); // body = Tab วนออกไปที่ browser แล้ว
      }
      assert.deepEqual(bad, [], 'focus ต้องเห็นชัด');
      assert.ok(seen.some((x) => x.includes('#refresh')), `Tab ต้องถึงปุ่มรีเฟรช: ${seen.join(' | ')}`);
      await d.page.focus('#refresh');
      await d.page.keyboard.press('Enter');
      await d.page.waitForLoadState('networkidle');
      assert.deepEqual(await smallTargets(d.page), []);
      assert.deepEqual(d.errors, []);
    } finally { await d.ctx.close(); }
  }
  for (const pg of ['summary', 'open']) {
    const L = colors[`${pg}-light`];
    const D = colors[`${pg}-dark`];
    assert.notEqual(L.bg, D.bg, `${pg}: พื้นต้องเปลี่ยนตามเครื่อง`);
    assert.ok(lum(D.bg) < 0.05 && lum(L.bg) > 0.7, `${pg}: light พื้นสว่าง / dark พื้นเข้ม ${L.bg} / ${D.bg}`);
    for (const c of [L, D]) {
      const [a, b] = [lum(c.bg), lum(c.fg)].sort((x, y) => y - x);
      assert.ok((a + 0.05) / (b + 0.05) >= 4.5, `${pg}: contrast ตัวหนังสือ ${c.fg} บน ${c.bg}`);
    }
  }
});

test('XSS · HTML ในชื่อร้าน / เมนู / ชื่อคน / หมายเหตุ แสดงเป็นข้อความ ไม่รันสคริปต์ (หน้าสรุป + กล่องรอบเดิมในหน้าเปิดรอบ)', async (t) => {
  if (tooLate(60)) { t.skip('ใกล้เที่ยงคืนเกินไป'); return; }
  const s = await startServer();
  t.after(() => s.close());
  const X = (k) => `<img src=x onerror="window.__xss='${k}'">`;
  const r = await s.api('POST', '/api/rounds', { restaurant: X('r'), cutoffAt: toBkk(Math.min(Date.now() + 3600e3, endOfBkkDay())), items: [{ name: X('m') + '<b>เมนู</b>', price: 50 }] });
  assert.equal(r.status, 201);
  await s.api('PUT', `/api/rounds/${r.body.id}/orders`, { name: X('n'), lines: [{ itemId: 'i1', qty: 1 }], note: X('note') + '<script>window.__xss="s"</script>' });
  const d = await newDevice({ width: 360 });
  try {
    await gotoSummary(d.page, s.base);
    await d.page.waitForSelector('#summary .tally__item');
    await sleep(300);
    assert.equal(await d.page.evaluate(() => window.__xss), undefined);
    assert.equal(await d.page.locator('#summary img, #store img, #summary b').count(), 0);
    assert.equal(await d.page.locator('#store').textContent(), X('r'));
    assert.ok((await d.page.locator('#summary .tally__name').textContent()).includes('<b>เมนู</b>'));
    await gotoOpen(d.page, s.base);
    await d.page.waitForFunction(() => document.querySelector('#existing-meta').textContent.length > 0);
    await sleep(300);
    assert.equal(await d.page.evaluate(() => window.__xss), undefined);
    assert.equal(await d.page.locator('#existing img').count(), 0);
    // error ที่มีชื่อเมนูเป็น HTML (message ของ API มีชื่อเมนู)
    await fillRound(d.page, { restaurant: 'ร้าน', items: [{ name: X('err'), price: '0' }], time: futureHHmm() });
    await d.page.click('#open-submit');
    await d.page.waitForSelector('#menu-rows .menu-row:nth-child(1) .menu-row__error:not([hidden])');
    await sleep(300);
    assert.equal(await d.page.evaluate(() => window.__xss), undefined);
    assert.equal(await d.page.locator('#menu-rows img').count(), 0);
    assert.deepEqual(d.errors, []);
  } finally { await d.ctx.close(); await s.close(); }
});
