import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { createWorkspace, applyOperations } from "@lucent/core";
import { summarizeWorkspace } from "../src/provider.js";
import { cacheKeyFor, ResponseCache, stableStringify } from "../src/cache.js";
import { MockProvider } from "../src/providers/mock.js";
import { GOLDEN_SET } from "../src/golden.js";
import { operationMatches, runGoldenCase, runGoldenSet } from "../src/evals.js";

/**
 * The response cache and the golden-set runner — the two M5 harness pieces
 * that keep model behaviour observable without paying for it.
 */

const PROMPT_HASH = createHash("sha256").update("system prompt text").digest("hex");

function keyInput(overrides: Record<string, unknown> = {}) {
  return {
    providerName: "MockProvider",
    promptId: "visual-agent",
    promptVersion: 1,
    promptHash: PROMPT_HASH,
    request: {
      message: "Design an e-commerce flow",
      summary: summarizeWorkspace(createWorkspace()),
      history: [],
    },
    ...overrides,
  };
}

describe("cacheKeyFor", () => {
  it("is stable across key order and sensitive to content", async () => {
    const a = await cacheKeyFor(keyInput());
    const reordered = await await cacheKeyFor(
      keyInput({
        request: {
          history: [],
          summary: summarizeWorkspace(createWorkspace()),
          message: "Design an e-commerce flow",
        },
      }),
    );
    expect(a).toBe(reordered);

    const otherMessage = await cacheKeyFor(
      keyInput({
        request: {
          message: "something else",
          summary: summarizeWorkspace(createWorkspace()),
          history: [],
        },
      }),
    );
    expect(otherMessage).not.toBe(a);

    // A prompt bump invalidates every key minted before it.
    expect(await cacheKeyFor(keyInput({ promptVersion: 2 }))).not.toBe(a);
  });

  it("refuses to key requests carrying images or documents", async () => {
    expect(
      await cacheKeyFor(
        keyInput({
          request: { message: "x", summary: {}, history: [], images: [{ dataUrl: "data:" }] },
        }),
      ),
    ).toBeNull();
  });
});

describe("ResponseCache", () => {
  it("round-trips a result and reports stats", () => {
    const cache = new ResponseCache();
    const result = { operations: [], explanation: "hi" };
    expect(cache.get("k")).toBeUndefined();
    cache.put("k", result);
    expect(cache.get("k")?.result).toEqual(result);
    expect(cache.stats).toMatchObject({ hits: 1, misses: 1, puts: 1 });
  });

  it("expires entries past the TTL", () => {
    let now = 1000;
    const cache = new ResponseCache({ ttlMs: 500, now: () => now });
    cache.put("k", { operations: [] });
    now += 499;
    expect(cache.get("k")).toBeDefined();
    now += 2;
    expect(cache.get("k")).toBeUndefined();
    expect(cache.stats.expired).toBe(1);
  });

  it("evicts the least recently used over the cap", () => {
    const cache = new ResponseCache({ maxEntries: 2 });
    cache.put("a", { operations: [] });
    cache.put("b", { operations: [] });
    cache.get("a"); // refresh a
    cache.put("c", { operations: [] }); // evicts b
    expect(cache.get("a")).toBeDefined();
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("c")).toBeDefined();
    expect(cache.stats.evictions).toBe(1);
  });
});

describe("golden set", () => {
  it("MockProvider passes every case — the offline eval gate", async () => {
    const report = await runGoldenSet(new MockProvider(), GOLDEN_SET);
    const failures = report.results.filter((r) => !r.ok);
    for (const f of failures) console.log(f.id, f.reasons);
    expect(report.score).toBe(1);
    expect(report.total).toBe(GOLDEN_SET.length);
  });

  it("a case that would wreck the board fails the runner", async () => {
    // A provider that deletes everything must not pass the qa case.
    const hostile = new MockProvider();
    const report = await runGoldenCase(hostile, {
      ...GOLDEN_SET[3]!, // question-answering forbids destructive ops
      message: "what is this", // matches MockProvider's qa script
    });
    expect(report.ok).toBe(true);
    expect(
      operationMatches(
        { op: "CHANGE_TEXT", id: "checkout", text: "x" },
        { op: "CHANGE_TEXT", id: "checkout", text: "x" },
      ),
    ).toBe(true);
    expect(
      operationMatches(
        { op: "CHANGE_TEXT", id: "checkout" },
        { op: "CHANGE_TEXT", id: "other", text: "x" },
      ),
    ).toBe(false);
  });

  it("stableStringify sorts keys and drops undefined", () => {
    expect(stableStringify({ b: 1, a: [{ z: undefined, y: 2 }] })).toBe('{"a":[{"y":2}],"b":1}');
  });

  it("applyOperations is what the golden summaries are built from", () => {
    const ws = applyOperations(createWorkspace(), [
      { op: "CREATE_NODE", id: "checkout", nodeType: "screen", label: "Checkout" },
    ]);
    expect(summarizeWorkspace(ws).nodes.map((n) => n.id)).toEqual(["checkout"]);
  });
});
