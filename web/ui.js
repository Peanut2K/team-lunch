/* ข้าวเที่ยงทีม — ตัวช่วยและ component ที่ทุกหน้าใช้ร่วมกัน
 *
 *   TL.fmt    จัดรูปตัวเลข / เวลา (โซน Asia/Bangkok ไม่ขึ้นกับเครื่อง)
 *   TL.clock  นาฬิกา server: sync จาก serverNow แล้วเดินต่อด้วย performance.now() (D2)
 *   TL.icons  ไอคอนเส้นบาง (SVG) — ไม่ใช้ emoji แทนไอคอน
 *   TL.ui     component: cutoff (แถบเวลาปิดรับ) ฯลฯ
 */
(function () {
  'use strict';

  var TL = (window.TL = window.TL || {});
  var BKK_OFFSET_MS = 7 * 60 * 60 * 1000;

  /* ---------- format ---------- */
  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  var fmt = {
    /** 1250 → "1,250" (จำนวนเต็มบาท D4) */
    baht: function (n) { return Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 }); },
    /** ISO → "11:00" ตามเวลาไทย */
    hhmm: function (iso) {
      var d = new Date(Date.parse(iso) + BKK_OFFSET_MS);
      return pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes());
    },
    /** "2026-10-05" → "วันจันทร์ 5 ต.ค." */
    thaiDate: function (ymd) {
      var ms = Date.parse(ymd + 'T12:00:00+07:00');
      if (isNaN(ms)) return ymd;
      try {
        return new Intl.DateTimeFormat('th-TH', {
          weekday: 'long', day: 'numeric', month: 'short', timeZone: 'Asia/Bangkok'
        }).format(new Date(ms));
      } catch (e) { return ymd; }
    },
    /** ms ที่เหลือ → "17:48" หรือ "1:05:12" */
    countdown: function (ms) {
      var s = Math.max(0, Math.ceil(ms / 1000));
      var h = Math.floor(s / 3600);
      var m = Math.floor((s % 3600) / 60);
      var sec = s % 60;
      return h > 0 ? h + ':' + pad2(m) + ':' + pad2(sec) : pad2(m) + ':' + pad2(sec);
    },
    /** ms ที่เหลือ → คำอ่านสำหรับ screen reader */
    countdownSpoken: function (ms) {
      var s = Math.max(0, Math.ceil(ms / 1000));
      var h = Math.floor(s / 3600);
      var m = Math.floor((s % 3600) / 60);
      if (h > 0) return 'เหลือ ' + h + ' ชั่วโมง ' + m + ' นาที';
      if (m > 0) return 'เหลือ ' + m + ' นาที';
      return 'เหลือไม่ถึง 1 นาที';
    }
  };

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* ---------- นาฬิกา server ---------- */
  // ไม่ใช้ Date.now() ของเครื่องในการนับ — ใช้ serverNow + เวลาที่ผ่านไปแบบ monotonic
  var clockBase = null; // { serverMs, perfMs }
  var clock = {
    sync: function (serverNowIso) {
      var ms = Date.parse(serverNowIso);
      if (!isNaN(ms)) clockBase = { serverMs: ms, perfMs: performance.now() };
    },
    isSynced: function () { return clockBase !== null; },
    /** เวลา server ตอนนี้ (ms) หรือ null ถ้ายังไม่เคยได้ serverNow */
    now: function () {
      if (!clockBase) return null;
      return clockBase.serverMs + (performance.now() - clockBase.perfMs);
    }
  };

  /* ---------- ไอคอน (เส้น 1.75 สม่ำเสมอ) ---------- */
  function svg(paths, size) {
    size = size || 24;
    return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
      paths + '</svg>';
  }
  var icons = {
    clock: function (s) { return svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>', s); },
    lock: function (s) { return svg('<rect x="5" y="10.5" width="14" height="9.5" rx="2.5"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/>', s); },
    plus: function (s) { return svg('<path d="M12 6v12M6 12h12"/>', s); },
    minus: function (s) { return svg('<path d="M6 12h12"/>', s); },
    check: function (s) { return svg('<path d="M5.5 12.5l4 4 9-9"/>', s); },
    alert: function (s) { return svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 8v4.5M12 15.8v.2"/>', s); },
    bowl: function (s) {
      return svg('<path d="M3.5 11.5h17a8.5 8.5 0 0 1-17 0z"/><path d="M8 20h8"/>' +
        '<path d="M9 8.5c0-1.2 1-1.6 1-2.8M12.5 8.5c0-1.2 1-1.6 1-2.8"/>', s);
    },
    store: function (s) { return svg('<path d="M4 9.5 5.5 4.5h13L20 9.5"/><path d="M4 9.5a2.7 2.7 0 0 0 5.3 0 2.7 2.7 0 0 0 5.4 0 2.7 2.7 0 0 0 5.3 0"/><path d="M5.5 12v7.5h13V12"/><path d="M10 19.5v-4h4v4"/>', s); },
    user: function (s) { return svg('<circle cx="12" cy="8.5" r="3.5"/><path d="M5 19.5c1.2-3.3 3.8-5 7-5s5.8 1.7 7 5"/>', s); },
    note: function (s) { return svg('<path d="M6 4.5h12v15H6z"/><path d="M9 9h6M9 12.5h6M9 16h3.5"/>', s); },
    edit: function (s) { return svg('<path d="M14.5 5.5l4 4L9 19H5v-4z"/><path d="M12.5 7.5l4 4"/>', s); },
    close: function (s) { return svg('<path d="M7 7l10 10M17 7 7 17"/>', s); }
  };

  /* ---------- component: แถบเวลาปิดรับ ---------- */
  var SOON_MS = 10 * 60 * 1000; // เหลือไม่ถึง 10 นาที → เตือนเบาๆ

  /**
   * mount แถบเวลาปิดรับลงใน el
   * round: { cutoffAt, status } จาก API
   * opts.now      : ms คงที่ (ใช้โชว์ตัวอย่างสถานะ ไม่เดิน) — ปกติไม่ต้องใส่ จะใช้ TL.clock
   * opts.onClose  : เรียกครั้งเดียวเมื่อนับถึง 0 (เช่น ให้หน้าโหลดรอบใหม่ / ล็อกฟอร์ม)
   * opts.onState  : เรียกทุกครั้งที่สถานะเปลี่ยน 'open' | 'soon' | 'closed'
   * คืน { update(round), state(), destroy() }
   */
  function cutoff(el, round, opts) {
    opts = opts || {};
    var current = round;
    var lastState = null;
    var closedFired = false;
    var timer = null;

    el.classList.add('cutoff');
    el.innerHTML =
      '<div class="cutoff__when">' +
        '<p class="cutoff__label"></p>' +
        '<p class="cutoff__time num"></p>' +
      '</div>' +
      '<div class="cutoff__left">' +
        '<span class="cutoff__icon"></span>' +
        '<span class="cutoff__left-text">' +
          '<span class="cutoff__left-label"></span>' +
          '<span class="cutoff__count num" role="timer" aria-hidden="true"></span>' +
          '<span class="visually-hidden cutoff__spoken"></span>' +
        '</span>' +
      '</div>' +
      '<p class="visually-hidden" aria-live="polite" data-cutoff-announce></p>';

    var q = function (sel) { return el.querySelector(sel); };
    var labelEl = q('.cutoff__label');
    var timeEl = q('.cutoff__time');
    var iconEl = q('.cutoff__icon');
    var leftLabelEl = q('.cutoff__left-label');
    var countEl = q('.cutoff__count');
    var spokenEl = q('.cutoff__spoken');
    var announceEl = q('[data-cutoff-announce]');

    function nowMs() {
      if (typeof opts.now === 'number') return opts.now;
      return clock.now();
    }

    function render() {
      var cutoffMs = Date.parse(current.cutoffAt);
      var now = nowMs();
      var remaining = now == null ? null : cutoffMs - now;
      var state;
      if (current.status === 'closed' || (remaining != null && remaining <= 0)) state = 'closed';
      else if (remaining != null && remaining < SOON_MS) state = 'soon';
      else state = 'open';

      timeEl.textContent = fmt.hhmm(current.cutoffAt);

      if (state === 'closed') {
        labelEl.textContent = 'ปิดรับแล้วเมื่อ';
        leftLabelEl.textContent = 'ปิดรับแล้ว';
        countEl.textContent = '';
        spokenEl.textContent = '';
      } else {
        labelEl.textContent = 'ปิดรับ';
        leftLabelEl.textContent = state === 'soon' ? 'ใกล้ปิดแล้ว เหลือ' : 'เหลือเวลา';
        countEl.textContent = remaining == null ? '--:--' : fmt.countdown(remaining);
        spokenEl.textContent = remaining == null ? '' : fmt.countdownSpoken(remaining);
      }

      if (state !== lastState) {
        el.setAttribute('data-state', state);
        iconEl.innerHTML = state === 'closed' ? icons.lock(22) : icons.clock(22);
        if (lastState !== null) {
          announceEl.textContent = state === 'closed'
            ? 'ปิดรับ order แล้ว'
            : state === 'soon' ? 'เหลือเวลาไม่ถึง 10 นาที' : '';
        }
        lastState = state;
        if (opts.onState) opts.onState(state);
      }
      if (state === 'closed' && !closedFired && current.status !== 'closed') {
        closedFired = true;
        if (opts.onClose) opts.onClose();
      }
    }

    render();
    if (typeof opts.now !== 'number') timer = setInterval(render, 250);

    return {
      update: function (r) { current = r; closedFired = false; render(); },
      state: function () { return lastState; },
      destroy: function () { if (timer) clearInterval(timer); timer = null; }
    };
  }

  /* ---------- component: กระดานเมนู + ปุ่ม − / + ---------- */
  var MAX_QTY = 10;

  /**
   * items: [{ id, name, price }] จาก Round
   * opts.qty      : { itemId: qty } เริ่มต้น
   * opts.onChange : (qtyMap) => void
   * opts.disabled : true เมื่อปิดรับ
   * คืน { getQty(), setQty(map), getLines(), setDisabled(bool) }
   */
  function menuBoard(el, items, opts) {
    opts = opts || {};
    var qty = {};
    items.forEach(function (it) { qty[it.id] = (opts.qty && opts.qty[it.id]) || 0; });
    var disabled = !!opts.disabled;

    el.classList.add('board');
    el.setAttribute('role', 'list');
    el.innerHTML = items.map(function (it) {
      var n = escapeHtml(it.name);
      return '<li class="dish" data-item="' + escapeHtml(it.id) + '">' +
        '<p class="dish__info">' +
          '<span class="dish__name">' + n + '</span>' +
          '<span class="dish__leader" aria-hidden="true"></span>' +
          '<span class="dish__price"><span class="num">' + fmt.baht(it.price) + '</span> <span class="dish__unit">บาท</span></span>' +
        '</p>' +
        '<div class="stepper" role="group" aria-label="จำนวน ' + n + '">' +
          '<button type="button" class="stepper__btn" data-step="-1" aria-label="ลด ' + n + '">' + icons.minus(20) + '</button>' +
          '<output class="stepper__qty num" aria-live="polite">0</output>' +
          '<button type="button" class="stepper__btn" data-step="1" aria-label="เพิ่ม ' + n + '">' + icons.plus(20) + '</button>' +
        '</div>' +
      '</li>';
    }).join('');

    function paint() {
      el.toggleAttribute('data-disabled', disabled);
      Array.prototype.forEach.call(el.querySelectorAll('.dish'), function (row) {
        var id = row.getAttribute('data-item');
        var n = qty[id];
        row.toggleAttribute('data-selected', n > 0);
        row.querySelector('.stepper__qty').textContent = n;
        row.querySelector('[data-step="-1"]').disabled = disabled || n <= 0;
        row.querySelector('[data-step="1"]').disabled = disabled || n >= MAX_QTY;
      });
    }

    el.addEventListener('click', function (e) {
      var btn = e.target.closest('.stepper__btn');
      if (!btn || btn.disabled || disabled) return;
      var id = btn.closest('.dish').getAttribute('data-item');
      var next = Math.min(MAX_QTY, Math.max(0, qty[id] + Number(btn.getAttribute('data-step'))));
      if (next === qty[id]) return;
      qty[id] = next;
      paint();
      // ปุ่มที่กดอาจ disabled ไปแล้ว (เช่นลดถึง 0) — ย้าย focus ไปปุ่มอีกฝั่งให้คีย์บอร์ดไม่หลุด
      if (btn.disabled) {
        var other = btn.parentNode.querySelector('.stepper__btn:not([disabled])');
        if (other) other.focus();
      }
      if (opts.onChange) opts.onChange(Object.assign({}, qty));
    });

    paint();
    return {
      getQty: function () { return Object.assign({}, qty); },
      setQty: function (map) {
        items.forEach(function (it) { qty[it.id] = (map && map[it.id]) || 0; });
        paint();
        if (opts.onChange) opts.onChange(Object.assign({}, qty));
      },
      /** [{ itemId, qty }] เฉพาะที่เลือก — รูปแบบเดียวกับ body ของ PUT orders */
      getLines: function () {
        return items.filter(function (it) { return qty[it.id] > 0; })
          .map(function (it) { return { itemId: it.id, qty: qty[it.id] }; });
      },
      setDisabled: function (v) { disabled = !!v; paint(); }
    };
  }

  /**
   * ยอดก่อนยืนยัน (แสดงให้เห็นก่อนกด — ยอดจริงคือ total ที่ API ตอบกลับ)
   */
  function previewTotal(items, qtyMap) {
    var dishes = 0;
    var total = 0;
    items.forEach(function (it) {
      var n = qtyMap[it.id] || 0;
      dishes += n;
      total += n * it.price;
    });
    return { dishes: dishes, total: total };
  }

  /* ---------- focus ต้องไม่ถูกแถบยอดติดล่างจอบัง (F8, WCAG 2.4.11) ----------
   * 1) ตั้ง --orderbar-h ที่ <html> ให้เท่าความสูงแถบจริง → CSS ใช้เป็น scroll-padding-bottom
   *    browser จึงเลื่อน element ที่ได้ focus ขึ้นมาเหนือแถบเอง
   * 2) กันพลาด: ตอน focusin เลื่อนหน้าให้ element ทั้งตัวอยู่เหนือแถบทันที แล้วเช็กซ้ำอีกเฟรม
   *    (Chromium เลื่อนแค่ให้เห็นเคอร์เซอร์ของ textarea ไม่ใช่ทั้งช่อง scroll-padding อย่างเดียวจึงไม่พอ)
   */
  var FOCUS_GAP = 16; // ระยะเผื่อเหนือแถบ (ให้เห็น focus ring ด้วย)

  function revealAboveBar(bar, t) {
    var safeTop = FOCUS_GAP;
    var safeBottom = bar.getBoundingClientRect().top - FOCUS_GAP;
    var r = t.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return;
    var dy = 0;
    if (r.bottom > safeBottom) dy = r.bottom - safeBottom;
    if (r.top - dy < safeTop) dy = r.top - safeTop; // สูงกว่าพื้นที่ที่เหลือ → ให้เห็นหัว element ก่อน
    if (dy !== 0) window.scrollBy(0, dy > 0 ? Math.ceil(dy) : Math.floor(dy));
  }

  function keepFocusAboveBar(bar) {
    var root = document.documentElement;
    function measure() {
      var h = bar.hidden ? 0 : Math.ceil(bar.getBoundingClientRect().height);
      root.style.setProperty('--orderbar-h', h + 'px');
    }
    measure();
    if (window.ResizeObserver) new ResizeObserver(measure).observe(bar);
    window.addEventListener('resize', measure);

    document.addEventListener('focusin', function (e) {
      var t = e.target;
      if (bar.hidden || !t || t === document.body || bar.contains(t) || !t.getBoundingClientRect) return;
      if (getComputedStyle(bar).position !== 'fixed') return;
      revealAboveBar(bar, t);
      // เช็กซ้ำหลัง browser เลื่อนตาม focus เอง
      requestAnimationFrame(function () {
        if (document.activeElement === t) revealAboveBar(bar, t);
      });
    });
  }

  /* ---------- component: แถบยอด + ปุ่มยืนยัน (ติดล่างจอ ใช้นิ้วโป้งกดได้) ---------- */
  /**
   * opts: { onConfirm, label } · คืน { set({ dishes, total, disabled, busy, label }) }
   */
  function orderBar(el, opts) {
    opts = opts || {};
    el.classList.add('orderbar');
    el.innerHTML =
      '<div class="orderbar__inner">' +
        '<p class="orderbar__sum">' +
          '<span class="orderbar__label"></span>' +
          '<span class="orderbar__total"><span class="num"></span> <span class="orderbar__unit">บาท</span></span>' +
        '</p>' +
        '<button type="button" class="btn btn--primary orderbar__btn"></button>' +
      '</div>';
    var labelEl = el.querySelector('.orderbar__label');
    var totalEl = el.querySelector('.orderbar__total .num');
    var btn = el.querySelector('.orderbar__btn');
    btn.addEventListener('click', function () { if (opts.onConfirm) opts.onConfirm(); });
    keepFocusAboveBar(el);

    function set(s) {
      s = s || {};
      var dishes = s.dishes || 0;
      labelEl.textContent = dishes > 0 ? 'ยอดของคุณ ' + dishes + ' จาน' : 'ยังไม่ได้เลือกเมนู';
      totalEl.textContent = fmt.baht(s.total || 0);
      btn.textContent = s.busy ? 'กำลังส่ง…' : (s.label || opts.label || 'ยืนยันสั่ง');
      btn.disabled = !!s.disabled || !!s.busy || dishes === 0;
      btn.setAttribute('aria-busy', s.busy ? 'true' : 'false');
    }
    set({});
    return { set: set };
  }

  /* ---------- component: ข้อความแจ้ง (error จาก API / ปิดรับ / ข้อมูล) ---------- */
  /**
   * kind: 'error' | 'closed' | 'info' · message: แสดงตรงๆ (เช่น error.message จาก API)
   * ส่ง message ว่างเพื่อซ่อน
   */
  function notice(el, message, kind) {
    kind = kind || 'error';
    if (!message) { el.hidden = true; el.innerHTML = ''; return; }
    el.hidden = false;
    el.className = 'notice notice--' + kind;
    el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    var icon = kind === 'closed' ? icons.lock(20) : kind === 'info' ? icons.check(20) : icons.alert(20);
    el.innerHTML = '<span class="notice__icon">' + icon + '</span><p class="notice__text">' + escapeHtml(message) + '</p>';
  }

  /* ---------- component: สถานะว่าง ---------- */
  /**
   * opts: { title, body, actionLabel, onAction }
   */
  function emptyState(el, opts) {
    el.className = 'empty';
    el.innerHTML =
      '<span class="empty__art">' + icons.bowl(40) + '</span>' +
      '<h2 class="empty__title">' + escapeHtml(opts.title) + '</h2>' +
      (opts.body ? '<p class="empty__body">' + escapeHtml(opts.body) + '</p>' : '') +
      (opts.actionLabel ? '<button type="button" class="btn btn--secondary empty__action">' + escapeHtml(opts.actionLabel) + '</button>' : '');
    var a = el.querySelector('.empty__action');
    if (a && opts.onAction) a.addEventListener('click', opts.onAction);
  }

  /* ---------- component: "สั่งแล้ว" ---------- */
  /**
   * order: Order จาก API ({ name, lines: [{ itemId, qty, name? }], note, total, updatedAt? })
   * items: เมนูของรอบ (ไว้แปลง itemId → ชื่อ)
   * opts: { onEdit, onCancel, disabled }
   */
  function orderDone(el, order, items, opts) {
    opts = opts || {};
    var nameById = {};
    (items || []).forEach(function (it) { nameById[it.id] = it.name; });
    var when = order.updatedAt ? ' เมื่อ ' + fmt.hhmm(order.updatedAt) : '';
    el.className = 'done';
    el.setAttribute('role', 'status');
    el.innerHTML =
      '<div class="done__head">' +
        '<span class="done__badge">' + icons.check(22) + '</span>' +
        '<div>' +
          '<h3 class="done__title">สั่งแล้ว</h3>' +
          '<p class="done__meta">ในชื่อ ' + escapeHtml(order.name) + escapeHtml(when) + '</p>' +
        '</div>' +
      '</div>' +
      '<ul class="done__lines">' + order.lines.map(function (ln) {
        return '<li><span>' + escapeHtml(ln.name || nameById[ln.itemId] || ln.itemId) + '</span>' +
          '<span class="num">× ' + ln.qty + '</span></li>';
      }).join('') + '</ul>' +
      (order.note ? '<p class="done__note">' + icons.note(18) + '<span>' + escapeHtml(order.note) + '</span></p>' : '') +
      '<p class="done__total"><span>ยอดที่ต้องจ่าย</span><span><span class="num">' + fmt.baht(order.total) + '</span> บาท</span></p>' +
      '<div class="done__actions">' +
        '<button type="button" class="btn btn--secondary" data-act="edit">' + icons.edit(20) + 'แก้ order</button>' +
        '<button type="button" class="btn btn--quiet" data-act="cancel">ยกเลิก order</button>' +
      '</div>';
    Array.prototype.forEach.call(el.querySelectorAll('[data-act]'), function (b) {
      b.disabled = !!opts.disabled;
      b.addEventListener('click', function () {
        var fn = b.getAttribute('data-act') === 'edit' ? opts.onEdit : opts.onCancel;
        if (fn) fn();
      });
    });
  }

  /* ---------- component: สรุปยอด (ตัวเลขทั้งหมดมาจาก API) ---------- */
  function summary(el, s) {
    el.className = 'tally';
    var byItem = s.byItem.slice().sort(function (a, b) { return b.qty - a.qty; });
    el.innerHTML =
      '<div class="tally__totals">' +
        '<p><span class="tally__grand num">' + fmt.baht(s.grandTotal) + '</span> <span class="tally__unit">บาท</span></p>' +
        '<p class="tally__count">รวมจาก <span class="num">' + s.orderCount + '</span> คน</p>' +
      '</div>' +
      '<h3 class="tally__heading">สั่งร้าน</h3>' +
      (byItem.length ? '<ol class="tally__items">' + byItem.map(function (it) {
        return '<li class="tally__item">' +
          '<span class="tally__qty num">' + it.qty + '</span>' +
          '<span class="tally__name">' + escapeHtml(it.name) + '</span>' +
          '<span class="tally__amount"><span class="num">' + fmt.baht(it.amount) + '</span> บาท</span>' +
        '</li>';
      }).join('') + '</ol>' : '<p class="tally__none">ยังไม่มีใครสั่ง</p>') +
      '<h3 class="tally__heading">เก็บเงินรายคน</h3>' +
      (s.byPerson.length ? '<ul class="tally__people">' + s.byPerson.map(function (p) {
        return '<li class="person">' +
          '<p class="person__head"><span class="person__name">' + escapeHtml(p.name) + '</span>' +
            '<span class="person__total"><span class="num">' + fmt.baht(p.total) + '</span> บาท</span></p>' +
          '<p class="person__lines">' + p.lines.map(function (ln) {
            return escapeHtml(ln.name) + ' × ' + ln.qty;
          }).join(', ') + '</p>' +
          (p.note ? '<p class="person__note">' + icons.note(16) + '<span>' + escapeHtml(p.note) + '</span></p>' : '') +
        '</li>';
      }).join('') + '</ul>' : '<p class="tally__none">ยังไม่มีใครสั่ง</p>');
  }

  TL.ui = TL.ui || {};
  TL.ui.menuBoard = menuBoard;
  TL.ui.previewTotal = previewTotal;
  TL.ui.orderBar = orderBar;
  TL.ui.notice = notice;
  TL.ui.emptyState = emptyState;
  TL.ui.orderDone = orderDone;
  TL.ui.summary = summary;

  TL.fmt = fmt;
  TL.clock = clock;
  TL.icons = icons;
  TL.escapeHtml = escapeHtml;
  TL.ui.cutoff = cutoff;
})();
