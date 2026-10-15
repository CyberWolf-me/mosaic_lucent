#!/usr/bin/env node
/**
 * Worker context bundles (spec section 8.1).
 *
 *   context.mjs <task-id> --worker <id>
 *
 * Prints the complete dispatch bundle: versioned contract, live state
 * (status, dependencies with their states, lease), ownership and paths,
 * acceptance criteria, verification, evidence obligations, retry policy,
 * and approvals — plus the product/architecture context a worker needs
 * and pointers for everything else. Relevant context, not a repo dump.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ctoDir, toplevel } from "./lib/gitutil.js";
import { loadTasksFile } from "./lib/spec.js";
import { openDb, ensureTask, getTask, specRevision } from "./lib/store.js";

function main() {
  const argv = process.argv.slice(2);
  const taskId = argv.find((a) => !a.startsWith("--"));
  const wi = argv.indexOf("--worker");
  const worker = wi >= 0 ? argv[wi + 1] : null;
  if (!taskId || !worker) {
    console.error("usage: context.mjs <task-id> --worker <id>");
    process.exit(2);
  }
  const root = toplevel(process.cwd());
  const db = openDb(ctoDir(process.cwd()));
  try {
    const { tasks } = loadTasksFile(join(root, "tasks.json"));
    const specs = new Map(tasks.map((t) => [t.id, t]));
    const spec = specs.get(taskId);
    if (!spec) throw new Error(`unknown task ${taskId}`);
    for (const [, s] of specs) ensureTask(db, s, "cto");
    const { state, lease } = getTask(db, specs, taskId);
    const depStates = (spec.dependencies ?? []).map((d) => {
      const st = db.prepare("SELECT status FROM task_state WHERE task_id = ?").get(d);
      return { id: d, status: st?.status ?? "backlog" };
    });
    const product = readFileSync(join(root, "PRODUCT.md"), "utf8");
    const lines = [
      `# Task contract: ${spec.id} — ${spec.title}`,
      ``,
      `- spec_revision: ${specRevision(spec)} (pin this; a mid-flight spec change is visible, never silent)`,
      `- worker: ${worker} | owner_role: ${spec.owner_role} | status: ${state.status}`,
      `- branch: ${lease?.branch ?? "(unassigned)"} | worktree: ${lease?.worktree ?? "(unassigned)"}`,
      `- dependencies: ${depStates.map((d) => `${d.id}=${d.status}`).join(", ") || "(none)"}`,
      ``,
      `## Objective`,
      spec.description,
      ``,
      `## Acceptance criteria`,
      ...spec.acceptance_criteria.map((a) => `- [ ] ${a}`),
      ``,
      `## Scope`,
      `allowed: ${spec.scope.allowed_paths.join(", ") || "(none — approval-gated operation)"}`,
      `prohibited: ${(spec.scope.prohibited_paths ?? []).join(", ") || "(none)"}`,
      ``,
      `## Verification (run in order; record every result with verify.mjs)`,
      ...spec.verification.commands.map((c) => `- \`${c.command}\` (cwd: ${c.cwd})`),
      `required gates: ${spec.verification.required_gates.join(", ")}`,
      ``,
      `## Return obligations (docs/agent-team.md §3)`,
      `result summary; files/interfaces changed; tests+checks with real output;`,
      `assumptions and open questions; limitations, failures, blockers.`,
      ``,
      `## Retry and escalation`,
      `max ${spec.retry_policy.max_automatic_attempts} automatic attempts, each recording the prior failure with a changed approach.`,
      `Escalate: blockers, scope changes, secrets encountered, destructive ops.`,
      `required approvals: ${(spec.required_approvals ?? []).join(", ") || "(none)"}`,
      ``,
      `## Product context (PRODUCT.md, full text — the why behind the work)`,
      product,
      ``,
      `## Pointers (read before touching code)`,
      `- ARCHITECTURE.md — package map, mutation/authorization boundaries, conventions`,
      `- docs/agent-team.md — roles, contract, retry/escalation`,
      `- docs/agent-policy.md — isolation, scope enforcement, integration, founder gates`,
      `- docs/adr/ — per-decision rationale (index in ARCHITECTURE.md §6)`,
    ];
    console.log(lines.join("\n"));
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
