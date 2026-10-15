/**
 * Task specification model: loading, schema validation, and the central
 * state-transition table (spec section 3.1-3.2).
 *
 * tasks.json is the canonical source for WHAT a task requires. It carries
 * no mutable execution status — status lives in .cto/state.sqlite.
 * Allowed transitions are declared exactly once, here.
 */

import { readFileSync } from "node:fs";

export const SPEC_VERSION = 1;

/** Terminal states. Everything else is nonterminal. */
export const STATUSES = Object.freeze([
  "backlog",
  "ready",
  "in_progress",
  "review",
  "integration",
  "verified",
  "done",
  "blocked",
]);

/**
 * Central transition table: from-state -> { to-state -> actors allowed }.
 * Actors: worker (implementation), reviewer (independent), integrator
 * (designated merge role), cto (orchestrator), founder (approvals).
 *
 * Load-bearing rules encoded here, not in callers:
 * - a worker can claim (ready->in_progress), submit (in_progress->review),
 *   or block — never verify, integrate, or finish;
 * - review->integration requires an ACCEPT decision (recorded separately);
 * - integration->verified requires post-integration checks;
 * - verified->done requires the acceptance record (evidence + docs + report).
 */
export const TRANSITIONS = Object.freeze({
  backlog: Object.freeze({ ready: ["cto"], blocked: ["cto", "worker"] }),
  ready: Object.freeze({
    in_progress: ["worker", "cto"],
    backlog: ["cto"],
    blocked: ["cto", "worker"],
  }),
  in_progress: Object.freeze({
    review: ["worker", "cto"],
    ready: ["cto"],
    blocked: ["cto", "worker"],
  }),
  review: Object.freeze({
    integration: ["reviewer", "cto"],
    in_progress: ["reviewer", "cto"],
    blocked: ["reviewer", "cto"],
  }),
  integration: Object.freeze({
    verified: ["integrator", "cto"],
    review: ["integrator", "cto"],
    blocked: ["integrator", "cto"],
  }),
  verified: Object.freeze({ done: ["cto", "integrator"], blocked: ["cto"] }),
  done: Object.freeze({}),
  blocked: Object.freeze({
    // Resume targets are constrained by `blocked_from`, checked in store.js;
    // the table names the legal set, the row names the legal one.
    backlog: ["cto"],
    ready: ["cto"],
    in_progress: ["cto", "worker"],
    review: ["reviewer", "cto"],
    integration: ["integrator", "cto"],
  }),
});

const ID_RE = /^[A-Z]+-[0-9]+$/;
const REQUIRED_TOP_FIELDS = [
  "id",
  "title",
  "description",
  "owner_role",
  "dependencies",
  "scope",
  "acceptance_criteria",
  "verification",
  "deliverables",
  "risk",
  "required_approvals",
  "retry_policy",
];
const OWNER_ROLES = ["product", "implementation", "qa", "security", "cto"];
const RISKS = ["low", "medium", "high"];

/** Scope pattern sanity: non-empty string, no absolute paths, no `..`. */
function validScopePattern(p) {
  return (
    typeof p === "string" &&
    p.length > 0 &&
    !p.startsWith("/") &&
    !/^[A-Za-z]:/.test(p) &&
    !p.split("/").includes("..")
  );
}

/**
 * Validate one task specification object.
 * @returns {string[]} error messages; empty means valid.
 */
export function validateTaskSpec(task, allIds, seenIds) {
  const idsSeen = seenIds ?? allIds;
  const errors = [];
  const label = task && typeof task.id === "string" ? task.id : "<missing-id>";
  for (const f of REQUIRED_TOP_FIELDS) {
    if (task[f] === undefined) errors.push(`${label}: missing required field "${f}"`);
  }
  if (task.id !== undefined) {
    if (typeof task.id !== "string" || !ID_RE.test(task.id)) {
      errors.push(`${label}: id must match ${ID_RE}`);
    } else if (idsSeen.has(task.id)) {
      errors.push(`${label}: duplicate task id`);
    }
  }
  if (task.owner_role !== undefined && !OWNER_ROLES.includes(task.owner_role)) {
    errors.push(`${label}: unknown owner_role "${task.owner_role}"`);
  }
  if (task.dependencies !== undefined) {
    if (!Array.isArray(task.dependencies)) {
      errors.push(`${label}: dependencies must be an array`);
    } else {
      for (const d of task.dependencies) {
        if (typeof d !== "string") errors.push(`${label}: dependency must be a string id`);
        else if (allIds.has && !allIds.has(d) && d !== task.id) {
          errors.push(`${label}: unknown dependency "${d}"`);
        }
      }
    }
    if (Array.isArray(task.dependencies) && task.dependencies.includes(task.id)) {
      errors.push(`${label}: task depends on itself`);
    }
  }
  if (task.scope !== undefined) {
    const { allowed_paths, prohibited_paths } = task.scope;
    // File-less tasks (remote operations, approvals) are legal only when
    // they carry explicit required_approvals — nothing to scope-check
    // means a human must authorize the operation instead.
    const fileless =
      Array.isArray(allowed_paths) && allowed_paths.length === 0;
    if (!Array.isArray(allowed_paths)) {
      errors.push(`${label}: scope.allowed_paths must be an array`);
    } else if (!fileless) {
      for (const p of allowed_paths) {
        if (!validScopePattern(p)) errors.push(`${label}: invalid allowed path pattern "${p}"`);
      }
    } else if (!Array.isArray(task.required_approvals) || task.required_approvals.length === 0) {
      errors.push(`${label}: file-less scope requires explicit required_approvals`);
    }
    if (prohibited_paths !== undefined) {
      if (!Array.isArray(prohibited_paths)) {
        errors.push(`${label}: scope.prohibited_paths must be an array`);
      } else {
        for (const p of prohibited_paths) {
          if (!validScopePattern(p)) errors.push(`${label}: invalid prohibited path pattern "${p}"`);
        }
      }
    }
  }
  if (task.acceptance_criteria !== undefined) {
    if (!Array.isArray(task.acceptance_criteria) || task.acceptance_criteria.length === 0) {
      errors.push(`${label}: acceptance_criteria must be a non-empty array`);
    }
  }
  if (task.verification !== undefined) {
    const v = task.verification;
    if (!Array.isArray(v.commands) || v.commands.length === 0) {
      errors.push(`${label}: verification.commands must be a non-empty array`);
    } else {
      for (const c of v.commands) {
        if (typeof c !== "object" || !c.command || !c.cwd) {
          errors.push(`${label}: each verification command needs {command, cwd}`);
        }
      }
    }
    if (!Array.isArray(v.required_gates) || v.required_gates.length === 0) {
      errors.push(`${label}: verification.required_gates must be a non-empty array`);
    }
  }
  if (task.deliverables !== undefined) {
    if (!Array.isArray(task.deliverables) || task.deliverables.length === 0) {
      errors.push(`${label}: deliverables must be a non-empty array`);
    }
  }
  if (task.risk !== undefined && !RISKS.includes(task.risk)) {
    errors.push(`${label}: unknown risk "${task.risk}"`);
  }
  if (task.required_approvals !== undefined && !Array.isArray(task.required_approvals)) {
    errors.push(`${label}: required_approvals must be an array`);
  }
  if (task.retry_policy !== undefined) {
    const n = task.retry_policy.max_automatic_attempts;
    if (!Number.isInteger(n) || n < 0 || n > 5) {
      errors.push(`${label}: retry_policy.max_automatic_attempts must be an integer 0-5`);
    }
  }
  return errors;
}

/**
 * Validate a whole tasks.json document: schema per task plus
 * cross-task rules (duplicate ids, unknown deps, dependency cycles).
 * @returns {{tasks: object[], errors: string[]}}
 */
export function validateTaskDocument(doc) {
  const errors = [];
  const tasks = Array.isArray(doc?.tasks) ? doc.tasks : null;
  if (!tasks) return { tasks: [], errors: ["document must have a tasks array"] };
  if (doc.spec_version !== SPEC_VERSION) {
    errors.push(`unsupported spec_version ${doc.spec_version} (expected ${SPEC_VERSION})`);
  }
  const ids = new Set();
  for (const t of tasks) {
    if (t && typeof t.id === "string") {
      if (ids.has(t.id)) errors.push(`${t.id}: duplicate task id`);
      ids.add(t.id);
    }
  }
  const seen = new Set();
  for (const t of tasks) {
    errors.push(...validateTaskSpec(t, ids, seen));
    if (t && typeof t.id === "string" && ID_RE.test(t.id)) seen.add(t.id);
  }
  // Cycle detection over known ids only.
  const adj = new Map(tasks.map((t) => [t.id, (t.dependencies ?? []).filter((d) => ids.has(d))]));
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map([...ids].map((id) => [id, WHITE]));
  const stack = [];
  const visit = (id) => {
    color.set(id, GRAY);
    stack.push(id);
    for (const dep of adj.get(id) ?? []) {
      if (color.get(dep) === GRAY) {
        const cycle = [...stack.slice(stack.indexOf(dep)), dep].join(" -> ");
        errors.push(`dependency cycle: ${cycle}`);
      } else if (color.get(dep) === WHITE) {
        visit(dep);
      }
    }
    stack.pop();
    color.set(id, BLACK);
  };
  for (const id of ids) {
    if (color.get(id) === WHITE) visit(id);
  }
  return { tasks, errors };
}

/** Load and validate tasks.json from disk. Throws on any error. */
export function loadTasksFile(path) {
  const raw = readFileSync(path, "utf8");
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    throw new Error(`tasks.json is not valid JSON: ${err.message}`);
  }
  const { tasks, errors } = validateTaskDocument(doc);
  if (errors.length > 0) {
    throw new Error(`tasks.json invalid:\n- ${errors.join("\n- ")}`);
  }
  return { spec_version: doc.spec_version, tasks };
}

/**
 * Check one transition against the central table.
 * @returns {null|string} null when allowed, else the rejection reason.
 */
export function checkTransition(from, to, actor) {
  if (!STATUSES.includes(from)) return `unknown from-state "${from}"`;
  if (!STATUSES.includes(to)) return `unknown to-state "${to}"`;
  const allowed = TRANSITIONS[from]?.[to];
  if (!allowed) return `illegal transition ${from} -> ${to}`;
  if (!allowed.includes(actor)) return `actor "${actor}" may not move ${from} -> ${to}`;
  return null;
}
