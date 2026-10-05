/* ข้าวเที่ยงทีม — หน้าสั่งอาหาร (FE-2 · PRD F2–F6, F8)
 *
 * เรียก API ผ่าน TL.api เท่านั้น (D5) — สลับ API จริง / server จำลองได้
 * นับถอยหลังจาก serverNow (D2) · เวลาปิดรับตัดสินที่ server — หน้าเว็บแค่แสดงผล
 * error จาก API แสดง message ตรงๆ · VALIDATION ที่มี field แสดงข้างช่องนั้น (D11)
 * ยอดก่อนยืนยันคิดในหน้าเพื่อให้เห็นก่อนกด — ยอดจริงคือ total ที่ API ตอบกลับ
 */
(function () {
  'use strict';

  var TL = window.TL;
  var $ = function (sel, root) { return (root || document).querySelector(sel); };

  var state = {
    round: null,
    cutoffCtl: null,
    board: null,
    bar: null,
    closed: false,
    busy: false
  };

  /* ---------- หัวหน้า ---------- */
  function renderMasthead() {
    $('#brand').innerHTML = TL.icons.bowl(20) + '<span>ข้าวเที่ยงทีม</span>';
    var chip = $('#mode-chip');
    if (TL.api.mode === 'mock') {
      chip.textContent = 'server จำลอง';
      chip.title = 'ข้อมูลในหน้านี้มาจาก server จำลองในเครื่องนี้';
      chip.hidden = false;
    }
  }

  /* ---------- รอบวันนี้ + นับถอยหลัง ---------- */
  function renderRoundHead(round) {
    $('#store').textContent = round.restaurant;
    $('#round-date').textContent = TL.fmt.thaiDate(round.date);
    state.cutoffCtl = TL.ui.cutoff($('#cutoff'), round, {
      onState: function (s) { setClosed(s === 'closed'); },
      // ถึงเวลาปิดตามนาฬิกา server ที่นับในหน้า → ถาม server ยืนยันอีกครั้ง (ไม่ reload)
      onClose: refreshRound
    });
  }

  /** ขอรอบวันนี้ใหม่ — ได้ status + serverNow ล่าสุด (api.js sync นาฬิกาให้เอง) */
  function refreshRound() {
    if (!state.round) return Promise.resolve(null);
    return TL.api.getToday().then(function (r) {
      if (r.id !== state.round.id) return r; // ข้ามวันแล้ว — คงหน้าเดิมไว้ ผู้ใช้ reload เอง
      state.round = r;
      state.cutoffCtl.update(r);
      return r;
    }, function () { return null; /* คงสถานะเดิมไว้ */ });
  }

  function setClosed(closed) {
    state.closed = closed;
    if (state.board) state.board.setDisabled(closed);
    $('#note').disabled = closed;
    refreshBar();
  }

  /* ---------- แถบยอด ---------- */
  function refreshBar() {
    if (!state.bar || !state.round) return;
    var p = TL.ui.previewTotal(state.round.items, state.board ? state.board.getQty() : {});
    state.bar.set({
      dishes: p.dishes,
      total: p.total,
      busy: state.busy,
      disabled: state.closed,
      label: state.closed ? 'ปิดรับแล้ว' : 'ยืนยันสั่ง'
    });
  }

  function setupOrdering(round) {
    $('#ordering').hidden = false;
    $('#order').hidden = false;
    state.board = TL.ui.menuBoard($('#board'), round.items, {
      disabled: round.status === 'closed',
      onChange: refreshBar
    });
    $('#orderbar').hidden = false;
    state.bar = TL.ui.orderBar($('#orderbar'), { onConfirm: function () {} });
    setClosed(state.closed || round.status === 'closed');
  }

  /* ---------- ไม่มีรอบ / โหลดไม่ได้ ---------- */
  function showNoRound(err) {
    $('#store').textContent = 'ข้าวเที่ยงทีม';
    var box = $('#no-round');
    box.hidden = false;
    if (err.code === 'NO_ROUND') {
      TL.ui.emptyState(box, {
        title: err.message, // message จาก API ตรงๆ
        body: 'รอคนรับสั่งเปิดรอบ แล้วเปิดหน้านี้ใหม่อีกครั้ง'
      });
    } else {
      TL.ui.notice(box, err.message, 'error');
    }
  }

  /* ---------- เริ่ม ---------- */
  function init() {
    renderMasthead();
    TL.api.getToday().then(function (round) {
      state.round = round;
      renderRoundHead(round);
      setupOrdering(round);
    }, showNoRound);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
