'use strict';

/**
 * F7 · สรุปยอดของรอบ (Summary ตาม API contract)
 *
 * ยอดทุกจุดคำนวณจาก order_lines × ราคาเมนูของรอบ ชุดเดียวกัน จึงตรงกันโดยโครงสร้าง:
 *   ผลรวม byPerson.total = ผลรวม byItem.amount = grandTotal
 * order ที่ถูกแทนที่ (lines เดิมถูกลบใน upsert) หรือยกเลิก (ลบทั้ง order) ไม่อยู่ใน DB แล้ว จึงไม่ถูกนับ
 *
 * ลำดับ:
 * - byItem: จำนวนรวมมากไปน้อย · เท่ากันเรียงตามลำดับเมนูของรอบ · แสดงเฉพาะเมนูที่มีคนสั่ง (qty > 0)
 * - byPerson: ตามเวลาที่สั่งครั้งแรก (created_at) · lines ตามลำดับที่คนนั้นส่งมา
 */
function createSummaryRepo(db) {
  const selectItems = db.prepare(
    'SELECT id, name, price, position FROM items WHERE round_id = ? ORDER BY position');
  const selectOrders = db.prepare(
    'SELECT id, name, note FROM orders WHERE round_id = ? ORDER BY created_at, rowid');
  const selectLines = db.prepare(
    `SELECT l.order_id, l.item_id, l.qty
       FROM order_lines l JOIN orders o ON o.id = l.order_id
      WHERE o.round_id = ?
      ORDER BY l.order_id, l.position`);

  return {
    /**
     * @param {{id: string}} round รอบที่มีอยู่แล้ว (route ตรวจ NOT_FOUND ก่อน)
     */
    forRound(round) {
      const items = selectItems.all(round.id);
      const itemById = new Map(items.map((it) => [it.id, it]));

      const linesByOrder = new Map();
      for (const l of selectLines.all(round.id)) {
        if (!linesByOrder.has(l.order_id)) linesByOrder.set(l.order_id, []);
        linesByOrder.get(l.order_id).push(l);
      }

      const qtyByItem = new Map();
      const byPerson = selectOrders.all(round.id).map((o) => {
        const lines = (linesByOrder.get(o.id) || []).map((l) => {
          const item = itemById.get(l.item_id);
          qtyByItem.set(l.item_id, (qtyByItem.get(l.item_id) || 0) + l.qty);
          return { itemId: l.item_id, name: item.name, qty: l.qty, price: item.price };
        });
        return {
          name: o.name,
          lines: lines.map(({ itemId, name, qty }) => ({ itemId, name, qty })),
          note: o.note,
          total: lines.reduce((sum, l) => sum + l.qty * l.price, 0),
        };
      });

      const byItem = items
        .filter((it) => qtyByItem.has(it.id))
        .map((it) => ({
          itemId: it.id,
          name: it.name,
          qty: qtyByItem.get(it.id),
          amount: qtyByItem.get(it.id) * it.price,
          position: it.position,
        }))
        .sort((a, b) => b.qty - a.qty || a.position - b.position)
        .map(({ itemId, name, qty, amount }) => ({ itemId, name, qty, amount }));

      return {
        byItem,
        byPerson,
        grandTotal: byItem.reduce((sum, it) => sum + it.amount, 0),
        orderCount: byPerson.length,
      };
    },
  };
}

module.exports = { createSummaryRepo };
