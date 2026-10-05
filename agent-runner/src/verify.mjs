import crypto from "node:crypto";

/**
 * Verify a Linear webhook: `Linear-Signature` = hex HMAC-SHA256 of the raw body
 * with the app's webhook signing secret, and `webhookTimestamp` within 60s.
 */
export function verifyWebhook({ rawBody, signature, secret, now = Date.now(), toleranceMs = 60_000 }) {
  if (!secret) return { ok: false, reason: "no webhook secret configured" };
  if (!signature || !/^[0-9a-f]+$/i.test(signature)) return { ok: false, reason: "missing signature" };
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest();
  const given = Buffer.from(signature, "hex");
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    return { ok: false, reason: "bad signature" };
  }
  let body;
  try {
    body = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return { ok: false, reason: "body is not JSON" };
  }
  const ts = Number(body.webhookTimestamp);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > toleranceMs) {
    return { ok: false, reason: "stale or missing webhookTimestamp" };
  }
  return { ok: true, body };
}

export function sign(rawBody, secret) {
  return crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
}
