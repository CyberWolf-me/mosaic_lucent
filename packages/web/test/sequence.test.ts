import { describe, it, expect } from "vitest";
import { createWorkspace, applyOperations } from "@lucent/core";
import type { Operation } from "@lucent/core";
import { toSequence } from "../src/board/sequence.js";

function graph() {
  const ops: Operation[] = [
    { op: "CREATE_NODE", id: "user", nodeType: "actor", label: "Customer" },
    { op: "CREATE_NODE", id: "api", nodeType: "service", label: "API" },
    { op: "CREATE_NODE", id: "stripe", nodeType: "service", label: "Stripe" },
    { op: "CONNECT_NODES", source: "user", target: "api", relationship: "POST /checkout" },
    { op: "CONNECT_NODES", source: "api", target: "stripe", relationship: "charge" },
  ];
  return applyOperations(createWorkspace(), ops);
}

describe("toSequence (Phase D)", () => {
  it("derives one actor per node and one message per edge", () => {
    const seq = toSequence(graph());
    expect(seq.actors).toHaveLength(3);
    expect(seq.messages).toHaveLength(2);
  });

  it("orders entry-point actors first (no incoming edges)", () => {
    const seq = toSequence(graph());
    expect(seq.actors[0]?.id).toBe("user");
    expect(seq.actors[0]?.x).toBeLessThan(seq.actors[1]!.x);
  });

  it("marks a right-to-left edge as a return message", () => {
    const ws = applyOperations(graph(), [
      { op: "CONNECT_NODES", source: "stripe", target: "api", relationship: "200 ok" },
    ]);
    const seq = toSequence(ws);
    const ret = seq.messages.find((m) => m.from === "stripe" && m.to === "api");
    expect(ret?.kind).toBe("return");
  });

  it("returns empty model for an empty board", () => {
    const seq = toSequence(createWorkspace());
    expect(seq.actors).toHaveLength(0);
    expect(seq.messages).toHaveLength(0);
  });
});
