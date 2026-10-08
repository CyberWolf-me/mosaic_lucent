import { useEffect, useState } from "react";
import { fetchAnalyticsBilling, fetchAnalyticsTrend, type UsageTrendRow } from "../analytics.js";
import { Ico } from "../ui/icons.js";
import { requestSettings } from "../ui/Chrome.js";
import { Button, Card, FilterChips, Page, PageHeader, SectionLabel } from "../ui/kit.js";
import { fetchOrgs, preferredOrg } from "../billing.js";
import { isPostHogEnabled } from "../analytics/posthog.js";

/**
 * Analytics dashboard (M7).
 *
 * Owner-visible meters for the active org: same numbers the paywall reads
 * (the "limit / used / remaining" row from `GET /api/orgs/:id/billing`) plus
 * a daily trend per metered kind (AI generations, voice minutes, asset
 * bytes, images). The trend is read from `/api/analytics/:orgId/trend`;
 * deployments without a usage store answer with no rows, which renders as
 * "no activity" rather than an error.
 *
 * Not a separate product surface — it lives behind Admin. Owner-only by
 * route, gate mirrored to the route that returns the trend.
 */

/**
 * Two vocabularies meet here (server `entitlements.ts` METERED_KEYS): the
 * billing row is keyed by the LIMIT we sell (`ai.generationsPerMonth`), the
 * trend by the USAGE kind we record (`ai.generation`). Asking the trend route
 * for the limit key matched no rollup, so those two charts were always empty.
 */
const METERED_KINDS = [
  { key: "ai.generationsPerMonth", usage: "ai.generation", label: "AI generations", unit: "count" },
  { key: "voice.minutes", usage: "voice.minute", label: "Voice minutes", unit: "count" },
  { key: "storage.bytes", usage: "storage.bytes", label: "Storage", unit: "bytes" },
  { key: "image.generation", usage: "image.generation", label: "Images generated", unit: "count" },
] as const;

type Unit = (typeof METERED_KINDS)[number]["unit"];

interface LimitsRow {
  key: string;
  label: string;
  limit: number | null;
  used: number | null;
  unlimited: boolean;
  remaining: number | null;
}

type WindowId = "7" | "30" | "90";

export function AnalyticsView({ onBack }: { onBack: () => void }) {
  const [orgId, setOrgId] = useState<string | null>(null);
  const [orgName, setOrgName] = useState<string | null>(null);
  const [isOwner, setIsOwner] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [limits, setLimits] = useState<LimitsRow[] | null>(null);
  const [trends, setTrends] = useState<Record<string, UsageTrendRow[]> | null>(null);
  const [windowDays, setWindowDays] = useState(30);
  const isPostHogActive = isPostHogEnabled();

  useEffect(() => {
    let cancelled = false;
    setTrends(null);
    void (async () => {
      try {
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
        setOrgName(org.name);
        setIsOwner(org.role === "owner");
        // Use /api/orgs/:id/billing because every owner-visible surface already
        // exists there, so these meters can never disagree with the paywall.
        const billing = await fetchAnalyticsBilling(org.id);
        if (cancelled) return;
        if (billing === null) {
          setError("Couldn't load this workspace's usage meters.");
          setLimits([]);
        } else {
          setError(null);
          setLimits(
            billing.limits.map((m) => ({
              key: m.key,
              label: m.key,
              limit: m.limit,
              used: m.used,
              unlimited: m.unlimited,
              remaining: m.limit === null || m.used === null ? null : Math.max(0, m.limit - m.used),
            })),
          );
        }
        // Pull a trend per metered kind. Failures here render an empty chart
        // rather than the whole dashboard erroring — the meters are the
        // important part and trend data is a separate purchase.
        const next: Record<string, UsageTrendRow[]> = {};
        for (const k of METERED_KINDS) {
          const t = await fetchAnalyticsTrend(org.id, k.usage, windowDays).catch(() => []);
          if (cancelled) return;
          next[k.key] = t;
        }
        if (!cancelled) setTrends(next);
      } catch {
        if (!cancelled) {
          setError("Can't reach the Lucent server.");
          setLimits((l) => l ?? []);
          setTrends((t) => t ?? {});
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [windowDays]);

  const loading = limits === null && error === null;

  return (
    <Page
      crumbs={[{ label: "Analytics", current: true }]}
      boardScoped={false}
      onOpenSettings={requestSettings}
      width="default"
    >
      <PageHeader
        eyebrow={
          <span title={orgId ?? undefined}>{orgName ? `Analytics · ${orgName}` : "Analytics"}</span>
        }
        title={
          <>
            What this workspace <em>used</em>
          </>
        }
        lede="This billing period, from the same meters your plan limits read — with the daily record underneath."
        actions={
          <>
            <Button variant="ghost" onClick={onBack}>
              <Ico.Left /> Back to canvas
            </Button>
            <Button variant="ghost" onClick={() => requestSettings("billing")}>
              <Ico.Book /> Plan &amp; usage
            </Button>
            {isPostHogActive && isOwner && (
              <Button
                variant="ghost"
                onClick={() =>
                  window.open(
                    "https://us.posthog.com/project/events",
                    "_blank",
                    "noopener,noreferrer",
                  )
                }
                title="PostHog event stream (workspace owners only)"
              >
                <Ico.Gauge /> PostHog Console ↗
              </Button>
            )}
          </>
        }
      />
      {error !== null && (
        <div className="boards-admin-error" role="alert">
          {error}
        </div>
      )}

      <div className="boards-usage-toolbar">
        <SectionLabel>Meters</SectionLabel>
        <div className="boards-usage-window">
          <span className="mono-caps">Daily window</span>
          <FilterChips
            items={(["7", "30", "90"] as const).map((d) => ({ id: d, label: `${d}d` }))}
            value={String(windowDays) as WindowId}
            onChange={(id) => setWindowDays(Number(id))}
            label="Trend window"
          />
        </div>
      </div>
      <div className="boards-usage-grid" aria-busy={loading}>
        {METERED_KINDS.map((k) => (
          <MeterCard
            key={k.key}
            kind={k.key}
            label={k.label}
            unit={k.unit}
            loading={loading}
            row={limits?.find((l) => l.key === k.key)}
            trend={trends ? (trends[k.key] ?? []) : null}
            windowDays={windowDays}
            isOwner={isOwner}
          />
        ))}
      </div>
    </Page>
  );
}

function MeterCard({
  label,
  row,
  trend,
  kind,
  unit,
  loading,
  windowDays,
  isOwner,
}: {
  label: string;
  row: LimitsRow | undefined;
  /** Null while the trend is loading. */
  trend: UsageTrendRow[] | null;
  kind: string;
  unit: Unit;
  loading: boolean;
  windowDays: number;
  isOwner: boolean;
}): React.ReactElement {
  const fmt = (n: number | null) => (unit === "bytes" ? formatBytes(n) : formatNumber(n));
  const series = trend ? dailySeries(trend, windowDays) : [];
  const windowTotal = series.reduce((s, p) => s + p.count, 0);
  const limit = row?.limit ?? null;
  const remaining = row?.remaining ?? null;
  const share =
    row && limit !== null && limit > 0 && row.used !== null && !row.unlimited
      ? Math.min(1, row.used / limit)
      : null;
  const tone = remaining === 0 ? "spent" : share !== null && share >= 0.8 ? "warn" : "";

  return (
    <Card className="boards-meter" role="group" aria-label={`${label} usage`}>
      <div className="boards-meter-head mono-caps" title={`Meter: ${kind}`}>
        {label}
      </div>
      <div className="boards-meter-value">
        {loading ? (
          <span className="boards-meter-big">—</span>
        ) : row ? (
          <>
            <span className="boards-meter-big">{fmt(row.used)}</span>
            {row.unlimited ? (
              <span className="boards-meter-limit">unlimited</span>
            ) : limit !== null ? (
              <span className="boards-meter-limit">/ {fmt(limit)}</span>
            ) : null}
          </>
        ) : trend !== null && isOwner ? (
          <>
            <span className="boards-meter-big">{fmt(windowTotal)}</span>
            <span className="boards-meter-limit">in {windowDays} days · no plan limit</span>
          </>
        ) : (
          <span className="boards-meter-big">—</span>
        )}
      </div>
      {share !== null && (
        <div
          className={`boards-meter-bar ${tone}`}
          role="meter"
          aria-label={`${label} used this period`}
          aria-valuemin={0}
          aria-valuemax={limit ?? 0}
          aria-valuenow={row?.used ?? 0}
        >
          <span style={{ width: `${Math.round(share * 100)}%` }} />
        </div>
      )}
      {remaining !== null && (
        <div className={`boards-meter-remaining ${tone}`}>
          {remaining === 0 ? "Limit reached" : `${fmt(remaining)} left this period`}
        </div>
      )}
      <div className="boards-meter-trend">
        {!isOwner ? (
          <span className="boards-meter-note">Daily history is visible to workspace owners.</span>
        ) : trend === null ? (
          <span className="boards-meter-note">Loading the last {windowDays} days…</span>
        ) : windowTotal === 0 ? (
          <span className="boards-meter-note">No activity in the last {windowDays} days.</span>
        ) : (
          <>
            <Sparkline series={series} />
            <span className="boards-meter-note">
              {fmt(windowTotal)} in the last {windowDays} days
            </span>
          </>
        )}
      </div>
    </Card>
  );
}

/**
 * The window as one point per UTC day (the rollup table's day key), with the
 * days that recorded nothing filled in as zero. Connecting only the days that
 * had rows drew a line straight across quiet weeks, which read as activity.
 */
function dailySeries(rows: UsageTrendRow[], days: number): { day: string; count: number }[] {
  const byDay = new Map<string, number>();
  for (const r of rows) byDay.set(r.day, (byDay.get(r.day) ?? 0) + r.count);
  const out: { day: string; count: number }[] = [];
  const today = Date.now();
  for (let i = days - 1; i >= 0; i -= 1) {
    const day = new Date(today - i * 86_400_000).toISOString().slice(0, 10);
    out.push({ day, count: byDay.get(day) ?? 0 });
  }
  return out;
}

function Sparkline({ series }: { series: { day: string; count: number }[] }) {
  const w = 100;
  const h = 28;
  const max = Math.max(1, ...series.map((p) => p.count));
  const stepX = series.length > 1 ? w / (series.length - 1) : w;
  const pts = series.map((p, i) => [i * stepX, h - (p.count / max) * (h - 2) - 1] as const);
  const line = pts
    .map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`)
    .join(" ");
  const area = `${line} L${w},${h} L0,${h} Z`;
  return (
    <svg
      className="boards-spark"
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <path className="boards-spark-area" d={area} />
      <path className="boards-spark-line" d={line} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function formatNumber(n: number | null): string {
  if (n === null) return "—";
  if (n < 1000) return n.toString();
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function formatBytes(n: number | null): string {
  if (n === null) return "—";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u += 1;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1).replace(/\.0$/, "")} ${units[u]}`;
}
