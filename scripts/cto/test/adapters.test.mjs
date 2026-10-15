/**
 * Adversarial tests: command adapter honesty (timeout/exit capture,
 * secret redaction) and verification-output parsing.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runCommand, sanitizeOutput } from "../lib/adapter.js";
import { parseCounts } from "../verify.mjs";

describe("runCommand honesty", () => {
  it("captures exit codes instead of throwing", async () => {
    const ok = await runCommand("node -e \"process.exit(0)\"", { cwd: process.cwd(), timeoutMs: 10000 });
    assert.equal(ok.exitCode, 0);
    assert.equal(ok.timedOut, false);
    const bad = await runCommand("node -e \"process.exit(3)\"", { cwd: process.cwd(), timeoutMs: 10000 });
    assert.equal(bad.exitCode, 3);
  });

  it("timeouts are recorded as timeouts, never passes", async () => {
    const res = await runCommand("node -e \"setTimeout(()=>{}, 10000)\"", { cwd: process.cwd(), timeoutMs: 300 });
    assert.equal(res.timedOut, true);
    assert.notEqual(res.exitCode, 0);
  });
});

describe("sanitizeOutput", () => {
  it("redacts secret-shaped values and truncates", () => {
    const dirty = "api_key=sk-live-abcdef password: hunter2 normal words";
    const clean = sanitizeOutput(dirty);
    assert.ok(!clean.includes("sk-live-abcdef"));
    assert.ok(!clean.includes("hunter2"));
    assert.ok(clean.includes("normal words"));
    const long = sanitizeOutput("x".repeat(25000), 100);
    assert.ok(long.includes("[truncated"));
  });
});

describe("parseCounts", () => {
  it("reads vitest summary lines; nulls when absent", () => {
    const out = " Test Files  2 failed | 177 passed\n      Tests  3 failed | 1595 passed | 154 skipped\n";
    assert.deepEqual(parseCounts(out), { passed: 1595, failed: 3, skipped: 154 });
    assert.deepEqual(parseCounts("no counts here"), { passed: null, failed: null, skipped: null });
  });
});
