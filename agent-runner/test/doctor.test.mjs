import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.mjs";
import { runDoctor } from "../src/doctor.mjs";

test("doctor reports missing setup with a fix for each item", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "doctor-"));
  const lines = [];
  const { rows, ok } = await runDoctor(loadConfig({ TOKEN_FILE: path.join(dir, "t.json"), CLAUDE_BIN: "definitely-not-installed-xyz" }), (l) => lines.push(l));
  assert.equal(ok, false);
  const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
  assert.equal(byName.node.ok, true);
  assert.equal(byName.git.ok, true);
  assert.equal(byName.claude.ok, false);
  assert.equal(byName.PUBLIC_URL.ok, false);
  assert.equal(byName["QA ติดตั้งใน Linear"].ok, false);
  assert.ok(rows.filter((r) => !r.ok).every((r) => r.fix), "every failing check says how to fix it");
  assert.match(lines.at(-1), /ยังขาด/);
});
