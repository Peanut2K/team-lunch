'use strict';

// เวลา server โซน Asia/Bangkok (D2) — ไทยไม่มี daylight saving จึงเป็น UTC+07:00 ตลอด
const OFFSET_MS = 7 * 60 * 60 * 1000;
const OFFSET_STR = '+07:00';

const systemClock = () => new Date();

/** Date → 'YYYY-MM-DDTHH:mm:ss+07:00' (ตัดเศษวินาที) */
function toBangkokISO(date) {
  const shifted = new Date(date.getTime() + OFFSET_MS).toISOString(); // ...Z แต่ตัวเลขเป็นเวลาไทย
  return shifted.slice(0, 19) + OFFSET_STR;
}

/** Date → 'YYYY-MM-DD' ตามปฏิทินไทย */
function bangkokDate(date) {
  return new Date(date.getTime() + OFFSET_MS).toISOString().slice(0, 10);
}

/** Date → 'HH:mm' ตามเวลาไทย (ใช้ใน message) */
function bangkokTime(date) {
  return new Date(date.getTime() + OFFSET_MS).toISOString().slice(11, 16);
}

const ISO_WITH_OFFSET =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * แปลง string ISO 8601 ที่ต้องมี offset ชัดเจน (เช่น +07:00 หรือ Z) เป็น Date
 * คืน null ถ้ารูปแบบผิดหรือวันที่ไม่มีจริง (เช่น 2026-02-31)
 */
function parseISOWithOffset(value) {
  if (typeof value !== 'string') return null;
  const m = ISO_WITH_OFFSET.exec(value);
  if (!m) return null;
  const [, y, mo, d, h, mi, s = '00', off] = m;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return null;
  // ตรวจว่าวันเวลาที่ใส่มามีจริง: แปลงกลับเป็นเวลาท้องถิ่นของ offset นั้นแล้วต้องตรงกัน
  let offMs = 0;
  if (off !== 'Z') {
    const sign = off[0] === '-' ? -1 : 1;
    offMs = sign * (Number(off.slice(1, 3)) * 60 + Number(off.slice(4, 6))) * 60000;
  }
  const local = new Date(ms + offMs).toISOString();
  if (local.slice(0, 19) !== `${y}-${mo}-${d}T${h}:${mi}:${s}`) return null;
  return new Date(ms);
}

/**
 * นาฬิกาจำลองสำหรับ test — ส่ง clock.now เข้า createApp({ now })
 * @param {string|Date} initial เวลาเริ่มต้น
 */
function createFakeClock(initial) {
  let current = new Date(initial).getTime();
  return {
    now: () => new Date(current),
    set: (t) => { current = new Date(t).getTime(); },
    advance: (ms) => { current += ms; },
  };
}

module.exports = {
  systemClock,
  toBangkokISO,
  bangkokDate,
  bangkokTime,
  parseISOWithOffset,
  createFakeClock,
};
