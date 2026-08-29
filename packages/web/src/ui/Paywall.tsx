import { useEffect, useState } from "react";
import { Ico } from "./icons.js";
import { clearPlanRefusal, planStatus, subscribeToPlanStatus } from "../api.js";
import type { Allowance, PlanRefusal, PlanStatus } from "../api.js";
import { formatAmount, formatDay } from "../billing.js";

/**
 * The plan ceiling as the product surfaces it (M4): the wall, and the warning
 * that comes before it.
 *
 * Two components because they answer two different questions in two different
 * amounts of space. `Paywall` is the card for a refusal that has already
 * happened, shown where there is room to explain it -- the dashboard, the billing
 * pane. `AllowanceNote` is the one-line strip the composer carries, so somebody
 * mid-flow learns they are nearly out before the next request is the one that
 * fails.
 *
 * Every number and every sentence here comes from the server. The refusal's own
 * wording is printed verbatim: it already names the plan, the ceiling, whether it
 * resets and which tier to buy, and a second copy of that sentence written in the
 * client would fork the pricing copy and go stale the first time a tier changes.
 * This file decides layout, and derives only what layout needs.
 */

/** Subscribe to the live plan status. Same pub/sub shape as `useSettings`. */
export function usePlanStatus(): PlanStatus {
  const [status, setStatus] = useState<PlanStatus>(planStatus);
  useEffect(() => subscribeToPlanStatus(setStatus), []);
  return status;
}

/**
 * What each entitlement is called in a heading. The server sends a key, not a
 * label, on a refusal -- the label it does send is built into the sentence -- so
 * the nouns are repeated here. An unknown key falls back to no noun at all rather
 * than to a guess, because the heading sits directly above the server's sentence
 * and a wrong noun there contradicts it.
 */
const NOUNS: Record<string, string> = {
  "ai.generationsPerMonth": "AI generations",
  "voice.minutes": "voice minutes",
  boards: "boards",
  seats: "seats",
  "storage.bytes": "storage",
  "history.depth": "version history",
  "export.formats": "export formats",
};

/**
 * The heading above the refusal. Three cases, because a customer acts on each of
 * them differently: an allowance that comes back, a ceiling that does not, and a
 * capability the tier never had.
 */
export function refusalHeadline(refusal: PlanRefusal): string {
  const noun = refusal.key !== null ? NOUNS[refusal.key] : undefined;
  if (refusal.reason === "plan_feature") {
    return noun !== undefined ? `${noun} aren't on this plan` : "Not included in this plan";
  }
  if (noun === undefined) return "You've reached a limit on this plan";
  return refusal.resetsAt !== null
    ? `You've used this month's ${noun}`
    : `You've reached your ${noun} limit`;
}

/** "50 of 50 used", or null for a feature refusal, which has no figures. */
export function refusalFigures(refusal: PlanRefusal): string | null {
  if (refusal.limit === null || refusal.used === null) return null;
  const key = refusal.key ?? "";
  return `${formatAmount(key, refusal.used)} of ${formatAmount(key, refusal.limit)} used`;
}

/** "Resets Sep 1, 2026" -- `billing.ts`'s wording, for the same fact. */
export function resetsLine(resetsAt: number | null): string | null {
  const day = formatDay(resetsAt);
  return day !== null ? `Resets ${day}` : null;
}

/**
 * The upgrade tier, named as the plan codes are elsewhere in the UI. Only the
 * four built-in codes are titled; a contract code is shown as sent, because a
 * customer on a bespoke plan recognises their own code better than a guess at
 * how to capitalise it.
 */
const PLAN_NAMES: Record<string, string> = {
  free: "Free",
  pro: "Pro",
  team: "Team",
  enterprise: "Enterprise",
};

export function planLabel(code: string): string {
  return PLAN_NAMES[code] ?? code;
}

/**
 * How much is left, in the meter's own vocabulary (`billing.ts`): "38 left this
 * month", "No AI generations left this month". Null when the response reported no
 * headroom to describe, so a caller shows nothing rather than a blank.
 */
export function allowanceLine(allowance: Allowance): string | null {
  if (allowance.remaining === null) return null;
  const noun = allowance.key !== null ? NOUNS[allowance.key] : undefined;
  const of = noun !== undefined ? ` ${noun}` : "";
  if (allowance.remaining === 0) return `No${of} left this month.`;
  return `${formatAmount(allowance.key ?? "", allowance.remaining)}${of} left this month.`;
}

/**
 * The wall. Built from a refusal and nothing else, so any surface holding one can
 * show it and a test can render it from a real 402 body.
 */
export function Paywall({
  refusal,
  message,
  onDismiss,
}: {
  refusal: PlanRefusal;
  /** The server's sentence, printed verbatim. */
  message: string;
  onDismiss?: () => void;
}) {
  const figures = refusalFigures(refusal);
  const resets = resetsLine(refusal.resetsAt);
  const suggested = refusal.suggestedPlan;
  return (
    <div className="paywall" role="alert">
      <div className="paywall-icon">
        <Ico.Lock />
      </div>
      <div className="paywall-body">
        <div className="paywall-head">
          <span className="paywall-title">{refusalHeadline(refusal)}</span>
          {refusal.planName !== null && <span className="billing-badge">{refusal.planName}</span>}
        </div>
        <p className="paywall-message">{message}</p>
        {(figures !== null || resets !== null) && (
          <div className="paywall-figures mono">
            {figures !== null && <span>{figures}</span>}
            {figures !== null && resets !== null && <span aria-hidden="true">·</span>}
            {resets !== null && <span>{resets}</span>}
          </div>
        )}
        <div className="paywall-actions">
          {/* The server's own url and nothing else, exactly as the billing pane
              does it: there is no checkout in this build, and a link to a route
              this deployment does not host is worse than no link. With no url the
              sentence above still says what to do -- upgrade, or talk to us. */}
          {refusal.upgradeUrl !== null && (
            <a className="btn amber" href={refusal.upgradeUrl}>
              {suggested !== null ? `Upgrade to ${planLabel(suggested)}` : "Review your plan"}
            </a>
          )}
          {onDismiss !== undefined && (
            <button className="btn ghost" onClick={onDismiss}>
              Not now
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * The wall for the live refusal, or nothing when none is standing. Dismissible,
 * because a customer who has read it still has work to do on the free tier.
 */
export function LivePaywall() {
  const { refusal } = usePlanStatus();
  if (refusal === null) return null;
  return (
    <Paywall refusal={refusal.refusal} message={refusal.message} onDismiss={clearPlanRefusal} />
  );
}

/**
 * The one-line strip. Shown next to the composer and on the dashboard, so the
 * warning reaches somebody mid-flow rather than waiting in Preferences.
 *
 * A standing refusal outranks a warning: once the wall is up, "38 left" is no
 * longer true. Renders nothing at all in the ordinary case, which is most of the
 * month. `status` is injectable for tests; production reads the live store.
 */
export function AllowanceNote({ status }: { status?: PlanStatus }) {
  const live = usePlanStatus();
  const { allowance, refusal } = status ?? live;
  if (refusal !== null) {
    return (
      <div className="allowance-note spent" role="status">
        <Ico.Lock />
        <span className="allowance-note-text">{refusal.message}</span>
        {refusal.refusal.upgradeUrl !== null && (
          <a className="allowance-note-link" href={refusal.refusal.upgradeUrl}>
            Upgrade
          </a>
        )}
      </div>
    );
  }
  const line = allowance !== null && allowance.warn ? allowanceLine(allowance) : null;
  if (allowance === null || line === null) return null;
  const resets = resetsLine(allowance.resetsAt);
  return (
    <div className="allowance-note" role="status">
      <Ico.Sparkle />
      <span className="allowance-note-text">{line}</span>
      {resets !== null && <span className="allowance-note-reset">{resets}</span>}
    </div>
  );
}
