'use strict';

// QA helper — ตรวจว่า `overflow-wrap: anywhere` (FE-2 ef276f4) ไม่ทำให้ข้อความปกติตัดบรรทัดผิดที่
// เทียบ layout ของหน้าเดียวกัน 2 แบบ: ตามที่ ship (anywhere) vs บังคับ `overflow-wrap: normal` ทุก element
// ถ้าแบบ normal ไม่มี scroll แนวนอน (ข้อความจริงใส่กรอบได้อยู่แล้ว) แบบที่ ship ต้องได้จำนวนบรรทัดเท่ากันทุกข้อความ
// และตัวเลข (ราคา ยอด เวลา) ต้องไม่ถูกตัดกลางตัวเลข

/** ทำงานใน page: เก็บจำนวนบรรทัดของทุก text node ที่เห็น + ตัวเลขที่ถูกตัดข้ามบรรทัด */
function auditInPage() {
  const lineCount = (range) => {
    const tops = [];
    for (const r of range.getClientRects()) {
      if (r.width < 0.5) continue;
      if (!tops.some((t) => Math.abs(t - r.top) < 4)) tops.push(r.top);
    }
    return tops.length;
  };
  const out = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walker.nextNode())) {
    const text = n.textContent;
    if (!text.trim()) continue;
    const el = n.parentElement;
    if (!el || el.closest('[hidden]') || el.closest('script,style,template')) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    const rr = el.getBoundingClientRect();
    if (rr.width === 0 && rr.height === 0) continue;
    const range = document.createRange();
    range.selectNodeContents(n);
    const brokenNums = [];
    for (const m of text.matchAll(/\d[\d,:.]*\d|\d/g)) {
      const r2 = document.createRange();
      r2.setStart(n, m.index);
      r2.setEnd(n, m.index + m[0].length);
      if (lineCount(r2) > 1) brokenNums.push(m[0]);
    }
    const tag = el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).join('.') : '');
    out.push({ tag, text: text.trim().slice(0, 50), lines: lineCount(range), brokenNums });
  }
  return { sw: document.documentElement.scrollWidth, vw: window.innerWidth, nodes: out };
}

/**
 * คืน { diffs, brokenNums, baselineOverflow } — diffs = ข้อความที่จำนวนบรรทัดต่างจากแบบ overflow-wrap: normal
 * (นับเฉพาะเมื่อแบบ normal ไม่มี scroll แนวนอน · ถ้า normal ล้นจอ = ค่ายาวไม่มีช่องว่าง ซึ่งต้องตัดอยู่แล้ว)
 */
async function wrapAudit(page) {
  const shipped = await page.evaluate(auditInPage);
  const handle = await page.addStyleTag({ content: '*, *::before, *::after { overflow-wrap: normal !important; word-break: normal !important; }' });
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const normal = await page.evaluate(auditInPage);
  await handle.evaluate((el) => el.remove());
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const baselineOverflow = normal.sw > normal.vw;
  const diffs = [];
  if (!baselineOverflow && shipped.nodes.length === normal.nodes.length) {
    shipped.nodes.forEach((a, i) => {
      const b = normal.nodes[i];
      if (a.lines !== b.lines) diffs.push(`${a.tag} "${a.text}": ${a.lines} บรรทัด (normal ${b.lines})`);
    });
  } else if (shipped.nodes.length !== normal.nodes.length) {
    diffs.push(`จำนวน text node ไม่ตรงกัน ${shipped.nodes.length} vs ${normal.nodes.length}`);
  }
  const brokenNums = shipped.nodes.filter((x) => x.brokenNums.length).map((x) => `${x.tag} "${x.text}": ${x.brokenNums.join(', ')}`);
  return { diffs, brokenNums, baselineOverflow, scrollWidth: shipped.sw };
}

module.exports = { wrapAudit };
