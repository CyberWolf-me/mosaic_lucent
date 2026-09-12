import { describe, expect, it } from "vitest";
import { createWorkspace } from "@lucent/core";
import { buildAttention } from "../src/attention.js";
import { proposalThreshold } from "../src/workspace.js";
import { settingsStore } from "../src/settings.js";
import { pointsAtLive, isLiveProvenance } from "../src/meetingTimeline.js";

describe("UX remediation: attention + threshold + live provenance", () => {
  it("empty workspace builds an empty queue", () => {
    expect(buildAttention(createWorkspace(), {})).toEqual([]);
  });

  it("proposal + skipped + offline surface as items with targets", () => {
    const items = buildAttention(createWorkspace(), {
      proposal: { operations: [1, 2, 3], request: "big" },
      skippedCount: 2,
      disconnected: true,
    });
    const kinds = items.map((i) => i.kind);
    expect(kinds).toContain("proposal");
    expect(kinds).toContain("skipped");
    expect(kinds).toContain("offline");
    for (const item of items) expect(item.target.view).toBeTruthy();
  });

  it("approval threshold follows settings", () => {
    settingsStore.set({ approvalThreshold: "always" });
    expect(proposalThreshold()).toBe(0);
    settingsStore.set({ approvalThreshold: "large" });
    expect(proposalThreshold()).toBe(5);
    settingsStore.set({ approvalThreshold: "never" });
    expect(proposalThreshold()).toBe(Infinity);
    settingsStore.set({ approvalThreshold: "large" });
  });

  it("live provenance includes live-session turns", () => {
    expect(isLiveProvenance("live-session")).toBe(true);
    expect(isLiveProvenance("saved-id")).toBe(false);
    expect(
      pointsAtLive({ meetingId: "live-session" }, "live-session"),
    ).toBe(true);
  });
});
