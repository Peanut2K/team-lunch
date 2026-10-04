/* ข้าวเที่ยงทีม — server จำลองในหน้าเว็บ (Decision log D5)
 *
 * ทำตัวเหมือน HTTP server ตาม API contract ใน Linear:
 *   handle(method, path, bodyText) -> Promise<{ status, body }>
 * api.js เป็นคนเดียวที่เรียกไฟล์นี้ — หน้าเว็บไม่เรียกตรง
 *
 * - เวลาเป็นเวลา "server" จำลอง = Date.now() + clockOffsetMs โซน Asia/Bangkok (+07:00)
 * - ข้อมูลเก็บใน localStorage ของเครื่อง (ถ้าใช้ไม่ได้ก็เก็บในหน่วยความจำ)
 *
 * ตัวช่วยสำหรับคนดู / QA (ผ่าน URL ตอนเปิดหน้า):
 *   ?mock=reset          ล้างข้อมูลแล้วสร้างรอบตัวอย่างใหม่ (ปิดรับอีก 25 นาที)
 *   ?mock=empty          ล้างข้อมูล ไม่มีรอบวันนี้ (เห็นสถานะ NO_ROUND)
 *   ?mock=cutoff:<วินาที> ล้างข้อมูลแล้วสร้างรอบตัวอย่างที่ปิดรับในอีก N วินาที (ติดลบ = ปิดไปแล้ว)
 * และผ่าน console: TL.mock.reset({ cutoffInSec, empty, orders }), TL.mock.setClockOffset(ms),
 *   TL.mock.now(), TL.mock.dump(), TL.mock.setLatency(ms)
 */
(function () {
  'use strict';

  var TL = (window.TL = window.TL || {});

  var STORAGE_KEY = 'teamlunch.mock.v1';
  var BKK_OFFSET_MS = 7 * 60 * 60 * 1000;
  var latencyMs = 120;

  /* ---------- storage ---------- */
  var memoryStore = null;
  function load() {
    try {
      var raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) { /* ใช้ memory แทน */ }
    return memoryStore;
  }
  function save(db) {
    memoryStore = db;
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(db)); } catch (e) { /* ignore */ }
  }
  function emptyDb() {
    return { version: 1, clockOffsetMs: 0, seq: 0, rounds: {} };
  }
  var db = load() || emptyDb();

  /* ---------- เวลา ---------- */
  function nowMs() { return Date.now() + (db.clockOffsetMs || 0); }

  function pad(n, w) { n = String(n); while (n.length < (w || 2)) n = '0' + n; return n; }

  // ms -> "YYYY-MM-DDTHH:mm:ss+07:00" (ไม่ขึ้นกับ timezone ของเครื่อง)
  function toBkkIso(ms) {
    var d = new Date(Math.floor(ms / 1000) * 1000 + BKK_OFFSET_MS);
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()) +
      'T' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds()) + '+07:00';
  }
  function bkkDate(ms) { return toBkkIso(ms).slice(0, 10); }
  function bkkHHmm(ms) { return toBkkIso(ms).slice(11, 16); }

  var ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
  function parseIso(s) {
    if (typeof s !== 'string' || !ISO_WITH_OFFSET.test(s)) return NaN;
    return Date.parse(s);
  }

  /* ---------- ตัวช่วยตอบ ---------- */
  function ok(status, body) { return { status: status, body: body === undefined ? null : body }; }
  function fail(status, code, message) {
    return { status: status, body: { error: { code: code, message: message } } };
  }
  function clone(x) { return x == null ? x : JSON.parse(JSON.stringify(x)); }

  function charLen(s) { return Array.from(s).length; }
  function isInt(n) { return typeof n === 'number' && isFinite(n) && Math.floor(n) === n; }
  function nameKey(name) { return String(name).trim().toLowerCase(); }

  function nextId(prefix) {
    db.seq = (db.seq || 0) + 1;
    var rand = Math.floor(Math.random() * 0xffff).toString(16);
    return prefix + pad(rand, 4) + db.seq.toString(16);
  }

  function roundStatus(r, now) { return now >= Date.parse(r.cutoffAt) ? 'closed' : 'open'; }

  function roundView(r) {
    var now = nowMs();
    return {
      id: r.id,
      date: r.date,
      restaurant: r.restaurant,
      cutoffAt: r.cutoffAt,
      status: roundStatus(r, now),
      serverNow: toBkkIso(now),
      items: clone(r.items)
    };
  }

  function orderView(o) {
    return {
      id: o.id,
      roundId: o.roundId,
      name: o.name,
      lines: clone(o.lines),
      note: o.note,
      total: o.total,
      updatedAt: o.updatedAt
    };
  }

  function todayRound() {
    var today = bkkDate(nowMs());
    for (var id in db.rounds) {
      if (db.rounds[id].date === today) return db.rounds[id];
    }
    return null;
  }

  function closedFail(r) {
    return fail(409, 'ROUND_CLOSED', 'ปิดรับ order แล้วเมื่อ ' + bkkHHmm(Date.parse(r.cutoffAt)));
  }

  /* ---------- endpoints ---------- */

  // POST /api/rounds
  function createRound(body) {
    // วันละ 1 รอบ: ถ้ามีรอบวันนี้แล้ว ตอบ ROUND_EXISTS ก่อน validation
    if (todayRound()) return fail(409, 'ROUND_EXISTS', 'วันนี้เปิดรอบสั่งไปแล้ว');

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return fail(400, 'VALIDATION', 'ข้อมูลที่ส่งมาไม่ถูกต้อง');
    }
    var restaurant = typeof body.restaurant === 'string' ? body.restaurant.trim() : '';
    if (!restaurant) return fail(400, 'VALIDATION', 'กรุณาใส่ชื่อร้าน');

    var cutoff = parseIso(body.cutoffAt);
    if (isNaN(cutoff)) return fail(400, 'VALIDATION', 'เวลาปิดรับไม่ถูกต้อง');
    var now = nowMs();
    if (cutoff <= now) return fail(400, 'VALIDATION', 'เวลาปิดรับต้องอยู่ในอนาคต');

    var items = body.items;
    if (!Array.isArray(items) || items.length < 1) return fail(400, 'VALIDATION', 'ต้องมีเมนูอย่างน้อย 1 รายการ');
    if (items.length > 30) return fail(400, 'VALIDATION', 'เมนูได้ไม่เกิน 30 รายการ');
    var clean = [];
    for (var i = 0; i < items.length; i++) {
      var it = items[i] || {};
      var nm = typeof it.name === 'string' ? it.name.trim() : '';
      if (!nm) return fail(400, 'VALIDATION', 'กรุณาใส่ชื่อเมนูให้ครบทุกรายการ');
      if (!isInt(it.price) || it.price <= 0) {
        return fail(400, 'VALIDATION', 'ราคา "' + nm + '" ต้องเป็นจำนวนเต็มบาทที่มากกว่า 0');
      }
      clean.push({ id: 'i' + (i + 1), name: nm, price: it.price });
    }

    var date = bkkDate(now);
    var r = {
      id: 'r_' + date.replace(/-/g, ''),
      date: date,
      restaurant: restaurant,
      cutoffAt: toBkkIso(cutoff),
      items: clean,
      orders: []
    };
    db.rounds[r.id] = r;
    save(db);
    return ok(201, roundView(r));
  }

  // GET /api/rounds/today
  function getToday() {
    var r = todayRound();
    if (!r) return fail(404, 'NO_ROUND', 'วันนี้ยังไม่มีรอบสั่ง');
    return ok(200, roundView(r));
  }

  // PUT /api/rounds/:id/orders
  function putOrder(roundId, body) {
    var r = db.rounds[roundId];
    if (!r) return fail(404, 'NOT_FOUND', 'ไม่พบรอบสั่งนี้');
    if (roundStatus(r, nowMs()) === 'closed') return closedFail(r);

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return fail(400, 'VALIDATION', 'ข้อมูลที่ส่งมาไม่ถูกต้อง');
    }
    var name = typeof body.name === 'string' ? body.name.trim() : '';
    if (charLen(name) < 1 || charLen(name) > 40) {
      return fail(400, 'VALIDATION', 'กรุณาใส่ชื่อ 1–40 ตัวอักษร');
    }

    var lines = body.lines;
    if (!Array.isArray(lines) || lines.length < 1) return fail(400, 'VALIDATION', 'เลือกเมนูอย่างน้อย 1 รายการ');
    var priceById = {};
    r.items.forEach(function (it) { priceById[it.id] = it.price; });
    var seen = {};
    var clean = [];
    var total = 0;
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i] || {};
      if (typeof ln.itemId !== 'string' || !(ln.itemId in priceById)) {
        return fail(400, 'VALIDATION', 'มีเมนูที่ไม่อยู่ในรอบสั่งนี้');
      }
      if (seen[ln.itemId]) return fail(400, 'VALIDATION', 'เลือกเมนูเดียวกันซ้ำในหลายบรรทัดไม่ได้');
      seen[ln.itemId] = true;
      if (!isInt(ln.qty) || ln.qty < 1 || ln.qty > 10) {
        return fail(400, 'VALIDATION', 'จำนวนต่อเมนูต้องเป็นจำนวนเต็ม 1–10');
      }
      clean.push({ itemId: ln.itemId, qty: ln.qty });
      total += priceById[ln.itemId] * ln.qty;
    }

    var note = body.note;
    if (note === undefined || note === null) note = '';
    if (typeof note !== 'string') return fail(400, 'VALIDATION', 'หมายเหตุต้องเป็นข้อความ');
    note = note.trim();
    if (charLen(note) > 100) return fail(400, 'VALIDATION', 'หมายเหตุยาวได้ไม่เกิน 100 ตัวอักษร');

    var key = nameKey(name);
    var existing = null;
    for (var j = 0; j < r.orders.length; j++) {
      if (r.orders[j].key === key) { existing = r.orders[j]; break; }
    }
    var stamp = toBkkIso(nowMs());
    var o;
    if (existing) {
      // ชื่อเดิม (ไม่สนตัวพิมพ์ + ตัดช่องว่าง) = แทนที่ order เดิม ไม่เพิ่มใหม่
      existing.name = name;
      existing.lines = clean;
      existing.note = note;
      existing.total = total;
      existing.updatedAt = stamp;
      o = existing;
    } else {
      o = {
        id: nextId('o_'),
        roundId: r.id,
        key: key,
        name: name,
        lines: clean,
        note: note,
        total: total,
        createdAt: stamp,
        updatedAt: stamp
      };
      r.orders.push(o);
    }
    save(db);
    return ok(200, orderView(o));
  }

  // DELETE /api/rounds/:id/orders/:name
  function deleteOrder(roundId, name) {
    var r = db.rounds[roundId];
    if (!r) return fail(404, 'NOT_FOUND', 'ไม่พบรอบสั่งนี้');
    if (roundStatus(r, nowMs()) === 'closed') return closedFail(r);
    var key = nameKey(name);
    for (var i = 0; i < r.orders.length; i++) {
      if (r.orders[i].key === key) {
        r.orders.splice(i, 1);
        save(db);
        return ok(204, null);
      }
    }
    return fail(404, 'NOT_FOUND', 'ไม่พบ order ของชื่อนี้');
  }

  // GET /api/rounds/:id/summary
  function getSummary(roundId) {
    var r = db.rounds[roundId];
    if (!r) return fail(404, 'NOT_FOUND', 'ไม่พบรอบสั่งนี้');
    var itemById = {};
    var qtyById = {};
    r.items.forEach(function (it, idx) { itemById[it.id] = { it: it, idx: idx }; qtyById[it.id] = 0; });

    var byPerson = r.orders.map(function (o) {
      return {
        name: o.name,
        lines: o.lines.map(function (ln) {
          qtyById[ln.itemId] += ln.qty;
          return { itemId: ln.itemId, name: itemById[ln.itemId].it.name, qty: ln.qty };
        }),
        note: o.note,
        total: o.total
      };
    });

    var byItem = r.items
      .filter(function (it) { return qtyById[it.id] > 0; })
      .map(function (it) {
        return { itemId: it.id, name: it.name, qty: qtyById[it.id], amount: qtyById[it.id] * it.price };
      })
      .sort(function (a, b) { return b.qty - a.qty || itemById[a.itemId].idx - itemById[b.itemId].idx; });

    var grandTotal = byPerson.reduce(function (s, p) { return s + p.total; }, 0);
    return ok(200, { byItem: byItem, byPerson: byPerson, grandTotal: grandTotal, orderCount: byPerson.length });
  }

  /* ---------- router ---------- */
  function route(method, path, bodyText) {
    var p = String(path).split('?')[0].replace(/\/+$/, '');
    var m;
    var body;
    if (bodyText != null && bodyText !== '') {
      try { body = JSON.parse(bodyText); } catch (e) {
        return fail(400, 'VALIDATION', 'ข้อมูลที่ส่งมาไม่ใช่ JSON');
      }
    }

    if (p === '/api/rounds' && method === 'POST') return createRound(body);
    if (p === '/api/rounds/today' && method === 'GET') return getToday();
    if ((m = p.match(/^\/api\/rounds\/([^/]+)\/orders$/)) && method === 'PUT') {
      return putOrder(safeDecode(m[1]), body);
    }
    if ((m = p.match(/^\/api\/rounds\/([^/]+)\/orders\/([^/]+)$/)) && method === 'DELETE') {
      return deleteOrder(safeDecode(m[1]), safeDecode(m[2]));
    }
    if ((m = p.match(/^\/api\/rounds\/([^/]+)\/summary$/)) && method === 'GET') {
      return getSummary(safeDecode(m[1]));
    }
    return fail(404, 'NOT_FOUND', 'ไม่พบ ' + method + ' ' + p);
  }

  function safeDecode(s) { try { return decodeURIComponent(s); } catch (e) { return s; } }

  function handle(method, path, bodyText) {
    method = String(method || 'GET').toUpperCase();
    return new Promise(function (resolve) {
      // หน่วงเล็กน้อยให้เหมือนเรียกผ่านเครือข่าย (เห็นสถานะกำลังโหลด)
      setTimeout(function () {
        db = load() || db; // เผื่อเปิดหลายแท็บ
        var res;
        try { res = route(method, path, bodyText); } catch (e) {
          res = fail(500, 'INTERNAL', 'server จำลองขัดข้อง: ' + e.message);
        }
        resolve({ status: res.status, body: clone(res.body) });
      }, latencyMs);
    });
  }

  /* ---------- ข้อมูลตัวอย่าง ---------- */
  var DEMO = {
    restaurant: 'ข้าวมันไก่ป้าแดง',
    items: [
      { name: 'ข้าวมันไก่ต้ม', price: 50 },
      { name: 'ข้าวมันไก่ทอด', price: 55 },
      { name: 'ข้าวมันไก่ผสม', price: 60 },
      { name: 'ข้าวมันไก่พิเศษ เครื่องในครบ', price: 70 },
      { name: 'เกาเหลาไก่ต้ม', price: 50 },
      { name: 'ไข่ต้มยางมะตูม', price: 10 }
    ],
    orders: [
      { name: 'แพร', lines: [{ itemId: 'i1', qty: 1 }], note: 'ไม่เอาหนัง' },
      { name: 'ต้น', lines: [{ itemId: 'i3', qty: 1 }, { itemId: 'i6', qty: 2 }], note: '' },
      { name: 'บอส', lines: [{ itemId: 'i1', qty: 2 }], note: 'น้ำจิ้มแยก' },
      { name: 'มิ้นท์', lines: [{ itemId: 'i2', qty: 1 }, { itemId: 'i5', qty: 1 }], note: '' }
    ]
  };

  function reset(opts) {
    opts = opts || {};
    var offset = db.clockOffsetMs || 0;
    db = emptyDb();
    db.clockOffsetMs = offset;
    save(db);
    if (opts.empty) return;

    var cutoffInSec = typeof opts.cutoffInSec === 'number' ? opts.cutoffInSec : 25 * 60;
    var now = nowMs();
    // สร้างรอบด้วยเวลาปิดในอนาคตก่อน แล้วค่อยเลื่อน (ให้ cutoff ติดลบได้ = รอบที่ปิดไปแล้ว)
    var res = createRound({
      restaurant: opts.restaurant || DEMO.restaurant,
      cutoffAt: toBkkIso(now + 60 * 60 * 1000),
      items: opts.items || DEMO.items
    });
    var r = db.rounds[res.body.id];
    var orders = opts.orders === undefined ? DEMO.orders : opts.orders;
    (orders || []).forEach(function (o) { putOrder(r.id, o); });
    r.cutoffAt = toBkkIso(now + cutoffInSec * 1000);
    save(db);
  }

  function applyUrlParam() {
    var v;
    try { v = new URLSearchParams(location.search).get('mock'); } catch (e) { v = null; }
    if (!v) return false;
    if (v === 'reset') reset();
    else if (v === 'empty') reset({ empty: true });
    else if (/^cutoff:-?\d+$/.test(v)) reset({ cutoffInSec: parseInt(v.split(':')[1], 10) });
    else return false;
    return true;
  }

  // เปิดครั้งแรก (ยังไม่มีข้อมูลเลย) → สร้างรอบตัวอย่างให้เห็นหน้าตาทันที
  if (!applyUrlParam() && !load()) reset();

  TL.mockServer = { handle: handle };
  TL.mock = {
    reset: reset,
    now: function () { return toBkkIso(nowMs()); },
    setClockOffset: function (ms) { db.clockOffsetMs = Number(ms) || 0; save(db); },
    setLatency: function (ms) { latencyMs = Math.max(0, Number(ms) || 0); },
    dump: function () { return clone(db); }
  };
})();
