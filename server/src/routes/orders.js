'use strict';

const express = require('express');
const { toBangkokISO } = require('../clock');
const { notFound, readBody } = require('../errors');
const { validateOrder } = require('../validate-order');

const roundNotFound = () => notFound('ไม่พบรอบสั่งนี้');

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
 * ROUND_CLOSED (ปิดรับตามเวลา server) ทำใน BE-24 — จุดที่ต้องตรวจมี comment `BE-24` กำกับไว้
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
    // BE-24: ตรวจ ROUND_CLOSED ตรงนี้ (หลัง VALIDATION ตาม D9)
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

  return router;
}

module.exports = { ordersRouter, toOrderJson };
