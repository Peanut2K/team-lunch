'use strict';

const express = require('express');
const { bangkokTime, toBangkokISO } = require('../clock');
const { ApiError, notFound, readBody, validation } = require('../errors');
const { roundStatus } = require('../round-view');
const { validateOrder, validatePersonName } = require('../validate-order');

const roundNotFound = () => notFound('ไม่พบรอบสั่งนี้');

/**
 * F6 / D2 · ปิดรับตามเวลา server — ใช้กฎเดียวกับ `status` ใน Round (roundStatus: now >= cutoffAt = ปิด)
 * จึงไม่มีช่วงที่ Round บอก "open" แต่ PUT/DELETE ตอบ ROUND_CLOSED หรือกลับกัน
 * message บอกเวลาที่ปิด (HH:mm เวลาไทย) ตามตัวอย่างใน API contract
 */
function assertRoundOpen(round, current) {
  if (roundStatus(round, current) === 'closed') {
    throw new ApiError(409, 'ROUND_CLOSED', `ปิดรับ order แล้วเมื่อ ${bangkokTime(new Date(round.cutoffAt))}`);
  }
}

/**
 * path `/<name>` แบบ regex ไม่มี capture group — express จึงไม่ decode ชื่อให้เอง
 * (ถ้า decode พัง express จะโยน error ก่อนถึง route ทำให้คุมลำดับ D9 ไม่ได้) เราจึง decode เองใน decodeName
 */
const NAME_PATH = /^\/[^/]+\/?$/;

/** ชื่อจาก path (URL-encoded) — คืน null ถ้า percent-encoding พัง */
function decodeName(req) {
  const raw = req.path.replace(/^\//, '').replace(/\/$/, '');
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

/** แปลง order จาก repo เป็น Order ตาม API contract */
function toOrderJson(o) {
  return {
    id: o.id,
    roundId: o.roundId,
    name: o.name,
    lines: o.lines.map((l) => ({ itemId: l.itemId, qty: l.qty })),
    note: o.note,
    total: o.total,
    updatedAt: toBangkokISO(new Date(o.updatedAt)),
  };
}

/**
 * route ใต้ /api/rounds/:id/orders
 * ลำดับ error (D9): NOT_FOUND (ไม่มีรอบ) → VALIDATION → ROUND_CLOSED
 * ROUND_CLOSED (ปิดรับตามเวลา server, BE-24) ตัดสินด้วยเวลา server ตอน request มาถึง (now() ครั้งเดียวต่อ request)
 * @param {{repo, ordersRepo, now: () => Date}} deps
 */
function ordersRouter({ repo, ordersRepo, now }) {
  const router = express.Router({ mergeParams: true });

  // F3 / F4 · สั่งหรือแทนที่ order — ชื่อเดิม (ตัดช่องว่าง + ไม่สนตัวพิมพ์, D3) = แทนที่ ไม่เพิ่ม
  router.put('/', (req, res) => {
    const current = now();
    const round = repo.findById(req.params.id);
    if (!round) throw roundNotFound();
    const input = validateOrder(readBody(req), round);
    assertRoundOpen(round, current); // หลัง VALIDATION ตาม D9
    const { order } = ordersRepo.upsert({ roundId: round.id, ...input, at: current.getTime() });
    res.status(200).json(toOrderJson(order));
  });

  // F3 (D12) · ดู order ของชื่อนี้ — ดูได้ทั้งตอนเปิดและปิดรับ
  // contract ให้แค่ 404: ไม่มีรอบ หรือชื่อนี้ยังไม่ได้สั่ง — ชื่อที่ผิดรูปแบบ (ว่าง, > 40, encode พัง)
  // ไม่มีทางมี order จึงตอบ 404 เช่นกัน ไม่ตอบ VALIDATION
  router.get(NAME_PATH, (req, res) => {
    const round = repo.findById(req.params.id);
    if (!round) throw roundNotFound();
    const name = decodeName(req);
    const order = name === null ? null : ordersRepo.findByName(round.id, name);
    if (!order) throw notFound('ชื่อนี้ยังไม่ได้สั่งในรอบนี้');
    res.json(toOrderJson(order));
  });

  // F5 · ยกเลิก order ของชื่อนี้ → 204
  // ลำดับ (D9): NOT_FOUND (ไม่มีรอบ) → VALIDATION (ชื่อใน path, field "name") → ROUND_CLOSED (BE-24)
  //             → NOT_FOUND (ชื่อนี้ไม่มี order)
  router.delete(NAME_PATH, (req, res) => {
    const round = repo.findById(req.params.id);
    if (!round) throw roundNotFound();
    const raw = decodeName(req);
    if (raw === null) throw validation('name', 'ชื่อใน URL ไม่ถูกต้อง (ต้อง URL-encode)');
    const name = validatePersonName(raw);
    // BE-24: ตรวจ ROUND_CLOSED ตรงนี้ (หลัง VALIDATION ก่อนหา order ตาม D9)
    if (!ordersRepo.deleteByName(round.id, name)) throw notFound('ไม่พบ order ของชื่อนี้');
    res.status(204).end();
  });

  return router;
}

module.exports = { ordersRouter, toOrderJson };
