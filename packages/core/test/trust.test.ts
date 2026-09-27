import { describe, expect, it } from "vitest";
import {
  applyOperations,
  createWorkspace,
  parseWorkspace,
  stampAuthorship,
  stampTrust,
  statementRows,
  validateOperations,
  withEditTrust,
  withoutTrust,
  type Operation,
} from "../src/index.js";

/**
 * The trust ladder (docs/26 J5, ADR 0047): stamped by whoever commits, never
 * by the model, never raised by an agent. Only a statement with a person's
 * review behind it reads as human; what a meeting extracted stays a
 * suggestion even after the panel's "Apply all".
 */

const node = (id: string, meetingId?: string): Operation => ({
  op: "CREATE_NODE",
  id,
  nodeType: "process",
  label: id,
  ...(meetingId ? { provenance: { meetingId, turnRange: [0, 1] as [number, number] } } : {}),
});
const statement = (id: string, trust?: string): Operation =>
  ({
    op: "SET_STATEMENT",
    id,
    statement: { kind: "decision", status: "resolved", ...(trust ? { trust } : {}) },
  }) as Operation;

function trustOf(ops: Operation[], id: string): string | undefined {
  const op = ops.find((o) => o.op === "SET_STATEMENT" && o.id === id);
  return op?.op === "SET_STATEMENT" ? op.statement?.trust : undefined;
}

describe("withoutTrust", () => {
  it("removes whatever trust the model's output claims", () => {
    const out = withoutTrust([
      node("a"),
      statement("a", "human-approved"),
      { op: "UPDATE_STATEMENT", id: "a", trust: "human-edited" } as Operation,
    ]);
    expect(trustOf(out, "a")).toBeUndefined();
    expect(out[2]).not.toHaveProperty("trust");
  });
});

describe("stampTrust", () => {
  it("a request a person made is human-approved — unless it came from a meeting", () => {
    const out = stampTrust(
      [node("asked"), statement("asked"), node("heard", "mtg_1"), statement("heard")],
      "requested",
    );
    expect(trustOf(out, "asked")).toBe("human-approved");
    expect(trustOf(out, "heard")).toBe("ai-suggested");
  });

  it("knows meeting evidence already on the board", () => {
    const ws = applyOperations(createWorkspace(), [node("old", "mtg_2")]);
    expect(trustOf(stampTrust([statement("old")], "requested", ws), "old")).toBe("ai-suggested");
  });

  it("a person's own statement is human-created, and a review keeps the trust it names", () => {
    const out = stampTrust(
      [node("mine"), statement("mine"), statement("reviewed", "human-approved")],
      "manual",
    );
    expect(trustOf(out, "mine")).toBe("human-created");
    expect(trustOf(out, "reviewed")).toBe("human-approved");
  });

  it("an agent can't claim more than a suggestion, and can't promote anything", () => {
    const out = stampTrust(
      [
        node("x"),
        statement("x", "human-approved"),
        { op: "UPDATE_STATEMENT", id: "x", trust: "human-approved" } as Operation,
      ],
      "agent",
    );
    expect(trustOf(out, "x")).toBe("ai-suggested");
    expect(out[2]).not.toHaveProperty("trust");
  });

  it("an integration's statement is system", () => {
    expect(trustOf(stampTrust([node("s"), statement("s")], "system"), "s")).toBe("system");
  });
});

describe("the ladder on the board", () => {
  const suggested = applyOperations(
    createWorkspace(),
    stampTrust([node("q", "mtg_1"), statement("q")], "requested"),
  );

  it("promotion is an ordinary validated op", () => {
    const approve: Operation[] = [{ op: "UPDATE_STATEMENT", id: "q", trust: "human-approved" }];
    expect(validateOperations(suggested, approve)).toEqual([]);
    const next = applyOperations(suggested, approve);
    expect(next.nodes.q!.statement!.trust).toBe("human-approved");
    expect(next.nodes.q!.statement!.status).toBe("resolved");
  });

  it("relabelling a suggestion makes it human-edited", () => {
    const edit = withEditTrust([{ op: "CHANGE_TEXT", id: "q", text: "Ship on Friday" }], suggested);
    expect(edit).toContainEqual({ op: "UPDATE_STATEMENT", id: "q", trust: "human-edited" });
    expect(applyOperations(suggested, edit).nodes.q!.statement!.trust).toBe("human-edited");
    // Same text, or a statement a person already reviewed: nothing to add.
    expect(withEditTrust([{ op: "CHANGE_TEXT", id: "q", text: "q" }], suggested)).toHaveLength(1);
  });

  it("survives a save and a reload, and reaches the statement rows", () => {
    const reloaded = parseWorkspace(JSON.parse(JSON.stringify(suggested)));
    expect(reloaded.ok && reloaded.workspace!.nodes.q!.statement!.trust).toBe("ai-suggested");
    expect(statementRows(suggested)[0]!.trust).toBe("ai-suggested");
  });

  it("stamping leaves authorship alone", () => {
    const ops = stampAuthorship(stampTrust([node("n"), statement("n")], "manual"), "usr_1");
    expect(trustOf(ops, "n")).toBe("human-created");
  });
});
