/* ข้าวเที่ยงทีม — หน้ารวม component (FE-1)
 * แสดงทุก component บนข้อมูลจริงจาก TL.api (server จำลองหรือ API จริง)
 * flow สั่งจริง (FE-2) และหน้าเปิดรอบ / สรุปยอด (FE-3) จะมาแทนที่ไฟล์นี้
 */
(function () {
  'use strict';

  var TL = window.TL;
  var $ = function (sel, root) { return (root || document).querySelector(sel); };

  function renderMasthead() {
    $('#brand').innerHTML = TL.icons.bowl(20) + '<span>ข้าวเที่ยงทีม</span>';
    var chip = $('#mode-chip');
    if (TL.api.mode === 'mock') {
      chip.textContent = 'server จำลอง';
      chip.title = 'ข้อมูลในหน้านี้มาจาก server จำลองในเครื่อง ไม่ได้ส่งไปที่ไหน';
      chip.hidden = false;
    }
  }

  function renderRoundHead(round) {
    $('#store').textContent = round.restaurant;
    $('#round-date').textContent = TL.fmt.thaiDate(round.date);
    cutoffCtl = TL.ui.cutoff($('#cutoff'), round, {
      onClose: function () {
        // ถึงเวลาปิด: ขอรอบใหม่จาก server เพื่อยืนยันสถานะ (ไม่ต้อง reload)
        TL.api.getToday().then(function (r) { cutoffCtl && cutoffCtl.update(r); }, function () {});
      }
    });
  }
  var cutoffCtl = null;

  function renderCutoffSamples(round) {
    var cutoffMs = Date.parse(round.cutoffAt);
    var samples = [
      { sel: '#sample-open', now: cutoffMs - (42 * 60 + 13) * 1000, status: 'open' },
      { sel: '#sample-soon', now: cutoffMs - (7 * 60 + 5) * 1000, status: 'open' },
      { sel: '#sample-closed', now: cutoffMs + 60 * 1000, status: 'closed' }
    ];
    samples.forEach(function (s) {
      TL.ui.cutoff($(s.sel), { cutoffAt: round.cutoffAt, status: s.status }, { now: s.now });
    });
  }

  function init() {
    renderMasthead();
    TL.api.getToday().then(function (round) {
      renderRoundHead(round);
      renderCutoffSamples(round);
    }, function (err) {
      $('#store').textContent = err.message;
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
