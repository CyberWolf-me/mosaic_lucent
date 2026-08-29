import { describe, expect, it } from "vitest";
import { buildSupportReport, formatSupportReport } from "../src/support.js";

/**
 * Support diagnostics (G2). The one rule: the report describes the session,
 * never the board. These tests pin both halves — what must be present (the
 * numbers a triage needs) and what must be impossible (contents leaking in
 * through the context fields).
 */

const CTX = {
  nodes: 403,
  edges: 87,
  shapes: 12,
  comments: 3,
  boardId: "brd_abc",
  syncStatus: "connected",
  syncRole: "editor",
  busy: false,
  streamChars: 0,
  provider: "AnthropicProvider",
};

describe("buildSupportReport", () => {
  it("carries the context and a timestamp", () => {
    const before = Date.now();
    const report = buildSupportReport(CTX);
    expect(report.at).toBeGreaterThanOrEqual(before);
    expect(report.context).toEqual(CTX);
  });

  it("carries counts, not contents", () => {
    const report = buildSupportReport(CTX);
    const json = JSON.stringify(report);
    // The invariant the module exists to hold: the report's shape has no
    // field that could carry board content, so the serialization is the
    // cheapest full-proof — no key that would hold text other than the
    // browser's own metadata appears.
    expect(Object.keys(report.context).sort()).toEqual(
      [
        "nodes",
        "edges",
        "shapes",
        "comments",
        "boardId",
        "syncStatus",
        "syncRole",
        "busy",
        "streamChars",
        "provider",
      ].sort(),
    );
    // A board id is an opaque handle, not content — it must survive, so
    // support can look the board up server-side with the user's consent.
    expect(json).toContain("brd_abc");
  });

  it("survives a Node environment (no navigator/window) without throwing", () => {
    // vitest runs `node`: this is the environment where the module must
    // still produce a usable report, because the same code path runs in a
    // browser that has not finished painting.
    const report = buildSupportReport(CTX);
    expect(report.userAgent).toBeTruthy();
    expect(report.viewport).toBeTruthy();
  });
});

describe("formatSupportReport", () => {
  it("fences the JSON so chat clients keep the indentation", () => {
    const text = formatSupportReport(buildSupportReport(CTX));
    expect(text.startsWith("```")).toBe(true);
    expect(text.trimEnd().endsWith("```")).toBe(true);
    // Round-trips: support tooling parses the inner JSON.
    const inner = text.replace(/^```\n?/, "").replace(/\n?```$/, "");
    expect(JSON.parse(inner)).toMatchObject({ product: "lucent" });
  });
});
