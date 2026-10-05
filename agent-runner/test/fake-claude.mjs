#!/usr/bin/env node
// Stand-in for `claude -p` in tests: checks the flags the runner passes and echoes a result.
import { readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const val = (f) => args[args.indexOf(f) + 1];
let prompt = "";
process.stdin.on("data", (d) => (prompt += d));
process.stdin.on("end", () => {
  const mcp = JSON.parse(readFileSync(val("--mcp-config"), "utf8"));
  const auth = mcp.mcpServers.Linear.headers.Authorization;
  writeFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ args, prompt, auth, cwd: process.cwd() }));
  const issue = (prompt.match(/issue ([A-Z]+-\d+)/) || [])[1];
  setTimeout(() => {
    process.stdout.write(JSON.stringify({ type: "result", is_error: false, result: `ทำ ${issue} เสร็จ ส่งต่อให้ QA แล้ว` }) + "\n");
  }, Number(process.env.FAKE_CLAUDE_DELAY_MS || 50));
});
