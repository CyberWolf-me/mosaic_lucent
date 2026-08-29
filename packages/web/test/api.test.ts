import { describe, it, expect, vi, afterEach } from "vitest";
import { createWorkspace } from "@lucent/core";
import { PlanRefusalError, generate, planRefusal, type PlanRefusal } from "../src/api.js";

/**
 * The user-facing failure message must name the layer that actually broke.
 * Reporting a stopped backend as "the AI service is unavailable" sent us
 * looking at the wrong thing, so these cases are pinned.
 */

const ws = createWorkspace();

function jsonResponse(status: number, body: unknown): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("generate error messages", () => {
  it("names the Lucent server when the fetch itself fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    await expect(generate("hi", ws)).rejects.toThrow(/reach the Lucent server/i);
  });

  it("names the Lucent server when the dev proxy reports it unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse(503, { error: "lucent server unreachable", detail: "ECONNREFUSED" }),
        ),
    );
    await expect(generate("hi", ws)).rejects.toThrow(/reach the Lucent server/i);
  });

  it("blames the AI provider on a 502 from our own server", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse(502, { error: "provider failed", detail: "Provider request failed (403)" }),
        ),
    );
    await expect(generate("hi", ws)).rejects.toThrow(/AI provider/i);
  });

  it("explains a 422 validation rejection as a rephrasing hint", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(422, { error: "operations failed validation" })),
    );
    await expect(generate("hi", ws)).rejects.toThrow(/rephrasing/i);
  });

  it("reports a timeout distinctly from an unreachable server", async () => {
    const abortErr = Object.assign(new Error("aborted"), { name: "AbortError" });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(abortErr));
    await expect(generate("hi", ws)).rejects.toThrow(/timed out/i);
  });

  it("returns operations on success", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse(200, { operations: [], explanation: "ok", provider: "mock" }),
        ),
    );
    await expect(generate("hi", ws)).resolves.toMatchObject({ explanation: "ok" });
  });
});

/* --------------------------- plan refusals (402) -------------------------- */

/**
 * The 402 body belongs to the server (`packages/server/src/entitlements.ts`
 * writes the sentence, the tier and the reset time), so these pin two things:
 * that we render that sentence rather than re-derive one that would go stale,
 * and that the fields a caller needs for an upgrade link survive the parse.
 */
const REFUSAL = {
  error: "Your Free plan includes 50 AI generations per month. Upgrade to Pro to continue.",
  reason: "plan_limit",
  key: "ai.generationsPerMonth",
  plan: "free",
  planName: "Free",
  limit: 50,
  used: 50,
  upgradeUrl: "/settings/billing",
  suggestedPlan: "pro",
  resetsAt: 1_760_000_000_000,
};

/**
 * What the parse must yield: the wire body minus `error`, which becomes the
 * message. Typed as `PlanRefusal` so a drift between the client's shape and the
 * server's `RefusalBody` fails to compile here rather than at a customer.
 */
const REFUSAL_FIELDS: PlanRefusal = {
  reason: "plan_limit",
  key: "ai.generationsPerMonth",
  plan: "free",
  planName: "Free",
  limit: 50,
  used: 50,
  upgradeUrl: "/settings/billing",
  suggestedPlan: "pro",
  resetsAt: 1_760_000_000_000,
};

async function failureFrom(res: Response): Promise<unknown> {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(res));
  try {
    await generate("hi", ws);
  } catch (err) {
    return err;
  }
  throw new Error("expected generate to reject");
}

describe("a 402 plan refusal", () => {
  it("renders the server's sentence verbatim", async () => {
    const err = await failureFrom(jsonResponse(402, REFUSAL));
    expect((err as Error).message).toBe(REFUSAL.error);
  });

  it("carries the fields a caller needs to offer the upgrade", async () => {
    const err = await failureFrom(jsonResponse(402, REFUSAL));
    expect(err).toBeInstanceOf(PlanRefusalError);
    expect(planRefusal(err)).toEqual(REFUSAL_FIELDS);
  });

  it("stays recognisable when the body is not the server's", async () => {
    // A proxy's error page must not be rendered as a plan message, but the
    // status alone is enough to know that billing, not permission, is the block.
    const err = await failureFrom(jsonResponse(402, "<html>402 Payment Required</html>"));
    expect(err).toBeInstanceOf(PlanRefusalError);
    expect((err as Error).message).toMatch(/Review your plan/);
    expect(planRefusal(err)?.upgradeUrl).toBeNull();
  });

  it("keeps a feature refusal apart from a used-up limit", async () => {
    const err = await failureFrom(
      jsonResponse(402, {
        ...REFUSAL,
        reason: "plan_feature",
        key: "export.formats",
        limit: null,
        used: null,
        resetsAt: null,
      }),
    );
    expect(planRefusal(err)?.reason).toBe("plan_feature");
    expect(planRefusal(err)?.resetsAt).toBeNull();
  });

  it("does not label other failures as plan refusals", async () => {
    const err = await failureFrom(jsonResponse(429, { error: "rate limited" }));
    expect(planRefusal(err)).toBeNull();
    expect((err as Error).message).toMatch(/Too many requests/);
  });
});
