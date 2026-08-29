import { describe, it, expect, vi, afterEach } from "vitest";
import {
  exportFormatChips,
  fetchBilling,
  fetchOrgs,
  formatBytes,
  formatCount,
  formatDay,
  formatMonth,
  limitNote,
  limitTitle,
  meterFor,
  parseBilling,
  planState,
  preferredOrg,
  resetLabel,
} from "../src/billing.js";
import type { BillingPlan, LimitRow } from "../src/billing.js";

/**
 * The billing pane's arithmetic, tested without a DOM (vitest runs in node here).
 *
 * The cases that matter are the three the wire format makes easy to get wrong:
 * `limit: null` must read as unlimited and never as a spent ceiling, `used: null`
 * must read as uncounted and never as zero, and a lapsed subscription must not be
 * sold an upgrade it already bought. Everything else is formatting.
 */
const store: Record<string, string> = {};
Object.defineProperty(globalThis, "localStorage", {
  value: {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => {
      store[k] = v;
    },
    removeItem: (k: string) => {
      delete store[k];
    },
  },
  configurable: true,
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete store["lucent.token"];
});

function signedIn() {
  store["lucent.token"] = "tok123";
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stubFetch(status: number, body: unknown) {
  const mock = vi.fn((_url: string, _init?: RequestInit) =>
    Promise.resolve(jsonResponse(status, body)),
  );
  vi.stubGlobal("fetch", mock);
  return mock;
}

const AUG = Date.UTC(2026, 7, 1);
const SEP = Date.UTC(2026, 8, 1);

/** The Free-tier body, field for field as `GET /api/orgs/:id/billing` sends it. */
const FREE_BODY = {
  orgId: "org_1",
  plan: { code: "free", name: "Free", status: null, seats: 1, fallback: true, periodEnd: null },
  period: { start: AUG, endExclusive: SEP },
  upgradeUrl: "/settings/billing",
  limits: [
    {
      key: "ai.generationsPerMonth",
      label: "AI generations",
      period: "month",
      limit: 50,
      used: 12,
      unlimited: false,
      remaining: 38,
    },
    {
      key: "history.depth",
      label: "versions of history",
      period: "standing",
      limit: 25,
      used: null,
      unlimited: false,
      remaining: null,
    },
  ],
  exportFormats: {
    key: "export.formats",
    label: "export formats",
    allowed: ["png"],
    all: ["png", "svg", "pdf", "json", "mermaid"],
  },
};

function limitRow(over: Partial<LimitRow> = {}): LimitRow {
  return {
    key: "ai.generationsPerMonth",
    label: "AI generations",
    period: "month",
    limit: 50,
    used: 12,
    unlimited: false,
    remaining: 38,
    ...over,
  };
}

function billingPlan(over: Partial<BillingPlan> = {}): BillingPlan {
  return {
    code: "free",
    name: "Free",
    status: null,
    seats: 1,
    fallback: true,
    periodEnd: null,
    ...over,
  };
}

describe("billing fetch", () => {
  it("never calls the server without a session", async () => {
    const mock = vi.fn();
    vi.stubGlobal("fetch", mock);
    expect(await fetchBilling("org_1")).toEqual({ kind: "signedOut" });
    expect(await fetchOrgs()).toEqual({ kind: "signedOut" });
    expect(mock).not.toHaveBeenCalled();
  });

  it("reads a 503 as billing not being configured, not as a Free plan", async () => {
    signedIn();
    stubFetch(503, { error: "billing is not configured" });
    expect(await fetchBilling("org_1")).toEqual({ kind: "unconfigured" });
  });

  it("reads 404 and 403 as the workspace being unavailable", async () => {
    signedIn();
    stubFetch(404, { error: "not found" });
    expect(await fetchBilling("org_1")).toEqual({ kind: "unavailable" });
    stubFetch(403, { error: "forbidden" });
    expect(await fetchBilling("org_1")).toEqual({ kind: "unavailable" });
  });

  it("reads a 401 as being signed out", async () => {
    signedIn();
    stubFetch(401, { error: "unauthorized" });
    expect(await fetchBilling("org_1")).toEqual({ kind: "signedOut" });
  });

  it("blames the server, not the plan, when the request cannot be made", async () => {
    signedIn();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))),
    );
    const result = await fetchBilling("org_1");
    expect(result.kind).toBe("error");
    expect(result.kind === "error" && result.message).toContain("npm run start -w @lucent/server");
  });

  it("names the status on an unexpected failure", async () => {
    signedIn();
    stubFetch(500, { error: "boom" });
    const result = await fetchBilling("org_1");
    expect(result).toEqual({ kind: "error", message: "Couldn't load your plan (500)." });
  });

  it("treats an unreadable 200 as an error rather than inventing a plan", async () => {
    signedIn();
    stubFetch(200, { plan: "Free" });
    const result = await fetchBilling("org_1");
    expect(result.kind).toBe("error");
    expect(result.kind === "error" && result.message).toContain("couldn't read");
  });

  it("encodes the org id into the path", async () => {
    signedIn();
    const mock = stubFetch(200, FREE_BODY);
    await fetchBilling("org 1/2");
    expect(mock.mock.calls[0]?.[0]).toBe("/api/orgs/org%201%2F2/billing");
  });

  it("parses the Free snapshot the server actually sends", async () => {
    signedIn();
    stubFetch(200, FREE_BODY);
    const result = await fetchBilling("org_1");
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.billing.plan).toEqual({
      code: "free",
      name: "Free",
      status: null,
      seats: 1,
      fallback: true,
      periodEnd: null,
    });
    expect(result.billing.upgradeUrl).toBe("/settings/billing");
    expect(result.billing.limits).toHaveLength(2);
    expect(result.billing.limits[1]?.used).toBeNull();
    expect(result.billing.exportFormats.allowed).toEqual(["png"]);
  });

  it("drops a limit row it cannot read instead of guessing its ceiling", () => {
    const parsed = parseBilling({
      ...FREE_BODY,
      limits: [{ ...FREE_BODY.limits[0]!, limit: "50" }, FREE_BODY.limits[1]!],
    });
    expect(parsed?.limits.map((r) => r.key)).toEqual(["history.depth"]);
  });

  it("assumes the paid plan did not apply when the fallback flag is unreadable", () => {
    const parsed = parseBilling({ ...FREE_BODY, plan: { code: "team", name: "Team" } });
    expect(parsed?.plan.fallback).toBe(true);
    expect(parsed?.plan.seats).toBe(1);
  });

  it("ignores a status it does not recognise rather than passing it off as one", () => {
    const parsed = parseBilling({
      ...FREE_BODY,
      plan: { ...FREE_BODY.plan, status: "half_paid" },
    });
    expect(parsed?.plan.status).toBeNull();
  });

  it("keeps a blank upgradeUrl out of the UI, since it links nowhere", () => {
    expect(parseBilling({ ...FREE_BODY, upgradeUrl: "" })?.upgradeUrl).toBeNull();
  });
});

describe("workspace resolution", () => {
  it("reads the org list and skips rows with no id", async () => {
    signedIn();
    stubFetch(200, {
      orgs: [
        { id: "org_1", name: "Personal", role: "owner", isPersonal: true },
        { name: "Broken", role: "viewer" },
        { id: "org_2", name: "Acme", role: "editor", isPersonal: false },
      ],
    });
    const result = await fetchOrgs();
    expect(result.kind).toBe("ok");
    expect(result.kind === "ok" && result.orgs.map((o) => o.id)).toEqual(["org_1", "org_2"]);
  });

  it("reports a signed-out org list and an unreachable one differently", async () => {
    signedIn();
    stubFetch(401, { error: "unauthorized" });
    expect(await fetchOrgs()).toEqual({ kind: "signedOut" });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))),
    );
    const offline = await fetchOrgs();
    expect(offline.kind === "error" && offline.message).toContain("Can't reach the Lucent server");
  });

  it("opens on the personal workspace, or the first one there is", () => {
    const personal = { id: "org_1", name: "Personal", role: "owner", isPersonal: true };
    const acme = { id: "org_2", name: "Acme", role: "editor", isPersonal: false };
    expect(preferredOrg([acme, personal])?.id).toBe("org_1");
    expect(preferredOrg([acme])?.id).toBe("org_2");
    expect(preferredOrg([])).toBeNull();
  });
});

describe("plan state", () => {
  it("describes a live paid plan with its renewal date", () => {
    const state = planState(
      billingPlan({
        code: "team",
        name: "Team",
        status: "active",
        seats: 4,
        fallback: false,
        periodEnd: SEP,
      }),
    );
    expect(state.kind).toBe("paid");
    expect(state.badge).toBe("Active");
    expect(state.detail).toBe("Team with 4 seats. Renews Sep 1, 2026.");
    expect(state.action).toBe("manage");
  });

  it("describes a trial by when it ends", () => {
    const state = planState(
      billingPlan({
        code: "pro",
        name: "Pro",
        status: "trialing",
        fallback: false,
        periodEnd: SEP,
      }),
    );
    expect(state.kind).toBe("trialing");
    expect(state.detail).toContain("The trial ends Sep 1, 2026.");
  });

  it("asks a past-due org to fix the payment, not to buy a bigger plan", () => {
    // past_due is in the server's ENTITLING_STATUSES, so the plan still applies:
    // nothing is missing from it, only the payment.
    const state = planState(
      billingPlan({
        code: "pro",
        name: "Pro",
        status: "past_due",
        fallback: false,
        periodEnd: SEP,
      }),
    );
    expect(state.kind).toBe("payment_failed");
    expect(state.action).toBe("payment");
    expect(state.actionLabel).toBe("Fix payment");
    expect(state.detail).toContain("Your plan still applies");
  });

  it("offers a plan to an org that has never had one", () => {
    const state = planState(billingPlan());
    expect(state.kind).toBe("none");
    expect(state.badge).toBe("Free");
    expect(state.detail).toContain("no subscription");
    expect(state.action).toBe("upgrade");
    expect(state.actionLabel).toBe("See plans");
  });

  it("says something different, and asks for something different, when a plan lapsed", () => {
    // The whole point of `fallback` + `status`: both of these orgs are on Free's
    // limits, and only one of them should be sold a plan.
    const absent = planState(billingPlan());
    const lapsed = planState(billingPlan({ status: "canceled", periodEnd: AUG }));
    expect(lapsed.kind).toBe("lapsed");
    expect(lapsed.badge).toBe("Canceled");
    expect(lapsed.detail).not.toBe(absent.detail);
    expect(lapsed.detail).toContain("Your subscription was canceled.");
    expect(lapsed.detail).toContain("The paid period ended Aug 1, 2026.");
    expect(lapsed.action).toBe("payment");
    expect(lapsed.action).not.toBe(absent.action);
  });

  it("gives each lapsed status its own cause", () => {
    const causes = (["unpaid", "paused", "incomplete", "incomplete_expired"] as const).map(
      (status) => planState(billingPlan({ status })).detail,
    );
    expect(new Set(causes).size).toBe(4);
    expect(causes[1]).toContain("paused");
  });

  it("stays honest when a live subscription's plan cannot be resolved", () => {
    // fallback with an entitling status means the subscription is fine but its
    // plan code is not one this deployment knows.
    const state = planState(billingPlan({ status: "active" }));
    expect(state.kind).toBe("lapsed");
    expect(state.detail).toContain("not being applied");
  });
});

describe("meters", () => {
  it("shows usage against a ceiling with the server's remaining", () => {
    const meter = meterFor(limitRow());
    expect(meter.kind).toBe("counted");
    expect(meter.tone).toBe("ok");
    expect(meter.value).toBe("12 of 50");
    expect(meter.status).toBe("38 left");
    expect(meter.percent).toBe(24);
    expect(meter.now).toBe(12);
    expect(meter.max).toBe(50);
  });

  it("trusts remaining over its own subtraction", () => {
    // The server owns this number. If it says 5 with 45 of 50 spent, 5 is what a
    // customer is told — the client does not re-derive it.
    expect(meterFor(limitRow({ used: 45, remaining: 5 })).status).toBe("5 left");
  });

  it("warns before the ceiling is reached", () => {
    expect(meterFor(limitRow({ used: 40, remaining: 10 })).tone).toBe("warn");
    expect(meterFor(limitRow({ used: 39, remaining: 11 })).tone).toBe("ok");
  });

  it("says a monthly allowance comes back and a standing one does not", () => {
    const monthly = meterFor(limitRow({ used: 50, remaining: 0 }));
    expect(monthly.tone).toBe("spent");
    expect(monthly.status).toBe("Nothing left this month");
    const standing = meterFor(
      limitRow({
        key: "boards",
        label: "boards",
        period: "standing",
        limit: 3,
        used: 3,
        remaining: 0,
      }),
    );
    expect(standing.status).toBe("Limit reached");
  });

  it("renders an unlimited row as unlimited, never as a spent ceiling", () => {
    const meter = meterFor(limitRow({ limit: null, used: 9999, unlimited: true, remaining: null }));
    expect(meter.kind).toBe("unlimited");
    expect(meter.value).toBe("Unlimited");
    expect(meter.status).toBe("9,999 used");
    expect(meter.tone).toBe("ok");
    // No bar at all: there is nothing for a percentage to be a percentage of.
    expect(meter.percent).toBeNull();
    expect(meter.now).toBeNull();
    expect(meter.max).toBeNull();
  });

  it("treats either unlimited signal as unlimited", () => {
    // `limit: null` and `unlimited: true` are the same fact twice, so one mangled
    // field cannot turn "no ceiling" into a ceiling.
    expect(meterFor(limitRow({ limit: null, remaining: null })).value).toBe("Unlimited");
    expect(meterFor(limitRow({ unlimited: true })).value).toBe("Unlimited");
  });

  it("says an unlimited row with no usage figure has no ceiling", () => {
    const meter = meterFor(
      limitRow({
        key: "history.depth",
        label: "versions of history",
        period: "standing",
        limit: null,
        used: null,
        unlimited: true,
        remaining: null,
      }),
    );
    expect(meter.status).toBe("No ceiling on this plan");
  });

  it("reports an uncounted row as its ceiling alone, not as zero used", () => {
    const row = limitRow({
      key: "history.depth",
      label: "versions of history",
      period: "standing",
      limit: 25,
      used: null,
      remaining: null,
    });
    const meter = meterFor(row);
    expect(meter.kind).toBe("uncounted");
    expect(meter.value).toBe("25");
    expect(meter.status).toBe("Not counted for the whole workspace");
    expect(meter.percent).toBeNull();
    expect(limitNote(row)).toContain("per board");
  });

  it("fills the bar for a zero ceiling instead of dividing by it", () => {
    const meter = meterFor(limitRow({ limit: 0, used: 0, remaining: 0 }));
    expect(meter.percent).toBe(100);
    expect(meter.tone).toBe("spent");
    expect(meter.value).toBe("0 of 0");
  });

  it("clamps a row that is already over its ceiling", () => {
    // A downgrade can leave 8 boards under a limit of 3; the row has to say so
    // without a bar wider than its track.
    const meter = meterFor(
      limitRow({
        key: "boards",
        label: "boards",
        period: "standing",
        limit: 3,
        used: 8,
        remaining: 0,
      }),
    );
    expect(meter.percent).toBe(100);
    expect(meter.value).toBe("8 of 3");
    expect(meter.status).toBe("Limit reached");
  });

  it("claims nothing about headroom it was not sent", () => {
    const meter = meterFor(limitRow({ remaining: null }));
    expect(meter.status).toBe("12 used");
  });

  it("formats a byte row as bytes and a tally as a tally", () => {
    const storage = meterFor(
      limitRow({
        key: "storage.bytes",
        label: "bytes of storage",
        period: "standing",
        limit: 100 * 1024 * 1024,
        used: 52 * 1024 * 1024,
        remaining: 48 * 1024 * 1024,
      }),
    );
    expect(storage.value).toBe("52 MB of 100 MB");
    expect(storage.status).toBe("48 MB left");
    expect(meterFor(limitRow({ limit: 6000, used: 1200, remaining: 4800 })).value).toBe(
      "1,200 of 6,000",
    );
  });
});

describe("formatting", () => {
  it("formats bytes with the same divisor the plans are written in", () => {
    // The Free tier is documented as 100 MB and stored as 100 * MiB; dividing by
    // 1000 would print "104.9 MB" for the plan's own number.
    expect(formatBytes(100 * 1024 * 1024)).toBe("100 MB");
    expect(formatBytes(0)).toBe("0 bytes");
    expect(formatBytes(999)).toBe("999 bytes");
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(5 * 1024 * 1024 * 1024)).toBe("5 GB");
    expect(formatBytes(Number.NaN)).toBe("—");
  });

  it("groups large counts", () => {
    expect(formatCount(6000)).toBe("6,000");
    expect(formatCount(0)).toBe("0");
    expect(formatCount(Number.POSITIVE_INFINITY)).toBe("—");
  });

  it("formats dates in UTC, because that is when the allowances reset", () => {
    // 23:30 UTC on Aug 31 is already September in Auckland; the reset is UTC, so
    // the pane says Aug 31 to everyone.
    expect(formatDay(Date.UTC(2026, 7, 31, 23, 30))).toBe("Aug 31, 2026");
    expect(formatDay(SEP)).toBe("Sep 1, 2026");
    expect(formatDay(null)).toBeNull();
    expect(formatDay(Number.NaN)).toBeNull();
    expect(formatMonth(AUG)).toBe("August 2026");
  });

  it("shows a reset date only where the row resets", () => {
    const period = { start: AUG, endExclusive: SEP };
    expect(resetLabel(limitRow(), period)).toBe("Resets Sep 1, 2026");
    expect(resetLabel(limitRow({ period: "standing" }), period)).toBeNull();
    expect(resetLabel(limitRow({ period: null }), period)).toBeNull();
  });

  it("titles rows readably and falls back to the server's own label", () => {
    expect(limitTitle(limitRow({ key: "storage.bytes", label: "bytes of storage" }))).toBe(
      "Storage",
    );
    expect(limitTitle(limitRow({ key: "history.depth", label: "versions of history" }))).toBe(
      "Version history",
    );
    expect(limitTitle(limitRow({ key: "voice.minutes", label: "voice minutes" }))).toBe(
      "Voice minutes",
    );
    expect(limitTitle(limitRow({ key: "future.thing", label: "widgets" }))).toBe("Widgets");
  });

  it("explains a missing usage figure only where one is missing", () => {
    expect(limitNote(limitRow({ used: null }))).toBeNull();
    expect(limitNote(limitRow({ key: "history.depth", used: null }))).not.toBeNull();
    expect(limitNote(limitRow({ key: "history.depth", used: 4 }))).toBeNull();
  });

  it("lists every format and flags the ones this plan cannot produce", () => {
    const chips = exportFormatChips({
      key: "export.formats",
      label: "export formats",
      allowed: ["png"],
      all: ["png", "svg", "pdf", "json", "mermaid"],
    });
    expect(chips.map((c) => c.label)).toEqual(["PNG", "SVG", "PDF", "JSON", "Mermaid"]);
    expect(chips.filter((c) => c.allowed).map((c) => c.format)).toEqual(["png"]);
  });

  it("still lists a format the plan allows that this build has not heard of", () => {
    const chips = exportFormatChips({
      key: "export.formats",
      label: "export formats",
      allowed: ["png", "dxf"],
      all: ["png"],
    });
    expect(chips.map((c) => c.format)).toEqual(["png", "dxf"]);
    expect(chips.every((c) => c.allowed)).toBe(true);
  });
});
