import type { ExecutionProvider } from "./provider.js";

/**
 * Connection health (docs/26 A5): how an org's link to Linear, Jira or
 * GitHub has been answering, so "sync failed" stops being a surprise found
 * one item at a time. Four states, derived — never stored as a word:
 *
 * - `active` — the last call that reached the provider worked (or none yet);
 * - `degraded` — the provider has been failing (5xx, 429, the network)
 *   since the last success;
 * - `needs-reauth` — the credential is missing, expired or refused
 *   (401/403, an unset reference); sticky until a call succeeds or the owner
 *   reconnects;
 * - `revoked` — the owner disconnected it.
 *
 * Only failures of the CONNECTION count. An item the provider refuses — an
 * assignee it can't resolve, a transition the workflow lacks, a 404 for one
 * issue — says nothing about the connection and leaves its health alone.
 */

export const CONNECTION_STATES = ["active", "degraded", "needs-reauth", "revoked"] as const;
export type ConnectionState = (typeof CONNECTION_STATES)[number];

export interface ConnectionHealth {
  /** Connection failures in a row since the last success. */
  failures: number;
  /** The last failure was the credential; cleared by a success or a reconnect. */
  authFailed: boolean;
  lastError?: string;
  lastErrorAt?: number;
  lastOkAt?: number;
}

export type CallOutcome = { ok: true } | { ok: false; error: string; auth: boolean };

export function connectionState(connection: {
  status: string;
  health?: ConnectionHealth | undefined;
}): ConnectionState {
  if (connection.status !== "active") return "revoked";
  if (connection.health?.authFailed) return "needs-reauth";
  if ((connection.health?.failures ?? 0) > 0) return "degraded";
  return "active";
}

export function nextHealth(
  prev: ConnectionHealth | undefined,
  outcome: CallOutcome,
  now: number,
): ConnectionHealth {
  const base: ConnectionHealth = prev ?? { failures: 0, authFailed: false };
  if (outcome.ok) {
    return {
      failures: 0,
      authFailed: false,
      ...(base.lastError !== undefined ? { lastError: base.lastError } : {}),
      ...(base.lastErrorAt !== undefined ? { lastErrorAt: base.lastErrorAt } : {}),
      lastOkAt: now,
    };
  }
  return {
    failures: base.failures + 1,
    authFailed: outcome.auth || base.authFailed,
    lastError: outcome.error.slice(0, 300),
    lastErrorAt: now,
    ...(base.lastOkAt !== undefined ? { lastOkAt: base.lastOkAt } : {}),
  };
}

/** The words a factory uses when the credential itself is the problem. */
const CREDENTIAL_PROBLEM =
  /not set in the environment|must be "email:api_token"|requires an apiKey/i;

/**
 * Is this error the connection's, and is it the credential? Null when it is
 * an item's problem (the connection answered; it refused one thing).
 */
export function connectionFailure(
  err: unknown,
): { ok: false; error: string; auth: boolean } | null {
  const message = err instanceof Error ? err.message : String(err);
  const status = (err as { status?: unknown } | null)?.status;
  if (status === 401 || status === 403 || CREDENTIAL_PROBLEM.test(message)) {
    return { ok: false, error: message, auth: true };
  }
  if (typeof status === "number" && (status === 429 || status >= 500)) {
    return { ok: false, error: message, auth: false };
  }
  // No status at all: the request never got an answer (DNS, TLS, reset).
  if (typeof status !== "number") return { ok: false, error: message, auth: false };
  return null;
}

const WATCHED = ["createTask", "updateTask", "getTask", "searchTasks", "recoverCreate"] as const;

/**
 * A provider whose calls are counted: the first connection failure wins,
 * otherwise any answered call is a success. `settle` reports once, at the end
 * of the request or job — one health write per batch, not per item.
 */
export function watchProvider(
  provider: ExecutionProvider,
  report: (outcome: CallOutcome) => Promise<void>,
): { provider: ExecutionProvider; settle(): Promise<void> } {
  let answered = false;
  let failure: { ok: false; error: string; auth: boolean } | null = null;
  const watched = new Proxy(provider, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof value !== "function" || !(WATCHED as readonly PropertyKey[]).includes(prop)) {
        return typeof value === "function"
          ? (value as (...a: unknown[]) => unknown).bind(target)
          : value;
      }
      return async (...args: unknown[]) => {
        try {
          const result = await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
          answered = true;
          return result;
        } catch (err) {
          const failed = connectionFailure(err);
          if (failed) failure ??= failed;
          else answered = true;
          throw err;
        }
      };
    },
  });
  return {
    provider: watched,
    async settle() {
      if (failure) await report(failure).catch(() => {});
      else if (answered) await report({ ok: true }).catch(() => {});
    },
  };
}
