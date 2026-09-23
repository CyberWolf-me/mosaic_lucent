import { describe, expect, it } from "vitest";
import type { Operation } from "@lucent/core";
import { isEmptyEffect, turnEffect } from "../src/turnEffect.js";

describe("turnEffect — what one conversation turn did to the board", () => {
  it("counts creations, connections and new statements by kind", () => {
    const ops: Operation[] = [
      { op: "CREATE_NODE", id: "a", nodeType: "process", label: "Checkout" },
      { op: "CREATE_NODE", id: "d", nodeType: "decision", label: "Use Stripe" },
      { op: "SET_STATEMENT", id: "d", statement: { kind: "decision", status: "resolved" } },
      { op: "CREATE_NODE", id: "q", nodeType: "question", label: "Cash on delivery?" },
      { op: "SET_STATEMENT", id: "q", statement: { kind: "question", status: "open" } },
      { op: "CONNECT_NODES", source: "d", target: "a", relationship: "decides" },
    ];
    const e = turnEffect(ops);
    expect(e.created).toBe(3);
    expect(e.connected).toBe(1);
    expect(e.statements).toEqual({ decision: 1, question: 1 });
    // Stating a node this batch created is part of creating it, not a change.
    expect(e.changed).toBe(0);
  });

  it("stating or relabelling an EXISTING node is a change", () => {
    const e = turnEffect([
      { op: "SET_STATEMENT", id: "old", statement: { kind: "risk", status: "open" } },
      { op: "CHANGE_TEXT", id: "other", text: "Renamed" },
    ] as Operation[]);
    expect(e.changed).toBe(2);
    expect(e.statements).toEqual({ risk: 1 });
  });

  it("counts removals and lifecycle moves", () => {
    const e = turnEffect([
      { op: "DELETE_NODE", id: "x" },
      { op: "UPDATE_STATEMENT", id: "q", status: "resolved" },
    ] as Operation[]);
    expect(e.removed).toBe(1);
    expect(e.resolved).toBe(1);
  });

  it("a layout-only turn is empty", () => {
    expect(isEmptyEffect(turnEffect([]))).toBe(true);
    expect(
      isEmptyEffect(turnEffect([{ op: "SET_LAYOUT_INTENT", direction: "LR" }] as never)),
    ).toBe(true);
  });
});
