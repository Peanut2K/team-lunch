import { spawn, execFile } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { promisify } from "node:util";
import path from "node:path";
import crypto from "node:crypto";
import { RUNNER_DIR } from "./config.mjs";

const exec = promisify(execFile);
const isWin = process.platform === "win32";

/** Build the prompt Claude Code gets (via stdin, so Thai text survives Windows shells). */
export function buildPrompt(job) {
  const lines = [
    `คุณถูก delegate ใน Linear ให้ทำ issue ${job.issueIdentifier}${job.issueTitle ? ` (${job.issueTitle})` : ""} ในบทบาท ${job.displayName}.`,
    `Linear agent session id: ${job.sessionId}`,
    "",
    `ทำตามไฟล์บทบาทของคุณ 1 รอบ สำหรับ issue ${job.issueIdentifier} ใบนี้เท่านั้น — ข้ามขั้น "หางาน" เพราะงานถูกส่งมาให้แล้ว`,
    "ใช้เครื่องมือ Linear (mcp__Linear__*) ซึ่งล็อกอินเป็นตัวตนของคุณเอง ทุกอย่างที่คุณเขียนใน Linear จะขึ้นชื่อคุณ",
    "จบรอบด้วยการส่งต่อตามไฟล์บทบาท (เปลี่ยน status + delegate ให้ node ถัดไป)",
  ];
  if (job.userMessage) {
    lines.push("", "มีคนพิมพ์ใน agent session นี้ — ตอบหรือทำตามด้วย:", "<<<", job.userMessage, ">>>");
  }
  lines.push(
    "",
    "ข้อความสุดท้ายของคุณจะถูกโพสต์เป็นคำตอบใน Linear agent session: สรุปภาษาไทย 2–6 บรรทัด ว่าทำอะไร ผลเป็นอย่างไร และส่งต่อให้ใคร",
  );
  return lines.join("\n");
}

function quoteWin(arg) {
  return /[\s"&|<>^]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}

export class Runner {
  constructor(config, { tokens, onLog = console.log } = {}) {
    this.config = config;
    this.tokens = tokens;
    this.log = onLog;
    this.queues = {}; // agentKey -> [job]
    this.busy = {}; // agentKey -> job | null
    this.history = []; // last finished jobs (for /health)
  }

  /** Queue a job; returns false if the same issue is already waiting for this agent. */
  enqueue(job) {
    const q = (this.queues[job.agentKey] ||= []);
    if (q.some((j) => j.issueIdentifier === job.issueIdentifier && !job.userMessage)) return false;
    q.push(job);
    this.#pump(job.agentKey);
    return true;
  }

  status() {
    const out = {};
    for (const key of Object.keys(this.config.agents)) {
      out[key] = {
        running: this.busy[key] ? this.busy[key].issueIdentifier : null,
        queued: (this.queues[key] || []).map((j) => j.issueIdentifier),
        installed: this.tokens?.has(key) ?? false,
      };
    }
    return { agents: out, recent: this.history.slice(-10) };
  }

  async #pump(agentKey) {
    if (this.busy[agentKey]) return;
    const job = this.queues[agentKey]?.shift();
    if (!job) return;
    this.busy[agentKey] = job;
    const started = Date.now();
    let result;
    try {
      result = await this.runJob(job);
    } catch (err) {
      result = { ok: false, text: `runner error: ${err.message}` };
    }
    this.busy[agentKey] = null;
    this.history.push({ agent: agentKey, issue: job.issueIdentifier, ok: result.ok, secs: Math.round((Date.now() - started) / 1000) });
    this.log(`[${agentKey}] ${job.issueIdentifier} finished ok=${result.ok}`);
    await job.onDone?.(result).catch((e) => this.log(`[${agentKey}] onDone failed: ${e.message}`));
    this.#pump(agentKey);
  }

  async ensureWorktree(agentKey) {
    const { repoDir, workDir } = this.config;
    if (!repoDir || !workDir) throw new Error("REPO_DIR and WORK_DIR must be set");
    const dir = path.join(workDir, agentKey);
    if (!existsSync(dir)) {
      mkdirSync(workDir, { recursive: true });
      await exec("git", ["-C", repoDir, "fetch", "origin"]);
      await exec("git", ["-C", repoDir, "worktree", "add", "--detach", dir, "origin/main"]);
      this.log(`[${agentKey}] created worktree ${dir}`);
    } else {
      await exec("git", ["-C", dir, "fetch", "origin"]).catch(() => {});
    }
    return dir;
  }

  async runJob(job) {
    const cwd = await this.ensureWorktree(job.agentKey);
    const token = await this.tokens.get(job.agentKey);

    // MCP config: Linear MCP authenticated *as this agent's app user* via Bearer token.
    const runDir = path.join(RUNNER_DIR, ".run");
    mkdirSync(runDir, { recursive: true });
    const mcpFile = path.join(runDir, `mcp-${job.agentKey}-${crypto.randomUUID()}.json`);
    writeFileSync(
      mcpFile,
      JSON.stringify({
        mcpServers: {
          Linear: { type: "http", url: this.config.linearMcpUrl, headers: { Authorization: `Bearer ${token}` } },
        },
      }),
    );

    const args = [
      "-p",
      "--agent", job.claudeAgent,
      "--strict-mcp-config",
      "--mcp-config", mcpFile,
      "--permission-mode", this.config.permissionMode,
      "--output-format", "json",
    ];
    this.log(`[${job.agentKey}] start ${job.issueIdentifier} in ${cwd}`);
    try {
      return await this.#spawnClaude(args, buildPrompt(job), cwd);
    } finally {
      rmSync(mcpFile, { force: true });
    }
  }

  #spawnClaude(args, prompt, cwd) {
    return new Promise((resolve) => {
      const bin = this.config.claudeBin;
      const child = isWin
        ? spawn([quoteWin(bin), ...args.map(quoteWin)].join(" "), { cwd, shell: true, windowsHide: true })
        : spawn(bin, args, { cwd });
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      const timer = setTimeout(() => {
        if (isWin) execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], () => {});
        else child.kill("SIGTERM");
      }, this.config.jobTimeoutMs);
      child.on("error", (e) => {
        clearTimeout(timer);
        resolve({ ok: false, text: `ไม่สามารถเรียก Claude Code (${bin}): ${e.message}` });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        let parsed = null;
        try {
          parsed = JSON.parse(out.trim().split("\n").pop());
        } catch {}
        if (parsed && typeof parsed.result === "string") {
          resolve({ ok: !parsed.is_error && code === 0, text: parsed.result });
        } else {
          resolve({ ok: false, text: `Claude Code exit ${code}\n${(err || out).slice(-2000)}` });
        }
      });
      child.stdin.end(prompt);
    });
  }
}
