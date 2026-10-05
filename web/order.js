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
    busy: false,
    order: null,     // order ที่บันทึกแล้วของชื่อในช่อง (จาก API) หรือ null
    mode: 'edit',    // 'edit' = เลือกเมนู · 'view' = เห็นการ์ด "สั่งแล้ว"
    lookupSeq: 0     // กันผล GET order เก่ามาทับผลใหม่
  };

  /* ---------- ชื่อจำไว้ในเครื่อง (F3) ---------- */
  var NAME_KEY = 'teamlunch.name';
  function loadName() {
    try { return window.localStorage.getItem(NAME_KEY) || ''; } catch (e) { return ''; }
  }
  function rememberName(name) {
    try { window.localStorage.setItem(NAME_KEY, name); } catch (e) { /* ใช้ไม่ได้ก็ไม่เป็นไร */ }
  }

  /* ---------- โหมด: เลือกเมนู / ดู order ที่สั่งแล้ว ---------- */
  function setMode(mode) {
    state.mode = mode;
    var viewing = mode === 'view' && !!state.order;
    $('#order').hidden = viewing;
    $('#orderbar').hidden = viewing;
    $('#order-done').hidden = !viewing;
    // แก้ order ที่มีอยู่ → หัวข้อบอกชัด + มีทางกลับไปการ์ดเดิม
    var editingExisting = !viewing && !!state.order;
    $('#order-title').textContent = editingExisting ? 'แก้ order ของ ' + state.order.name : 'เลือกเมนู';
    $('#edit-cancel').hidden = !editingExisting;
    if (viewing) renderDone();
    refreshBar();
  }

  function renderDone() {
    var el = $('#order-done');
    TL.ui.orderDone(el, state.order, state.round.items, {
      disabled: state.closed,
      onEdit: startEdit,
      onCancel: function () {}
    });
  }

  /** เติมเมนู + หมายเหตุจาก order เดิม แล้วสลับไปโหมดแก้ */
  function startEdit() {
    if (!state.order || state.closed) return;
    var map = {};
    state.order.lines.forEach(function (ln) { map[ln.itemId] = ln.qty; });
    state.board.setQty(map);
    $('#note').value = state.order.note || '';
    setMode('edit');
    var first = $('#board .stepper__btn:not([disabled])');
    $('#order').scrollIntoView({ block: 'start' });
    if (first) first.focus({ preventScroll: true });
  }

  function clearPicks() {
    state.board.setQty({});
    $('#note').value = '';
  }

  /**
   * ดู order ของชื่อนี้ (D12) — มีแล้ว: โชว์การ์ด "สั่งแล้ว" · ยังไม่สั่ง (404): กลับไปเลือกเมนู
   * ถ้าผู้ใช้เลือกเมนูค้างไว้แล้วชื่อนี้มี order อยู่ → คงที่เลือกไว้ และบอกว่ากดยืนยันจะแทนที่ (F4)
   */
  function lookup() {
    var name = $('#name').value.trim();
    var seq = ++state.lookupSeq;
    var wasViewing = state.mode === 'view';
    if (!name) {
      state.order = null;
      if (wasViewing) clearPicks();
      setMode('edit');
      return Promise.resolve(null);
    }
    if (state.order && sameName(state.order.name, name)) return Promise.resolve(state.order);
    return TL.api.getOrder(state.round.id, name).then(function (order) {
      if (seq !== state.lookupSeq) return null;
      state.order = order;
      rememberName(order.name);
      var hasPicks = state.board.getLines().length > 0;
      if (!wasViewing && hasPicks && !state.closed) {
        setMode('edit');
        TL.ui.notice($('#order-notice'), 'ชื่อ ' + order.name + ' สั่งไว้แล้ว กดยืนยันอีกครั้งจะแทนที่ order เดิม', 'info');
      } else {
        TL.ui.notice($('#order-notice'), '');
        setMode('view');
      }
      return order;
    }, function (err) {
      if (seq !== state.lookupSeq) return null;
      state.order = null;
      if (wasViewing) clearPicks();
      setMode('edit');
      // 404 = ชื่อนี้ยังไม่ได้สั่ง เป็นเรื่องปกติ ไม่ต้องเตือน
      if (err.code !== 'NOT_FOUND') TL.ui.notice($('#order-notice'), err.message, 'error');
      return null;
    });
  }

  /** เทียบชื่อแบบเดียวกับ key ของ BE (ตัดช่องว่าง + ไม่สนตัวพิมพ์, D3) — ใช้แค่เลี่ยงยิง GET ซ้ำ */
  function sameName(a, b) {
    return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
  }

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
    // การ์ด "สั่งแล้ว": ปุ่มแก้ / ยกเลิกใช้ไม่ได้หลังปิดรับ (F5)
    if (state.mode === 'view' && state.order) renderDone();
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

    var nameInput = $('#name');
    nameInput.value = loadName();
    nameInput.addEventListener('change', lookup);
    nameInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); lookup(); }
    });
    $('#edit-cancel').addEventListener('click', function () {
      TL.ui.notice($('#order-notice'), '');
      setMode('view');
      $('#order-done').focus();
    });
    setMode('edit');
    if (nameInput.value.trim()) lookup();
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
