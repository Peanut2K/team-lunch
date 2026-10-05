// End-to-end: signed Linear webhook -> thought within 10s -> Claude Code (fake) runs in the
// agent's own worktree with Linear MCP authenticated as the agent -> response activity.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.mjs";
import { createServer } from "../src/server.mjs";
import { sign } from "../src/verify.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(path.join(tmpdir(), "agent-runner-"));
const activities = [];
let linear, app, base, config;

function listen(server) {
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port)));
}

before(async () => {
  // fake Linear GraphQL + OAuth
  linear = http.createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      if (req.url === "/oauth/token") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ access_token: "tok-refreshed", refresh_token: "r2", expires_in: 86400 }));
      }
      const { query, variables } = JSON.parse(b);
      if (query.includes("agentActivityCreate")) activities.push({ at: Date.now(), auth: req.headers.authorization, ...variables.input });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: { agentActivityCreate: { success: true }, viewer: { id: "u1", name: "QA" } } }));
    });
  });
  const lport = await listen(linear);

  // a real git repo with an origin, like the user's Desktop clone
  const origin = path.join(tmp, "origin.git");
  const repo = path.join(tmp, "team-lunch");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  execFileSync("git", ["clone", "-q", origin, repo]);
  writeFileSync(path.join(repo, "README.md"), "x");
  execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qam", "init", "--allow-empty"]);
  execFileSync("git", ["-C", repo, "add", "-A"]);
  execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "readme"]);
  execFileSync("git", ["-C", repo, "push", "-q", "origin", "main"]);

  config = loadConfig({
    PUBLIC_URL: "https://example.test",
    REPO_DIR: repo,
    WORK_DIR: path.join(tmp, "agents"),
    CLAUDE_BIN: path.join(here, "fake-claude.mjs"),
    LINEAR_API_URL: `http://127.0.0.1:${lport}/graphql`,
    LINEAR_OAUTH_URL: `http://127.0.0.1:${lport}/oauth/token`,
    TOKEN_FILE: path.join(tmp, "tokens.json"),
    BE_DEV_CLIENT_ID: "cid", BE_DEV_CLIENT_SECRET: "csec", BE_DEV_WEBHOOK_SECRET: "whsec-be",
    QA_CLIENT_ID: "cid", QA_CLIENT_SECRET: "csec", QA_WEBHOOK_SECRET: "whsec-qa",
  });
  process.env.FAKE_CLAUDE_LOG = path.join(tmp, "claude.json");
  const logs = [];
  ({ server: app } = createServer(config, { log: (m) => logs.push(m) }));
  // pre-install QA (as if OAuth was done) with a token that is still valid
  writeFileSync(config.tokenFile, JSON.stringify({}));
  const port = await listen(app);
  base = `http://127.0.0.1:${port}`;
});

after(() => {
  app?.close();
  linear?.close();
});

async function webhook(agentKey, payload, secret) {
  const raw = Buffer.from(JSON.stringify({ webhookTimestamp: Date.now(), ...payload }));
  return fetch(`${base}/webhook/${agentKey}`, {
    method: "POST",
    headers: { "content-type": "application/json", "linear-signature": sign(raw, secret) },
    body: raw,
  });
}

async function waitFor(fn, ms = 10_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("timeout");
}

test("unsigned / wrongly signed webhooks are rejected", async () => {
  const r = await webhook("qa", { type: "AgentSessionEvent" }, "wrong");
  assert.equal(r.status, 401);
});

test("install flow redirects to Linear authorize with actor=app and agent scopes", async () => {
  const r = await fetch(`${base}/oauth/qa/install`, { redirect: "manual" });
  assert.equal(r.status, 302);
  const loc = new URL(r.headers.get("location"));
  assert.equal(loc.origin + loc.pathname, "https://linear.app/oauth/authorize");
  assert.equal(loc.searchParams.get("actor"), "app");
  assert.match(loc.searchParams.get("scope"), /app:assignable/);
  assert.equal(loc.searchParams.get("redirect_uri"), "https://example.test/oauth/qa/callback");
  // finish the callback against the fake OAuth server
  const cb = await fetch(`${base}/oauth/qa/callback?code=abc&state=${loc.searchParams.get("state")}`);
  assert.equal(cb.status, 200);
  const stored = JSON.parse(readFileSync(config.tokenFile, "utf8"));
  assert.equal(stored.qa.accessToken, "tok-refreshed");
});

test("delegation -> thought < 10s -> claude runs as the agent -> response", async () => {
  const t0 = Date.now();
  const r = await webhook(
    "qa",
    { type: "AgentSessionEvent", action: "created", agentSession: { id: "ses-1", issue: { identifier: "FE-1", title: "หน้าตาพื้นฐาน" } } },
    "whsec-qa",
  );
  assert.equal(r.status, 200);

  const thought = await waitFor(() => activities.find((a) => a.agentSessionId === "ses-1" && a.content.type === "thought"));
  assert.ok(thought.at - t0 < 10_000, "thought must arrive within 10s");
  assert.equal(thought.auth, "Bearer tok-refreshed");

  const resp = await waitFor(() => activities.find((a) => a.agentSessionId === "ses-1" && a.content.type === "response"));
  assert.match(resp.content.body, /FE-1/);

  const call = JSON.parse(readFileSync(process.env.FAKE_CLAUDE_LOG, "utf8"));
  assert.deepEqual(call.args.slice(0, 3), ["-p", "--agent", "qa"]);
  assert.ok(call.args.includes("--strict-mcp-config"));
  assert.equal(call.auth, "Bearer tok-refreshed", "Linear MCP must be authenticated as the agent app");
  assert.match(call.prompt, /FE-1/);
  assert.equal(path.basename(call.cwd), "qa", "runs inside the agent's own worktree");
  assert.ok(existsSync(path.join(config.workDir, "qa", "README.md")), "worktree checked out from origin/main");
  // temp MCP config with the token is cleaned up
  assert.equal(existsSync(call.args[call.args.indexOf("--mcp-config") + 1]), false);
});

test("agent not installed yet -> 401-free 200 to Linear but no crash, and health shows state", async () => {
  const r = await webhook(
    "be-dev",
    { type: "AgentSessionEvent", action: "created", agentSession: { id: "ses-2", issue: { identifier: "BE-22" } } },
    "whsec-be",
  );
  assert.equal(r.status, 200);
  const h = await (await fetch(`${base}/health`)).json();
  assert.equal(h.agents["be-dev"].installed, false);
  assert.equal(h.agents.qa.installed, true);
});
