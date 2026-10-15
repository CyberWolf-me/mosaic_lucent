/**
 * Execution adapter contract (spec section 7) plus the one adapter the
 * current environment actually provides: local command execution.
 *
 * Contract for any adapter (agent runners, present or future):
 *   prepare(contract) -> context   // resolve worktree/branch, no status change
 *   start(context)    -> handle    // begin work, returns opaque handle
 *   poll(handle)      -> state     // {phase, detail} — never mutates tasks
 *   cancel(handle)    -> void      // best-effort timeout/cancellation
 *   result(handle)    -> outcome   // structured result + artifact refs
 *
 * Hard rule: adapters never modify task status. Status changes flow only
 * through store.js transitions, which the adapter is never given. An
 * adapter that could set status directly would bypass review, evidence,
 * and approval gates.
 */

import { spawn } from "node:child_process";

const SECRET_PATTERNS = [
  /sk-(live|test)-[A-Za-z0-9-_]+/g,
  /github_pat_[A-Za-z0-9_]+/g,
  /xox[bap]-[A-Za-z0-9-]+/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /(^|[\s"'`])(bearer|api[_-]?key|token|secret|password|passwd)[=: ]\s*['"]?[^\s'"]+/gim,
];

/** Redact secret-shaped values from captured output before persistence. */
export function sanitizeOutput(text, limit = 20000) {
  let out = String(text ?? "");
  for (const re of SECRET_PATTERNS) out = out.replace(re, "[redacted]");
  if (out.length > limit) out = `${out.slice(0, limit)}\n…[truncated ${out.length - limit} chars]`;
  return out;
}

/**
 * Run one command with a timeout. Resolves (never rejects on command
 * failure) with a structured outcome; rejects only on spawn errors.
 */
export function runCommand(command, { cwd, timeoutMs = 10 * 60 * 1000, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    let child;
    try {
      child = spawn(command, { cwd, shell: true, env: { ...process.env, ...env } });
    } catch (err) {
      reject(err);
      return;
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({
        command,
        cwd,
        startedAt,
        finishedAt: Date.now(),
        exitCode: timedOut ? 124 : (exitCode ?? 1),
        timedOut,
        stdout: sanitizeOutput(stdout),
        stderr: sanitizeOutput(stderr),
      });
    });
  });
}

/**
 * Minimal local adapter: executes commands in the task's worktree and
 * returns structured outcomes. Used by verify.mjs; agent-dispatch adapters
 * implement the same prepare/start/poll/cancel/result shape.
 */
export function createLocalAdapter() {
  return {
    name: "local",
    async runStep({ command, cwd, timeoutMs }) {
      return runCommand(command, { cwd, timeoutMs });
    },
  };
}
