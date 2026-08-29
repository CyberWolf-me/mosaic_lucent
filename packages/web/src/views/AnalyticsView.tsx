import { useEffect, useState } from "react";
import { fetchAnalyticsBilling, fetchAnalyticsTrend, type UsageTrendRow } from "../analytics.js";
import { Ico } from "../ui/icons.js";
import { fetchOrgs, preferredOrg } from "../billing.js";

/**
 * Analytics dashboard (M7).
 *
 * Owner-visible meters for the active org: same numbers the paywall reads
 * (the "limit / used / remaining" row from `GET /api/orgs/:id/billing`) plus
 * a 30-day trend per metered kind (AI generations, voice minutes, asset
 * bytes). The trend is read from `/api/analytics/:orgId/trend` which is
 * added alongside this view; older deployments simply render the meters.
 *
 * Not a separate product surface — it lives behind Admin. Owner-only by
 * route, gate mirrored to the route that returns the trend.
 */

const METERED_KINDS = [
  { key: "ai.generationsPerMonth", label: "AI generations" },
  { key: "voice.minutes", label: "Voice minutes" },
  { key: "storage.bytes", label: "Storage" },
  { key: "image.generation", label: "Images generated" },
] as const;

interface LimitsRow {
  key: string;
  label: string;
  limit: number | null;
  used: number | null;
  unlimited: boolean;
  remaining: number | null;
}

export function AnalyticsView({ onBack }: { onBack: () => void }) {
  const [orgId, setOrgId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [limits, setLimits] = useState<LimitsRow[]>([]);
  const [trends, setTrends] = useState<Record<string, UsageTrendRow[]>>({});
  const [windowDays, setWindowDays] = useState(30);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const orgs = await fetchOrgs();
      if (cancelled) return;
      if (orgs.kind !== "ok") {
        setError(
          orgs.kind === "signedOut"
            ? "Sign in to view analytics."
            : "Couldn't load your workspace.",
        );
        return;
      }
      const org = preferredOrg(orgs.orgs);
      if (org === null) {
        setError("You don't have a workspace yet.");
        return;
      }
      setOrgId(org.id);
      // Use /api/orgs/:id/billing because every owner-visible surface already
      // exists there. The dedicated analytics trend endpoint is added below;
      // older deployments silently get empty trends.
      const billing = await fetchAnalyticsBilling(org.id);
      if (billing !== null && !cancelled) {
        const rows: LimitsRow[] = [];
        for (const m of billing.limits) {
          rows.push({
            key: m.key,
            label: m.key,
            limit: m.limit,
            used: m.used,
            unlimited: m.unlimited,
            remaining: m.limit === null || m.used === null ? null : Math.max(0, m.limit - m.used),
          });
        }
        setLimits(rows);
      }
      // Pull a trend per metered kind. Failures here render an empty chart
      // rather than the whole dashboard erroring — the meters are the
      // important part and trend data is a separate purchase.
      const next: Record<string, UsageTrendRow[]> = {};
      for (const k of METERED_KINDS) {
        const t = await fetchAnalyticsTrend(org.id, k.key, windowDays);
        if (!cancelled) next[k.key] = t;
      }
      if (!cancelled) setTrends(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [windowDays]);

  return (
    <div className="view-page analytics-view">
      <header className="view-head">
        <button className="icon-btn" onClick={onBack} aria-label="Back">
          <Ico.Left />
        </button>
        <h2>Analytics</h2>
        <div className="view-head-spacer" />
        {orgId !== null && <span className="mono small">org {orgId.slice(0, 12)}…</span>}
      </header>
      {error !== null && <div className="view-error">{error}</div>}
      <section className="analytics-meters">
        <div className="meter-controls">
          <span className="meter-controls-label">Window</span>
          {([7, 30, 90] as const).map((d) => (
            <button
              key={d}
              className={`tpl-chip ${windowDays === d ? "active" : ""}`}
              onClick={() => setWindowDays(d)}
            >
              {d}d
            </button>
          ))}
        </div>
        <div className="meter-grid">
          {METERED_KINDS.map((k) => (
            <MeterCard
              key={k.key}
              kind={k.key}
              label={k.label}
              row={limits.find((l) => l.key === k.key)}
              trend={trends[k.key] ?? []}
            />
          ))}
        </div>
      </section>
    </div>
  );
}

function MeterCard({
  label,
  row,
  trend,
  kind,
}: {
  label: string;
  row: LimitsRow | undefined;
  trend: UsageTrendRow[];
  kind: string;
}): React.ReactElement {
  const used = row?.used ?? 0;
  const limit = row?.limit ?? null;
  const remaining = row?.remaining ?? null;
  // The trend chart is a 60×40 SVG sparkline — small enough to be a sidebar
  // tile, large enough to show direction without dragging in a chart library.
  const path = buildSparkPath(
    trend.map((r) => ({ value: r.count, label: r.day })),
    60,
    24,
  );
  return (
    <div className="meter-card" aria-label={`${label} usage`}>
      <div className="meter-card-head">
        <span className="meter-card-label">{label}</span>
        <span className="mono small">{kind}</span>
      </div>
      <div className="meter-card-value">
        <strong>{formatNumber(used)}</strong>
        {limit !== null && !row?.unlimited && (
          <span className="meter-card-limit"> / {formatNumber(limit)}</span>
        )}
        {row?.unlimited === true && <span className="meter-card-limit"> unlimited</span>}
      </div>
      {remaining !== null && (
        <div className={`meter-card-remaining ${remaining === 0 ? "exhausted" : ""}`}>
          {remaining === 0 ? "Limit reached" : `${formatNumber(remaining)} left`}
        </div>
      )}
      <svg
        className="meter-spark"
        viewBox="0 0 60 24"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <path d={path} fill="none" stroke="currentColor" strokeWidth="1.5" />
      </svg>
    </div>
  );
}

/**
 * Render a sparkline path. The input is a value-bearing series; output is
 * an SVG path that fits the given width/height. Empty input → empty string,
 * which falls through to no path rendered (better than a lone dot).
 */
function buildSparkPath(
  series: Array<{ value: number; label: string }>,
  w: number,
  h: number,
): string {
  if (series.length === 0) return "";
  const max = Math.max(1, ...series.map((p) => p.value));
  const stepX = series.length > 1 ? w / (series.length - 1) : w;
  let d = "";
  series.forEach((p, i) => {
    const x = i * stepX;
    const y = h - (p.value / max) * h;
    d += `${i === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)} `;
  });
  return d.trim();
}

function formatNumber(n: number | null): string {
  if (n === null) return "—";
  if (n < 1000) return n.toString();
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}
