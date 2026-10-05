/* ข้าวเที่ยงทีม — หน้าเปิดรอบสั่ง (FE-3 · PRD F1, F8)
 *
 * เรียก API ผ่าน TL.api เท่านั้น (D5) — สลับ API จริง / server จำลองได้
 * กฎ validation ตัดสินที่ BE ทั้งหมด: หน้านี้ส่งค่าที่ผู้ใช้กรอกไปตรงๆ แล้วแสดง message ของ API
 *   VALIDATION ที่มี field → แสดงใต้ช่องนั้น (D11) · field: null → ข้อความรวม
 *   ROUND_EXISTS → message ของ API + พาไปดูรอบที่มีอยู่
 * เวลาปิดรับ: ฟอร์มเริ่มที่ 11:00 (PRD F1, D10) แล้วประกอบเป็น ISO +07:00 ของวันนี้ตามปฏิทินไทย
 */
(function () {
  'use strict';

  var TL = window.TL;
  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var BKK_OFFSET_MS = 7 * 60 * 60 * 1000;
  var MAX_ITEMS = 30; // API contract: items 1–30 รายการ

  var state = { busy: false, seq: 0 };

  /* ---------- วันนี้ตามปฏิทินไทย ----------
   * ใช้เวลา server ถ้าเคยได้ serverNow (เช่นจาก GET /rounds/today) ไม่งั้นใช้นาฬิกาเครื่อง
   * — วันที่ใช้แค่ประกอบ cutoffAt ส่วน "อยู่ในอนาคต / วันเดียวกับรอบ" BE เป็นคนตัดสิน (D2, D10)
   */
  function bkkToday() {
    var ms = TL.clock.isSynced() ? TL.clock.now() : Date.now();
    return new Date(ms + BKK_OFFSET_MS).toISOString().slice(0, 10);
  }

  /** "11:00" → "2026-10-05T11:00:00+07:00" · ว่าง → "" (ให้ BE ตอบว่าต้องใส่) */
  function cutoffIso(hhmm) {
    if (!/^\d{2}:\d{2}(:\d{2})?$/.test(hhmm)) return hhmm;
    if (hhmm.length === 5) hhmm += ':00';
    return bkkToday() + 'T' + hhmm + '+07:00';
  }

  /** ราคาที่พิมพ์ → ตัวเลข ถ้าเป็นตัวเลขล้วน (ยอมให้มี , คั่นหลักพัน) · ไม่ใช่ตัวเลข → ส่งไปตามที่พิมพ์ ให้ BE ตอบ VALIDATION */
  function parsePrice(raw) {
    var t = String(raw).trim().replace(/,/g, '');
    if (t === '') return null;
    if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
    return t;
  }

  /* ---------- แถวเมนู (เพิ่ม / ลบ) ---------- */
  var rowSeq = 0;

  function rows() { return Array.prototype.slice.call(document.querySelectorAll('#menu-rows .menu-row')); }

  function addRow(focus) {
    if (rows().length >= MAX_ITEMS) return;
    var k = ++rowSeq;
    var li = document.createElement('li');
    li.className = 'menu-row';
    li.innerHTML =
      '<div class="menu-row__name">' +
        '<label class="visually-hidden" for="item-name-' + k + '"></label>' +
        '<input class="field__input" id="item-name-' + k + '" type="text" autocomplete="off" placeholder="ชื่อเมนู" enterkeyhint="next">' +
      '</div>' +
      '<div class="menu-row__price">' +
        '<label class="visually-hidden" for="item-price-' + k + '"></label>' +
        '<input class="field__input num" id="item-price-' + k + '" type="text" inputmode="numeric" autocomplete="off" placeholder="ราคา" enterkeyhint="next">' +
        '<span class="menu-row__unit" aria-hidden="true">บาท</span>' +
      '</div>' +
      '<button type="button" class="btn btn--quiet menu-row__remove">' + TL.icons.close(20) + '</button>' +
      '<p class="field__error menu-row__error" id="item-error-' + k + '" hidden></p>';
    $('#menu-rows').appendChild(li);
    li.querySelector('.menu-row__remove').addEventListener('click', function () { removeRow(li); });
    Array.prototype.forEach.call(li.querySelectorAll('input'), function (inp) {
      inp.addEventListener('input', function () { hideRowError(li); });
    });
    relabel();
    if (focus) li.querySelector('input').focus();
  }

  function removeRow(li) {
    var list = rows();
    if (list.length <= 1) return;
    var i = list.indexOf(li);
    li.parentNode.removeChild(li);
    hideError($('#items-error'));
    relabel();
    var next = rows()[Math.min(i, rows().length - 1)];
    (next ? next.querySelector('input') : $('#add-item')).focus();
  }

  /** เลขรายการใน label / ปุ่มลบตามลำดับปัจจุบัน + ปุ่มเพิ่ม / ลบ ใช้ได้ไหม */
  function relabel() {
    var list = rows();
    list.forEach(function (li, i) {
      var n = i + 1;
      var labels = li.querySelectorAll('label');
      labels[0].textContent = 'ชื่อเมนูรายการที่ ' + n;
      labels[1].textContent = 'ราคาเมนูรายการที่ ' + n + ' (บาท)';
      var rm = li.querySelector('.menu-row__remove');
      rm.setAttribute('aria-label', 'ลบเมนูรายการที่ ' + n);
      rm.disabled = list.length <= 1;
    });
    var add = $('#add-item');
    add.disabled = list.length >= MAX_ITEMS;
    add.innerHTML = TL.icons.plus(20) + '<span>' +
      (list.length >= MAX_ITEMS ? 'ครบ ' + MAX_ITEMS + ' เมนูแล้ว' : 'เพิ่มเมนู') + '</span>';
  }

  /* ---------- error ข้างช่อง (D11) ---------- */
  function showError(msgEl, input, message) {
    msgEl.innerHTML = TL.icons.alert(16) + '<span>' + TL.escapeHtml(message) + '</span>';
    msgEl.setAttribute('role', 'alert');
    msgEl.hidden = false;
    if (input) {
      input.setAttribute('aria-invalid', 'true');
      input.setAttribute('aria-describedby', msgEl.id);
      input.focus({ preventScroll: true });
      input.scrollIntoView({ block: 'center' });
    } else {
      msgEl.scrollIntoView({ block: 'center' });
    }
  }

  function hideError(msgEl, input) {
    if (!msgEl.hidden) {
      msgEl.hidden = true;
      msgEl.textContent = '';
      msgEl.removeAttribute('role');
    }
    if (input) { input.removeAttribute('aria-invalid'); input.removeAttribute('aria-describedby'); }
  }

  function hideRowError(li) {
    var msg = li.querySelector('.menu-row__error');
    Array.prototype.forEach.call(li.querySelectorAll('input'), function (inp) { hideError(msg, inp); });
  }

  function clearErrors() {
    hideError($('#restaurant-error'), $('#restaurant'));
    hideError($('#cutoff-error'), $('#cutoff-time'));
    hideError($('#items-error'));
    rows().forEach(hideRowError);
    TL.ui.notice($('#form-notice'), '');
  }

  /** field ของ API → ช่องที่ผิด: restaurant · cutoffAt · items · items[i] · items[i].name · items[i].price */
  function showApiError(err) {
    if (err.code === 'VALIDATION' && typeof err.field === 'string') {
      var f = err.field;
      if (f === 'restaurant') return showError($('#restaurant-error'), $('#restaurant'), err.message);
      if (f === 'cutoffAt') return showError($('#cutoff-error'), $('#cutoff-time'), err.message);
      if (f === 'items') {
        showError($('#items-error'), null, err.message);
        $('#add-item').focus({ preventScroll: true });
        return;
      }
      var m = f.match(/^items\[(\d+)\](?:\.(name|price))?$/);
      var li = m && rows()[Number(m[1])];
      if (li) {
        var input = li.querySelector(m[2] === 'price' ? '.menu-row__price input' : '.menu-row__name input');
        return showError(li.querySelector('.menu-row__error'), input, err.message);
      }
    }
    if (err.code === 'ROUND_EXISTS') return showExisting(err.message, true);
    var box = $('#form-notice');
    TL.ui.notice(box, err.message, 'error');
    box.scrollIntoView({ block: 'nearest' });
  }

  /* ---------- วันนี้มีรอบแล้ว → พาไปดูรอบที่มีอยู่ ---------- */
  /**
   * title: ข้อความหัว (ROUND_EXISTS ใช้ message ของ API ตรงๆ)
   * moveFocus: true = ผู้ใช้เพิ่งกดเปิดรอบ → เลื่อน + ย้าย focus ไปที่ปุ่มดูรอบ
   */
  function showExisting(title, moveFocus) {
    var box = $('#existing');
    var my = ++state.seq;
    box.hidden = false;
    box.setAttribute('role', moveFocus ? 'alert' : 'status');
    box.innerHTML =
      '<span class="existing__icon">' + TL.icons.store(22) + '</span>' +
      '<div class="existing__body">' +
        '<p class="existing__title">' + TL.escapeHtml(title) + '</p>' +
        '<p class="existing__meta" id="existing-meta"></p>' +
        '<div class="existing__actions">' +
          '<a class="btn btn--primary existing__go" data-href="summary.html">ดูสรุปยอดรอบนี้</a>' +
          '<a class="btn btn--secondary" data-href="index.html">หน้าสั่งอาหาร</a>' +
        '</div>' +
      '</div>';
    TL.ui.wireLinks(box);
    if (moveFocus) {
      box.scrollIntoView({ block: 'start' });
      box.querySelector('.existing__go').focus({ preventScroll: true });
    }
    // รายละเอียดรอบที่มีอยู่ (ร้าน · เวลาปิด) — ถ้าดึงไม่ได้ก็แสดงแค่หัวข้อ
    return TL.api.getToday().then(function (r) {
      if (my !== state.seq) return;
      $('#existing-meta').textContent = r.restaurant + ' · ' +
        (r.status === 'closed' ? 'ปิดรับแล้วเมื่อ ' : 'ปิดรับ ') + TL.fmt.hhmm(r.cutoffAt) + ' น.';
    }, function () { /* ไม่มีข้อมูลเพิ่ม */ });
  }

  /* ---------- ส่งฟอร์ม → POST /api/rounds ---------- */
  function setBusy(busy) {
    state.busy = busy;
    var btn = $('#open-submit');
    btn.disabled = busy;
    btn.setAttribute('aria-busy', busy ? 'true' : 'false');
    btn.textContent = busy ? 'กำลังเปิดรอบ…' : 'เปิดรอบสั่ง';
  }

  function submit(e) {
    e.preventDefault();
    if (state.busy) return;
    clearErrors();
    var body = {
      restaurant: $('#restaurant').value,
      cutoffAt: cutoffIso($('#cutoff-time').value),
      items: rows().map(function (li) {
        return {
          name: li.querySelector('.menu-row__name input').value,
          price: parsePrice(li.querySelector('.menu-row__price input').value)
        };
      })
    };
    setBusy(true);
    TL.api.createRound(body).then(function () {
      // เปิดสำเร็จ → ไปหน้าสรุปยอดของรอบนี้ (มีลิงก์หน้าสั่งให้ส่งต่อทีม)
      var href = TL.ui.pageHref('summary.html');
      location.href = href + (href.indexOf('?') < 0 ? '?' : '&') + 'opened=1';
    }, function (err) {
      setBusy(false);
      showApiError(err);
    });
  }

  /* ---------- เริ่ม ---------- */
  function init() {
    TL.ui.masthead();
    TL.ui.wireLinks(document);
    addRow(false);
    $('#add-item').addEventListener('click', function () { hideError($('#items-error')); addRow(true); });
    $('#round-form').addEventListener('submit', submit);
    $('#restaurant').addEventListener('input', function () { hideError($('#restaurant-error'), $('#restaurant')); });
    $('#cutoff-time').addEventListener('input', function () { hideError($('#cutoff-error'), $('#cutoff-time')); });
    $('#today-date').textContent = TL.fmt.thaiDate(bkkToday());

    // วันนี้เปิดรอบไปแล้ว → บอกตั้งแต่เปิดหน้า (ยังกรอกได้ ถ้ากดเปิดซ้ำ API จะตอบ ROUND_EXISTS)
    TL.api.getToday().then(function () {
      $('#today-date').textContent = TL.fmt.thaiDate(bkkToday()); // ได้ serverNow แล้ว ใช้วันของ server
      showExisting('วันนี้เปิดรอบสั่งไปแล้ว', false);
    }, function () { /* NO_ROUND = ยังไม่มีรอบ เปิดได้ตามปกติ */ });
  }

  init();
})();
