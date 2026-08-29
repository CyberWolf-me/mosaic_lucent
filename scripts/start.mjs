#!/usr/bin/env node
/**
 * Lucent single-process launcher (M0.6).
 *
 * Builds the web app, frees the loopback port, then starts the API server
 * with the static handler wired in so the whole product runs on one port.
 * Use this in CI, smoke tests, or to deploy behind a reverse proxy.
 *
 * Set LUCENT_DATABASE_URL before running to enable Postgres persistence;
 * otherwise the in-memory stores are used (single instance only).
 */

import { spawn } from "node:child_process";
import killPortModule from "kill-port";

const killPort =
  typeof killPortModule === "function"
    ? killPortModule
    : (killPortModule.default ?? (await import("kill-port")).default);

const PORT = Number(process.env.LUCENT_PORT ?? 4387);

function run(label, args) {
  return new Promise((resolve, reject) => {
    const child = spawn("npm", args, { stdio: "inherit", shell: process.platform === "win32" });
    child.on("exit", (code) => {
      if (code === 0) resolve(undefined);
      else reject(new Error(`${label} exited with code ${code ?? "signal"}`));
    });
    child.on("error", reject);
  });
}

try {
  await killPort(PORT, "tcp");
} catch {
  // nothing bound — fine.
}

try {
  await run("web build", ["run", "build", "-w", "@lucent/web"]);
} catch (err) {
  console.error("[start] web build failed:", err.message);
  process.exit(1);
}

// Start the server in the foreground so this script's lifetime equals the
// server's. SIGINT/SIGTERM propagate to the child through the shell.
await run("server", ["run", "start", "-w", "@lucent/server"]);
