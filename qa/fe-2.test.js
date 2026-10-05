'use strict';

// QA FE-2 — หน้าสั่งอาหาร (web/index.html + order.js) บน API จริง
// เกณฑ์: PRD F2, F3, F4, F5, F6, F8 + DoD "ไม่มี error ใน console" + API contract v2
//        + Decision log D2, D3, D11, D12, D15, D16 (ไม่ใช่คำอธิบายของ Dev)
// ทุก test start backend จริง (`node src/index.js` ใน server/) บน port ว่าง + DB ชั่วคราว แล้วเปิดหน้าเว็บที่ backend เสิร์ฟที่ `/`
// D16: ไม่นับข้อความ "Failed to load resource ... 4xx" ที่เบราว์เซอร์พิมพ์เองเมื่อ API ตอบ 4xx ตาม contract
// Google Fonts ถูกบล็อกใน environment นี้ — ตอบ CSS ว่างแทน (ไม่ใช่ defect)
// รัน: cd server && npm install · cd qa && npm install && PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node --test fe-2.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright');

const SERVER_DIR = path.join(__dirname, '..', 'server');
const SHOTS = path.join(__dirname, 'screenshots');
fs.mkdirSync(SHOTS, { recursive: true });
const OFFSET = 7 * 3600e3;
const toBkk = (ms) => new Date(ms + OFFSET).toISOString().slice(0, 19) + '+07:00';
const hhmm = (ms) => new Date(ms + OFFSET).toISOString().slice(11, 16);
const endOfBkkDay = (ms = Date.now()) => Date.parse(toBkk(ms).slice(0, 10) + 'T23:59:59+07:00');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const enc = encodeURIComponent;
const MENU = [{ name: 'ข้าวมันไก่ต้ม', price: 50 }, { name: 'ข้าวมันไก่ทอด', price: 55 }, { name: 'เกาเหลา', price: 40 }];

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

/** start backend จริง — คืน { base, api(method, path, body), close() } · kill เฉพาะ process ที่ start เอง */
async function startServer() {
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qa-fe2-')), 'test.db');
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
  const close = () => new Promise((r) => { if (child.exitCode !== null) return r(); child.once('exit', r); child.kill(); });
  return { base, api, close };
}

async function openRound(s, cutoffMs) {
  const r = await s.api('POST', '/api/rounds', { restaurant: 'ข้าวมันไก่ป้าแดง', cutoffAt: toBkk(cutoffMs), items: MENU });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
}

/** context ใหม่ = เครื่องใหม่ (localStorage แยก) · เก็บ console error ตาม D16 */
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

async function gotoOrder(page, base) {
  await page.goto(base + '/');
  await page.waitForFunction(() => {
    const s = document.querySelector('#store');
    return s && !/กำลังโหลด/.test(s.textContent);
  });
}

const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
const cutoffState = (page) => page.getAttribute('#cutoff', 'data-state');
const barBtn = (page) => page.locator('#orderbar .orderbar__btn');
const dish = (page, name) => page.locator('#board .dish', { hasText: name });
const plus = (page, name) => dish(page, name).locator('[data-step="1"]');
const minus = (page, name) => dish(page, name).locator('[data-step="-1"]');
const qtyOf = async (page, name) => Number(await dish(page, name).locator('.stepper__qty').textContent());

/** อ่านตัวนับถอยหลังเป็นวินาที ("MM:SS" หรือ "H:MM:SS") */
async function countdownSec(page) {
  const t = (await page.locator('.cutoff__count').textContent()).trim();
  const parts = t.split(':').map(Number);
  assert.ok(parts.every((n) => Number.isInteger(n)), `ตัวนับอ่านไม่ได้: "${t}"`);
  return parts.reduce((a, n) => a * 60 + n, 0);
}

async function setName(page, name) {
  await page.fill('#name', name);
  await page.locator('#name').press('Tab'); // change → lookup (D12)
  await page.waitForLoadState('networkidle');
}

async function focusVisible(page) {
  return page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return { ok: false, tag: 'body' };
    const cs = getComputedStyle(el);
    const ok = (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) >= 2) || (cs.boxShadow && cs.boxShadow !== 'none');
    return { ok, tag: el.tagName + (el.id ? '#' + el.id : '') + ' ' + (el.getAttribute('aria-label') || el.textContent.trim().slice(0, 20)) };
  });
}

// ───────────────────────── F2: ไม่มีรอบ ─────────────────────────
test('F2 ไม่มีรอบวันนี้: แสดง message ของ NO_ROUND ตรงๆ ชัดเจน · 360 light / 1280 dark · ไม่มี scroll แนวนอน · ไม่มี console error', async () => {
  const s = await startServer();
  try {
    const api = await s.api('GET', '/api/rounds/today');
    assert.equal(api.status, 404);
    assert.equal(api.body.error.code, 'NO_ROUND');
    for (const [w, scheme] of [[360, 'light'], [1280, 'dark']]) {
      const { ctx, page, errors } = await newDevice({ width: w, scheme });
      try {
        await gotoOrder(page, s.base);
        await page.waitForSelector('#no-round:not([hidden])');
        const text = await page.locator('#no-round').innerText();
        assert.ok(text.includes(api.body.error.message), `ต้องแสดง message จาก API ตรงๆ: "${api.body.error.message}" ได้ "${text}"`);
        assert.equal(await page.locator('#ordering').isHidden(), true, 'ไม่มีรอบ → ไม่มีฟอร์มสั่ง');
        assert.equal(await noHScroll(page), true);
        await page.screenshot({ path: path.join(SHOTS, `fe-2-no-round-${w}-${scheme}.png`), fullPage: true });
        assert.deepEqual(errors, []);
      } finally { await ctx.close(); }
    }
  } finally { await s.close(); }
});

// ───────────────────────── F2–F5: flow หลักบน API จริง ─────────────────────────
test('F2–F5 + F8 flow หลักบน API จริง (360px light + 1280px dark)', async (t) => {
  if (endOfBkkDay() - Date.now() < 30 * 60e3) { t.skip('ใกล้เที่ยงคืนเกินไป (D10)'); return; }
  const s = await startServer();
  const cutoffMs = Math.min(Date.now() + 2 * 3600e3, endOfBkkDay());
  const round = await openRound(s, cutoffMs);
  const R = `/api/rounds/${round.id}`;
  const A = await newDevice({ width: 360, height: 780 });
  t.after(async () => { await A.ctx.close(); await s.close(); });
  const { page } = A;

  await t.test('F2 · เห็นร้าน เมนู ราคา เวลาปิดรับ (ในจอแรก) + นับถอยหลังตรงเวลา server', async () => {
    await gotoOrder(page, s.base);
    await page.waitForSelector('#board .dish');
    assert.equal(await page.locator('#store').textContent(), 'ข้าวมันไก่ป้าแดง');
    for (const it of MENU) {
      const row = dish(page, it.name);
      assert.equal(await row.count(), 1, it.name);
      assert.match(await row.innerText(), new RegExp(`${it.price}\\s*บาท`), `${it.name} ราคา`);
    }
    assert.equal((await page.locator('.cutoff__time').textContent()).trim(), hhmm(cutoffMs));
    const box = await page.locator('.cutoff__time').boundingBox();
    assert.ok(box && box.y + box.height <= 780, 'เวลาปิดรับต้องเห็นในจอแรก');
    assert.equal(await cutoffState(page), 'open');
    const left = await countdownSec(page);
    const expected = (cutoffMs - Date.now()) / 1000;
    assert.ok(Math.abs(left - expected) <= 3, `นับถอยหลัง ${left}s ควร ≈ ${expected.toFixed(0)}s`);
    assert.equal(await page.locator('#mode-chip').isHidden(), true, 'เสิร์ฟผ่าน backend ต้องใช้ API จริง');
    await sleep(1500);
    assert.ok(await countdownSec(page) < left, 'ตัวนับต้องเดิน');
    await page.screenshot({ path: path.join(SHOTS, 'fe-2-open-360-light.png'), fullPage: true });
  });

  await t.test('F3/D11 · ไม่ใส่ชื่อแล้วกดยืนยัน → message VALIDATION จาก API ข้างช่องชื่อ', async () => {
    await plus(page, 'ข้าวมันไก่ต้ม').click();
    await barBtn(page).click();
    await page.waitForSelector('#name-error:not([hidden])');
    const api = await s.api('PUT', `${R}/orders`, { name: '', lines: [{ itemId: round.items[0].id, qty: 1 }], note: '' });
    assert.equal(api.body.error.field, 'name');
    assert.equal((await page.locator('#name-error').innerText()).trim(), api.body.error.message);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'name', 'focus ไปช่องที่ผิด');
    assert.equal(await page.getAttribute('#name', 'aria-invalid'), 'true');
    assert.equal(await page.locator('#order-notice').isHidden(), true, 'ไม่ใช่ error รวม');
    // ชื่อมีแต่ช่องว่าง
    await page.fill('#name', '    ');
    await barBtn(page).click();
    await page.waitForSelector('#name-error:not([hidden])');
    assert.equal((await s.api('GET', `${R}/summary`)).body.orderCount, 0);
    await page.screenshot({ path: path.join(SHOTS, 'fe-2-validation-name-360.png'), fullPage: false });
    await minus(page, 'ข้าวมันไก่ต้ม').click();
  });

  await t.test('F3 · − / + จำกัด 0–10 · หลายเมนู · เห็นยอดก่อนยืนยัน · ปุ่ม disabled เมื่อยังไม่เลือก', async () => {
    assert.equal(await barBtn(page).isDisabled(), true);
    assert.equal(await minus(page, 'เกาเหลา').isDisabled(), true);
    for (let k = 0; k < 10; k++) await plus(page, 'เกาเหลา').click();
    assert.equal(await qtyOf(page, 'เกาเหลา'), 10);
    assert.equal(await plus(page, 'เกาเหลา').isDisabled(), true, 'จำนวนสูงสุด 10');
    for (let k = 0; k < 10; k++) await minus(page, 'เกาเหลา').click();
    assert.equal(await qtyOf(page, 'เกาเหลา'), 0);
    await plus(page, 'ข้าวมันไก่ต้ม').click();
    await plus(page, 'ข้าวมันไก่ต้ม').click();
    await plus(page, 'ข้าวมันไก่ทอด').click();
    const bar = await page.locator('#orderbar').innerText();
    assert.match(bar, /155/, `ยอดก่อนยืนยัน 2×50+55=155: ${bar}`);
    assert.match(bar, /3 จาน/);
    assert.equal(await barBtn(page).isDisabled(), false);
  });

  await t.test('F3 · ใส่ชื่อ + หมายเหตุ → ยืนยัน → การ์ด "สั่งแล้ว" ตรงกับ Order ที่ API เก็บ · ชื่อจำไว้ในเครื่อง', async () => {
    await page.fill('#name', ' Hi ');
    await page.fill('#note', 'ไม่เอาหนัง');
    await barBtn(page).click();
    await page.waitForSelector('#order-done:not([hidden]) .done__title');
    const g = await s.api('GET', `${R}/orders/Hi`);
    assert.equal(g.status, 200);
    assert.deepEqual(g.body.lines, [{ itemId: round.items[0].id, qty: 2 }, { itemId: round.items[1].id, qty: 1 }]);
    assert.equal(g.body.note, 'ไม่เอาหนัง');
    const card = await page.locator('#order-done').innerText();
    assert.match(card, /สั่งแล้ว/);
    assert.match(card, /Hi/);
    assert.match(card, /ข้าวมันไก่ต้ม[\s\S]*× 2/);
    assert.match(card, /ข้าวมันไก่ทอด[\s\S]*× 1/);
    assert.match(card, /ไม่เอาหนัง/);
    assert.ok(card.includes(String(g.body.total)), `ยอดในการ์ดต้องเป็น total ของ API (${g.body.total})`);
    assert.equal(await page.evaluate(() => localStorage.getItem('teamlunch.name')), 'Hi');
    assert.equal(await noHScroll(page), true);
    await page.screenshot({ path: path.join(SHOTS, 'fe-2-ordered-360-light.png'), fullPage: true });
  });

  await t.test('F3/D12 · reload → ชื่อเดิมเติมให้เอง และเห็น order เดิมโดยไม่ต้องพิมพ์', async () => {
    await page.reload();
    await page.waitForSelector('#order-done:not([hidden]) .done__title');
    assert.equal(await page.inputValue('#name'), 'Hi');
    assert.match(await page.locator('#order-done').innerText(), /× 2/);
  });

  const B = await newDevice({ width: 1280, height: 900, scheme: 'dark' });
  t.after(() => B.ctx.close());

  await t.test('F4/D3 · เครื่องอื่นพิมพ์ " HI " → เห็น order เดิม · แก้ (เติมค่าเดิม) แล้วบันทึก = แทนที่ ไม่เพิ่ม order', async () => {
    const p = B.page;
    await gotoOrder(p, s.base);
    await setName(p, ' HI ');
    await p.waitForSelector('#order-done:not([hidden]) .done__title');
    await p.locator('#order-done [data-act="edit"]').click();
    assert.equal(await qtyOf(p, 'ข้าวมันไก่ต้ม'), 2, 'แก้ order ต้องเติมค่าเดิม');
    assert.equal(await qtyOf(p, 'ข้าวมันไก่ทอด'), 1);
    assert.equal(await p.inputValue('#note'), 'ไม่เอาหนัง');
    assert.match(await barBtn(p).textContent(), /บันทึกการแก้ไข/);
    await minus(p, 'ข้าวมันไก่ทอด').click();
    await plus(p, 'เกาเหลา').click();
    await p.fill('#note', 'ไม่เผ็ด');
    assert.match(await p.locator('#orderbar').innerText(), /140/);
    await barBtn(p).click();
    await p.waitForSelector('#order-done:not([hidden]) .done__title');
    const sum = (await s.api('GET', `${R}/summary`)).body;
    assert.equal(sum.orderCount, 1, 'F4: แทนที่ ไม่ใช่เพิ่ม');
    assert.equal(sum.byPerson[0].total, 140);
    assert.equal(sum.byPerson[0].note, 'ไม่เผ็ด');
    assert.equal(sum.byPerson[0].name, 'HI', 'D15: ชื่อเป็นตัวพิมพ์ล่าสุด');
    assert.ok((await p.locator('#order-done').innerText()).includes('140'));
    assert.equal(await noHScroll(p), true);
    await p.screenshot({ path: path.join(SHOTS, 'fe-2-edited-1280-dark.png'), fullPage: true });
  });

  await t.test('F8 · dark ตามเครื่อง: พื้นหลังต่างจาก light', async () => {
    const bg = (p) => p.evaluate(() => getComputedStyle(document.body).backgroundColor);
    assert.notEqual(await bg(B.page), await bg(page));
  });

  await t.test('F5 · ยกเลิก: ถามยืนยันในการ์ด → ยกเลิก → API ไม่มี order · กลับมาเลือกเมนูได้', async () => {
    await page.reload();
    await page.waitForSelector('#order-done:not([hidden]) .done__title');
    await page.locator('#order-done [data-act="cancel"]').click();
    const yes = page.locator('[data-act="cancel-yes"]');
    await yes.waitFor();
    await page.screenshot({ path: path.join(SHOTS, 'fe-2-cancel-confirm-360.png'), fullPage: false });
    assert.equal((await s.api('GET', `${R}/orders/hi`)).status, 200, 'ยังไม่ลบจนกว่าจะยืนยัน');
    await yes.click();
    await page.waitForSelector('#order-notice:not([hidden])');
    assert.match(await page.locator('#order-notice').innerText(), /ยกเลิก/);
    assert.equal((await s.api('GET', `${R}/orders/hi`)).status, 404);
    assert.equal((await s.api('GET', `${R}/summary`)).body.orderCount, 0);
    assert.equal(await page.locator('#order').isVisible(), true);
    assert.equal(await qtyOf(page, 'ข้าวมันไก่ต้ม'), 0);
  });

  await t.test('F5 · ยกเลิกจากอีกเครื่องไปแล้ว → กดยกเลิกได้ message NOT_FOUND จาก API ตรงๆ', async () => {
    const p = B.page;
    // B ยังเห็นการ์ดเก่า (order ถูกลบจาก A แล้ว)
    await p.locator('#order-done [data-act="cancel"]').click();
    await p.locator('[data-act="cancel-yes"]').click();
    await p.waitForSelector('#order-notice:not([hidden])');
    const api = await s.api('DELETE', `${R}/orders/HI`);
    assert.equal(api.status, 404);
    assert.ok((await p.locator('#order-notice').innerText()).includes(api.body.error.message));
  });

  await t.test('ความปลอดภัย · ชื่อ/หมายเหตุมี HTML → แสดงเป็นตัวอักษร ไม่รันสคริปต์', async () => {
    const evil = '<img src=x onerror="window.__xss=1">';
    await page.fill('#name', evil.slice(0, 40));
    await plus(page, 'เกาเหลา').click();
    await page.fill('#note', '<b>x</b><script>window.__xss=2</script>');
    await barBtn(page).click();
    await page.waitForSelector('#order-done:not([hidden]) .done__title');
    assert.equal(await page.evaluate(() => window.__xss), undefined);
    assert.ok((await page.locator('#order-done').innerText()).includes('<b>x</b>'));
    await page.locator('#order-done [data-act="cancel"]').click();
    await page.locator('[data-act="cancel-yes"]').click();
    await page.waitForSelector('#order-notice:not([hidden])');
  });

  await t.test('F8 · คีย์บอร์ดอย่างเดียว: Tab ไปช่องชื่อ → + เมนู → หมายเหตุ → ยืนยัน · เห็น focus ทุกจุด', async () => {
    const p = (await newDevice({ width: 360, height: 640 }));
    t.after(() => p.ctx.close());
    const pg = p.page;
    await gotoOrder(pg, s.base);
    await pg.waitForSelector('#board .dish');
    const seen = [];
    let reachedName = false;
    for (let k = 0; k < 6 && !reachedName; k++) {
      await pg.keyboard.press('Tab');
      reachedName = await pg.evaluate(() => document.activeElement.id === 'name');
    }
    assert.ok(reachedName, 'Tab ต้องไปถึงช่องชื่อ');
    seen.push(await focusVisible(pg));
    await pg.keyboard.type('คีย์บอร์ด');
    // Tab ไปปุ่ม + ของเมนูแรก แล้วกด Enter 2 ครั้ง, Space 1 ครั้ง
    let onPlus = false;
    for (let k = 0; k < 6 && !onPlus; k++) {
      await pg.keyboard.press('Tab');
      onPlus = await pg.evaluate(() => document.activeElement.getAttribute('data-step') === '1');
      seen.push(await focusVisible(pg));
    }
    assert.ok(onPlus, 'Tab ต้องไปถึงปุ่ม +');
    await pg.keyboard.press('Enter');
    await pg.keyboard.press('Space');
    assert.equal(await qtyOf(pg, 'ข้าวมันไก่ต้ม'), 2);
    let onNote = false;
    for (let k = 0; k < 12 && !onNote; k++) {
      await pg.keyboard.press('Tab');
      onNote = await pg.evaluate(() => document.activeElement.id === 'note');
      seen.push(await focusVisible(pg));
    }
    assert.ok(onNote, 'Tab ต้องไปถึงหมายเหตุ');
    await pg.keyboard.type('ไม่เผ็ด');
    let onConfirm = false;
    for (let k = 0; k < 4 && !onConfirm; k++) {
      await pg.keyboard.press('Tab');
      onConfirm = await pg.evaluate(() => document.activeElement.classList.contains('orderbar__btn'));
      seen.push(await focusVisible(pg));
    }
    assert.ok(onConfirm, 'Tab ต้องไปถึงปุ่มยืนยัน');
    await pg.screenshot({ path: path.join(SHOTS, 'fe-2-keyboard-focus-360.png'), fullPage: false });
    await pg.keyboard.press('Enter');
    await pg.waitForSelector('#order-done:not([hidden]) .done__title');
    const bad = seen.filter((x) => !x.ok);
    assert.deepEqual(bad, [], 'ทุก element ที่ได้ focus ต้องเห็น focus ชัด');
    // การ์ดได้ focus หลังสั่ง แล้ว Tab ไปปุ่มแก้ / ยกเลิกได้
    let onEdit = false;
    for (let k = 0; k < 4 && !onEdit; k++) {
      await pg.keyboard.press('Tab');
      onEdit = await pg.evaluate(() => document.activeElement.getAttribute('data-act') === 'edit');
    }
    assert.ok(onEdit, 'Tab ต้องไปถึงปุ่มแก้ order');
    assert.ok((await focusVisible(pg)).ok);
    const g = await s.api('GET', `${R}/orders/${enc('คีย์บอร์ด')}`);
    assert.equal(g.status, 200);
    assert.equal(g.body.total, 100);
    assert.deepEqual(p.errors, []);
  });

  await t.test('DoD · ไม่มี console error (D16) ทั้งสองเครื่อง', async () => {
    assert.deepEqual(A.errors, []);
    assert.deepEqual(B.errors, []);
  });
});

// ───────────────────────── D2: นาฬิกาเครื่องผิด ─────────────────────────
test('F2/D2 · นาฬิกาเครื่องเร็วไป 3 ชม. → ยังนับถอยหลังจาก serverNow · กลับมาที่แท็บแล้ว sync เวลา server ใหม่', async (t) => {
  if (endOfBkkDay() - Date.now() < 30 * 60e3) { t.skip('ใกล้เที่ยงคืนเกินไป'); return; }
  const s = await startServer();
  const cutoffMs = Math.min(Date.now() + 40 * 60e3, endOfBkkDay());
  await openRound(s, cutoffMs);
  const skew = `(() => { const D = Date; const off = 3 * 3600e3;
    class FakeDate extends D { constructor(...a) { if (a.length === 0) super(D.now() + off); else super(...a); } static now() { return D.now() + off; } }
    window.Date = FakeDate; })();`;
  const { ctx, page, errors } = await newDevice({ init: skew });
  try {
    // ครั้งแรกให้ serverNow ช้ากว่าจริง 5 นาที (เหมือนหน้าพักไว้นาน) ครั้งถัดไปตอบตามจริง
    let first = true;
    await page.route('**/api/rounds/today', async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      if (first) { first = false; body.serverNow = toBkk(Date.parse(body.serverNow) - 5 * 60e3); }
      await route.fulfill({ response: res, json: body });
    });
    await gotoOrder(page, s.base);
    assert.ok(await page.evaluate(() => Date.now()) - Date.now() > 2.9 * 3600e3, 'นาฬิกาเครื่องถูกเลื่อนจริง');
    const lagged = await countdownSec(page);
    const real = (cutoffMs - Date.now()) / 1000;
    assert.ok(Math.abs(lagged - (real + 300)) <= 3, `นับจาก serverNow ที่ได้ (${lagged}s ≈ ${(real + 300).toFixed(0)}s) ไม่ใช่นาฬิกาเครื่อง (ซึ่งจะเป็น "ปิดรับแล้ว")`);
    assert.equal(await cutoffState(page), 'open');
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.waitForFunction((exp) => {
      const t = document.querySelector('.cutoff__count').textContent.split(':').map(Number).reduce((a, n) => a * 60 + n, 0);
      return Math.abs(t - exp) < 60;
    }, real);
    assert.ok(Math.abs(await countdownSec(page) - (cutoffMs - Date.now()) / 1000) <= 3, 'กลับมาที่แท็บ → sync เวลา server ใหม่');
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); await s.close(); }
});

// ───────────────────────── F2: เหลือ < 10 นาที ─────────────────────────
test('F2 · เหลือ < 10 นาที → สถานะ soon เปลี่ยนสีเตือน (360 light / dark)', async (t) => {
  if (endOfBkkDay() - Date.now() < 10 * 60e3) { t.skip('ใกล้เที่ยงคืนเกินไป'); return; }
  const s = await startServer();
  const s2 = await startServer();
  try {
    await openRound(s, Date.now() + 5 * 60e3);
    await openRound(s2, Math.min(Date.now() + 60 * 60e3, endOfBkkDay()));
    for (const scheme of ['light', 'dark']) {
      const soon = await newDevice({ scheme });
      const open = await newDevice({ scheme });
      try {
        await gotoOrder(soon.page, s.base);
        await gotoOrder(open.page, s2.base);
        assert.equal(await cutoffState(soon.page), 'soon');
        assert.equal(await cutoffState(open.page), 'open');
        const look = (p) => p.evaluate(() => {
          const el = document.querySelector('.cutoff__left');
          const cs = getComputedStyle(el);
          return cs.backgroundColor + '|' + cs.color + '|' + getComputedStyle(document.querySelector('.cutoff__left-label')).color;
        });
        assert.notEqual(await look(soon.page), await look(open.page), 'soon ต้องเปลี่ยนสี');
        await soon.page.screenshot({ path: path.join(SHOTS, `fe-2-soon-360-${scheme}.png`), fullPage: false });
        assert.deepEqual(soon.errors, []);
        assert.deepEqual(open.errors, []);
      } finally { await soon.ctx.close(); await open.ctx.close(); }
    }
  } finally { await s.close(); await s2.close(); }
});

// ───────────────────────── F6: ปิดรับเอง + ส่งตอนปิดพอดี ─────────────────────────
test('F5/F6 · ถึงเวลาปิด → "ปิดรับแล้ว" เองไม่ reload · แก้/ยกเลิกไม่ได้ · ส่งหลังปิดพอดี = ข้อความปิดรับ ไม่ใช่ error ทั่วไป', async (t) => {
  if (endOfBkkDay() - Date.now() < 120e3) { t.skip('ใกล้เที่ยงคืนเกินไป'); return; }
  const s = await startServer();
  const cutoffMs = Math.ceil((Date.now() + 15000) / 1000) * 1000;
  const round = await openRound(s, cutoffMs);
  const R = `/api/rounds/${round.id}`;
  assert.equal((await s.api('PUT', `${R}/orders`, { name: 'Bo', lines: [{ itemId: round.items[0].id, qty: 3 }], note: '' })).status, 200);
  assert.equal((await s.api('PUT', `${R}/orders`, { name: 'Cy', lines: [{ itemId: round.items[2].id, qty: 1 }], note: '' })).status, 200);

  // V: เห็นการ์ด "สั่งแล้ว" ของ Bo · E: Cy กำลังแก้ order ค้างไว้ · N: คนใหม่เลือกเมนูค้างไว้
  // L: หน้าที่ serverNow คลาดช้า 30 วินาที (เช่นเน็ตช้า) → ยังเห็นเปิดอยู่ตอน server ปิดแล้ว
  const V = await newDevice({ init: "localStorage.setItem('teamlunch.name','Bo')" });
  const E = await newDevice({ init: "localStorage.setItem('teamlunch.name','Cy')" });
  const N = await newDevice({ width: 1280, height: 800 });
  const L = await newDevice();
  t.after(async () => { for (const d of [V, E, N, L]) await d.ctx.close(); await s.close(); });
  await L.page.route('**/api/rounds/today', async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    body.serverNow = toBkk(Date.parse(body.serverNow) - 30e3);
    await route.fulfill({ response: res, json: body });
  });

  for (const d of [V, E, N, L]) await gotoOrder(d.page, s.base);
  await V.page.waitForSelector('#order-done:not([hidden]) .done__title');
  await E.page.waitForSelector('#order-done:not([hidden]) .done__title');
  await E.page.locator('#order-done [data-act="edit"]').click();
  await plus(E.page, 'เกาเหลา').click();
  await plus(N.page, 'ข้าวมันไก่ทอด').click();
  await N.page.fill('#name', 'Nok');
  await plus(L.page, 'ข้าวมันไก่ต้ม').click();
  await L.page.fill('#name', 'Lat');
  for (const d of [V, E, N, L]) {
    assert.notEqual(await cutoffState(d.page), 'closed'); // เหลือ < 10 นาที = soon
    await d.page.evaluate(() => { window.__noReload = 1; });
  }

  await t.test('ก่อนปิด: แก้ / ยกเลิกยังกดได้ (F5)', async () => {
    assert.equal(await V.page.locator('#order-done [data-act="edit"]').isDisabled(), false);
    assert.equal(await V.page.locator('#order-done [data-act="cancel"]').isDisabled(), false);
  });

  await t.test('ถึงเวลาปิด → "ปิดรับแล้ว" เอง ไม่ reload · ปุ่มยืนยัน / − + / หมายเหตุ / แก้ / ยกเลิก ใช้ไม่ได้', async () => {
    await sleep(Math.max(0, cutoffMs - Date.now() + 1500));
    for (const [label, d] of [['V', V], ['E', E], ['N', N]]) {
      const p = d.page;
      await p.waitForFunction(() => document.querySelector('#cutoff').getAttribute('data-state') === 'closed', null, { timeout: 5000 });
      assert.equal(await p.evaluate(() => window.__noReload), 1, `${label}: ต้องไม่ reload`);
      assert.match(await p.locator('#cutoff').innerText(), /ปิดรับแล้ว/, label);
    }
    // V: การ์ด Bo — แก้ / ยกเลิกไม่ได้
    assert.equal(await V.page.locator('#order-done [data-act="edit"]').isDisabled(), true);
    assert.equal(await V.page.locator('#order-done [data-act="cancel"]').isDisabled(), true);
    // E: แก้ค้างไว้ → กลับไปเห็น order ที่บันทึกจริง (เกาเหลา 1 ไม่ใช่ที่แก้ค้าง)
    await E.page.waitForSelector('#order-done:not([hidden]) .done__title');
    assert.equal(await E.page.locator('#order-done [data-act="edit"]').isDisabled(), true);
    // N: ฟอร์มล็อก
    assert.equal(await barBtn(N.page).isDisabled(), true);
    assert.match(await barBtn(N.page).textContent(), /ปิดรับแล้ว/);
    assert.equal(await plus(N.page, 'เกาเหลา').isDisabled(), true);
    assert.equal(await N.page.locator('#note').isDisabled(), true);
    assert.equal((await s.api('GET', `${R}/orders/Nok`)).status, 404);
    await V.page.screenshot({ path: path.join(SHOTS, 'fe-2-closed-live-360.png'), fullPage: true });
    await N.page.screenshot({ path: path.join(SHOTS, 'fe-2-closed-live-1280.png'), fullPage: true });
  });

  await t.test('ส่งหลังปิดพอดี (หน้ายังเห็นเปิด) → notice ปิดรับพร้อม message ROUND_CLOSED จาก API แล้วล็อกเอง', async () => {
    const p = L.page;
    assert.notEqual(await cutoffState(p), 'closed', 'หน้า L ต้องยังเห็นเปิดอยู่ (serverNow คลาด 30 วิ)');
    assert.equal(await barBtn(p).isDisabled(), false);
    await barBtn(p).click();
    await p.waitForSelector('#order-notice:not([hidden])');
    const api = await s.api('PUT', `${R}/orders`, { name: 'Lat', lines: [{ itemId: round.items[0].id, qty: 1 }], note: '' });
    assert.equal(api.status, 409);
    assert.equal(api.body.error.code, 'ROUND_CLOSED');
    const n = p.locator('#order-notice');
    assert.equal((await n.innerText()).trim(), api.body.error.message, 'แสดง message ของ API ตรงๆ');
    assert.match(await n.getAttribute('class'), /notice--closed/, 'ต้องเป็นสถานะปิดรับ ไม่ใช่ error ทั่วไป');
    await p.waitForFunction(() => document.querySelector('#cutoff').getAttribute('data-state') === 'closed', null, { timeout: 5000 });
    assert.equal(await barBtn(p).isDisabled(), true);
    assert.equal(await p.evaluate(() => window.__noReload), 1);
    await p.screenshot({ path: path.join(SHOTS, 'fe-2-closed-race-360.png'), fullPage: true });
  });

  await t.test('เปิดหน้าหลังปิดแล้ว: เห็น "ปิดรับแล้ว" ทันที · ชื่อเดิมยังเห็น order (D12) แต่แก้ / ยกเลิกไม่ได้ · 360 dark', async () => {
    const d = await newDevice({ scheme: 'dark', init: "localStorage.setItem('teamlunch.name','bo')" });
    try {
      await gotoOrder(d.page, s.base);
      await d.page.waitForSelector('#order-done:not([hidden]) .done__title');
      assert.equal(await cutoffState(d.page), 'closed');
      assert.match(await d.page.locator('#order-done').innerText(), /× 3/);
      assert.equal(await d.page.locator('#order-done [data-act="edit"]').isDisabled(), true);
      assert.equal(await d.page.locator('#order-done [data-act="cancel"]').isDisabled(), true);
      assert.equal(await noHScroll(d.page), true);
      await d.page.screenshot({ path: path.join(SHOTS, 'fe-2-closed-load-360-dark.png'), fullPage: true });
      assert.deepEqual(d.errors, []);
    } finally { await d.ctx.close(); }
    const sum = (await s.api('GET', `${R}/summary`)).body;
    assert.deepEqual(sum.byPerson.map((x) => [x.name, x.total]), [['Bo', 150], ['Cy', 40]], 'order หลังปิดไม่ถูกบันทึก/ไม่ถูกแก้');
  });

  await t.test('DoD · ไม่มี console error (D16)', async () => {
    for (const d of [V, E, N, L]) assert.deepEqual(d.errors, []);
  });
});

// ───────────────────────── F8: 360px ทุกสถานะ ─────────────────────────
// ค่ายาวสุดที่ contract ยอมรับ (D8: ชื่อร้าน/เมนู 60 · name 40 · note 100) รวมคำยาวไม่มีช่องว่าง
test('F8 · 360px: ไม่มี scroll แนวนอนทุกสถานะ แม้ค่ายาวสุดตาม contract · ปุ่ม ≥ 44px', async (t) => {
  if (endOfBkkDay() - Date.now() < 30 * 60e3) { t.skip('ใกล้เที่ยงคืนเกินไป'); return; }
  const s = await startServer();
  const r = await s.api('POST', '/api/rounds', {
    restaurant: 'R'.repeat(60), cutoffAt: toBkk(Math.min(Date.now() + 3600e3, endOfBkkDay())),
    items: [{ name: 'ก๋วยเตี๋ยวเรือน้ำตกหมูตุ๋นเส้นเล็กพิเศษใส่ทุกอย่างไม่ใส่ผัก', price: 10000 }, { name: 'W'.repeat(60), price: 9999 }],
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const d = await newDevice({ width: 360, height: 640 });
  const over = [];
  try {
    const p = d.page;
    const check = async (label) => {
      const res = await p.evaluate(() => ({
        sw: document.documentElement.scrollWidth,
        el: [...document.querySelectorAll('body *')].filter((e) => e.offsetParent !== null && e.children.length === 0 && e.getBoundingClientRect().right > window.innerWidth + 1)
          .map((e) => (e.id ? '#' + e.id : '.' + String(e.className || e.tagName).split(' ')[0] || e.tagName)),
      }));
      if (res.sw > 360) over.push(`${label}: scrollWidth ${res.sw} (${[...new Set(res.el)].join(', ')})`);
    };
    await gotoOrder(p, s.base);
    await check('เปิดหน้า (ชื่อร้าน/เมนู 60 ตัว)');
    for (let k = 0; k < 10; k++) await p.locator('#board .dish').nth(0).locator('[data-step="1"]').click();
    for (let k = 0; k < 10; k++) await p.locator('#board .dish').nth(1).locator('[data-step="1"]').click();
    assert.match(await p.locator('#orderbar').innerText(), /199,990/);
    await check('ยอดหลักแสน');
    await p.fill('#name', 'W'.repeat(40));
    await p.fill('#note', 'N'.repeat(100));
    await barBtn(p).click();
    await p.waitForSelector('#order-done:not([hidden]) .done__title');
    await check('การ์ดสั่งแล้ว');
    await p.screenshot({ path: path.join(SHOTS, 'fe-2-long-360-done.png'), fullPage: true });
    const small = await p.evaluate(() => [...document.querySelectorAll('button')]
      .filter((b) => b.offsetParent !== null)
      .map((b) => { const r = b.getBoundingClientRect(); return { t: b.textContent.trim() || b.getAttribute('aria-label'), w: r.width, h: r.height }; })
      .filter((x) => x.w < 44 || x.h < 44));
    assert.deepEqual(small, [], 'ปุ่มต้อง ≥ 44px');
    await p.locator('#order-done [data-act="edit"]').click();
    await check('แก้ order (หัวข้อ "แก้ order ของ <ชื่อ>")');
    await p.screenshot({ path: path.join(SHOTS, 'fe-2-long-360-edit.png'), fullPage: true });
    await p.click('#edit-cancel');
    await p.locator('#order-done [data-act="cancel"]').click();
    await p.locator('[data-act="cancel-yes"]').click();
    await p.waitForSelector('#order-notice:not([hidden])');
    await check('ยกเลิกแล้ว (notice "ยกเลิก order ของ <ชื่อ> แล้ว")');
    await p.screenshot({ path: path.join(SHOTS, 'fe-2-long-360-cancelled.png'), fullPage: true });
    assert.deepEqual(d.errors, []);
    assert.deepEqual(over, [], 'F8: ไม่มี scroll แนวนอนที่ 360px');
  } finally { await d.ctx.close(); await s.close(); }
});

test('F8 · 360px ค่าปกติภาษาไทยยาว: ไม่มี scroll แนวนอน', async (t) => {
  if (endOfBkkDay() - Date.now() < 30 * 60e3) { t.skip('ใกล้เที่ยงคืนเกินไป'); return; }
  const s = await startServer();
  const r = await s.api('POST', '/api/rounds', {
    restaurant: 'ร้าน'.repeat(15), cutoffAt: toBkk(Math.min(Date.now() + 3600e3, endOfBkkDay())),
    items: [{ name: 'ก๋วยเตี๋ยวเรือน้ำตกหมูตุ๋นเส้นเล็กพิเศษใส่ทุกอย่างไม่ใส่ผัก', price: 120 }],
  });
  assert.equal(r.status, 201);
  const d = await newDevice({ width: 360, height: 640 });
  try {
    const p = d.page;
    await gotoOrder(p, s.base);
    await plus(p, 'ก๋วยเตี๋ยว').click();
    await p.fill('#name', 'สมชาย ใจดีมากที่สุดในสามโลกและจักรวาลนี้');
    await p.fill('#note', 'ไม่เผ็ด ไม่ใส่ผักชี ขอน้ำซุปแยก เส้นเล็กลวกนานๆ ไม่ใส่ถั่วงอก ใส่พริกน้ำส้มแยกถุง ขอบคุณมากครับ');
    await barBtn(p).click();
    await p.waitForSelector('#order-done:not([hidden]) .done__title');
    assert.equal(await noHScroll(p), true);
    await p.screenshot({ path: path.join(SHOTS, 'fe-2-long-thai-360.png'), fullPage: true });
    assert.deepEqual(d.errors, []);
  } finally { await d.ctx.close(); await s.close(); }
});

// ───────────────────────── F8 regression ของ ef276f4 (`body { overflow-wrap: anywhere }`) ─────────────────────────
// ค่าปกติ (ภาษาไทยมีวรรค, ตัวเลขราคา/ยอดหลักหมื่น-แสน, เวลา) ต้องตัดบรรทัดเหมือนเดิม — ไม่ตัดกลางคำ/กลางตัวเลข
// วิธี: เทียบจำนวนบรรทัดของทุกข้อความกับหน้าเดียวกันที่บังคับ overflow-wrap: normal (ดู lib/wrap-audit.js)
const { wrapAudit } = require('./lib/wrap-audit');
test('F8 · regression overflow-wrap: ข้อความไทยปกติ / ตัวเลข / ราคา ไม่ถูกตัดผิดที่ (360 + 1280, light/dark)', async (t) => {
  if (endOfBkkDay() - Date.now() < 30 * 60e3) { t.skip('ใกล้เที่ยงคืนเกินไป'); return; }
  const s = await startServer();
  const r = await s.api('POST', '/api/rounds', {
    restaurant: 'ข้าวมันไก่เจ้าเก่าประตูน้ำ สาขาสีลม ซอย 5', cutoffAt: toBkk(Math.min(Date.now() + 3600e3, endOfBkkDay())),
    items: [
      { name: 'ข้าวมันไก่ต้ม + ไก่ทอด (พิเศษ) เพิ่มเลือด', price: 10000 },
      { name: 'ก๋วยเตี๋ยวเรือน้ำตกหมูตุ๋น เส้นเล็ก', price: 9999 },
      { name: 'เกาเหลา', price: 45 },
    ],
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  t.after(() => s.close());
  for (const [w, scheme] of [[360, 'light'], [1280, 'dark']]) {
    await t.test(`${w}px ${scheme}`, async () => {
      const d = await newDevice({ width: w, height: 780, scheme });
      const problems = [];
      const check = async (label) => {
        const a = await wrapAudit(d.page);
        if (a.scrollWidth > w) problems.push(`${label}: scrollWidth ${a.scrollWidth}`);
        if (a.baselineOverflow) problems.push(`${label}: ค่าปกติแต่ล้นจอแม้ไม่มี overflow-wrap`);
        for (const x of a.diffs) problems.push(`${label}: ตัดบรรทัดต่างจากปกติ ${x}`);
        for (const x of a.brokenNums) problems.push(`${label}: ตัวเลขถูกตัดข้ามบรรทัด ${x}`);
      };
      try {
        const p = d.page;
        await gotoOrder(p, s.base);
        await check('เปิดหน้า');
        for (let k = 0; k < 10; k++) await p.locator('#board .dish').nth(0).locator('[data-step="1"]').click();
        for (let k = 0; k < 10; k++) await p.locator('#board .dish').nth(1).locator('[data-step="1"]').click();
        await p.locator('#board .dish').nth(2).locator('[data-step="1"]').click();
        await check('เลือกเมนู ยอดหลักแสน');
        await p.fill('#name', `สมศักดิ์ รักษ์ศรีสวัสดิ์ ${w}`);
        await p.fill('#note', 'ไม่เผ็ด ไม่ใส่ผักชี ขอน้ำจิ้มแยก 2 ถุง โทร 081-234-5678 ถ้าของหมด');
        await barBtn(p).click();
        await p.waitForSelector('#order-done:not([hidden]) .done__title');
        await check('การ์ดสั่งแล้ว');
        await p.screenshot({ path: path.join(SHOTS, `fe-2-wrap-${w}-${scheme}-done.png`), fullPage: true });
        await p.locator('#order-done [data-act="edit"]').click();
        await check('แก้ order');
        await p.click('#edit-cancel');
        await p.locator('#order-done [data-act="cancel"]').click();
        await check('ถามยืนยันยกเลิก');
        await p.locator('[data-act="cancel-yes"]').click();
        await p.waitForSelector('#order-notice:not([hidden])');
        await check('ยกเลิกแล้ว');
        // component สรุปยอดใน kit.html (ชุด .person__* / .tally__* ที่ ef276f4 แตะ)
        await p.goto(s.base + '/kit.html');
        await p.waitForLoadState('networkidle');
        await check('kit.html');
        assert.deepEqual(d.errors, []);
        assert.deepEqual(problems, []);
      } finally { await d.ctx.close(); }
    });
  }
});
