#!/usr/bin/env node
/**
 * Evidence-bound verification (spec sections 3.4, 8.3).
 *
 *   verify.mjs <task-id> [--attempt <id>] [--command <cmd>] [--integrated] [--timeout-ms N]
 *
 * Runs the task's declared verification commands (or one of them), captures
 * exit codes and sanitized output, and persists an evidence record bound to
 * the exact source revision tested (branch, HEAD, dirty fingerprint).
 *
 * Refusals, not silent passes: timeouts, spawn failures, and missing output
 * are recorded as timeout/fail/error — never as pass. --integrated marks
 * the record as applying to the integrated revision (post-merge checks).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ctoDir, toplevel, branch, head, dirtyFingerprint } from "./lib/gitutil.js";
import { loadTasksFile } from "./lib/spec.js";
import { openDb, ensureTask, recordVerification } from "./lib/store.js";
import { createLocalAdapter } from "./lib/adapter.js";

/** Best-effort vitest/jest-style count extraction; nulls when absent. */
export function parseCounts(output) {
  // Prefer the "Tests  a passed (b)" line over the file-counts line, which
  // carries the same words with different numbers.
  const testsLine = output.split("\n").find((l) => /^\s*Tests\s/.test(l)) ?? output;
  const pick = (re) => {
    const m = testsLine.match(re);
    return m ? Number(m[1]) : null;
  };
  return {
    passed: pick(/(\d+)\s+passed/),
    failed: pick(/(\d+)\s+failed/),
    skipped: pick(/(\d+)\s+skipped/),
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const taskId = argv.find((a) => !a.startsWith("--"));
  const opt = (name, def) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : def;
  };
  const flag = (name) => argv.includes(`--${name}`);
  if (!taskId) {
    console.error("usage: verify.mjs <task-id> [--attempt <id>] [--command <cmd>] [--integrated]");
    process.exit(2);
  }
  const root = toplevel(process.cwd());
  const cto = ctoDir(process.cwd());
  const db = openDb(cto);
  try {
    const { tasks } = loadTasksFile(join(root, "tasks.json"));
    const specs = new Map(tasks.map((t) => [t.id, t]));
    const spec = specs.get(taskId);
    if (!spec) throw new Error(`unknown task ${taskId}`);
    for (const [, s] of specs) ensureTask(db, s, "qa");

    const lease = db.prepare("SELECT * FROM leases WHERE task_id = ?").get(taskId) ?? null;
    const attemptId = opt("attempt", lease?.attempt_id ?? null);
    const cwd = lease && !lease.released_at ? lease.worktree : root;
    const runBranch = lease && !lease.released_at ? lease.branch : branch(cwd);
    const runHead = head(cwd);
    const fp = await dirtyFingerprint(cwd);

    const only = opt("command", null);
    const commands = spec.verification.commands.filter((c) => !only || c.command === only);
    if (commands.length === 0) throw new Error(`no matching verification command${only ? ` for "${only}"` : ""}`);

    const adapter = createLocalAdapter();
    const logDir = join(cto, "logs", taskId, attemptId ?? "no-attempt");
    mkdirSync(logDir, { recursive: true });
    let overall = "pass";
    for (const c of commands) {
      const stepCwd = join(root, c.cwd === "." ? "" : c.cwd);
      const res = await adapter.runStep({ command: c.command, cwd: stepCwd, timeoutMs: Number(opt("timeout-ms", 600000)) });
      const counts = parseCounts(`${res.stdout}\n${res.stderr}`);
      const outcome = res.timedOut ? "timeout" : res.exitCode === 0 ? "pass" : "fail";
      if (outcome !== "pass") overall = outcome;
      const stamp = new Date(res.startedAt).toISOString().replace(/[:.]/g, "-");
      const outputRef = join(logDir, `${stamp}.log`);
      writeFileSync(outputRef, `command: ${res.command}\ncwd: ${res.cwd}\nexit: ${res.exitCode}\n\n--- stdout ---\n${res.stdout}\n--- stderr ---\n${res.stderr}\n`);
      recordVerification(db, {
        taskId,
        attemptId,
        actor: "qa",
        command: c.command,
        cwd: c.cwd,
        branch: runBranch,
        head: runHead,
        base: null,
        dirtyFp: fp,
        startedAt: res.startedAt,
        finishedAt: res.finishedAt,
        exitCode: res.exitCode,
        passed: counts.passed,
        failed: counts.failed,
        skipped: counts.skipped,
        outputRef,
        outcome,
        appliesToIntegrated: flag("integrated"),
      });
      console.log(`${outcome.toUpperCase()} ${c.command} (exit ${res.exitCode}${res.timedOut ? ", timed out" : ""})`);
    }
    console.log(JSON.stringify({ taskId, head: runHead, dirty_fp: fp, overall }, null, 2));
    if (overall !== "pass") process.exit(1);
  } catch (err) {
    console.error(`error: ${err.message}`);
    process.exit(1);
  } finally {
    db.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
