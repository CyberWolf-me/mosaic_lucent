#!/usr/bin/env node
/**
 * Controlled local integration (spec sections 6.4, 8.6).
 *
 *   integrate.mjs <task-id> [--actor integrator] [--main main]
 *
 * In order: ACCEPT-review check → base/state check → scope check →
 * explicit merge → post-integration checks → record + verified transition.
 * Any failure returns the task to review with the reason recorded; branch
 * evidence from before the merge is stale by construction (head moved).
 *
 * This command cannot push or deploy: no such code path exists here.
 */

import { execFileSync } from "node:child_process";
import { join } from "node:path";
import {
  ctoDir,
  toplevel,
  head,
  dirtyFingerprint,
  changedPaths,
} from "./lib/gitutil.js";
import { loadTasksFile } from "./lib/spec.js";
import {
  openDb,
  ensureTask,
  transition,
  recordIntegration,
  recordVerification,
  getTask,
} from "./lib/store.js";
import { checkScope } from "./lib/scope.js";
import { createLocalAdapter } from "./lib/adapter.js";
import { parseCounts } from "./verify.mjs";
import { sourceHash, verifyGenerated } from "./lib/report.js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

function sh(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function backToReview(db, specs, taskId, actor, reason) {
  try {
    transition(db, specs, { taskId, to: "review", actor, reason });
  } catch (err) {
    console.error(`note: could not return task to review: ${err.message}`);
  }
  throw new Error(reason);
}

async function main() {
  const argv = process.argv.slice(2);
  const taskId = argv.find((a) => !a.startsWith("--"));
  const opt = (name, def) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : def;
  };
  if (!taskId) {
    console.error("usage: integrate.mjs <task-id> [--actor integrator] [--main main]");
    process.exit(2);
  }
  const actor = opt("actor", "integrator");
  const mainBranch = opt("main", "main");
  const root = toplevel(process.cwd());
  const cto = ctoDir(process.cwd());
  const db = openDb(cto);
  try {
    const { tasks } = loadTasksFile(join(root, "tasks.json"));
    const specs = new Map(tasks.map((t) => [t.id, t]));
    const spec = specs.get(taskId);
    if (!spec) throw new Error(`unknown task ${taskId}`);
    for (const [, s] of specs) ensureTask(db, s, actor);
    const { state, lease } = getTask(db, specs, taskId);
    if (state.status !== "review") throw new Error(`integration requires status review (is ${state.status})`);
    if (!lease || lease.released_at) {
      // Lease may be released after submit; branch/worktree recorded on the attempt.
    }
    const attempt = db.prepare("SELECT * FROM attempts WHERE task_id = ? ORDER BY started_at DESC LIMIT 1").get(taskId);
    if (!attempt) throw new Error("no attempt recorded");
    const branchName = lease?.branch ?? attempt.branch;

    // 1. ACCEPT review by a distinct reviewer (also enforced in transition()).
    const review = db.prepare("SELECT * FROM reviews WHERE task_id = ? AND attempt_id = ? ORDER BY id DESC LIMIT 1").get(taskId, attempt.attempt_id);
    if (!review || review.decision !== "ACCEPT") {
      throw new Error("integration requires an ACCEPT review for the active attempt");
    }

    // 2. Move to integration (transition() re-checks the ACCEPT).
    transition(db, specs, { taskId, to: "integration", actor, reason: `merging ${branchName}` });

    // 3. Scope check over the actual branch diff.
    const base = sh(root, "merge-base", mainBranch, branchName);
    const changed = changedPaths(base, branchName, root);
    const scope = checkScope(spec, changed);
    if (!scope.ok) {
      backToReview(db, specs, taskId, actor, `scope violations:\n- ${scope.violations.join("\n- ")}`);
    }

    // 4. Explicit merge on main. Any merge failure — conflict or otherwise —
    // aborts (best-effort; an abort failure is itself reported) and returns
    // the task to review. A merge that produces no new commit means there
    // was nothing to integrate.
    const preHead = head(root);
    try {
      execFileSync("git", ["merge", "--no-ff", branchName, "-m", `merge: ${taskId} ${spec.title}`], { cwd: root, stdio: "pipe" });
    } catch (err) {
      try {
        execFileSync("git", ["merge", "--abort"], { cwd: root, stdio: "ignore" });
      } catch (abortErr) {
        backToReview(db, specs, taskId, actor, `merge of ${branchName} failed AND abort failed (${abortErr.message}); tree may be mid-merge — resolve by hand`);
      }
      backToReview(db, specs, taskId, actor, `merge conflict merging ${branchName}; merge aborted, resolve explicitly`);
    }
    const resultCommit = head(root);
    if (resultCommit === preHead) {
      backToReview(db, specs, taskId, actor, `merge of ${branchName} produced no new commit; nothing to integrate`);
    }

    // 4b. Generated-file trace: changed generated docs must carry a valid
    // generator footer for the CURRENT tasks.json — machine-generated from
    // current specs, not hand-edited or ancient. Recency is not required
    // here (integration appends events after the last report by
    // construction); freshness is restored by close-out regeneration and
    // gated by report.mjs --check.
    {
      const current = sourceHash(readFileSync(join(root, "tasks.json"), "utf8"));
      const maxSeq = db.prepare("SELECT COALESCE(MAX(seq), 0) AS m FROM events").get().m;
      for (const path of ["docs/tasks.md", "docs/execution-log.md"]) {
        if (changed.includes(path)) {
          const trace = verifyGenerated(readFileSync(join(root, path), "utf8"), {
            tasksHash: current,
            maxEventSeq: maxSeq,
          });
          if (!trace.ok) {
            backToReview(db, specs, taskId, actor, `untraced generated file ${path}: ${trace.reason}; regenerate with report.mjs, never hand-edit`);
          }
        }
      }
    }

    // 5. Post-integration checks: the task's declared commands, on main.
    const adapter = createLocalAdapter();
    const logDir = join(cto, "logs", taskId, "integration");
    mkdirSync(logDir, { recursive: true });
    const checks = {};
    let failed = false;
    for (const c of spec.verification.commands) {
      const stepCwd = join(root, c.cwd === "." ? "" : c.cwd);
      const res = await adapter.runStep({ command: c.command, cwd: stepCwd, timeoutMs: 600000 });
      const counts = parseCounts(`${res.stdout}\n${res.stderr}`);
      const outcome = res.timedOut ? "timeout" : res.exitCode === 0 ? "pass" : "fail";
      if (outcome !== "pass") failed = true;
      checks[c.command] = { outcome, exit_code: res.exitCode };
      const stamp = new Date(res.startedAt).toISOString().replace(/[:.]/g, "-");
      const outputRef = join(logDir, `${stamp}.log`);
      writeFileSync(outputRef, `command: ${res.command}\nexit: ${res.exitCode}\n\n${res.stdout}\n--- stderr ---\n${res.stderr}\n`);
      recordVerification(db, {
        taskId, attemptId: attempt.attempt_id, actor,
        command: c.command, cwd: c.cwd, branch: mainBranch, head: resultCommit, base,
        dirtyFp: await dirtyFingerprint(root),
        startedAt: res.startedAt, finishedAt: res.finishedAt, exitCode: res.exitCode,
        passed: counts.passed, failed: counts.failed, skipped: counts.skipped,
        outputRef, outcome, appliesToIntegrated: true,
      });
    }
    if (failed) {
      backToReview(db, specs, taskId, actor, `post-integration checks failed on ${resultCommit}; see verification records`);
    }

    // 6. Record + verified. transition() re-checks the post-integration evidence.
    recordIntegration(db, { taskId, actor, branch: branchName, base, resultCommit, checks });
    transition(db, specs, { taskId, to: "verified", actor, reason: `integrated as ${resultCommit}` });
    console.log(JSON.stringify({ taskId, base, pre_head: preHead, result_commit: resultCommit, scope_paths: changed.length }, null, 2));
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
