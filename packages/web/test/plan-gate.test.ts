import { describe, expect, it } from "vitest";
import type { Operation } from "@lucent/core";
import { gatePlanOps, planRequestText, PLAN_SAFE_OPS, type GatedOp } from "../src/planGate.js";

/**
 * The plan gate (Stage D2, ADR 0028). The acceptance rule is MECHANICAL:
 * the one op that converts a proposal into confirmed work (UPDATE_STATEMENT)
 * is not in the allowlist, so no plan can silently decide anything — the
 * rule the golden case pins at the model layer and this pins at the gate.
 */

const planBatch: Operation[] = [
  { op: "CREATE_NODE", id: "t1", nodeType: "action", label: "Task 1" },
  { op: "SET_STATEMENT", id: "t1", statement: { kind: "action", status: "open" } },
  { op: "SET_ISSUE", id: "t1", issue: { type: "task", status: "open" } },
  { op: "CREATE_GROUP", id: "plan", label: "Plan", children: ["t1"], kind: "process" },
  { op: "CONNECT_NODES", source: "t1", target: "t2", relationship: "next" },
];

describe("gatePlanOps", () => {
  it("passes the in-list ops through in order", () => {
    const { allowed, skipped } = gatePlanOps(planBatch);
    expect(allowed).toEqual(planBatch);
    expect(skipped).toEqual([]);
  });

  it("skips UPDATE_STATEMENT — lifecycle conversion is a human act", () => {
    const batch: Operation[] = [
      ...planBatch,
      { op: "UPDATE_STATEMENT", id: "que-0", status: "resolved" as never },
    ];
    const { allowed, skipped } = gatePlanOps(batch);
    expect(allowed).toEqual(planBatch);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.op).toBe("UPDATE_STATEMENT");
    expect(skipped[0]!.reason).toContain("que-0");
    expect(skipped[0]!.reason).toContain("human act");
  });

  it("skips DELETE and CHANGE_TEXT — a plan never destroys or rewrites", () => {
    const batch: Operation[] = [
      ...planBatch,
      { op: "DELETE_NODE", id: "old" },
      { op: "CHANGE_TEXT", id: "old2", text: "rewritten" },
    ];
    const { skipped } = gatePlanOps(batch);
    expect(skipped.map((s) => s.op)).toEqual(["DELETE_NODE", "CHANGE_TEXT"]);
  });

  it("every skipped descriptor carries the op kind and a readable reason", () => {
    const { skipped } = gatePlanOps([{ op: "UPDATE_ISSUE", id: "x" }, ...planBatch.slice(0, 1)] as Operation[]);
    // UPDATE_ISSUE is ALLOWED — only the first slice item is in-list; this
    // asserts the descriptor shape on a real skip instead.
    const real: GatedOp[] = gatePlanOps([{ op: "MOVE_NODE" } as unknown as Operation]).skipped;
    expect(real[0]!.op).toBe("MOVE_NODE");
    expect(typeof real[0]!.reason).toBe("string");
  });

  it("PLAN_SAFE_OPS is the creation-and-organization list", () => {
    expect([...PLAN_SAFE_OPS].sort()).toEqual([
      "CONNECT_NODES",
      "CREATE_GROUP",
      "CREATE_NODE",
      "SET_GROUP_KIND",
      "SET_ISSUE",
      "SET_STATEMENT",
      "UPDATE_ISSUE",
    ]);
  });
});

describe("planRequestText", () => {
  it("names the count and the preservation rules", () => {
    const one = planRequestText(1);
    expect(one).toContain("from this statement");
    expect(one).toContain("never create confirmed work");
    const many = planRequestText(5);
    expect(many).toContain("from these 5 statements");
    expect(many).toContain("preserve existing actions");
    expect(many).toContain("Proposals and questions are context");
  });

  it("teaches the drives linkage (Stage E1) — each derived action traces to its decision", () => {
    expect(planRequestText(3)).toContain(
      "link each derived action to the decision that drives it with a drives relationship",
    );
  });

  it("teaches the workstream organization (Stage E3) — the task-tree shape", () => {
    const text = planRequestText(9);
    expect(text).toContain("organize the derived work into workstream groups");
    expect(text).toContain("Research / Design / Engineering / QA");
  });
});
