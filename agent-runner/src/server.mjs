import http from "node:http";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import { loadConfig } from "./config.mjs";
import { verifyWebhook } from "./verify.mjs";
import { TokenStore, authorizeUrl, oauthToken, postActivity, viewerId } from "./linear.mjs";
import { Runner } from "./runner.mjs";

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function send(res, status, body, type = "application/json; charset=utf-8") {
  res.writeHead(status, { "content-type": type });
  res.end(typeof body === "string" ? body : JSON.stringify(body, null, 2));
}

/** Pull what we need out of an AgentSessionEvent payload. */
export function parseAgentEvent(body) {
  if (body?.type !== "AgentSessionEvent") return null;
  if (body.action !== "created" && body.action !== "prompted") return null;
  const s = body.agentSession || {};
  const issue = s.issue || {};
  if (!s.id || !issue.identifier) return null;
  const userMessage =
    body.action === "prompted" ? body.agentActivity?.body || body.agentActivity?.content?.body || "" : "";
  return { action: body.action, sessionId: s.id, issueIdentifier: issue.identifier, issueTitle: issue.title || "", userMessage };
}

export function createServer(config = loadConfig(), deps = {}) {
  const log = deps.log || ((m) => console.log(new Date().toISOString(), m));
  const tokens = deps.tokens || new TokenStore(config);
  const runner = deps.runner || new Runner(config, { tokens, onLog: log });
  const states = new Map(); // oauth state -> agentKey

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://local");
    const parts = url.pathname.split("/").filter(Boolean);
    try {
      if (req.method === "GET" && url.pathname === "/health") {
        return send(res, 200, runner.status());
      }

      // ---- one-time install of each agent into the Linear workspace (actor=app) ----
      if (req.method === "GET" && parts[0] === "oauth" && config.agents[parts[1]]) {
        const agentKey = parts[1];
        const agent = config.agents[agentKey];
        if (parts[2] === "install") {
          if (!agent.clientId || !config.publicUrl) return send(res, 400, `${agentKey}: ตั้ง CLIENT_ID และ PUBLIC_URL ใน .env ก่อน`, "text/plain; charset=utf-8");
          const state = crypto.randomUUID();
          states.set(state, agentKey);
          res.writeHead(302, { location: authorizeUrl(config, agentKey, state) });
          return res.end();
        }
        if (parts[2] === "callback") {
          const state = url.searchParams.get("state");
          if (states.get(state) !== agentKey) return send(res, 400, "state ไม่ตรง — เริ่มใหม่ที่ /oauth/<agent>/install", "text/plain; charset=utf-8");
          states.delete(state);
          const tok = await oauthToken(config, {
            grant_type: "authorization_code",
            code: url.searchParams.get("code") || "",
            redirect_uri: `${config.publicUrl}/oauth/${agentKey}/callback`,
            client_id: agent.clientId,
            client_secret: agent.clientSecret,
          });
          const me = await viewerId(config, tok.access_token).catch(() => null);
          tokens.set(agentKey, { ...tok, appUserId: me?.id });
          log(`[${agentKey}] installed as ${me?.name || "?"} (${me?.id || "?"})`);
          return send(res, 200, `<h2>ติดตั้ง ${agent.displayName} แล้ว</h2><p>ชื่อใน Linear: ${me?.name || "?"}</p><p>ปิดหน้านี้ได้</p>`, "text/html; charset=utf-8");
        }
      }

      // ---- Linear webhooks: one URL per agent ----
      if (req.method === "POST" && parts[0] === "webhook" && config.agents[parts[1]]) {
        const agentKey = parts[1];
        const agent = config.agents[agentKey];
        const raw = await readBody(req);
        const v = verifyWebhook({ rawBody: raw, signature: req.headers["linear-signature"], secret: agent.webhookSecret });
        if (!v.ok) {
          log(`[${agentKey}] rejected webhook: ${v.reason}`);
          return send(res, 401, { error: v.reason });
        }
        send(res, 200, { ok: true }); // answer Linear right away

        const ev = parseAgentEvent(v.body);
        if (!ev) return;
        const token = await tokens.get(agentKey);
        const queued = runner.status().agents[agentKey];
        const wait = queued.running ? ` (รอ ${queued.running}${queued.queued.length ? ` และอีก ${queued.queued.length} ใบ` : ""} ก่อน)` : "";
        // Linear expects a thought within 10 seconds of the session starting.
        await postActivity(config, token, ev.sessionId, "thought", `${agent.displayName} รับงาน ${ev.issueIdentifier} แล้ว กำลังเริ่ม Claude Code${wait}`);
        log(`[${agentKey}] ${ev.action} ${ev.issueIdentifier} session=${ev.sessionId}`);

        runner.enqueue({
          ...ev,
          agentKey,
          displayName: agent.displayName,
          claudeAgent: agent.claudeAgent,
          onDone: async (result) => {
            const t = await tokens.get(agentKey);
            await postActivity(config, t, ev.sessionId, result.ok ? "response" : "error", result.text);
          },
        });
        return;
      }

      return send(res, 404, { error: "not found" });
    } catch (err) {
      log(`error ${req.method} ${url.pathname}: ${err.message}`);
      if (!res.headersSent) send(res, 500, { error: err.message });
    }
  });
  return { server, runner, tokens };
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const config = loadConfig();
  const { server } = createServer(config);
  server.listen(config.port, () => {
    console.log(`agent-runner listening on :${config.port}`);
    for (const [key, a] of Object.entries(config.agents)) {
      const ready = a.clientId && a.webhookSecret;
      console.log(`  ${a.displayName.padEnd(7)} webhook ${config.publicUrl || "<PUBLIC_URL>"}/webhook/${key}  install ${config.publicUrl || "<PUBLIC_URL>"}/oauth/${key}/install  ${ready ? "" : "(ยังไม่ได้ตั้งค่าใน .env)"}`);
    }
  });
}
