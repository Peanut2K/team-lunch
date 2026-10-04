'use strict';

const { toBangkokISO } = require('./clock');

/**
 * สถานะรอบ ณ เวลา server — ถึงเวลาปิดรับแล้ว (now >= cutoffAt) ถือว่าปิด
 * ใบอื่น (เช่น BE-24 ปิดรับ) ควรใช้ฟังก์ชันนี้ตัวเดียวกันเพื่อให้ status สอดคล้องกับกฎ
 */
function roundStatus(round, now) {
  return now.getTime() < round.cutoffAt ? 'open' : 'closed';
}

/** แปลงรอบจาก repo เป็น Round ตาม API contract (คำนวณ status / serverNow ทุกครั้งที่ตอบ) */
function toRoundJson(round, now) {
  return {
    id: round.id,
    date: round.date,
    restaurant: round.restaurant,
    cutoffAt: toBangkokISO(new Date(round.cutoffAt)),
    status: roundStatus(round, now),
    serverNow: toBangkokISO(now),
    items: round.items.map((it) => ({ id: it.id, name: it.name, price: it.price })),
  };
}

module.exports = { roundStatus, toRoundJson };
