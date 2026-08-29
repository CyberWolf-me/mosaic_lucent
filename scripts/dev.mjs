#!/usr/bin/env node
/**
 * Lucent dev launcher (M0.6).
 *
 * Boots the API server and the Vite dev server side-by-side so a developer
 * can run `npm run dev` and get both processes up on the loopback. Vite's
 * proxy already forwards `/api/*` and `/ws` to the server, so the split is
 * transparent in the browser.
 *
 * Ports (override with env):
 *   LUCENT_SERVER_PORT (default 4387)
 *   LUCENT_WEB_PORT    (default 5173)
 *
 * Ctrl+C once kills both children — they share this process's stdio and a
 * SIGINT handler that propagates the signal.
 */

import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import killPortModule from "kill-port";
import { createRequire } from "node:module";

const _require = createRequire(import.meta.url);
// `kill-port` ships dual ESM/CJS; default import resolves to the default export
// in some bundlers and the namespace in others. Normalize.
const killPort =
  typeof killPortModule === "function"
    ? killPortModule
    : (killPortModule.default ?? (await import("kill-port")).default);

const SERVER_PORT = Number(process.env.LUCENT_SERVER_PORT ?? 4387);
const WEB_PORT = Number(process.env.LUCENT_WEB_PORT ?? 5173);

/** Spawn a workspace script and stream its stdio through this process. */
function spawnWorkspace(script, env, label) {
  const child = spawn("npm", ["run", script, "-w", label], {
    stdio: "inherit",
    env: { ...process.env, ...env },
    shell: process.platform === "win32",
  });
  child.on("exit", (code, signal) => {
    // Propagate a child crash so the dev script exits non-zero too.
    process.exitCode = code ?? 1;
    if (signal) console.error(`[dev] ${label} exited via ${signal}`);
  });
  return child;
}

/** Free a port if a previous run left it occupied. Bounded so we don't hang. */
async function freePort(port) {
  try {
    await killPort(port, "tcp");
  } catch {
    // kill-port throws when nothing is bound; that's fine, move on.
  }
}

const children = [];

// Free known ports first. If another process is holding them, fail fast
// rather than starting two servers that immediately collide.
await Promise.all([freePort(SERVER_PORT), freePort(WEB_PORT)]);

// Kick off the API server first so Vite's proxy target is up before the first
// browser request lands.
children.push(spawnWorkspace("dev", { LUCENT_PORT: String(SERVER_PORT) }, "@lucent/server"));

// Give the server a moment to bind, then start Vite. If the server fails to
// boot the child will exit and the wrapper will follow.
await delay(750);
children.push(
  spawnWorkspace(
    "dev",
    { LUCENT_WEB_PORT: String(WEB_PORT), LUCENT_API_PORT: String(SERVER_PORT) },
    "@lucent/web",
  ),
);

const shutdown = (signal) => {
  console.log(`\n[dev] received ${signal}, stopping children…`);
  for (const child of children) {
    if (!child.killed) child.kill(signal);
  }
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// Keep the parent alive while children run. Node will exit when all stdio
// children close.
process.stdin.resume();
