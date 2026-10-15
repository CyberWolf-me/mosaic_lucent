#!/usr/bin/env node
/**
 * Task state operations (spec section 8.2). All mutations go through the
 * shared transactional domain layer (lib/store.js) — this CLI adds no
 * rules of its own.
 *
 *   task.mjs list [--status <s>] [--owner <role>]
 *   task.mjs show <task-id>
 *   task.mjs validate
 *   task.mjs claim <task-id> --worker <id> --branch <b> --worktree <p> [--ttl-minutes N]
 *   task.mjs release <task-id> --worker <id> [--reason <r>]
 *   task.mjs heartbeat <task-id> --worker <id>
 *   task.mjs submit <task-id> --worker <id>        (in_progress -> review)
 *   task.mjs review <task-id> --attempt <a> --reviewer <r> --decision <ACCEPT|CHANGES_REQUIRED|BLOCKED> [--findings <f>]
 *   task.mjs block <task-id> --actor <a> --reason <r>
 *   task.mjs unblock <task-id> --actor <a>
 *   task.mjs approve --action <a> --target <t> --by <founder> [--note <n>]
 *   task.mjs move <task-id> --to <status> --actor <a> [--reason <r>]
 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ctoDir, toplevel } from "./lib/gitutil.js";
import { loadTasksFile, validateTaskDocument } from "./lib/spec.js";
import {
  openDb,
  ensureTask,
  getTask,
  listTasks,
  transition,
  claim,
  release,
  heartbeat,
  recordReview,
  grantApproval,
} from "./lib/store.js";
import { readFileSync } from "node:fs";

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        out[key] = next;
        i += 1;
      } else {
        out[key] = true;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

function loadAll(root, db, actor) {
  const doc = JSON.parse(readFileSync(join(root, "tasks.json"), "utf8"));
  const { tasks, errors } = validateTaskDocument(doc);
  if (errors.length > 0) throw new Error(`tasks.json invalid:\n- ${errors.join("\n- ")}`);
  const specs = new Map(tasks.map((t) => [t.id, t]));
  for (const [, s] of specs) ensureTask(db, s, actor);
  return specs;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  const actor = args.actor ?? args.worker ?? args.reviewer ?? args.by ?? "cto";
  if (!cmd) {
    console.error("usage: task.mjs <list|show|validate|claim|release|heartbeat|submit|review|block|unblock|approve|move> ...");
    process.exit(2);
  }
  const root = toplevel(process.cwd());
  const db = openDb(ctoDir(process.cwd()));
  try {
    if (cmd === "validate") {
      const { tasks } = loadTasksFile(join(root, "tasks.json"));
      console.log(JSON.stringify({ valid: true, tasks: tasks.length }, null, 2));
      return;
    }
    const specs = loadAll(root, db, actor);
    switch (cmd) {
      case "list": {
        let rows = listTasks(db, specs);
        if (args.status) rows = rows.filter((r) => r.status === args.status);
        if (args.owner) rows = rows.filter((r) => r.owner_role === args.owner);
        console.log(JSON.stringify(rows, null, 2));
        break;
      }
      case "show": {
        const id = args._[0];
        if (!id) throw new Error("show needs <task-id>");
        console.log(JSON.stringify(getTask(db, specs, id), null, 2));
        break;
      }
      case "claim": {
        const id = args._[0];
        if (!id || !args.worker || !args.branch || !args.worktree) {
          throw new Error("claim needs <task-id> --worker --branch --worktree");
        }
        console.log(JSON.stringify(claim(db, specs, {
          taskId: id,
          workerId: args.worker,
          branch: args.branch,
          worktree: args.worktree,
          ttlMs: Number(args["ttl-minutes"] ?? 30) * 60 * 1000,
        }), null, 2));
        break;
      }
      case "release": {
        const id = args._[0];
        if (!id || !args.worker) throw new Error("release needs <task-id> --worker");
        release(db, { taskId: id, workerId: args.worker, reason: args.reason ?? "" });
        console.log(JSON.stringify({ released: id }, null, 2));
        break;
      }
      case "heartbeat": {
        const id = args._[0];
        if (!id || !args.worker) throw new Error("heartbeat needs <task-id> --worker");
        heartbeat(db, { taskId: id, workerId: args.worker });
        console.log(JSON.stringify({ renewed: id }, null, 2));
        break;
      }
      case "submit": {
        const id = args._[0];
        if (!id || !args.worker) throw new Error("submit needs <task-id> --worker");
        transition(db, specs, { taskId: id, to: "review", actor: "worker", by: args.worker, reason: args.reason ?? "" });
        console.log(JSON.stringify({ submitted: id }, null, 2));
        break;
      }
      case "review": {
        const id = args._[0];
        if (!id || !args.attempt || !args.reviewer || !args.decision) {
          throw new Error("review needs <task-id> --attempt --reviewer --decision");
        }
        recordReview(db, {
          taskId: id,
          attemptId: args.attempt,
          reviewer: args.reviewer,
          decision: args.decision,
          findings: args.findings ?? "",
        });
        // The review records the DECISION only. State advances are owned by
        // their actors: integrate.mjs moves review->integration (after its
        // pre-checks), the worker resumes on CHANGES_REQUIRED. A review
        // command that auto-advanced would skip the integration gates.
        if (args.decision === "CHANGES_REQUIRED") {
          transition(db, specs, { taskId: id, to: "in_progress", actor: "reviewer", by: args.reviewer, reason: args.findings ?? "" });
        } else if (args.decision === "BLOCKED") {
          transition(db, specs, { taskId: id, to: "blocked", actor: "reviewer", by: args.reviewer, reason: args.findings ?? "" });
        }
        console.log(JSON.stringify({ reviewed: id, decision: args.decision }, null, 2));
        break;
      }
      case "block": {
        const id = args._[0];
        if (!id || !args.reason) throw new Error("block needs <task-id> --reason");
        transition(db, specs, { taskId: id, to: "blocked", actor: args.actor ?? "cto", by: args.worker ?? null, reason: args.reason });
        console.log(JSON.stringify({ blocked: id }, null, 2));
        break;
      }
      case "unblock": {
        const id = args._[0];
        if (!id) throw new Error("unblock needs <task-id>");
        const st = db.prepare("SELECT * FROM task_state WHERE task_id = ?").get(id);
        if (!st || st.status !== "blocked") throw new Error(`${id} is not blocked`);
        transition(db, specs, { taskId: id, to: st.blocked_from ?? "backlog", actor: args.actor ?? "cto", by: args.worker ?? null, reason: "unblocked" });
        console.log(JSON.stringify({ unblocked: id }, null, 2));
        break;
      }
      case "approve": {
        if (!args.action || !args.target || !args.by) throw new Error("approve needs --action --target --by");
        grantApproval(db, { action: args.action, target: args.target, grantedBy: args.by, note: args.note ?? "" });
        console.log(JSON.stringify({ approved: `${args.action}:${args.target}`, by: args.by }, null, 2));
        break;
      }
      case "move": {
        const id = args._[0];
        if (!id || !args.to) throw new Error("move needs <task-id> --to");
        if (!args.actor) throw new Error("move needs --actor <role> (roles carry authority, identities do not)");
        transition(db, specs, { taskId: id, to: args.to, actor: args.actor, by: args.worker ?? null, reason: args.reason ?? "" });
        console.log(JSON.stringify({ moved: id, to: args.to }, null, 2));
        break;
      }
      default:
        throw new Error(`unknown command ${cmd}`);
    }
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
