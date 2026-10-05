import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
export const RUNNER_DIR = path.resolve(here, "..");

const AGENT_DEFS = JSON.parse(readFileSync(path.join(RUNNER_DIR, "agents.json"), "utf8"));

/** Build runtime config from env. Missing secrets are allowed (agent just stays disabled). */
export function loadConfig(env = process.env) {
  const agents = {};
  for (const [key, def] of Object.entries(AGENT_DEFS)) {
    const p = def.envPrefix;
    agents[key] = {
      key,
      displayName: def.displayName,
      claudeAgent: def.claudeAgent,
      clientId: env[`${p}_CLIENT_ID`] || "",
      clientSecret: env[`${p}_CLIENT_SECRET`] || "",
      webhookSecret: env[`${p}_WEBHOOK_SECRET`] || "",
    };
  }
  return {
    port: Number(env.PORT || 8787),
    publicUrl: (env.PUBLIC_URL || "").replace(/\/+$/, ""),
    repoDir: env.REPO_DIR || "",
    workDir: env.WORK_DIR || "",
    claudeBin: env.CLAUDE_BIN || "claude",
    permissionMode: env.CLAUDE_PERMISSION_MODE || "bypassPermissions",
    jobTimeoutMs: Number(env.JOB_TIMEOUT_MIN || 45) * 60_000,
    linearApiUrl: env.LINEAR_API_URL || "https://api.linear.app/graphql",
    linearOauthUrl: env.LINEAR_OAUTH_URL || "https://api.linear.app/oauth/token",
    linearMcpUrl: env.LINEAR_MCP_URL || "https://mcp.linear.app/mcp",
    tokenFile: env.TOKEN_FILE || path.join(RUNNER_DIR, ".tokens.json"),
    agents,
  };
}
