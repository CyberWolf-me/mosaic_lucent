import { describe, expect, it } from "vitest";
import { aiDropWarnings, aiRationale, aiSelectionRatio, isAiPreview } from "../src/views/aiPreview.js";
import type { IntegrationPreview } from "../src/boards.js";

/** A minimal preview factory — the tests fill only what each rule reads. */
function preview(overrides: {
  origin?: "user" | "ai";
  selectedCount?: number;
  totalCandidates?: number;
  explanation?: string;
  request?: string;
  warnings?: string[];
}): IntegrationPreview {
  return {
    action: {
      id: "act_1",
      provider: "fake",
      status: "pending",
      createdAt: 1,
      ...(overrides.origin ? { origin: overrides.origin } : {}),
      ...(overrides.request
        ? { provenance: { request: overrides.request, explanation: overrides.explanation ?? "" } }
        : {}),
    },
    preview: {
      creates: [],
      updates: [],
      statement: "…",
      ...(overrides.selectedCount !== undefined ? { selectedCount: overrides.selectedCount } : {}),
      ...(overrides.totalCandidates !== undefined ? { totalCandidates: overrides.totalCandidates } : {}),
      ...(overrides.explanation ? { explanation: overrides.explanation } : {}),
      ...(overrides.warnings ? { warnings: overrides.warnings } : {}),
    },
  };
}

describe("isAiPreview", () => {
  it("distinguishes the AI origin from the human default", () => {
    expect(isAiPreview(preview({ origin: "ai", explanation: "x" }))).toBe(true);
    expect(isAiPreview(preview({ explanation: "x" }))).toBe(false);
    expect(isAiPreview(null)).toBe(false);
  });
});

describe("aiSelectionRatio — the narrowing made explicit", () => {
  it("returns the selected/total pair only for a complete AI preview", () => {
    expect(aiSelectionRatio(preview({ origin: "ai", selectedCount: 4, totalCandidates: 10 }))).toEqual({
      selected: 4,
      total: 10,
    });
    // Missing either number → the ratio line does not render.
    expect(aiSelectionRatio(preview({ origin: "ai", selectedCount: 4 }))).toBeNull();
    expect(aiSelectionRatio(preview({ origin: "user", selectedCount: 4, totalCandidates: 10 }))).toBeNull();
  });
});

describe("aiRationale — a recommendation, quoted, with its request", () => {
  it("carries the explanation and the provenance request", () => {
    const r = aiRationale(
      preview({ origin: "ai", explanation: "Launch-related.", request: "send the launch ones" }),
    );
    expect(r).toEqual({ explanation: "Launch-related.", request: "send the launch ones" });
  });
  it("no explanation → no rationale block; a human preview never has one", () => {
    expect(aiRationale(preview({ origin: "ai" }))).toBeNull();
    expect(aiRationale(preview({ origin: "user", explanation: "x" }))).toBeNull();
  });
});

describe("aiDropWarnings — the model's unknown ids, made visible", () => {
  it("returns the warnings verbatim; absent → empty", () => {
    expect(
      aiDropWarnings(preview({ origin: "ai", warnings: ['the model named "nd_ghost" — dropped'] })),
    ).toEqual(['the model named "nd_ghost" — dropped']);
    expect(aiDropWarnings(preview({ origin: "ai" }))).toEqual([]);
  });
});
