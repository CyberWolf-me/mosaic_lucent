/**
 * Load Test Configuration & Environment Settings
 *
 * SAFETY: this harness drives heavy, sometimes destructive load. It now defaults
 * to a LOCAL target only (the docker-compose stack on :4387). Running against a
 * remote host requires an explicit ALLOW_REMOTE_TARGET=true, and assertNonProd()
 * hard-blocks the known production box regardless of that flag, so a stray env
 * var can never point this harness at production.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");

export const CONFIG = {
  // Target URL: LOCAL by default. Point at the docker-compose stack on :4387.
  TARGET_URL: process.env.TARGET_URL || "http://127.0.0.1:4387",

  // Unique run identifier
  RUN_ID: process.env.RUN_ID || `LT_${Date.now()}_${Math.floor(Math.random() * 10000)}`,

  // Artifact directory for logs, metrics, and reports (repo-local, gitignored)
  ARTIFACT_DIR: process.env.ARTIFACT_DIR || path.join(REPO_ROOT, ".load-artifacts"),

  // User provisioning credentials
  DEFAULT_PASSWORD: process.env.TEST_USER_PASSWORD || "LoadTestPass123!#",

  // Concurrency and timeouts
  PROVISION_CONCURRENCY: 8,
  OPERATION_TIMEOUT_MS: 15000,
  WS_CONNECT_TIMEOUT_MS: 12000,
  RECONNECT_WINDOW_MS: 10000,

  // Guardrails
  ALLOW_DESTRUCTIVE_TESTS: process.env.ALLOW_DESTRUCTIVE_TESTS === "true",
  ALLOW_PAID_AI: process.env.ALLOW_PAID_AI === "true",
  ALLOW_REMOTE_TARGET: process.env.ALLOW_REMOTE_TARGET === "true",
  CLEANUP_ON_EXIT: process.env.CLEANUP_ON_EXIT !== "false",

  // Command used by LT-15 to perform a REAL server restart (destructive-gated).
  RESTART_CMD: process.env.RESTART_CMD || "docker compose restart server",
};

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);

/**
 * Hard safety gate — call once at startup before any load is driven. Throws
 * unless the target is loopback, or the caller explicitly opted into a remote
 * target with ALLOW_REMOTE_TARGET=true. The known production box is refused
 * ALWAYS, even with the opt-in.
 */
export function assertNonProd(targetUrl = CONFIG.TARGET_URL) {
  let host;
  try {
    host = new URL(targetUrl).hostname;
  } catch {
    throw new Error(`[safety] TARGET_URL is not a valid URL: ${targetUrl}`);
  }
  const BANNED = ["161.33.167.15", ".sslip.io"];
  if (BANNED.some((b) => host === b || host.endsWith(b))) {
    throw new Error(
      `[safety] Refusing to run against production host "${host}". ` +
        `This harness is for an isolated local stack only.`,
    );
  }
  if (LOOPBACK_HOSTS.has(host)) return;
  if (CONFIG.ALLOW_REMOTE_TARGET) {
    console.warn(
      `[safety] ALLOW_REMOTE_TARGET=true — running against non-loopback host "${host}".`,
    );
    return;
  }
  throw new Error(
    `[safety] TARGET_URL host "${host}" is not loopback. Refusing to run. ` +
      `Set ALLOW_REMOTE_TARGET=true to override (never for production).`,
  );
}

export function isLoopback(targetUrl = CONFIG.TARGET_URL) {
  try {
    return LOOPBACK_HOSTS.has(new URL(targetUrl).hostname);
  } catch {
    return false;
  }
}
