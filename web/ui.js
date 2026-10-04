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

  TL.fmt = fmt;
  TL.clock = clock;
  TL.icons = icons;
  TL.escapeHtml = escapeHtml;
  TL.ui = TL.ui || {};
  TL.ui.cutoff = cutoff;
})();
