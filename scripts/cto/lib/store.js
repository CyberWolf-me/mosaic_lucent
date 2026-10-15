/**
 * Transactional operational state (spec sections 2.1, 3.2-3.6).
 *
 * SQLite via node:sqlite (zero new dependencies). One database per
 * repository, shared by all worktrees through git-common-dir resolution
 * (see gitutil.ctoDir). tasks.json defines WHAT; this module records
 * status, leases, attempts, evidence, reviews, integrations, approvals,
 * and the append-only event history.
 *
 * Every state-changing operation runs in a transaction and appends an
 * event. Raw command output is referenced by path, never inlined, and
 * events must not contain secrets (callers sanitize before recording).
 */

import { mkdirSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { checkTransition } from "./spec.js";
import { sanitizeOutput } from "./adapter.js";

export const SCHEMA_VERSION = 1;

/** A dependency counts as satisfied only when fully done. */
export const DEPENDENCY_SATISFIED_STATUS = "done";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS task_state (
  task_id TEXT PRIMARY KEY,
  spec_rev TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'backlog',
  blocked_from TEXT,
  blocked_reason TEXT,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS leases (
  task_id TEXT PRIMARY KEY,
  worker_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  branch TEXT NOT NULL,
  worktree TEXT NOT NULL,
  claimed_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  heartbeat_at INTEGER NOT NULL,
  released_at INTEGER,
  release_reason TEXT,
  FOREIGN KEY (task_id) REFERENCES task_state(task_id)
);
CREATE TABLE IF NOT EXISTS attempts (
  attempt_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  worker_id TEXT NOT NULL,
  branch TEXT NOT NULL,
  worktree TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  outcome TEXT,
  FOREIGN KEY (task_id) REFERENCES task_state(task_id)
);
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  actor TEXT NOT NULL,
  task_id TEXT,
  attempt_id TEXT,
  action TEXT NOT NULL,
  outcome TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS verification (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  attempt_id TEXT,
  command TEXT NOT NULL,
  cwd TEXT NOT NULL,
  branch TEXT NOT NULL,
  head TEXT NOT NULL,
  base TEXT,
  dirty_fp TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER NOT NULL,
  exit_code INTEGER NOT NULL,
  passed INTEGER,
  failed INTEGER,
  skipped INTEGER,
  output_ref TEXT,
  outcome TEXT NOT NULL,
  applies_to_integrated INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (task_id) REFERENCES task_state(task_id)
);
CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  reviewer TEXT NOT NULL,
  decision TEXT NOT NULL,
  findings TEXT NOT NULL DEFAULT '',
  ts INTEGER NOT NULL,
  FOREIGN KEY (task_id) REFERENCES task_state(task_id)
);
CREATE TABLE IF NOT EXISTS integrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  branch TEXT NOT NULL,
  base TEXT NOT NULL,
  result_commit TEXT NOT NULL,
  checks_json TEXT NOT NULL DEFAULT '{}',
  ts INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  granted_by TEXT NOT NULL,
  ts INTEGER NOT NULL,
  used_at INTEGER,
  note TEXT NOT NULL DEFAULT ''
);
`;

/** Canonical spec revision: sha256 of stable-stringified task spec. */
export function specRevision(task) {
  return createHash("sha256").update(stableStringify(task)).digest("hex").slice(0, 16);
}

function stableStringify(v) {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

export function newAttemptId() {
  return `att_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;
}

/**
 * Transaction wrapper (node:sqlite exposes no transaction helper).
 * BEGIN IMMEDIATE so a concurrent writer fails fast at the lock instead
 * of interleaving; any error rolls back and rethrows.
 */
export function withTx(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Rollback of a failed BEGIN (e.g. lock timeout) — original error stands.
    }
    throw err;
  }
}

/** Open (creating) the shared state database. Returns the DatabaseSync. */
export function openDb(ctoDirPath) {
  mkdirSync(ctoDirPath, { recursive: true });
  const db = new DatabaseSync(join(ctoDirPath, "state.sqlite"));
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(SCHEMA);
  const row = db.prepare("SELECT v FROM meta WHERE k = 'schema_version'").get();
  if (!row) {
    db.prepare("INSERT INTO meta (k, v) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION));
  } else if (row.v !== String(SCHEMA_VERSION)) {
    throw new Error(`state.sqlite schema ${row.v} != supported ${SCHEMA_VERSION}`);
  }
  return db;
}

/**
 * Free-text scrubbing for the event record (finding F15b). Reasons,
 * findings, and notes are worker-supplied and may contain pasted secrets;
 * every event detail is sanitized before persistence. Stored review/approval
 * columns are sanitized at their own inserts as well.
 */
function scrubDetail(detail) {
  if (typeof detail === "string") return sanitizeOutput(detail, 2000);
  if (Array.isArray(detail)) return detail.map(scrubDetail);
  if (detail && typeof detail === "object") {
    return Object.fromEntries(Object.entries(detail).map(([k, v]) => [k, scrubDetail(v)]));
  }
  return detail;
}

function event(db, { actor, taskId = null, attemptId = null, action, outcome, detail = {} }) {
  db.prepare(
    "INSERT INTO events (ts, actor, task_id, attempt_id, action, outcome, detail) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(Date.now(), actor, taskId, attemptId, action, outcome, JSON.stringify(scrubDetail(detail)));
}

function getState(db, taskId) {
  return db.prepare("SELECT * FROM task_state WHERE task_id = ?").get(taskId) ?? null;
}

/**
 * Register a task spec (idempotent). New tasks enter at backlog; a changed
 * spec revision is recorded and emits spec.changed without moving status —
 * requirement changes are visible, never silent.
 */
export function ensureTask(db, spec, actor = "cto") {
  const rev = specRevision(spec);
  withTx(db, () => {
    const existing = getState(db, spec.id);
    if (!existing) {
      db.prepare("INSERT INTO task_state (task_id, spec_rev, status, updated_at) VALUES (?, ?, 'backlog', ?)").run(
        spec.id,
        rev,
        Date.now(),
      );
      event(db, { actor, taskId: spec.id, action: "task.created", outcome: "ok", detail: { spec_rev: rev } });
    } else if (existing.spec_rev !== rev) {
      db.prepare("UPDATE task_state SET spec_rev = ?, updated_at = ? WHERE task_id = ?").run(
        rev,
        Date.now(),
        spec.id,
      );
      event(db, {
        actor,
        taskId: spec.id,
        action: "task.spec_changed",
        outcome: "ok",
        detail: { from: existing.spec_rev, to: rev, status_kept: existing.status },
      });
    }
  });

}

/** Spec-joined snapshot of one task: spec fields + live state + lease. */
export function getTask(db, specsById, taskId) {
  const spec = specsById.get(taskId);
  if (!spec) throw new Error(`unknown task ${taskId}`);
  const state = getState(db, taskId) ?? { status: "backlog", spec_rev: specRevision(spec) };
  const lease = db.prepare("SELECT * FROM leases WHERE task_id = ?").get(taskId) ?? null;
  const latestReview =
    db.prepare("SELECT * FROM reviews WHERE task_id = ? ORDER BY id DESC LIMIT 1").get(taskId) ?? null;
  return { spec, state, lease, latestReview };
}

function depsSatisfied(db, specsById, spec) {
  const unmet = [];
  for (const dep of spec.dependencies ?? []) {
    const st = getState(db, dep);
    if (!st || st.status !== DEPENDENCY_SATISFIED_STATUS) {
      unmet.push(`${dep} is ${st?.status ?? "unknown"} (needs ${DEPENDENCY_SATISFIED_STATUS})`);
    }
  }
  return unmet;
}

function latestAcceptForAttempt(db, taskId, attemptId) {
  return (
    db.prepare("SELECT * FROM reviews WHERE task_id = ? AND attempt_id = ? ORDER BY id DESC LIMIT 1").get(
      taskId,
      attemptId,
    ) ?? null
  );
}

/**
 * The attempt under review: the latest one started. Submit closes an
 * attempt (outcome "submitted") but review and integration still act on
 * it — "active" means "the attempt this task's current state refers to",
 * not "still running". A newer claim supersedes it.
 */
function activeAttempt(db, taskId) {
  return (
    db.prepare("SELECT * FROM attempts WHERE task_id = ? ORDER BY started_at DESC LIMIT 1").get(taskId) ?? null
  );
}

/**
 * Guarded state transition. `actor` is always a ROLE (worker | reviewer |
 * integrator | cto | founder); the acting identity rides in `by` for the
 * event record. This separation is what stops a worker identity from
 * accidentally carrying authority — authority comes from the role, and
 * roles are assigned by the control plane, never self-declared.
 * Throws with a specific reason on any rule violation; on success updates
 * state and appends the event atomically.
 */
export function transition(db, specsById, { taskId, to, actor, by = null, reason = "" }) {
  const spec = specsById.get(taskId);
  if (!spec) throw new Error(`unknown task ${taskId}`);
  const now = Date.now();
  const who = by ?? actor;
  withTx(db, () => {
    const state = getState(db, taskId);
    const from = state?.status ?? "backlog";
    const ruleError = checkTransition(from, to, actor);
    if (ruleError) throw new Error(ruleError);

    if (to === "ready" || to === "in_progress") {
      const unmet = depsSatisfied(db, specsById, spec);
      if (unmet.length > 0) {
        throw new Error(`unmet dependencies: ${unmet.join("; ")}`);
      }
    }
    if (from === "blocked" && to !== state.blocked_from && actor !== "cto") {
      throw new Error(`blocked tasks resume to ${state.blocked_from}; only cto may reroute`);
    }
    if (to === "integration") {
      const attempt = activeAttempt(db, taskId);
      if (!attempt) throw new Error("integration requires an active attempt");
      const review = latestAcceptForAttempt(db, taskId, attempt.attempt_id);
      if (!review || review.decision !== "ACCEPT") {
        throw new Error("integration requires an ACCEPT review for the active attempt");
      }
    }
    if (to === "verified") {
      const integ =
        db.prepare("SELECT * FROM integrations WHERE task_id = ? ORDER BY id DESC LIMIT 1").get(taskId) ?? null;
      if (!integ) throw new Error("verified requires a recorded integration");
      const post = db.prepare(
        `SELECT * FROM verification WHERE task_id = ? AND outcome = 'pass' AND applies_to_integrated = 1 AND head = ? ORDER BY id DESC LIMIT 1`,
      ).get(taskId, integ.result_commit);
      if (!post) {
        throw new Error(`verified requires a passing post-integration check on ${integ.result_commit}`);
      }
    }
    if (to === "done") {
      const missing = [];
      for (const need of spec.required_approvals ?? []) {
        const grant = db.prepare(
          "SELECT * FROM approvals WHERE action || ':' || target = ? AND used_at IS NULL ORDER BY id DESC LIMIT 1",
        ).get(need);
        if (!grant) missing.push(need);
      }
      if (missing.length > 0) throw new Error(`missing approvals: ${missing.join(", ")}`);
      for (const need of spec.required_approvals ?? []) {
        db.prepare("UPDATE approvals SET used_at = ? WHERE action || ':' || target = ? AND used_at IS NULL").run(
          now,
          need,
        );
      }
    }

    if (to === "blocked") {
      db.prepare("UPDATE task_state SET status = 'blocked', blocked_from = ?, blocked_reason = ?, updated_at = ? WHERE task_id = ?").run(
        from,
        sanitizeOutput(reason || "no reason given", 2000),
        now,
        taskId,
      );
    } else {
      db.prepare("UPDATE task_state SET status = ?, blocked_from = NULL, blocked_reason = NULL, updated_at = ? WHERE task_id = ?").run(
        to,
        now,
        taskId,
      );
    }
    if (from === "in_progress" && (to === "review" || to === "blocked")) {
      const attempt = activeAttempt(db, taskId);
      if (attempt) {
        db.prepare("UPDATE attempts SET ended_at = ?, outcome = ? WHERE attempt_id = ?").run(
          now,
          to === "review" ? "submitted" : "blocked",
          attempt.attempt_id,
        );
      }
    }
    event(db, { actor: who, taskId, action: `task.${from}_to_${to}`, outcome: "ok", detail: { role: actor, reason } });
  });
}

/**
 * Atomic claim (ready -> in_progress) with lease. Exactly one worker can
 * hold a task: a live foreign lease fails closed; an expired lease is
 * reclaimable and returns recovery info about the prior holder — the
 * worktree is NEVER touched here (see worktree.mjs recovery).
 */
export function claim(db, specsById, { taskId, workerId, branch, worktree, ttlMs = 30 * 60 * 1000 }) {
  const now = Date.now();
  return withTx(db, () => {
    const spec = specsById.get(taskId);
    if (!spec) throw new Error(`unknown task ${taskId}`);
    const state = getState(db, taskId);
    const from = state?.status ?? "backlog";
    if (from !== "ready") throw new Error(`claim requires status ready (is ${from})`);
    const unmet = depsSatisfied(db, specsById, spec);
    if (unmet.length > 0) throw new Error(`unmet dependencies: ${unmet.join("; ")}`);

    const existing = db.prepare("SELECT * FROM leases WHERE task_id = ?").get(taskId) ?? null;
    let recoveredFrom = null;
    if (existing && !existing.released_at && existing.expires_at > now && existing.worker_id !== workerId) {
      event(db, {
        actor: workerId,
        taskId,
        action: "task.claim_refused",
        outcome: "refused",
        detail: { held_by: existing.worker_id, expires_at: existing.expires_at },
      });
      throw new Error(`task held by ${existing.worker_id} until ${new Date(existing.expires_at).toISOString()}`);
    }
    if (existing && !existing.released_at && existing.expires_at > now && existing.worker_id === workerId) {
      // Same-worker reclaim while live: refuse rather than orphan the open
      // attempt. Release first, then claim again (finding F15a).
      throw new Error(`lease already held by ${workerId}: release it before reclaiming`);
    }
    if (existing && !existing.released_at && existing.expires_at <= now) {
      recoveredFrom = {
        worker_id: existing.worker_id,
        attempt_id: existing.attempt_id,
        branch: existing.branch,
        worktree: existing.worktree,
      };
      event(db, { actor: workerId, taskId, action: "lease.expired", outcome: "recovered", detail: recoveredFrom });
      const stale = activeAttempt(db, taskId);
      if (stale) {
        db.prepare("UPDATE attempts SET ended_at = ?, outcome = ? WHERE attempt_id = ?").run(
          now,
          "lease_expired",
          stale.attempt_id,
        );
      }
    }

    const attemptId = newAttemptId();
    db.prepare(
      `INSERT INTO leases (task_id, worker_id, attempt_id, branch, worktree, claimed_at, expires_at, heartbeat_at, released_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT(task_id) DO UPDATE SET worker_id = excluded.worker_id, attempt_id = excluded.attempt_id,
         branch = excluded.branch, worktree = excluded.worktree, claimed_at = excluded.claimed_at,
         expires_at = excluded.expires_at, heartbeat_at = excluded.heartbeat_at, released_at = NULL, release_reason = NULL`,
    ).run(taskId, workerId, attemptId, branch, worktree, now, now + ttlMs, now);
    db.prepare(
      "INSERT INTO attempts (attempt_id, task_id, worker_id, branch, worktree, started_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(attemptId, taskId, workerId, branch, worktree, now);
    db.prepare("UPDATE task_state SET status = 'in_progress', updated_at = ? WHERE task_id = ?").run(now, taskId);
    event(db, {
      actor: workerId,
      taskId,
      attemptId,
      action: "task.claimed",
      outcome: "ok",
      detail: { branch, worktree, recovered_from: recoveredFrom },
    });
    return { attemptId, recoveredFrom };
  });
}

/** Release a held lease (worker done, timed out, or CTO reassignment). */
export function release(db, { taskId, workerId, reason = "" }) {
  withTx(db, () => {
    const lease = db.prepare("SELECT * FROM leases WHERE task_id = ?").get(taskId) ?? null;
    if (!lease || lease.released_at) throw new Error(`no active lease on ${taskId}`);
    db.prepare("UPDATE leases SET released_at = ?, release_reason = ? WHERE task_id = ?").run(
      Date.now(),
      reason,
      taskId,
    );
    event(db, { actor: workerId, taskId, attemptId: lease.attempt_id, action: "lease.released", outcome: "ok", detail: { reason } });
  });

}

/** Renew a held lease; throws when the caller does not hold it. */
export function heartbeat(db, { taskId, workerId, ttlMs = 30 * 60 * 1000 }) {
  const now = Date.now();
  withTx(db, () => {
    const lease = db.prepare("SELECT * FROM leases WHERE task_id = ?").get(taskId) ?? null;
    if (!lease || lease.released_at || lease.worker_id !== workerId) {
      throw new Error(`no lease held by ${workerId} on ${taskId}`);
    }
    db.prepare("UPDATE leases SET heartbeat_at = ?, expires_at = ? WHERE task_id = ?").run(now, now + ttlMs, taskId);
  });

}

/** Record one verification execution. Never throws away failures. */
export function recordVerification(db, rec) {
  withTx(db, () => {
    db.prepare(
      `INSERT INTO verification (task_id, attempt_id, command, cwd, branch, head, base, dirty_fp, started_at, finished_at,
        exit_code, passed, failed, skipped, output_ref, outcome, applies_to_integrated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      rec.taskId,
      rec.attemptId ?? null,
      rec.command,
      rec.cwd,
      rec.branch,
      rec.head,
      rec.base ?? null,
      rec.dirtyFp,
      rec.startedAt,
      rec.finishedAt,
      rec.exitCode,
      rec.passed ?? null,
      rec.failed ?? null,
      rec.skipped ?? null,
      rec.outputRef ?? null,
      rec.outcome,
      rec.appliesToIntegrated ? 1 : 0,
    );
    event(db, {
      actor: rec.actor ?? "qa",
      taskId: rec.taskId,
      attemptId: rec.attemptId ?? null,
      action: "verification.recorded",
      outcome: rec.outcome,
      detail: { command: rec.command, head: rec.head, exit_code: rec.exitCode },
    });
  });

}

/** A stored verification result is stale when the source moved since. */
export function verificationIsStale(record, { head, dirtyFp }) {
  return record.head !== head || record.dirty_fp !== dirtyFp;
}

/** Record a review decision. Reviewer must differ from the attempt worker. */
export function recordReview(db, { taskId, attemptId, reviewer, decision, findings = "" }) {
  const valid = ["ACCEPT", "CHANGES_REQUIRED", "BLOCKED"];
  if (!valid.includes(decision)) throw new Error(`decision must be one of ${valid.join(", ")}`);
  withTx(db, () => {
    const attempt = db.prepare("SELECT * FROM attempts WHERE attempt_id = ?").get(attemptId) ?? null;
    if (!attempt || attempt.task_id !== taskId) throw new Error(`unknown attempt ${attemptId} for ${taskId}`);
    if (attempt.worker_id === reviewer) {
      throw new Error("reviewer must be distinct from the implementation worker (no self-approval)");
    }
    db.prepare("INSERT INTO reviews (task_id, attempt_id, reviewer, decision, findings, ts) VALUES (?, ?, ?, ?, ?, ?)").run(
      taskId,
      attemptId,
      reviewer,
      decision,
      sanitizeOutput(findings, 5000),
      Date.now(),
    );
    event(db, { actor: reviewer, taskId, attemptId, action: "review.decided", outcome: decision, detail: { findings: findings.slice(0, 500) } });
  });

}

/** Record an integration result (called by integrate.mjs after merging). */
export function recordIntegration(db, { taskId, actor, branch, base, resultCommit, checks = {} }) {
  withTx(db, () => {
    db.prepare("INSERT INTO integrations (task_id, branch, base, result_commit, checks_json, ts) VALUES (?, ?, ?, ?, ?, ?)").run(
      taskId,
      branch,
      base,
      resultCommit,
      JSON.stringify(checks),
      Date.now(),
    );
    event(db, { actor, taskId, action: "integration.completed", outcome: "ok", detail: { branch, base, result_commit: resultCommit } });
  });

}

/** Grant a founder (or delegated) approval for one action:target. */
export function grantApproval(db, { action, target, grantedBy, note = "" }) {
  withTx(db, () => {
    db.prepare("INSERT INTO approvals (action, target, granted_by, ts, note) VALUES (?, ?, ?, ?, ?)").run(
      action,
      target,
      grantedBy,
      Date.now(),
      sanitizeOutput(note, 2000),
    );
    event(db, { actor: grantedBy, action: "approval.granted", outcome: "ok", detail: { action, target, note } });
  });

}

/** List tasks with live status (for reports and `task list`). */
export function listTasks(db, specsById) {
  return [...specsById.values()].map((spec) => {
    const state = getState(db, spec.id) ?? { status: "backlog", spec_rev: specRevision(spec) };
    return { id: spec.id, title: spec.title, owner_role: spec.owner_role, status: state.status, risk: spec.risk };
  });
}

/** Recent events, newest first (bounded). */
export function recentEvents(db, limit = 100) {
  return db.prepare("SELECT * FROM events ORDER BY seq DESC LIMIT ?").all(limit);
}
