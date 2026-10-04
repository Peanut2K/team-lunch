/* ข้าวเที่ยงทีม — หน้ารวม component (FE-1)
 * แสดงทุก component บนข้อมูลจาก TL.api (server จำลอง หรือ API จริง)
 * flow สั่งเต็มรูปแบบ (FE-2) และหน้าเปิดรอบ / สรุปยอด (FE-3) จะต่อยอดจากไฟล์นี้
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
    busy: false,
    closed: false
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

  /* ---------- รอบวันนี้ ---------- */
  function setClosed(closed) {
    state.closed = closed;
    if (state.board) state.board.setDisabled(closed);
    refreshBar();
  }

  function renderRoundHead(round) {
    $('#store').textContent = round.restaurant;
    $('#round-date').textContent = TL.fmt.thaiDate(round.date);
    state.cutoffCtl = TL.ui.cutoff($('#cutoff'), round, {
      onState: function (s) { setClosed(s === 'closed'); },
      onClose: function () {
        // ถึงเวลาปิดตามนาฬิกา server: ถาม server อีกครั้งเพื่อยืนยัน (ไม่ต้อง reload)
        TL.api.getToday().then(function (r) {
          state.round = r;
          state.cutoffCtl.update(r);
        }, function () { /* คงสถานะปิดไว้ */ });
      }
    });
  }

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

  function showOrderError(err) {
    var closed = err && err.code === 'ROUND_CLOSED';
    TL.ui.notice($('#order-notice'), err.message, closed ? 'closed' : 'error');
    if (closed) {
      TL.api.getToday().then(function (r) { state.round = r; state.cutoffCtl.update(r); }, function () {});
    }
  }

  function submitOrder() {
    if (state.busy || state.closed) return;
    state.busy = true;
    refreshBar();
    TL.ui.notice($('#order-notice'), '');
    TL.api.putOrder(state.round.id, {
      name: $('#name').value,
      lines: state.board.getLines(),
      note: $('#note').value
    }).then(function (order) {
      renderDone($('#order-done'), order);
      $('#order-done').hidden = false;
      loadSummary();
    }, showOrderError).then(function () {
      state.busy = false;
      refreshBar();
    });
  }

  function renderDone(el, order) {
    TL.ui.orderDone(el, order, state.round.items, {
      disabled: state.closed,
      onEdit: function () {
        var first = $('#board .stepper__btn:not([disabled])');
        $('#board').scrollIntoView({ behavior: 'smooth', block: 'start' });
        if (first) first.focus({ preventScroll: true });
      },
      onCancel: function () {
        TL.api.deleteOrder(state.round.id, order.name).then(function () {
          el.hidden = true;
          TL.ui.notice($('#order-notice'), 'ยกเลิก order ของ ' + order.name + ' แล้ว', 'info');
          loadSummary();
        }, showOrderError);
      }
    });
  }

  function renderOrderSection(round) {
    $('#order').hidden = false;
    state.board = TL.ui.menuBoard($('#board'), round.items, {
      disabled: round.status === 'closed',
      onChange: refreshBar
    });
    $('#orderbar').hidden = false;
    state.bar = TL.ui.orderBar($('#orderbar'), { onConfirm: submitOrder });
    $('#order-form').addEventListener('submit', function (e) { e.preventDefault(); submitOrder(); });
    refreshBar();
  }

  function loadSummary() {
    if (!state.round) return Promise.resolve(null);
    return TL.api.getSummary(state.round.id).then(function (s) {
      TL.ui.summary($('#summary'), s);
      return s;
    }, function (err) {
      TL.ui.notice($('#summary'), err.message, 'error');
      return null;
    });
  }

  /* ---------- ตัวอย่างสถานะ (ไม่เดิน) ---------- */
  function renderSamples(round, summary) {
    var cutoffAt = round ? round.cutoffAt : '2026-10-05T11:00:00+07:00';
    var cutoffMs = Date.parse(cutoffAt);
    [
      { sel: '#sample-open', now: cutoffMs - (42 * 60 + 13) * 1000, status: 'open' },
      { sel: '#sample-soon', now: cutoffMs - (7 * 60 + 5) * 1000, status: 'open' },
      { sel: '#sample-closed', now: cutoffMs + 60 * 1000, status: 'closed' }
    ].forEach(function (s) {
      TL.ui.cutoff($(s.sel), { cutoffAt: cutoffAt, status: s.status }, { now: s.now });
    });

    // ข้อความ error: ขอจาก server จริงๆ (ส่ง order ว่าง → VALIDATION)
    if (round) {
      TL.api.putOrder(round.id, { name: '', lines: [] }).then(null, function (err) {
        TL.ui.notice($('#sample-notice-error'), err.message, 'error');
      });
    } else {
      TL.ui.notice($('#sample-notice-error'), 'เลือกเมนูอย่างน้อย 1 รายการ', 'error');
    }
    TL.ui.notice($('#sample-notice-closed'), 'ปิดรับ order แล้วเมื่อ ' + TL.fmt.hhmm(cutoffAt), 'closed');

    var person = summary && summary.byPerson[0];
    if (person) {
      // ตัวอย่างเฉยๆ ปุ่มไม่ผูกกับ API
      TL.ui.orderDone($('#sample-done'), person, round.items, {});
    } else {
      $('#sample-done').closest('section').hidden = true;
    }

    TL.ui.emptyState($('#sample-empty'), {
      title: 'วันนี้ยังไม่มีรอบสั่ง',
      body: 'รอคนรับสั่งเปิดรอบ หรือเปิดรอบเองถ้าวันนี้คุณเป็นคนรับสั่ง',
      actionLabel: 'เปิดรอบสั่ง'
    });
  }

  /* ---------- เริ่ม ---------- */
  function init() {
    renderMasthead();
    TL.api.getToday().then(function (round) {
      state.round = round;
      renderRoundHead(round);
      renderOrderSection(round);
      return loadSummary().then(function (s) { renderSamples(round, s); });
    }, function (err) {
      $('#store').textContent = 'ข้าวเที่ยงทีม';
      var box = $('#no-round');
      box.hidden = false;
      if (err.code === 'NO_ROUND') {
        TL.ui.emptyState(box, {
          title: err.message,
          body: 'รอคนรับสั่งเปิดรอบ หรือเปิดรอบเองถ้าวันนี้คุณเป็นคนรับสั่ง'
        });
      } else {
        TL.ui.notice(box, err.message, 'error');
      }
      $('#summary').closest('section').hidden = true;
      renderSamples(null, null);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
