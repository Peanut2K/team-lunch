'use strict';

const express = require('express');
const { bangkokDate } = require('../clock');
const { ApiError } = require('../errors');
const { isUniqueViolation } = require('../db');
const { validateNewRound } = require('../validate-round');
const { toRoundJson } = require('../round-view');

const roundExists = () => new ApiError(409, 'ROUND_EXISTS', 'วันนี้เปิดรอบสั่งไปแล้ว เปิดซ้ำไม่ได้');

/**
 * @param {{repo: ReturnType<import('../rounds-repo').createRoundsRepo>, now: () => Date}} deps
 */
function roundsRouter({ repo, now }) {
  const router = express.Router();

  // F1 · เปิดรอบสั่งวันนี้
  router.post('/', (req, res) => {
    const current = now();
    const input = validateNewRound(req.body, current);
    const date = bangkokDate(current);

    if (repo.findByDate(date)) throw roundExists();

    let round;
    try {
      round = repo.create({
        id: `r_${date.replace(/-/g, '')}`,
        date,
        restaurant: input.restaurant,
        cutoffAt: input.cutoffAt,
        createdAt: current.getTime(),
        items: input.items,
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw roundExists(); // มีคนเปิดตัดหน้าพร้อมกัน
      throw err;
    }
    res.status(201).json(toRoundJson(round, current));
  });

  // F2 · ดูรอบวันนี้ (วันตามปฏิทินไทย) — status / serverNow คำนวณจากเวลา server ทุกครั้ง
  router.get('/today', (req, res) => {
    const current = now();
    const round = repo.findByDate(bangkokDate(current));
    if (!round) throw new ApiError(404, 'NO_ROUND', 'วันนี้ยังไม่มีรอบสั่งข้าว');
    res.json(toRoundJson(round, current));
  });

  return router;
}

module.exports = { roundsRouter };
