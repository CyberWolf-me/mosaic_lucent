#!/usr/bin/env node
/**
 * Report generation (spec sections 8.4, 13).
 *
 *   report.mjs [--check] [--report-dir docs/reports]
 *
 * Regenerates docs/tasks.md, docs/execution-log.md, and a timestamped
 * founder report. --check regenerates in memory and fails when committed
 * files differ (stale generated docs gate for CI / local verification).
 * Generation is deterministic: same sources, same bytes.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ctoDir, toplevel, head } from "./lib/gitutil.js";
import { validateTaskDocument } from "./lib/spec.js";
import { openDb, ensureTask, recentEvents } from "./lib/store.js";
import { buildProjections, renderFounderReport } from "./lib/report.js";

function main() {
  const argv = process.argv.slice(2);
  const checkOnly = argv.includes("--check");
  const ri = argv.indexOf("--report-dir");
  const reportDir = ri >= 0 && argv[ri + 1] ? argv[ri + 1] : "docs/reports";
  const root = toplevel(process.cwd());
  const cto = ctoDir(process.cwd());
  const db = openDb(cto);
  try {
    const tasksText = readFileSync(join(root, "tasks.json"), "utf8");
    const { tasks, errors } = validateTaskDocument(JSON.parse(tasksText));
    if (errors.length > 0) throw new Error(`tasks.json invalid:\n- ${errors.join("\n- ")}`);
    for (const t of tasks) ensureTask(db, t, "cto");
    const states = new Map(
      tasks.map((t) => [t.id, db.prepare("SELECT * FROM task_state WHERE task_id = ?").get(t.id) ?? { status: "backlog" }]),
    );
    const events = [...recentEvents(db, 500)].reverse();
    const { board, log, tasksHash, maxEventSeq } = buildProjections({ tasksText, tasks, states, events });
    const pendingApprovals = tasks
      .filter((t) => (t.required_approvals ?? []).length > 0)
      .flatMap((t) => t.required_approvals.map((a) => `${t.id} needs ${a}`));
    const integ = db.prepare("SELECT * FROM integrations ORDER BY id DESC LIMIT 1").get() ?? null;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const report = renderFounderReport({
      tasks,
      states,
      events,
      pendingApprovals,
      integratedCommit: integ?.result_commit ?? null,
      remotePushed: false,
      tasksHash,
      maxEventSeq,
    });

    const targets = [
      [join(root, "docs/tasks.md"), board],
      [join(root, "docs/execution-log.md"), log],
      [join(root, reportDir, `${stamp}.md`), report],
    ];
    if (checkOnly) {
      const stale = [];
      for (const [path, content] of targets.slice(0, 2)) {
        if (!existsSync(path) || readFileSync(path, "utf8") !== content) stale.push(path);
      }
      if (stale.length > 0) {
        console.error(`stale generated docs:\n- ${stale.join("\n- ")}\nrun report.mjs to regenerate`);
        process.exit(1);
      }
      console.log(JSON.stringify({ fresh: true, tasks: tasks.length, events: events.length }, null, 2));
      return;
    }
    for (const [path, content] of targets) {
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, content);
    }
    console.log(JSON.stringify({ generated: targets.map(([p]) => p), head: head(root) }, null, 2));
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
