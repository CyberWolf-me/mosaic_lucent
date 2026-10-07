/**
 * Dependency-free PostHog client analytics for Lucent Web.
 *
 * Follows Principle 1 & docs/06:
 * - NO canvas content, node texts, prompts, or diagram schemas ever leave the browser.
 * - Only UI interactions, navigation, feature engagement, and performance metrics are sent.
 * - Fire-and-forget: never throws, never blocks the render loop.
 */

export interface PostHogConfig {
  key: string;
  host?: string;
}

const DEFAULT_HOST = "https://us.i.posthog.com";

let config: { key: string; host: string } | null = null;
let distinctId: string = getOrCreateAnonId();

function clean(v: string | undefined | null): string {
  return typeof v === "string" ? v.trim() : "";
}

function getOrCreateAnonId(): string {
  try {
    if (typeof sessionStorage !== "undefined") {
      const existing = sessionStorage.getItem("lucent.posthog.anon_id");
      if (existing) return existing;
    }
    const next =
      (typeof crypto !== "undefined" && crypto.randomUUID && `anon_${crypto.randomUUID()}`) ||
      `anon_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    if (typeof sessionStorage !== "undefined") {
      sessionStorage.setItem("lucent.posthog.anon_id", next);
    }
    return next;
  } catch {
    return `anon_${Date.now().toString(36)}`;
  }
}

function initConfig(): { key: string; host: string } | null {
  if (config) return config;
  const envKey = clean((import.meta as any).env?.VITE_POSTHOG_KEY as string | undefined);
  if (!envKey) return null;
  const envHost =
    clean((import.meta as any).env?.VITE_POSTHOG_HOST as string | undefined) || DEFAULT_HOST;
  config = { key: envKey, host: envHost };
  return config;
}

/** Check if PostHog analytics is configured and active. */
export function isPostHogEnabled(): boolean {
  return initConfig() !== null;
}

/** Get the currently resolved PostHog configuration. */
export function getPostHogConfig(): { key: string; host: string } | null {
  return initConfig();
}

/** Explicitly configure PostHog (if overriding env var defaults). */
export function configurePostHog(cfg: { key?: string | null; host?: string | null }): void {
  const key = clean(cfg.key);
  config = key ? { key, host: clean(cfg.host) || DEFAULT_HOST } : null;
}

/** Diagram internals / sensitive data that must NEVER appear in telemetry. */
const DENIED_PROPS =
  /^(nodes|edges|groups|shapes|model|prompt|text|boardState|ops|operations|password|secret|token|credential)/i;

function sanitize(props?: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!props) return out;
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null) continue;
    if (DENIED_PROPS.test(k)) continue;
    out[k] = v;
  }
  return out;
}

function send(
  event: string,
  properties: Record<string, unknown> = {},
  fetchFn: typeof fetch = globalThis.fetch,
): void {
  const cfg = initConfig();
  if (!cfg) return;

  const endpoint = `${cfg.host.replace(/\/+$/, "")}/capture/`;
  const payload = {
    api_key: cfg.key,
    event,
    distinct_id: distinctId,
    properties: {
      ...sanitize(properties),
      $lib: "lucent-web",
      $current_url: typeof window !== "undefined" ? window.location.href : "",
      $pathname: typeof window !== "undefined" ? window.location.pathname : "",
    },
    timestamp: new Date().toISOString(),
  };

  if (typeof fetchFn === "function") {
    fetchFn(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      keepalive: true,
    }).catch(() => {
      // Non-blocking: never disrupt UI
    });
  }
}

/** Track a custom product event in PostHog. */
export function track(
  event: string,
  properties?: Record<string, unknown>,
  fetchFn?: typeof fetch,
): void {
  send(event, properties, fetchFn);
}

/** Record a pageview in PostHog. */
export function pageview(
  viewName: string,
  properties?: Record<string, unknown>,
  fetchFn?: typeof fetch,
): void {
  send(
    "$pageview",
    {
      view: viewName,
      ...properties,
    },
    fetchFn,
  );
}

/** Associate user ID and traits when signed in. */
export function identify(
  userId: string,
  traits?: { email?: string; name?: string },
  fetchFn?: typeof fetch,
): void {
  if (!userId) return;
  distinctId = userId;
  send(
    "$identify",
    {
      distinct_id: userId,
      $set: sanitize(traits as Record<string, unknown>),
    },
    fetchFn,
  );
}

/** Reset to a new anonymous ID upon signout. */
export function resetUser(): void {
  try {
    if (typeof sessionStorage !== "undefined") {
      sessionStorage.removeItem("lucent.posthog.anon_id");
    }
  } catch {
    // ignore
  }
  distinctId = getOrCreateAnonId();
}
