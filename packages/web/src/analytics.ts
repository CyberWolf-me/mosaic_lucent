import { apiFetch } from "./http.js";

/**
 * Org analytics client (M7).
 *
 * The server already owns the metering pipeline (`usage_events`,
 * `usage_rollups`); this is the client-side slice of it. The same numbers
 * the entitlement gate reads show up here, so the dashboard never disagrees
 * with the paywall. The endpoint pair is `{orgId}/billing` (already exists
 * for the billing surface) and a new rollup endpoint the analytics view
 * fetches for trend data.
 *
 * Fetching counts is the cheap path. Trend data is heavy enough to belong
 * behind its own route so the billing surface stays fast; this file
 * documents both shapes so a future server change pins the contract here.
 */

export interface AnalyticsBillingSurface {
  orgId: string;
  period: { start: number; end: number };
  usage: Record<string, number>;
  limits: Array<{ key: string; limit: number | null; used: number | null; unlimited: boolean }>;
}

/**
 * One row in a daily trend, mirroring `usage_rollups` (`kind, day, count`).
 * The day is a UTC date key in `YYYY-MM-DD` form per usageStore.ts.
 */
export interface UsageTrendRow {
  day: string;
  kind: string;
  count: number;
}

/** Fetch the same shape the billing pane renders. */
export async function fetchAnalyticsBilling(
  orgId: string,
): Promise<AnalyticsBillingSurface | null> {
  const res = await apiFetch(`/api/orgs/${encodeURIComponent(orgId)}/billing`);
  if (!res.ok) return null;
  return (await res.json()) as AnalyticsBillingSurface;
}

/**
 * Fetch the daily trend for one kind. v1 returns a flat array sorted by
 * date; a future server refactor may pivot to `{day, byKind}` for fewer
 * round trips, but the client's need is "one chart, one kind".
 */
export async function fetchAnalyticsTrend(
  orgId: string,
  kind: string,
  days = 30,
): Promise<UsageTrendRow[]> {
  const url = `/api/analytics/${encodeURIComponent(orgId)}/trend?kind=${encodeURIComponent(kind)}&days=${days}`;
  const res = await apiFetch(url);
  if (!res.ok) return [];
  const body = (await res.json()) as { rows?: UsageTrendRow[] };
  return Array.isArray(body.rows) ? body.rows : [];
}
