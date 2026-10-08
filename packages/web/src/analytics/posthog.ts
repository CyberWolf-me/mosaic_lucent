import { useEffect, useState } from "react";
import posthog from "posthog-js";

/**
 * PostHog client analytics for Lucent Web.
 *
 * Powers:
 * - Session Replay (DOM & canvas interactions with input masking)
 * - Product Analytics & Activation Funnels (AI acceptance, voice turns, board lifecycle)
 * - Feature Flags & Remote Config (toggling experimental layouts, AI tiers)
 * - In-App Surveys (user feedback on diagrams)
 * - Error & Session Correlation (replay URL linked to diagnostics)
 *
 * Follows Principle 1 & docs/06:
 * - NO canvas content, node texts, prompts, or diagram schemas ever leave the browser.
 * - Only UI interactions, navigation, feature engagement, and performance metrics are sent.
 */

export interface PostHogConfig {
  key: string;
  host?: string;
}

const DEFAULT_HOST = "https://us.i.posthog.com";

let config: { key: string; host: string } | null = null;
let sdkInitialized = false;
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

/** Diagram internals / sensitive data that must NEVER appear in telemetry. */
const DENIED_PROPS =
  /^(nodes|edges|groups|shapes|model|prompt|text|boardState|ops|operations|password|secret|token|credential)/i;

export function sanitize(props?: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!props) return out;
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null) continue;
    if (DENIED_PROPS.test(k)) continue;
    out[k] = v;
  }
  return out;
}

/** Initialize PostHog SDK (Session Replay, Feature Flags, Autocapture, Surveys). */
export function initPostHog(): void {
  if (sdkInitialized || typeof window === "undefined") return;
  const cfg = initConfig();
  if (!cfg) return;

  try {
    posthog.init(cfg.key, {
      api_host: cfg.host,
      person_profiles: "identified_only", // Privacy-preserving & prevents anonymous profile clutter
      autocapture: true,
      capture_pageview: false, // We control pageviews cleanly via router
      capture_pageleave: true,
      disable_session_recording: false,
      session_recording: {
        maskAllInputs: true,
        maskTextSelector: "[data-private], .private-content, textarea, input",
      },
      loaded: (ph) => {
        sdkInitialized = true;
        distinctId = ph.get_distinct_id?.() || distinctId;
      },
    });
    sdkInitialized = true;
  } catch (err) {
    console.warn("[lucent] posthog init failed:", err);
  }
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
  sdkInitialized = false;
}

function sendHttpFallback(
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
    }).catch(() => {});
  }
}

/** Track a custom product event in PostHog. */
export function track(
  event: string,
  properties?: Record<string, unknown>,
  fetchFn?: typeof fetch,
): void {
  const cleanProps = sanitize(properties);
  if (fetchFn) {
    sendHttpFallback(event, cleanProps, fetchFn);
    return;
  }
  if (sdkInitialized && typeof posthog.capture === "function") {
    posthog.capture(event, cleanProps);
  } else {
    sendHttpFallback(event, cleanProps);
  }
}

/** Record a pageview in PostHog. */
export function pageview(
  viewName: string,
  properties?: Record<string, unknown>,
  fetchFn?: typeof fetch,
): void {
  const props = { view: viewName, ...sanitize(properties) };
  if (fetchFn) {
    sendHttpFallback("$pageview", props, fetchFn);
    return;
  }
  if (sdkInitialized && typeof posthog.capture === "function") {
    posthog.capture("$pageview", props);
  } else {
    sendHttpFallback("$pageview", props);
  }
}

/** Associate user ID and traits when signed in. */
export function identify(
  userId: string,
  traits?: { email?: string; name?: string },
  fetchFn?: typeof fetch,
): void {
  if (!userId) return;
  distinctId = userId;
  const cleanTraits = sanitize(traits as Record<string, unknown>);
  if (fetchFn) {
    sendHttpFallback("$identify", { distinct_id: userId, $set: cleanTraits }, fetchFn);
    return;
  }
  if (sdkInitialized && typeof posthog.identify === "function") {
    posthog.identify(userId, cleanTraits);
  } else {
    sendHttpFallback("$identify", { distinct_id: userId, $set: cleanTraits });
  }
}

/** Reset to a new anonymous ID upon signout. */
export function resetUser(): void {
  try {
    if (typeof sessionStorage !== "undefined") {
      sessionStorage.removeItem("lucent.posthog.anon_id");
    }
  } catch {}
  distinctId = getOrCreateAnonId();
  if (sdkInitialized && typeof posthog.reset === "function") {
    posthog.reset();
  }
}

/**
 * Feature Flags & Remote Config
 */

/** Check if a feature flag is enabled. */
export function isFeatureEnabled(flagKey: string, defaultValue = false): boolean {
  if (!sdkInitialized || typeof posthog.isFeatureEnabled !== "function") {
    return defaultValue;
  }
  return posthog.isFeatureEnabled(flagKey) ?? defaultValue;
}

/** Get feature flag value (boolean or variant string for A/B testing). */
export function getFeatureFlag(flagKey: string): boolean | string | undefined {
  if (!sdkInitialized || typeof posthog.getFeatureFlag !== "function") return undefined;
  return posthog.getFeatureFlag(flagKey);
}

/** Get feature flag payload (JSON remote config). */
export function getFeatureFlagPayload<T = unknown>(flagKey: string): T | undefined {
  if (!sdkInitialized || typeof posthog.getFeatureFlagPayload !== "function") return undefined;
  return posthog.getFeatureFlagPayload(flagKey) as T | undefined;
}

/** React hook for PostHog feature flags. */
export function useFeatureFlag(
  flagKey: string,
  defaultValue?: boolean | string,
): boolean | string | undefined {
  const [val, setVal] = useState<boolean | string | undefined>(() => {
    return getFeatureFlag(flagKey) ?? defaultValue;
  });

  useEffect(() => {
    if (!sdkInitialized) return;
    const update = () => {
      const res = posthog.getFeatureFlag(flagKey);
      setVal(res ?? defaultValue);
    };
    update();
    return posthog.onFeatureFlags?.(update);
  }, [flagKey, defaultValue]);

  return val;
}

/**
 * Session Replay
 */

/** Get the current session's PostHog replay URL (e.g. to attach to error/support reports). */
export function getSessionReplayUrl(): string | undefined {
  if (!sdkInitialized || typeof posthog.get_session_replay_url !== "function") return undefined;
  return posthog.get_session_replay_url() || undefined;
}

/**
 * AI Acceptance & Product Funnel Helpers
 */

/** Record when an AI prompt (voice or text) is submitted. */
export function trackAiPrompt(source: "voice" | "text" | "quick_action", mode: string = "generate"): void {
  track("ai_prompt_submitted", { source, mode });
}

/**
 * Record how an AI generation ended, success or failure. `operation_count`,
 * not `operations_count`: `sanitize` drops every key that starts with
 * "operations". `schemaIssues` are schema locations only, never model content.
 */
export function trackAiGeneration(
  outcome: "success" | "validation_error" | "provider_error",
  durationMs: number,
  operationCount: number,
  failure?: { kind: string; schemaIssues?: string[] },
): void {
  track("ai_generation_completed", {
    outcome,
    duration_ms: durationMs,
    operation_count: operationCount,
    error_kind: failure?.kind,
    schema_issues: failure?.schemaIssues,
  });
}

/** Record when the user keeps/accepts an AI-generated diagram. */
export function trackAiAccepted(generationId?: string): void {
  track("ai_generation_accepted", { generation_id: generationId });
}

/** Record when the user rejects/undoes an AI generation. */
export function trackAiUndone(operationsUndone: number, generationId?: string): void {
  track("ai_generation_undone", {
    operations_undone: operationsUndone,
    generation_id: generationId,
  });
}

/** Record direct user feedback on an AI visual generation. */
export function trackAiFeedback(rating: "positive" | "negative", comment?: string): void {
  track("ai_generation_feedback", { rating, comment });
}
