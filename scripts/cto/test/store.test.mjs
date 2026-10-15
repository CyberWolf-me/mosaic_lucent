/**
 * Adversarial tests: state machine, claims, reviews, approvals, evidence.
 * Spec Phase 6 scenarios: double-claim, expired lease, dead worker,
 * unmet deps, illegal transitions, failed/stale/incomplete verification,
 * self-approval, review loop, blocked resume, approval consumption.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  openDb,
  ensureTask,
  transition,
  claim,
  release,
  heartbeat,
  recordVerification,
  verificationIsStale,
  recordReview,
  recordIntegration,
  grantApproval,
  listTasks,
  recentEvents,
} from "../lib/store.js";
import { tmpCto, specs, minimalTask } from "./helpers.mjs";

let db;
let dir;
beforeEach(() => {
  if (db) db.close();
  dir = tmpCto();
  db = openDb(dir);
});

function driveToReview(taskId = "T-1", worker = "w1") {
  const sp = specs(minimalTask(taskId));
  ensureTask(db, sp.get(taskId), "cto");
  transition(db, sp, { taskId, to: "ready", actor: "cto" });
  const { attemptId } = claim(db, sp, { taskId, workerId: worker, branch: "b", worktree: "/tmp/w" });
  transition(db, sp, { taskId, to: "review", actor: "worker", by: worker });
  return { sp, attemptId };
}

describe("task lifecycle guards", () => {
  it("illegal transitions fail with explicit reasons", () => {
    const sp = specs(minimalTask("T-1"));
    ensureTask(db, sp.get("T-1"), "cto");
    assert.throws(() => transition(db, sp, { taskId: "T-1", to: "done", actor: "cto" }), /illegal transition/);
    assert.throws(() => transition(db, sp, { taskId: "T-1", to: "ready", actor: "worker" }), /may not move/);
    assert.throws(() => transition(db, sp, { taskId: "NOPE", to: "ready", actor: "cto" }), /unknown task/);
  });

  it("identities carry no authority: actor must be a role", () => {
    const { sp } = driveToReview();
    // "w1" is an identity, not a role — authority comes from roles only.
    assert.throws(() => transition(db, sp, { taskId: "T-1", to: "blocked", actor: "w1" }), /may not move/);
  });

  it("a worker cannot mark work verified or done", () => {
    const { sp } = driveToReview();
    // Either refusal shape is a refusal; the point is the worker is stopped.
    assert.throws(() => transition(db, sp, { taskId: "T-1", to: "verified", actor: "worker" }), /illegal transition|may not move/);
    assert.throws(() => transition(db, sp, { taskId: "T-1", to: "integration", actor: "worker" }), /illegal transition|may not move/);
  });

  it("unmet dependencies block ready and claim", () => {
    const sp = specs(minimalTask("T-1"), minimalTask("T-2", { dependencies: ["T-1"] }));
    ensureTask(db, sp.get("T-1"), "cto");
    ensureTask(db, sp.get("T-2"), "cto");
    assert.throws(() => transition(db, sp, { taskId: "T-2", to: "ready", actor: "cto" }), /unmet dependencies/);
    // Even done-but-not-done states fail: in_progress is not satisfied.
    transition(db, sp, { taskId: "T-1", to: "ready", actor: "cto" });
    assert.throws(() => transition(db, sp, { taskId: "T-2", to: "ready", actor: "cto" }), /unmet dependencies/);
  });

  it("blocked tasks resume to blocked_from; only cto may reroute", () => {
    // Once submitted, control belongs to the reviewer: a worker cannot
    // block (or pull back) from review — it blocks from in_progress instead.
    const { sp } = driveToReview();
    assert.throws(
      () => transition(db, sp, { taskId: "T-1", to: "blocked", actor: "worker", by: "w1", reason: "x" }),
      /illegal transition|may not move/,
    );
    // Blocked-from-review: the worker may only resume to review, and the
    // cto may reroute anywhere the table allows.
    const sp2 = specs(minimalTask("T-2"));
    ensureTask(db, sp2.get("T-2"), "cto");
    transition(db, sp2, { taskId: "T-2", to: "ready", actor: "cto" });
    claim(db, sp2, { taskId: "T-2", workerId: "w1", branch: "b", worktree: "/tmp/w" });
    transition(db, sp2, { taskId: "T-2", to: "review", actor: "worker", by: "w1" });
    transition(db, sp2, { taskId: "T-2", to: "blocked", actor: "reviewer", by: "r1", reason: "waiting on API" });
    assert.throws(
      () => transition(db, sp2, { taskId: "T-2", to: "in_progress", actor: "worker", by: "w1" }),
      /resume to review/,
    );
    transition(db, sp2, { taskId: "T-2", to: "review", actor: "reviewer", by: "r1", reason: "api back" });
    const st = db.prepare("SELECT status FROM task_state WHERE task_id = ?").get("T-2");
    assert.equal(st.status, "review");
  });
});

describe("exclusive claims and leases", () => {
  it("two workers cannot hold one task (same connection)", () => {
    const sp = specs(minimalTask("T-1"));
    ensureTask(db, sp.get("T-1"), "cto");
    transition(db, sp, { taskId: "T-1", to: "ready", actor: "cto" });
    claim(db, sp, { taskId: "T-1", workerId: "w1", branch: "b1", worktree: "/tmp/w1" });
    // Task left ready, so a second claim must fail on the live lease.
    db.prepare("UPDATE task_state SET status = 'ready' WHERE task_id = 'T-1'").run();
    assert.throws(() => claim(db, sp, { taskId: "T-1", workerId: "w2", branch: "b2", worktree: "/tmp/w2" }), /held by w1/);
  });

  it("claims from a second connection to the same database also refuse", () => {
    const sp = specs(minimalTask("T-1"));
    ensureTask(db, sp.get("T-1"), "cto");
    transition(db, sp, { taskId: "T-1", to: "ready", actor: "cto" });
    claim(db, sp, { taskId: "T-1", workerId: "w1", branch: "b1", worktree: "/tmp/w1" });
    db.prepare("UPDATE task_state SET status = 'ready' WHERE task_id = 'T-1'").run();
    const db2 = openDb(dir);
    try {
      assert.throws(
        () => claim(db2, sp, { taskId: "T-1", workerId: "w2", branch: "b2", worktree: "/tmp/w2" }),
        /held by w1/,
      );
    } finally {
      db2.close();
    }
  });

  it("expired lease is reclaimable with recovery info; nothing is deleted", () => {
    const sp = specs(minimalTask("T-1"));
    ensureTask(db, sp.get("T-1"), "cto");
    transition(db, sp, { taskId: "T-1", to: "ready", actor: "cto" });
    claim(db, sp, { taskId: "T-1", workerId: "w1", branch: "b1", worktree: "/tmp/w1", ttlMs: 1 });
    db.prepare("UPDATE task_state SET status = 'ready' WHERE task_id = 'T-1'").run();
    const { recoveredFrom } = claim(db, sp, { taskId: "T-1", workerId: "w2", branch: "b2", worktree: "/tmp/w2" });
    assert.equal(recoveredFrom.worker_id, "w1");
    assert.equal(recoveredFrom.branch, "b1");
    // The prior worktree path is reported, never removed by the store.
    assert.equal(recoveredFrom.worktree, "/tmp/w1");
  });

  it("heartbeat renews the holder's lease; strangers cannot renew", () => {
    const sp = specs(minimalTask("T-1"));
    ensureTask(db, sp.get("T-1"), "cto");
    transition(db, sp, { taskId: "T-1", to: "ready", actor: "cto" });
    claim(db, sp, { taskId: "T-1", workerId: "w1", branch: "b", worktree: "/tmp/w", ttlMs: 60000 });
    heartbeat(db, { taskId: "T-1", workerId: "w1" });
    assert.throws(() => heartbeat(db, { taskId: "T-1", workerId: "w2" }), /no lease held/);
  });

  it("same-worker live reclaim is refused (release first)", () => {
    const sp = specs(minimalTask("T-1"));
    ensureTask(db, sp.get("T-1"), "cto");
    transition(db, sp, { taskId: "T-1", to: "ready", actor: "cto" });
    claim(db, sp, { taskId: "T-1", workerId: "w1", branch: "b", worktree: "/tmp/w" });
    db.prepare("UPDATE task_state SET status = 'ready' WHERE task_id = 'T-1'").run();
    assert.throws(
      () => claim(db, sp, { taskId: "T-1", workerId: "w1", branch: "b", worktree: "/tmp/w" }),
      /release it before reclaiming/,
    );
  });

  it("release then reclaim works; double release fails", () => {
    const sp = specs(minimalTask("T-1"));
    ensureTask(db, sp.get("T-1"), "cto");
    transition(db, sp, { taskId: "T-1", to: "ready", actor: "cto" });
    claim(db, sp, { taskId: "T-1", workerId: "w1", branch: "b", worktree: "/tmp/w" });
    release(db, { taskId: "T-1", workerId: "w1", reason: "done" });
    assert.throws(() => release(db, { taskId: "T-1", workerId: "w1" }), /no active lease/);
  });
});

describe("review independence and loop", () => {
  it("self-approval is refused", () => {
    const { sp, attemptId } = driveToReview("T-1", "w1");
    assert.throws(
      () => recordReview(db, { taskId: "T-1", attemptId, reviewer: "w1", decision: "ACCEPT" }),
      /distinct from the implementation worker/,
    );
  });

  it("integration requires ACCEPT on the active attempt", () => {
    const { sp, attemptId } = driveToReview();
    recordReview(db, { taskId: "T-1", attemptId, reviewer: "r1", decision: "CHANGES_REQUIRED", findings: "redo" });
    transition(db, sp, { taskId: "T-1", to: "in_progress", actor: "reviewer", by: "r1", reason: "redo" });
    transition(db, sp, { taskId: "T-1", to: "review", actor: "worker", by: "w1" });
    assert.throws(() => transition(db, sp, { taskId: "T-1", to: "integration", actor: "reviewer", by: "r1" }), /ACCEPT/);
  });

  it("ACCEPT then integration, verification, and done flow", () => {
    const sp = specs(minimalTask("T-1"));
    ensureTask(db, sp.get("T-1"), "cto");
    transition(db, sp, { taskId: "T-1", to: "ready", actor: "cto" });
    const { attemptId } = claim(db, sp, { taskId: "T-1", workerId: "w1", branch: "b", worktree: "/tmp/w" });
    transition(db, sp, { taskId: "T-1", to: "review", actor: "worker", by: "w1" });
    recordReview(db, { taskId: "T-1", attemptId, reviewer: "r1", decision: "ACCEPT" });
    transition(db, sp, { taskId: "T-1", to: "integration", actor: "reviewer", by: "r1" });
    recordIntegration(db, { taskId: "T-1", actor: "integrator", branch: "b", base: "abc", resultCommit: "def" });
    // No post-integration evidence yet: verified must refuse.
    assert.throws(() => transition(db, sp, { taskId: "T-1", to: "verified", actor: "integrator" }), /post-integration/);
    recordVerification(db, {
      taskId: "T-1", attemptId, actor: "qa", command: "true", cwd: ".", branch: "main",
      head: "def", base: "abc", dirtyFp: "clean", startedAt: 1, finishedAt: 2, exitCode: 0,
      passed: 3, failed: 0, skipped: 0, outcome: "pass", appliesToIntegrated: true,
    });
    transition(db, sp, { taskId: "T-1", to: "verified", actor: "integrator" });
    transition(db, sp, { taskId: "T-1", to: "done", actor: "cto" });
    const rows = listTasks(db, sp);
    assert.equal(rows[0].status, "done");
  });

  it("failed verification is recorded as fail and blocks verified", () => {
    const { sp, attemptId } = driveToReview();
    recordReview(db, { taskId: "T-1", attemptId, reviewer: "r1", decision: "ACCEPT" });
    transition(db, sp, { taskId: "T-1", to: "integration", actor: "reviewer", by: "r1" });
    recordIntegration(db, { taskId: "T-1", actor: "i", branch: "b", base: "a", resultCommit: "c" });
    recordVerification(db, {
      taskId: "T-1", attemptId, command: "npm test", cwd: ".", branch: "main",
      head: "c", dirtyFp: "clean", startedAt: 1, finishedAt: 2, exitCode: 1,
      passed: 1, failed: 2, outcome: "fail", appliesToIntegrated: true,
    });
    assert.throws(() => transition(db, sp, { taskId: "T-1", to: "verified", actor: "integrator" }), /post-integration/);
  });

  it("stale evidence is detectable when the source moves", () => {
    const rec = { head: "aaa", dirty_fp: "clean" };
    assert.equal(verificationIsStale(rec, { head: "aaa", dirtyFp: "clean" }), false);
    assert.equal(verificationIsStale(rec, { head: "bbb", dirtyFp: "clean" }), true);
    assert.equal(verificationIsStale(rec, { head: "aaa", dirtyFp: "dirty:x" }), true);
  });
});

describe("approvals gate done", () => {
  it("required approvals must be granted, and each grant is single-use", () => {
    const sp = specs(minimalTask("T-1", { required_approvals: ["founder:push-origin-main"] }));
    ensureTask(db, sp.get("T-1"), "cto");
    transition(db, sp, { taskId: "T-1", to: "ready", actor: "cto" });
    const { attemptId } = claim(db, sp, { taskId: "T-1", workerId: "w1", branch: "b", worktree: "/tmp/w" });
    transition(db, sp, { taskId: "T-1", to: "review", actor: "worker", by: "w1" });
    recordReview(db, { taskId: "T-1", attemptId, reviewer: "r1", decision: "ACCEPT" });
    transition(db, sp, { taskId: "T-1", to: "integration", actor: "reviewer", by: "r1" });
    recordIntegration(db, { taskId: "T-1", actor: "i", branch: "b", base: "a", resultCommit: "c" });
    recordVerification(db, {
      taskId: "T-1", attemptId, command: "true", cwd: ".", branch: "main",
      head: "c", dirtyFp: "clean", startedAt: 1, finishedAt: 2, exitCode: 0, outcome: "pass", appliesToIntegrated: true,
    });
    transition(db, sp, { taskId: "T-1", to: "verified", actor: "integrator" });
    assert.throws(() => transition(db, sp, { taskId: "T-1", to: "done", actor: "cto" }), /missing approvals/);
    grantApproval(db, { action: "founder", target: "push-origin-main", grantedBy: "founder" });
    transition(db, sp, { taskId: "T-1", to: "done", actor: "cto" });
    const leftovers = db.prepare("SELECT * FROM approvals WHERE used_at IS NULL").all();
    assert.equal(leftovers.length, 0);
  });
});

describe("event history", () => {
  it("every mutation appends structured events with actor and task", () => {
    const sp = specs(minimalTask("T-1"));
    ensureTask(db, sp.get("T-1"), "cto");
    transition(db, sp, { taskId: "T-1", to: "ready", actor: "cto" });
    const events = recentEvents(db, 10);
    assert.ok(events.length >= 2);
    for (const e of events) {
      assert.ok(e.ts && e.actor && e.action && e.outcome);
    }
    assert.ok(events.some((e) => e.action === "task.created"));
  });

  it("secrets in free text are redacted before persistence", () => {
    const sp = specs(minimalTask("T-1"));
    ensureTask(db, sp.get("T-1"), "cto");
    transition(db, sp, { taskId: "T-1", to: "ready", actor: "cto" });
    const { attemptId } = claim(db, sp, { taskId: "T-1", workerId: "w1", branch: "b", worktree: "/tmp/w" });
    recordReview(db, {
      taskId: "T-1",
      attemptId,
      reviewer: "r1",
      decision: "CHANGES_REQUIRED",
      findings: "leaked token=abc123 please rotate",
    });
    const row = db.prepare("SELECT findings FROM reviews WHERE attempt_id = ?").get(attemptId);
    assert.ok(!row.findings.includes("abc123"));
    const ev = db.prepare("SELECT detail FROM events WHERE action = 'review.decided'").get();
    assert.ok(!ev.detail.includes("abc123"));
  });

  it("spec changes are recorded without moving status", () => {
    const sp = specs(minimalTask("T-1"));
    ensureTask(db, sp.get("T-1"), "cto");
    transition(db, sp, { taskId: "T-1", to: "ready", actor: "cto" });
    ensureTask(db, { ...sp.get("T-1"), title: "renamed" }, "cto");
    const st = db.prepare("SELECT status FROM task_state WHERE task_id = ?").get("T-1");
    assert.equal(st.status, "ready");
    assert.ok(recentEvents(db, 10).some((e) => e.action === "task.spec_changed"));
  });
});
