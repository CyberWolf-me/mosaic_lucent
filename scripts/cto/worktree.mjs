#!/usr/bin/env node
/**
 * Worker isolation: branches + worktrees per task (spec sections 6.1, 8.5).
 *
 *   worktree.mjs create <task-id> --worker <id> [--base main] [--ttl-minutes 30]
 *   worktree.mjs status
 *   worktree.mjs recover <task-id>
 *   worktree.mjs remove <task-id> [--allow-unmerged <reason>]
 *
 * Recovery never deletes uncommitted work. Removal refuses dirty trees
 * unconditionally and unmerged branches without an explicit reason.
 */

import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ctoDir, toplevel, worktrees as listWorktrees, isMergedInto } from "./lib/gitutil.js";
import { loadTasksFile } from "./lib/spec.js";
import { openDb, ensureTask, claim } from "./lib/store.js";

function usage() {
  console.error("usage: worktree.mjs <create|status|recover|remove> [args]");
  process.exit(2);
}

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

function slug(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function branchExists(name, cwd) {
  try {
    git(cwd, "rev-parse", "--verify", `refs/heads/${name}`);
    return true;
  } catch {
    return false;
  }
}

function loadSpecs(root) {
  const { tasks } = loadTasksFile(join(root, "tasks.json"));
  return new Map(tasks.map((t) => [t.id, t]));
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd) usage();
  const args = parseArgs(rest);
  const root = toplevel(process.cwd());
  const db = openDb(ctoDir(process.cwd()));
  const specs = loadSpecs(root);
  try {
    if (cmd === "create") {
      const taskId = args._[0];
      const worker = args.worker;
      if (!taskId || !worker) throw new Error("create needs <task-id> --worker <id>");
      const spec = specs.get(taskId);
      if (!spec) throw new Error(`unknown task ${taskId}`);
      for (const [id, s] of specs) ensureTask(db, s, "cto");
      const base = args.base ?? "main";
      const name = `feat/${taskId.toLowerCase()}-${slug(spec.title)}`;
      if (branchExists(name, root)) throw new Error(`branch collision: ${name} already exists`);
      const wtPath = resolve(join(root, "..", `${root.split(/[\\/]/).pop()}-${taskId.toLowerCase()}`));
      const collision = listWorktrees(root).find((w) => w.path === wtPath || w.branch === `refs/heads/${name}`);
      if (collision) throw new Error(`worktree collision at ${collision.path}`);
      try {
        git(root, "fetch", "origin", base, "--quiet");
      } catch {
        // Offline or no remote: proceed against the local base; the base
        // sha is recorded in the claim event either way.
      }
      execFileSync("git", ["worktree", "add", wtPath, "-b", name, base], { cwd: root, stdio: "inherit" });
      const { attemptId, recoveredFrom } = claim(db, specs, {
        taskId,
        workerId: worker,
        branch: name,
        worktree: wtPath,
        ttlMs: Number(args["ttl-minutes"] ?? 30) * 60 * 1000,
      });
      console.log(JSON.stringify({ taskId, worker, branch: name, worktree: wtPath, attemptId, recoveredFrom }, null, 2));
    } else if (cmd === "status") {
      const rows = listWorktrees(root).map((w) => {
        let lease = null;
        try {
          lease = db.prepare("SELECT task_id, worker_id, attempt_id, expires_at, released_at FROM leases WHERE worktree = ?").get(w.path) ?? null;
        } catch {
          lease = null;
        }
        return { ...w, lease };
      });
      console.log(JSON.stringify(rows, null, 2));
    } else if (cmd === "recover") {
      const taskId = args._[0];
      if (!taskId) throw new Error("recover needs <task-id>");
      const lease = db.prepare("SELECT * FROM leases WHERE task_id = ?").get(taskId) ?? null;
      if (!lease) throw new Error(`no lease ever recorded for ${taskId}`);
      const live = lease.released_at == null && lease.expires_at > Date.now();
      let tree = { exists: false, dirty: null, uncommitted: [] };
      try {
        const st = execFileSync("git", ["status", "--porcelain"], { cwd: lease.worktree, encoding: "utf8" });
        tree = { exists: true, dirty: st.trim().length > 0, uncommitted: st.trim().split("\n").filter(Boolean) };
      } catch {
        tree = { exists: false, dirty: null, uncommitted: [] };
      }
      // Recovery is inspection only: report, never delete or reassign here.
      console.log(
        JSON.stringify(
          {
            taskId,
            lease: { worker: lease.worker_id, attempt: lease.attempt_id, branch: lease.branch, worktree: lease.worktree, live, expires_at: lease.expires_at },
            tree,
            next: live
              ? "lease is live: coordinate with the holder or wait for expiry"
              : "lease expired: reclaim with `task.mjs claim` (same branch/worktree), prior work is preserved",
          },
          null,
          2,
        ),
      );
    } else if (cmd === "remove") {
      const taskId = args._[0];
      if (!taskId) throw new Error("remove needs <task-id>");
      const lease = db.prepare("SELECT * FROM leases WHERE task_id = ?").get(taskId) ?? null;
      if (!lease) throw new Error(`no lease recorded for ${taskId}`);
      if (lease.released_at == null) throw new Error("lease still active: release it first (`task.mjs release`)");
      let porcelain = "";
      try {
        porcelain = execFileSync("git", ["status", "--porcelain"], { cwd: lease.worktree, encoding: "utf8" }).trim();
      } catch {
        throw new Error(`worktree missing at ${lease.worktree}: remove manually after inspection`);
      }
      if (porcelain) throw new Error(`refusing: dirty worktree with uncommitted changes:\n${porcelain}`);
      if (!isMergedInto(lease.branch, root) && !args["allow-unmerged"]) {
        throw new Error("refusing: branch not merged into main (pass --allow-unmerged <reason> with CTO approval)");
      }
      execFileSync("git", ["worktree", "remove", lease.worktree], { cwd: root, stdio: "inherit" });
      try {
        execFileSync("git", ["branch", "-D", lease.branch], { cwd: root, stdio: "ignore" });
      } catch {
        // Branch may already be gone or kept deliberately; worktree removal is the goal.
      }
      console.log(JSON.stringify({ removed: lease.worktree, branch: lease.branch }, null, 2));
    } else {
      usage();
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
