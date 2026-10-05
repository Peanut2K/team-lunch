/* ข้าวเที่ยงทีม — หน้าสรุปยอดสำหรับคนรับสั่ง (FE-3 · PRD F7, F8)
 *
 * เรียก API ผ่าน TL.api เท่านั้น (D5): GET /api/rounds/today → GET /api/rounds/:id/summary
 * ตัวเลขทุกตัวมาจาก Summary ของ API ตรงๆ — หน้านี้ไม่บวก / ไม่เรียงเอง (API contract, D16)
 * error แสดง message ของ API ตรงๆ · NO_ROUND → สถานะว่าง + ปุ่มไปหน้าเปิดรอบ
 * รีเฟรชเอง: ทุก 20 วิ ตอนหน้าเปิดอยู่ · กลับมาที่แท็บ · ถึงเวลาปิดรับ (ได้ยอดสุดท้าย) · กดปุ่มรีเฟรช
 */
(function () {
  'use strict';

  var TL = window.TL;
  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var BKK_OFFSET_MS = 7 * 60 * 60 * 1000;
  var AUTO_REFRESH_MS = 20 * 1000;

  var state = { round: null, cutoffCtl: null, busy: false, seq: 0, timer: null };

  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  /** เวลา server ตอนนี้ "HH:mm:ss" (D2) */
  function serverClockText() {
    var ms = TL.clock.now();
    if (ms == null) return '';
    var d = new Date(ms + BKK_OFFSET_MS);
    return pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()) + ':' + pad2(d.getUTCSeconds());
  }

  /* ---------- หัวรอบ ---------- */
  function renderRound(r) {
    if (state.round && state.round.id === r.id && state.cutoffCtl) {
      state.round = r;
      state.cutoffCtl.update(r);
      return;
    }
    if (state.cutoffCtl) state.cutoffCtl.destroy();
    state.round = r;
    $('#store').textContent = r.restaurant;
    $('#round-date').textContent = TL.fmt.thaiDate(r.date);
    $('#cutoff').hidden = false;
    state.cutoffCtl = TL.ui.cutoff($('#cutoff'), r, {
      // ถึงเวลาปิดรับ → ขอสรุปอีกครั้ง ได้ยอดสุดท้ายไว้โทรสั่งร้าน
      onClose: function () { refresh(); }
    });
    $('#no-round').hidden = true;
    $('#sum-section').hidden = false;
    $('#share').hidden = false;
  }

  function showNoRound(message) {
    if (state.cutoffCtl) { state.cutoffCtl.destroy(); state.cutoffCtl = null; }
    state.round = null;
    $('#store').textContent = 'สรุปยอด';
    $('#round-date').textContent = '';
    $('#cutoff').hidden = true;
    $('#sum-section').hidden = true;
    $('#share').hidden = true;
    var box = $('#no-round');
    box.hidden = false;
    TL.ui.emptyState(box, {
      title: message, // message ของ NO_ROUND จาก API ตรงๆ
      body: 'คนรับสั่งเปิดรอบของวันนี้ได้ที่หน้าเปิดรอบสั่ง',
      actionLabel: 'เปิดรอบสั่ง',
      onAction: function () { location.href = TL.ui.pageHref('open.html'); }
    });
  }

  /* ---------- สรุปยอด ---------- */
  function setBusy(busy) {
    state.busy = busy;
    var b = $('#refresh');
    b.disabled = busy;
    b.setAttribute('aria-busy', busy ? 'true' : 'false');
    b.textContent = busy ? 'กำลังโหลด…' : 'รีเฟรช';
  }

  /** ขอรอบวันนี้ (ได้ serverNow + status ล่าสุด) แล้วขอสรุปของรอบนั้น */
  function refresh() {
    if (state.busy) return Promise.resolve();
    var my = ++state.seq;
    setBusy(true);
    return TL.api.getToday().then(function (r) {
      if (my !== state.seq) return;
      renderRound(r);
      return TL.api.getSummary(r.id).then(function (s) {
        if (my !== state.seq) return;
        TL.ui.summary($('#summary'), s);
        // error ครั้งก่อนหายแล้ว → ซ่อน (ข้อความ "เปิดรอบแล้ว" แบบ info คงไว้)
        if ($('#sum-notice').classList.contains('notice--error')) TL.ui.notice($('#sum-notice'), '');
        var t = serverClockText();
        $('#updated').textContent = t ? 'อัปเดตล่าสุด ' + t + ' น.' +
          (r.status === 'closed' ? ' · ปิดรับแล้ว ยอดนี้คือยอดสุดท้าย' : ' · รีเฟรชเองทุก 20 วินาที') : '';
      });
    }).catch(function (err) {
      if (my !== state.seq) return;
      if (err.code === 'NO_ROUND') return showNoRound(err.message);
      // error อื่น: แสดง message ของ API ตรงๆ ใต้หัวสรุป (คงตัวเลขที่เห็นล่าสุดไว้)
      var box = $('#sum-notice');
      TL.ui.notice(box, err.message, 'error');
    }).then(function () {
      if (my === state.seq) setBusy(false);
    });
  }

  /* ---------- ลิงก์ให้ทีมสั่ง ---------- */
  function setupShare() {
    var a = $('#share-url');
    TL.ui.wireLinks(a.parentNode);
    // URL เต็มของหน้าสั่ง (ไม่พา ?api= / ?theme= ไปด้วย — คนอื่นเปิดจากเครื่องตัวเอง)
    var orderUrl = new URL('./', location.href).href;
    a.textContent = orderUrl.replace(/^https?:\/\//, '');
    a.setAttribute('href', TL.ui.pageHref('index.html'));
    var btn = $('#share-copy');
    btn.addEventListener('click', function () {
      var done = function (ok) {
        btn.textContent = ok ? 'คัดลอกแล้ว' : 'คัดลอกไม่ได้ กดค้างที่ลิงก์แทน';
        setTimeout(function () { btn.textContent = 'คัดลอกลิงก์'; }, 2500);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(orderUrl).then(function () { done(true); }, function () { done(false); });
      } else {
        done(false);
      }
    });
  }

  /* ---------- เริ่ม ---------- */
  function init() {
    TL.ui.masthead();
    TL.ui.wireLinks(document);
    setupShare();

    // มาจากหน้าเปิดรอบที่เพิ่งเปิดสำเร็จ
    var opened = false;
    try { opened = new URLSearchParams(location.search).get('opened') === '1'; } catch (e) { /* ignore */ }
    if (opened) TL.ui.notice($('#sum-notice'), 'เปิดรอบสั่งแล้ว ส่งลิงก์หน้าสั่งอาหารให้ทีมได้เลย', 'info');

    $('#refresh').addEventListener('click', function () { refresh(); });
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') refresh();
    });
    state.timer = setInterval(function () {
      if (document.visibilityState === 'visible' && state.round) refresh();
    }, AUTO_REFRESH_MS);

    refresh();
  }

  init();
})();
