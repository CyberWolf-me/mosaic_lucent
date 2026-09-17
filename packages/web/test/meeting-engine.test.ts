import { describe, it, expect } from "vitest";
import {
  applyExtractOutcome,
  createMeetingEngine,
  extractStatusMessage,
  sliceBatch,
} from "../src/meeting-engine.js";

/**
 * docs/25 V4: the meeting engine seam — orchestration without storage.
 *
 * These pin the refactor contract: the engine fires exactly when the
 * inlined loop fired (same trigger, same clocks), slices the same batches,
 * re-queues only busy/failed, and renders the same heartbeat strings. The
 * meeting suites (eval, extract, logic) pin the behavior around it;
 * nothing here may change what they observe.
 */
describe("sliceBatch", () => {
  it("takes the queued tail with its stable transcript index", () => {
    expect(sliceBatch(["a", "b", "c", "d"], 2)).toEqual({ batch: ["c", "d"], batchStart: 2 });
    expect(sliceBatch(["a"], 5)).toEqual({ batch: ["a"], batchStart: 0 });
    expect(sliceBatch(["a", "b"], 0)).toEqual({ batch: [], batchStart: 2 });
  });
});

describe("applyExtractOutcome", () => {
  it("re-queues only busy and failed — every other outcome stands dequeued", () => {
    expect(applyExtractOutcome(0, 3, "applied")).toBe(0);
    expect(applyExtractOutcome(0, 3, "proposed")).toBe(0);
    expect(applyExtractOutcome(0, 3, "answered")).toBe(0);
    expect(applyExtractOutcome(0, 3, "rejected")).toBe(0);
    expect(applyExtractOutcome(0, 3, "refused")).toBe(0);
    expect(applyExtractOutcome(0, 3, "cancelled")).toBe(0);
    expect(applyExtractOutcome(0, 3, "busy")).toBe(3);
    expect(applyExtractOutcome(0, 3, "failed")).toBe(3);
  });
});

describe("extractStatusMessage", () => {
  it("renders the heartbeat strings the view rendered inline", () => {
    expect(extractStatusMessage("applied", 1)).toBe("Applied 1 new turn to the board");
    expect(extractStatusMessage("applied", 4)).toBe("Applied 4 new turns to the board");
    expect(extractStatusMessage("proposed", 2, { ops: 5 })).toContain("5 proposed changes");
    expect(extractStatusMessage("answered", 2)).toContain("no board changes were needed");
    expect(extractStatusMessage("rejected", 2)).toContain("nothing was changed");
    expect(extractStatusMessage("busy", 2)).toContain("waiting");
    expect(extractStatusMessage("refused", 2)).toContain("read-only");
    expect(extractStatusMessage("failed", 2, { error: "boom" })).toContain("boom");
    expect(extractStatusMessage("failed", 2, { error: "boom" })).toContain("will retry");
    expect(extractStatusMessage("cancelled", 2)).toContain("nothing was applied");
  });
});

describe("createMeetingEngine", () => {
  it("fires on the hybrid trigger, never re-entrant, resets clean", () => {
    let at = 1_000_000;
    const engine = createMeetingEngine({ now: () => at });
    // Fresh clocks (Infinity/Infinity) with queued turns fire at once — the
    // same answer the inlined loop's null refs gave shouldExtract.
    expect(engine.shouldFire(3)).toBe(true);
    expect(engine.shouldFire(0)).toBe(false); // nothing queued
    engine.noteFinal(at);
    at += 5_000; // silence past quietMs with 3 finals queued
    expect(engine.shouldFire(3)).toBe(true);
    engine.markFired();
    expect(engine.state.inFlight).toBe(true);
    expect(engine.shouldFire(100)).toBe(false); // re-entrancy guard
    engine.markDone();
    expect(engine.shouldFire(100)).toBe(false); // debounce: just fired
    at += 16_000;
    expect(engine.shouldFire(100)).toBe(true); // spacing elapsed
    engine.reset();
    expect(engine.state).toEqual({ lastFinalAt: null, lastExtractAt: null, inFlight: false });
    // Reset restores the pre-capture clocks (Infinity/Infinity): a deep queue
    // still fires — identical to the inlined loop's fresh refs.
    expect(engine.shouldFire(100)).toBe(true);
    expect(engine.shouldFire(0)).toBe(false);
  });
});
