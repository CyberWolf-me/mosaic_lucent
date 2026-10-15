/**
 * Minimal git helpers for the control plane. All operations are read-only
 * except worktree/branch management in worktree.mjs and merges in
 * integrate.mjs. No secrets are ever captured.
 */

import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";

function git(cwd, ...args) {
  const out = execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return out.trim();
}

/** Repo root for any directory inside it. */
export function toplevel(cwd = process.cwd()) {
  return git(cwd, "rev-parse", "--show-toplevel");
}

/**
 * Directory holding shared CTO runtime state. Resolved through the COMMON
 * git dir so linked worktrees share one .cto/ with the main checkout
 * instead of each duplicating it.
 */
export function ctoDir(cwd = process.cwd()) {
  const common = resolve(cwd, git(cwd, "rev-parse", "--git-common-dir"));
  const base = common.endsWith(".git") || common.endsWith("/.git") ? dirname(common) : common;
  return join(base, ".cto");
}

/** Current branch name, or "DETACHED:<sha>" when detached. */
export function branch(cwd = process.cwd()) {
  try {
    return git(cwd, "symbolic-ref", "--short", "HEAD");
  } catch {
    return `DETACHED:${head(cwd)}`;
  }
}

/** Current HEAD sha. */
export function head(cwd = process.cwd()) {
  return git(cwd, "rev-parse", "HEAD");
}

/** True when the working tree has staged or unstaged changes. */
export function isDirty(cwd = process.cwd()) {
  try {
    execFileSync("git", ["diff", "--quiet"], { cwd, stdio: "ignore" });
    execFileSync("git", ["diff", "--cached", "--quiet"], { cwd, stdio: "ignore" });
    return false;
  } catch {
    return true;
  }
}

/**
 * Fingerprint of dirty state: sha256 over sorted changed paths plus their
 * content. Two runs on the same dirty tree produce the same fingerprint;
 * any content change alters it. Used to detect stale evidence.
 */
export async function dirtyFingerprint(cwd = process.cwd()) {
  if (!isDirty(cwd)) return "clean";
  const { createHash } = await import("node:crypto");
  const names = git(cwd, "diff", "--name-only", "HEAD").split("\n").filter(Boolean).sort();
  const h = createHash("sha256");
  for (const n of names) {
    h.update(n);
    h.update("\0");
    try {
      const obj = git(cwd, "show", `HEAD:${n}`);
      h.update(obj);
    } catch {
      // New file with no HEAD blob: hash the working-tree content instead.
      const { readFileSync } = await import("node:fs");
      h.update(readFileSync(join(toplevel(cwd), n)));
    }
    h.update("\0");
  }
  return `dirty:${h.digest("hex").slice(0, 32)}:${names.length}`;
}

/** Paths changed between two revisions (merge-base aware by default). */
export function changedPaths(base, ref = "HEAD", cwd = process.cwd()) {
  const via = git(cwd, "merge-base", base, ref);
  const out = git(cwd, "diff", "--name-only", `${via}..${ref}`);
  return out ? out.split("\n").filter(Boolean).sort() : [];
}

/** True when ref is an ancestor of (or equal to) HEAD. */
export function isMergedInto(ref, cwd = process.cwd()) {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", ref, "HEAD"], { cwd, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Porcelain worktree list: [{path, head, branch, bare}]. */
export function worktrees(cwd = process.cwd()) {
  const out = git(cwd, "worktree", "list", "--porcelain");
  const entries = [];
  let cur = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) {
      cur = { path: line.slice(9), head: null, branch: null, bare: false };
      entries.push(cur);
    } else if (cur && line.startsWith("HEAD ")) cur.head = line.slice(5);
    else if (cur && line.startsWith("branch ")) cur.branch = line.slice(7);
    else if (cur && line === "bare") cur.bare = true;
  }
  return entries;
}
