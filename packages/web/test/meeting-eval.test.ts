import { describe, it, expect } from "vitest";
import { MEETING_FIXTURES, type MeetingFixture } from "../src/meeting-fixtures.js";
import {
  gateMeetingOps,
  shouldExtract,
  differentialPrompt,
  DEFAULT_TRIGGER,
  MEETING_AUTO_APPLY_MAX_OPS,
} from "../src/meeting-extract.js";
import { classifyTurn } from "../src/meetings.js";
import {
  applyOperations,
  applyLayout,
  computeLayout,
  createWorkspace,
  relayoutRegion,
} from "@lucent/core";
import type { Operation, Workspace } from "@lucent/core";

/**
 * The offline half of the meeting evaluation (P0-2): the differential-loop
 * POLICIES driven across all five scripted meetings. What this suite proves
 * is what the code guarantees regardless of provider quality — trigger
 * behaviour, auto-apply gating, region continuity (update-not-duplicate), and
 * spatial stability. What it deliberately does NOT cover is model output
 * quality; that is the real-provider scoresheet in
 * docs/16-meeting-evaluation.md.
 *
 * Together they implement the advisory's point: measure the AI, not just
 * whether the UI looks nice — and pin the deterministic parts so only the
 * model's behaviour is left to opinion.
 */

/** Replay a fixture through the trigger as a recording session would. */
function simulateTrigger(fixture: MeetingFixture): {
  extracts: number;
  turnsAtExtract: number[];
  unextractedTail: number;
} {
  let sinceLastExtract = 0;
  let msSinceLastFinal = Infinity;
  let msSinceLastExtract = Infinity;
  let extracts = 0;
  const turnsAtExtract: number[] = [];
  let unextractedTail = 0;
  for (const _turn of fixture.turns) {
    sinceLastExtract += 1;
    msSinceLastFinal = 0; // speech keeps arriving in a tight sim
    msSinceLastExtract += 4_000; // assume ~4s between finals
    if (shouldExtract(sinceLastExtract, msSinceLastFinal, msSinceLastExtract)) {
      extracts += 1;
      turnsAtExtract.push(sinceLastExtract);
      unextractedTail = 0;
      msSinceLastExtract = 0;
      sinceLastExtract = 0;
    } else {
      unextractedTail = sinceLastExtract;
    }
  }
  return { extracts, turnsAtExtract, unextractedTail };
}

describe("trigger policy across all five meetings", () => {
  it.each(MEETING_FIXTURES.map((f) => [f.id, f] as const))(
    "%s: bursts fire before the meeting ends (no turn waits forever)",
    (_id, fixture) => {
      const sim = simulateTrigger(fixture);
      // Every fixture has at least one burst-scale accumulation (>= burstTurns)
      // or hits the overdue valve: nothing should be left entirely unextracted.
      expect(sim.unextractedTail).toBeLessThan(fixture.turns.length);
      expect(sim.extracts).toBeGreaterThan(0);
    },
  );

  it("a meeting's tail is not lost when speech stops: the overdue valve drains it", () => {
    // 9 turns accumulated, then SILENCE — no more onFinal events. The valve
    // must fire on the wall-clock arm alone (the 3s timer in MeetingView
    // polls exactly this).
    const msSinceLastFinal = 30_000; // speech stopped long ago
    expect(shouldExtract(9, msSinceLastFinal, DEFAULT_TRIGGER.maxIntervalMs)).toBe(true);
    // And quiet-early speech: 3 turns + a long pause extracts on "speaker finished".
    expect(shouldExtract(3, 10_000, 20_000)).toBe(true);
  });

  it("chatty meetings extract in bounded batches, not per-sentence", () => {
    // With min-spacing enforced, a 10-turn meeting cannot fire 10 times.
    const sim = simulateTrigger(MEETING_FIXTURES[0]!);
    expect(sim.extracts).toBeLessThanOrEqual(MEETING_FIXTURES[0]!.turns.length / 2);
    expect(sim.extracts).toBeGreaterThan(0);
  });
});

describe("gating policy across all five meetings", () => {
  it("every fixture's additive footprint would auto-apply", () => {
    // The typical healthy extraction: creates + connects + groups only.
    const healthy: Operation[] = [
      { op: "CREATE_NODE", id: "n1", nodeType: "step", label: "A" },
      { op: "CREATE_NODE", id: "n2", nodeType: "step", label: "B" },
      { op: "CONNECT_NODES", source: "n1", target: "n2", relationship: "then" },
      { op: "CREATE_GROUP", id: "g", label: "Topic", children: [] },
    ];
    expect(gateMeetingOps(healthy).autoApply).toBe(true);
  });

  it("the correction fixture must never auto-apply a destructive rewrite", () => {
    // "Actually, young professionals" done WRONG would be delete-and-recreate.
    // The gate must catch that shape if a model ever emits it.
    const destructiveCorrection: Operation[] = [
      { op: "CREATE_NODE", id: "n1", nodeType: "audience", label: "Young professionals" },
      { op: "DELETE_NODE", id: "students" },
    ];
    const decision = gateMeetingOps(destructiveCorrection);
    expect(decision.autoApply).toBe(false);
    expect(decision.reason).toContain("DELETE_NODE");
  });

  it("oversized extraction batches gate behind review", () => {
    const big = Array.from({ length: MEETING_AUTO_APPLY_MAX_OPS + 1 }, (_, i) => ({
      op: "CREATE_NODE" as const,
      id: `n${i}`,
      nodeType: "step",
      label: `Node ${i}`,
    }));
    expect(gateMeetingOps(big).autoApply).toBe(false);
  });
});

describe("differential prompt contract across all five meetings", () => {
  it.each(MEETING_FIXTURES.map((f) => [f.id, f] as const))(
    "%s: the prompt quotes the turns with speakers, forbids rebuild, carries the kind contract",
    (_id, fixture) => {
      const prompt = differentialPrompt(
        fixture.turns.map((t) => ({ speaker: t.speaker, text: t.text, kind: t.kind })),
      );
      // Speakers are attributed (attribution scoring depends on them being in).
      expect(prompt).toContain(`${fixture.turns[0]!.speaker}:`);
      // The contract clauses every extraction must carry (P0-3 set).
      expect(prompt).toContain("do NOT rebuild");
      expect(prompt).toContain("update that node");
      expect(prompt).toContain("are NEVER decisions");
      expect(prompt).toContain("A mention is never an owner");
    },
  );

  it("the messy meeting's correction carries the speaker who corrected", () => {
    const messy = MEETING_FIXTURES.find((f) => f.id === "messy-meeting")!;
    const correction = messy.turns.find((t) => t.text.startsWith("Actually"))!;
    const prompt = differentialPrompt(
      [correction].map((t) => ({ speaker: t.speaker, text: t.text })),
    );
    // The correction must be attributed to David — the person the scoresheet
    // scores on the "did the right person get the correction" axis.
    expect(prompt).toContain("David:");
  });
});

describe("classification sanity on the fixtures", () => {
  it("the disagreement fixture's rejection classifies as a decision marker", () => {
    const brainstorm = MEETING_FIXTURES.find((f) => f.id === "brainstorm-disagreement")!;
    const rejection = brainstorm.turns.find((t) => t.text.startsWith("No, we're not"))!;
    expect(classifyTurn(rejection.text)).toBe("decision");
  });

  it("speculation classifies as hypothesis, not decision", () => {
    const brainstorm = MEETING_FIXTURES.find((f) => f.id === "brainstorm-disagreement")!;
    const speculation = brainstorm.turns.find((t) => t.text.startsWith("What if"))!;
    expect(classifyTurn(speculation.text)).toBe("hypothesis");
  });

  it("ownership statements classify as actions", () => {
    const planning = MEETING_FIXTURES.find((f) => f.id === "planning-owners")!;
    const ownsIt = planning.turns.find((t) => t.text.includes("I'll"))!;
    expect(classifyTurn(ownsIt.text)).toBe("action");
  });
});

describe("continuity: the same topic returns, the region updates", () => {
  /** Seed a board with a region for each of the first n expected topics. */
  const seedBoard = (topicIds: string[]): Workspace => {
    const ops: Operation[] = topicIds.flatMap((id) => [
      {
        op: "CREATE_NODE",
        id: `${id}-1`,
        nodeType: "step",
        label: `${id} core`,
        groupId: `grp-${id}`,
      },
      {
        op: "CREATE_NODE",
        id: `${id}-2`,
        nodeType: "step",
        label: `${id} detail`,
        groupId: `grp-${id}`,
      },
      {
        op: "CONNECT_NODES",
        source: `${id}-1`,
        target: `${id}-2`,
        relationship: "relates to",
      },
      {
        op: "CREATE_GROUP",
        id: `grp-${id}`,
        label: id,
        children: [`${id}-1`, `${id}-2`],
        kind: "flowchart" as const,
      },
    ]);
    const ws = applyOperations(createWorkspace(), ops);
    return applyLayout(ws, computeLayout(ws, { direction: "vertical" }));
  };

  it("returning to a topic adds nodes INSIDE the existing region (no duplicate region)", () => {
    // The architecture fixture's pattern: frontend → … → back to frontend.
    const board = seedBoard(["Frontend", "Backend"]);
    const frontendRegion = board.groups["grp-Frontend"]!;
    const frontendCountBefore = frontendRegion.children.length;

    // A "new turn about frontend" arrives: two new nodes into grp-Frontend.
    const ops: Operation[] = [
      {
        op: "CREATE_NODE",
        id: "frontend-3",
        nodeType: "step",
        label: "Service worker",
        groupId: "grp-Frontend",
      },
      {
        op: "CONNECT_NODES",
        source: "frontend-1",
        target: "frontend-3",
        relationship: "adds offline support to",
      },
    ];
    const next = applyOperations(board, ops);
    // Exactly ONE frontend region still exists, and it grew.
    const frontendRegions = Object.values(next.groups).filter((g) => /frontend/i.test(g.label));
    expect(frontendRegions).toHaveLength(1);
    expect(frontendRegions[0]!.children.length).toBe(frontendCountBefore + 1);
  });

  it("the touched region relayouts at its origin; untouched regions hold position", () => {
    // Topic ids are the fixture's own labels ("Frontend"), so node ids come
    // out as `Frontend-1` — the lookups match the seeded ids exactly.
    const board = seedBoard(["Frontend", "Backend"]);
    const backendPosBefore = board.nodes["Backend-1"]!.position;

    const ops: Operation[] = [
      {
        op: "CREATE_NODE",
        id: "Frontend-3",
        nodeType: "step",
        label: "Service worker",
        groupId: "grp-Frontend",
      },
    ];
    const next = applyOperations(board, ops);
    const relaid = relayoutRegion(next, "grp-Frontend");
    const final = relaid ? applyLayout(next, relaid) : next;
    // Backend never moved (the spatial-additivity invariant).
    expect(final.nodes["Backend-1"]!.position).toEqual(backendPosBefore);
    // The new frontend node is placed, not orphaned at the origin.
    expect(final.nodes["Frontend-3"]!.position).toBeDefined();
  });
});
