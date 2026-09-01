import { describe, it, expect } from "vitest";
import {
  gateMeetingOps,
  shouldExtract,
  differentialPrompt,
  DEFAULT_TRIGGER,
} from "../src/meeting-extract.js";
import type { Operation } from "@lucent/core";

/**
 * The live-meeting policy (M2): hybrid trigger, safe-op gate, differential
 * prompt. Pure by design — these decide WHEN to call the model, WHAT may
 * apply silently, and WHAT the model is told; the MeetingView wires them to
 * STT and send().
 */

describe("shouldExtract — the hybrid trigger", () => {
  it("extracts when enough new turns have arrived and the speaker paused", () => {
    // 3 new finals + 5s of silence = the "speaker finished" extract.
    expect(shouldExtract(3, 5_000, 60_000)).toBe(true);
  });

  it("does not extract on a pause with too little new content", () => {
    expect(shouldExtract(1, 30_000, 60_000)).toBe(false);
  });

  it("extracts on a burst of turns with no silence required", () => {
    expect(shouldExtract(DEFAULT_TRIGGER.burstTurns, 0, 20_000)).toBe(true);
  });

  it("extracts when overdue, even mid-flow", () => {
    // 90s since the last extract and at least one new final.
    expect(shouldExtract(1, 100, DEFAULT_TRIGGER.maxIntervalMs)).toBe(true);
  });

  it("respects the minimum spacing between extract calls", () => {
    // Quiet and enough content, but the last extract was 5s ago: wait.
    expect(shouldExtract(5, 10_000, 5_000)).toBe(false);
  });

  it("never extracts with nothing new", () => {
    expect(shouldExtract(0, 60_000, 120_000)).toBe(false);
  });

  it("thresholds are configurable", () => {
    // A chatty meeting can tighten the trigger; a demo can loosen it.
    expect(shouldExtract(2, 2_000, 60_000, { quietTurns: 2, quietMs: 2_000 })).toBe(true);
    expect(shouldExtract(2, 2_000, 60_000, { quietTurns: 9 })).toBe(false);
  });
});

describe("gateMeetingOps — additive auto-apply vs. review", () => {
  it("auto-applies a small additive batch", () => {
    const ops: Operation[] = [
      { op: "CREATE_NODE", id: "n1", nodeType: "step", label: "A" },
      { op: "CREATE_NODE", id: "n2", nodeType: "step", label: "B" },
      { op: "CONNECT_NODES", source: "n1", target: "n2", relationship: "then" },
    ];
    expect(gateMeetingOps(ops).autoApply).toBe(true);
  });

  it("gates any destructive op, even in an otherwise safe batch", () => {
    const ops: Operation[] = [
      { op: "CREATE_NODE", id: "n1", nodeType: "step", label: "A" },
      { op: "DELETE_NODE", id: "existing" },
    ];
    const decision = gateMeetingOps(ops);
    expect(decision.autoApply).toBe(false);
    expect(decision.reason).toContain("DELETE_NODE");
  });

  it("gates an oversized additive batch", () => {
    const ops = Array.from({ length: 15 }, (_, i) => ({
      op: "CREATE_NODE" as const,
      id: `n${i}`,
      nodeType: "step",
      label: `N${i}`,
    }));
    const decision = gateMeetingOps(ops);
    expect(decision.autoApply).toBe(false);
    expect(decision.reason).toContain("review");
  });

  it("gates ops off the safe list — including ADD_COMMENT (noise risk)", () => {
    const ops: Operation[] = [
      {
        op: "ADD_COMMENT",
        id: "c1",
        targetId: "n1",
        body: "misheard speech",
      },
    ];
    expect(gateMeetingOps(ops).autoApply).toBe(false);
  });

  it("gates TRANSFORM_DIAGRAM — a whole-board change is never silent", () => {
    const ops: Operation[] = [{ op: "TRANSFORM_DIAGRAM", to: "mindmap" }];
    const decision = gateMeetingOps(ops);
    expect(decision.autoApply).toBe(false);
    expect(decision.reason).toContain("TRANSFORM_DIAGRAM");
  });
});

describe("differentialPrompt — add, never rebuild", () => {
  it("includes the turns with speaker attribution and kinds", () => {
    const prompt = differentialPrompt([
      { speaker: "Sarah", text: "I'll handle marketing.", kind: "action" },
      { text: "Launch in October." },
    ]);
    expect(prompt).toContain("Sarah: [action] I'll handle marketing.");
    expect(prompt).toContain("Launch in October.");
  });

  it("tells the model the board already shows prior content", () => {
    const prompt = differentialPrompt([{ text: "New idea." }]);
    expect(prompt).toContain("do NOT rebuild");
  });

  it("instructs updates over duplicates for refinements", () => {
    const prompt = differentialPrompt([{ text: "Actually pricing is annual." }]);
    expect(prompt).toContain("update that node");
    expect(prompt).toContain("not duplicate");
  });

  it("marks casual suggestions as proposals, never decisions (P0-3 contract)", () => {
    const prompt = differentialPrompt([{ text: "Maybe Stripe?" }]);
    expect(prompt).toContain("are NEVER decisions");
    expect(prompt).toContain("Proposal:");
  });

  it("teaches rejection as visible supersession, not silence", () => {
    const prompt = differentialPrompt([{ text: "No, we're not doing usage-based pricing." }]);
    expect(prompt).toContain("REJECTION");
    expect(prompt).toContain("supersede");
    expect(prompt).toContain("Rejected:");
  });

  it("teaches correction as in-place replacement", () => {
    const prompt = differentialPrompt([{ text: "Actually, young professionals." }]);
    expect(prompt).toContain("CORRECTION");
    expect(prompt).toContain("replaces the earlier statement's node in place");
  });

  it("teaches the mention-vs-owner attribution rule (the ambiguity case)", () => {
    const prompt = differentialPrompt([{ text: "We should talk to Sarah about pricing." }]);
    expect(prompt).toContain("A mention is not an owner");
    expect(prompt).toContain("Discuss pricing with Sarah");
    expect(prompt).toContain("NOT an action owned by Sarah");
  });

  it("tells the model to skip small talk and jokes entirely", () => {
    const prompt = differentialPrompt([{ text: "Did you see the game?" }]);
    expect(prompt).toContain("small talk, a joke, or off-topic");
    expect(prompt).toContain("emit nothing for it");
  });

  it("names the region kinds available for new topics", () => {
    const prompt = differentialPrompt([{ text: "New topic." }]);
    expect(prompt).toContain("mindmap");
    expect(prompt).toContain("orgchart");
  });
});
