// Small status page served at "/" (refreshes itself every 5s).
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

export function renderDashboard(config, status) {
  const rows = Object.entries(config.agents)
    .map(([key, a]) => {
      const s = status.agents[key];
      const state = !s.installed ? '<span class="warn">ยังไม่ติดตั้ง</span>' : s.running ? `<b>กำลังทำ ${esc(s.running)}</b>` : '<span class="ok">ว่าง</span>';
      const install = s.installed ? "" : ` · <a href="/oauth/${key}/install">ติดตั้ง</a>`;
      return `<tr><td>${esc(a.displayName)}</td><td>${state}${install}</td><td>${s.queued.map(esc).join(", ") || "—"}</td></tr>`;
    })
    .join("");
  const recent = status.recent
    .slice()
    .reverse()
    .map((j) => `<tr><td>${esc(j.agent)}</td><td>${esc(j.issue)}</td><td class="${j.ok ? "ok" : "warn"}">${j.ok ? "สำเร็จ" : "ผิดพลาด"}</td><td>${j.secs}s</td></tr>`)
    .join("");
  return `<!doctype html><html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="5"><title>agent-runner</title>
<style>
:root{--bg:#f6f5f1;--fg:#14172b;--muted:#5f6480;--line:#d9d8e3;--ok:#2f7d4f;--warn:#a84e15}
@media (prefers-color-scheme:dark){:root{--bg:#14172b;--fg:#f2f1ec;--muted:#b9bcd6;--line:#3a3e5c;--ok:#7fd39f;--warn:#f0a36b}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif;padding:24px 16px;max-width:760px;margin-inline:auto}
h1{font-size:20px;margin:0 0 4px}p{color:var(--muted);margin:0 0 20px}h2{font-size:15px;margin:24px 0 8px}
table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:8px 6px;border-bottom:1px solid var(--line)}th{color:var(--muted);font-weight:500}
.ok{color:var(--ok)}.warn{color:var(--warn)}a{color:inherit}
</style></head><body>
<h1>agent-runner · ข้าวเที่ยงทีม</h1><p>${esc(config.publicUrl || "ยังไม่ได้ตั้ง PUBLIC_URL")} · อัปเดตทุก 5 วินาที</p>
<h2>Agents</h2><table><tr><th>Agent</th><th>สถานะ</th><th>คิว</th></tr>${rows}</table>
<h2>งานล่าสุด</h2><table><tr><th>Agent</th><th>Issue</th><th>ผล</th><th>เวลา</th></tr>${recent || '<tr><td colspan="4">ยังไม่มี</td></tr>'}</table>
</body></html>`;
}
