import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyWebhook, sign } from "../src/verify.mjs";
import { parseAgentEvent } from "../src/server.mjs";

const secret = "s3cret";
const body = (o) => Buffer.from(JSON.stringify(o));

test("accepts a correctly signed, fresh webhook", () => {
  const raw = body({ type: "AgentSessionEvent", webhookTimestamp: Date.now() });
  const r = verifyWebhook({ rawBody: raw, signature: sign(raw, secret), secret });
  assert.equal(r.ok, true);
});

test("rejects wrong signature, wrong secret, missing header", () => {
  const raw = body({ webhookTimestamp: Date.now() });
  assert.equal(verifyWebhook({ rawBody: raw, signature: sign(raw, "other"), secret }).ok, false);
  assert.equal(verifyWebhook({ rawBody: raw, signature: undefined, secret }).ok, false);
  assert.equal(verifyWebhook({ rawBody: raw, signature: "zz", secret }).ok, false);
  assert.equal(verifyWebhook({ rawBody: raw, signature: sign(raw, secret), secret: "" }).ok, false);
});

test("rejects a tampered body", () => {
  const raw = body({ webhookTimestamp: Date.now(), a: 1 });
  const sig = sign(raw, secret);
  const tampered = body({ webhookTimestamp: Date.now(), a: 2 });
  assert.equal(verifyWebhook({ rawBody: tampered, signature: sig, secret }).ok, false);
});

test("rejects timestamps older than 60s (replay)", () => {
  const raw = body({ webhookTimestamp: Date.now() - 61_000 });
  assert.equal(verifyWebhook({ rawBody: raw, signature: sign(raw, secret), secret }).ok, false);
});

test("parseAgentEvent: created and prompted", () => {
  const base = { type: "AgentSessionEvent", agentSession: { id: "ses1", issue: { identifier: "BE-22", title: "API" } } };
  assert.deepEqual(parseAgentEvent({ ...base, action: "created" }), {
    action: "created", sessionId: "ses1", issueIdentifier: "BE-22", issueTitle: "API", userMessage: "",
  });
  assert.equal(parseAgentEvent({ ...base, action: "prompted", agentActivity: { body: "แก้ด่วน" } }).userMessage, "แก้ด่วน");
  assert.equal(parseAgentEvent({ ...base, action: "removed" }), null);
  assert.equal(parseAgentEvent({ type: "Issue", action: "create" }), null);
  assert.equal(parseAgentEvent({ ...base, agentSession: { id: "x" }, action: "created" }), null);
});
