import { describe, expect, it } from "vitest";
import type { Operation } from "../src/model.js";
import {
  applyOperations,
  createWorkspace,
  parseWorkspace,
  safeParseOperations,
} from "../src/index.js";
import { attachProvenance } from "../src/operations.js";

/**
 * Conversation evidence (ADR 0042): the third provenance family member. An AI
 * change made from a request typed or spoken to the board carries who asked,
 * when, and the words — so a chat-built node answers "why is this here?"
 * the way a meeting-built one already could. Same pipeline as the others:
 * stamped by the client (never the model), on the op, so it reaches peers,
 * the server, the op log and undo.
 */

const created = (provenance: unknown): Operation[] =>
  [{ op: "CREATE_NODE", id: "n1", nodeType: "service", label: "Payments", provenance }] as never;

describe("conversation provenance: the schema", () => {
  it("conversation evidence alone is valid", () => {
    expect(
      safeParseOperations(
        created({ conversation: { at: 1_790_000_000_000, by: "Sam Rivera" }, quote: "add Stripe" }),
      ).success,
    ).toBe(true);
  });

  it("`by` is optional — an anonymous local board still records when", () => {
    expect(safeParseOperations(created({ conversation: { at: 1 } })).success).toBe(true);
  });

  it("a conversation without a time is rejected", () => {
    expect(safeParseOperations(created({ conversation: { by: "Sam" } })).success).toBe(false);
  });

  it("an over-long name is rejected (the 80-char cap)", () => {
    expect(
      safeParseOperations(created({ conversation: { at: 1, by: "x".repeat(81) } })).success,
    ).toBe(false);
  });

  it("a quote alone is still not evidence", () => {
    expect(safeParseOperations(created({ quote: "add Stripe" })).success).toBe(false);
  });
});

describe("conversation provenance: attach and persist", () => {
  const evidence = {
    conversation: { at: 1_790_000_000_000, by: "Sam Rivera" },
    quote: "We take payments with Stripe",
  };

  it("attachProvenance stamps CREATE_NODE and SET_STATEMENT, idempotently", () => {
    const ops: Operation[] = [
      { op: "CREATE_NODE", id: "d1", nodeType: "decision", label: "Use Stripe" },
      { op: "SET_STATEMENT", id: "d1", statement: { kind: "decision", status: "resolved" } },
      { op: "CONNECT_NODES", id: "e1", source: "d1", target: "d1", relationship: "self" },
    ];
    const once = attachProvenance(ops, evidence);
    expect(once[0]).toMatchObject({ provenance: evidence });
    expect(once[1]).toMatchObject({ statement: { provenance: evidence } });
    expect(once[2]).toEqual(ops[2]);
    expect(attachProvenance(once, { conversation: { at: 2 } })).toEqual(once);
  });

  it("does not overwrite meeting evidence already on an op", () => {
    const meeting = { meetingId: "mtg_1", turnRange: [3, 4] as [number, number] };
    const [op] = attachProvenance(created(meeting), evidence);
    expect(op).toMatchObject({ provenance: meeting });
  });

  it("survives apply → parseWorkspace (the load path must not strip it)", () => {
    const ws = applyOperations(createWorkspace(), attachProvenance(created(undefined), evidence));
    const loaded = parseWorkspace(JSON.parse(JSON.stringify(ws)));
    if (!loaded.ok) throw new Error(loaded.detail);
    expect(loaded.workspace.nodes.n1?.provenance?.conversation).toEqual(evidence.conversation);
    expect(loaded.workspace.nodes.n1?.provenance?.quote).toBe(evidence.quote);
  });
});
