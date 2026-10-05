import { readFileSync, writeFileSync, existsSync } from "node:fs";

/** Per-agent OAuth tokens (actor=app), stored locally in .tokens.json (gitignored). */
export class TokenStore {
  constructor(config) {
    this.config = config;
    this.file = config.tokenFile;
    this.data = existsSync(this.file) ? JSON.parse(readFileSync(this.file, "utf8")) : {};
  }
  save() {
    writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }
  has(agentKey) {
    return Boolean(this.data[agentKey]?.accessToken);
  }
  set(agentKey, tok) {
    this.data[agentKey] = {
      accessToken: tok.access_token,
      refreshToken: tok.refresh_token || this.data[agentKey]?.refreshToken || null,
      // Linear access tokens last 24h; refresh a few minutes early.
      expiresAt: Date.now() + (Number(tok.expires_in) || 86_400) * 1000,
      appUserId: tok.appUserId || this.data[agentKey]?.appUserId || null,
    };
    this.save();
  }
  async get(agentKey) {
    const t = this.data[agentKey];
    if (!t?.accessToken) throw new Error(`agent ${agentKey} is not installed yet — open /oauth/${agentKey}/install`);
    if (t.refreshToken && Date.now() > t.expiresAt - 5 * 60_000) {
      const a = this.config.agents[agentKey];
      const fresh = await oauthToken(this.config, {
        grant_type: "refresh_token",
        refresh_token: t.refreshToken,
        client_id: a.clientId,
        client_secret: a.clientSecret,
      });
      this.set(agentKey, fresh);
    }
    return this.data[agentKey].accessToken;
  }
}

export async function oauthToken(config, fields) {
  const res = await fetch(config.linearOauthUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    throw new Error(`Linear OAuth ${fields.grant_type} failed: ${res.status} ${JSON.stringify(json)}`);
  }
  return json;
}

export function authorizeUrl(config, agentKey, state) {
  const a = config.agents[agentKey];
  const q = new URLSearchParams({
    client_id: a.clientId,
    redirect_uri: `${config.publicUrl}/oauth/${agentKey}/callback`,
    response_type: "code",
    scope: "read,write,app:assignable,app:mentionable",
    actor: "app",
    state,
  });
  return `https://linear.app/oauth/authorize?${q}`;
}

export async function graphql(config, token, query, variables = {}) {
  const res = await fetch(config.linearApiUrl, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.errors) {
    throw new Error(`Linear GraphQL error ${res.status}: ${JSON.stringify(json.errors || json)}`);
  }
  return json.data;
}

const ACTIVITY = `mutation AgentActivityCreate($input: AgentActivityCreateInput!) {
  agentActivityCreate(input: $input) { success }
}`;

/** type: thought | response | error | elicitation (body) */
export async function postActivity(config, token, agentSessionId, type, body) {
  // Linear limits are generous, but keep the activity readable.
  const text = String(body || "").slice(0, 8000);
  return graphql(config, token, ACTIVITY, { input: { agentSessionId, content: { type, body: text } } });
}

export async function viewerId(config, token) {
  const d = await graphql(config, token, "query { viewer { id name } }");
  return d.viewer;
}
