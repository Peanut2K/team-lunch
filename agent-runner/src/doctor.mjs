// `npm run doctor` — check that this machine can run the agents (like a daemon's tool auto-detect).
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { loadConfig } from "./config.mjs";
import { TokenStore } from "./linear.mjs";

const isWin = process.platform === "win32";

let lastError = {};
function version(cmd, args = ["--version"]) {
  return new Promise((resolve) => {
    execFile(cmd, args, { shell: isWin, timeout: 15_000, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        lastError[cmd] = (stderr || err.message || "").trim().split(/\r?\n/)[0];
        return resolve(null);
      }
      resolve((stdout || stderr).trim().split(/\r?\n/)[0]);
    });
  });
}

/** Explain a missing tool: is it on this process's PATH at all? */
async function whyMissing(cmd) {
  const where = await new Promise((resolve) =>
    execFile(isWin ? "where" : "which", [cmd], { windowsHide: true }, (err, stdout) => resolve(err ? "" : stdout.trim().split(/\r?\n/)[0])),
  );
  if (where) return `เจอที่ ${where} แต่รันไม่ผ่าน: ${lastError[cmd] || "?"}`;
  return "ไม่อยู่ใน PATH ของหน้าต่างนี้ (ถ้าเพิ่งติดตั้ง ให้ปิด PowerShell แล้วเปิดใหม่)";
}

export async function runDoctor(config = loadConfig(), out = console.log) {
  const rows = [];
  const check = (ok, name, detail, fix = "") => rows.push({ ok, name, detail, fix });

  const nodeMajor = Number(process.versions.node.split(".")[0]);
  check(nodeMajor >= 22, "node", process.versions.node, "ติดตั้ง Node 22+");
  const tools = [
    ["git", ["--version"], "winget install Git.Git"],
    [config.claudeBin, ["--version"], "npm install -g @anthropic-ai/claude-code แล้วรัน claude เพื่อ login"],
    ["gh", ["--version"], "winget install GitHub.cli แล้ว gh auth login"],
    ["ngrok", ["version"], "winget install ngrok.ngrok"],
  ];
  for (const [cmd, args, fix] of tools) {
    const v = await version(cmd, args);
    check(Boolean(v), cmd === config.claudeBin ? "claude" : cmd, v || (await whyMissing(cmd)), fix);
  }

  check(Boolean(config.publicUrl), "PUBLIC_URL", config.publicUrl || "ยังไม่ตั้ง", "ใส่ใน .env");
  check(Boolean(config.repoDir && existsSync(config.repoDir)), "REPO_DIR", config.repoDir || "ยังไม่ตั้ง", "path ของ repo ที่ clone ไว้");
  check(Boolean(config.workDir), "WORK_DIR", config.workDir || "ยังไม่ตั้ง", "โฟลเดอร์สำหรับ worktree ของ agent");

  const tokens = new TokenStore(config);
  for (const a of Object.values(config.agents)) {
    const configured = Boolean(a.clientId && a.clientSecret && a.webhookSecret);
    check(configured, `${a.displayName} .env`, configured ? "ครบ" : "ขาด CLIENT_ID / CLIENT_SECRET / WEBHOOK_SECRET", "ดู README ขั้นที่ 3–4");
    check(tokens.has(a.key), `${a.displayName} ติดตั้งใน Linear`, tokens.has(a.key) ? "แล้ว" : "ยัง", `เปิด ${config.publicUrl || "<PUBLIC_URL>"}/oauth/${a.key}/install`);
  }

  for (const r of rows) out(`${r.ok ? "✔" : "✘"} ${r.name.padEnd(22)} ${r.detail}${r.ok ? "" : `  → ${r.fix}`}`);
  const bad = rows.filter((r) => !r.ok).length;
  out(bad ? `\nยังขาด ${bad} อย่าง` : "\nพร้อมทำงาน");
  return { rows, ok: bad === 0 };
}

if (process.argv[1]?.endsWith("doctor.mjs")) {
  const { ok } = await runDoctor();
  process.exitCode = ok ? 0 : 1;
}
