import { describe, it, expect } from "vitest";
import { createWorkspace } from "../src/model.js";
import { applyOperations } from "../src/reducer.js";
import { validateOperations } from "../src/validator.js";
import type { Operation } from "../src/operations.js";

describe("reducer", () => {
  it("creates nodes and connects them", () => {
    const ops: Operation[] = [
      { op: "CREATE_NODE", id: "a", nodeType: "service", label: "A" },
      { op: "CREATE_NODE", id: "b", nodeType: "service", label: "B" },
      { op: "CONNECT_NODES", source: "a", target: "b", relationship: "calls" },
    ];
    const ws = applyOperations(createWorkspace(), ops);
    expect(Object.keys(ws.nodes)).toEqual(["a", "b"]);
    expect(Object.values(ws.edges)).toHaveLength(1);
    expect(Object.values(ws.edges)[0]).toMatchObject({
      source: "a",
      target: "b",
      relationship: "calls",
    });
  });

  it("deleting a node removes its edges and group membership", () => {
    const ops: Operation[] = [
      { op: "CREATE_NODE", id: "a", nodeType: "t", label: "A" },
      { op: "CREATE_NODE", id: "b", nodeType: "t", label: "B" },
      { op: "CREATE_GROUP", id: "g", label: "G", children: ["a", "b"] },
      { op: "CONNECT_NODES", source: "a", target: "b", relationship: "x" },
      { op: "DELETE_NODE", id: "a" },
    ];
    const ws = applyOperations(createWorkspace(), ops);
    expect(ws.nodes.a).toBeUndefined();
    expect(Object.values(ws.edges)).toHaveLength(0);
    expect(ws.groups.g.children).toEqual(["b"]);
  });

  it("connecting is idempotent for the same relationship", () => {
    const ops: Operation[] = [
      { op: "CREATE_NODE", id: "a", nodeType: "t", label: "A" },
      { op: "CREATE_NODE", id: "b", nodeType: "t", label: "B" },
      { op: "CONNECT_NODES", source: "a", target: "b", relationship: "calls" },
      { op: "CONNECT_NODES", source: "a", target: "b", relationship: "calls" },
    ];
    const ws = applyOperations(createWorkspace(), ops);
    expect(Object.values(ws.edges)).toHaveLength(1);
  });

  it("does not mutate the input workspace", () => {
    const base = createWorkspace();
    applyOperations(base, [{ op: "CREATE_NODE", id: "a", nodeType: "t", label: "A" }]);
    expect(Object.keys(base.nodes)).toHaveLength(0);
  });
});

describe("validator", () => {
  it("flags connecting a missing node", () => {
    const errors = validateOperations(createWorkspace(), [
      { op: "CONNECT_NODES", source: "a", target: "b", relationship: "calls" },
    ]);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].message).toMatch(/does not exist/);
  });

  it("accepts a node created earlier in the same batch", () => {
    const errors = validateOperations(createWorkspace(), [
      { op: "CREATE_NODE", id: "a", nodeType: "t", label: "A" },
      { op: "CREATE_NODE", id: "b", nodeType: "t", label: "B" },
      { op: "CONNECT_NODES", source: "a", target: "b", relationship: "calls" },
    ]);
    expect(errors).toHaveLength(0);
  });

  it("flags self-connection and duplicate node ids", () => {
    const errors = validateOperations(createWorkspace(), [
      { op: "CREATE_NODE", id: "a", nodeType: "t", label: "A" },
      { op: "CREATE_NODE", id: "a", nodeType: "t", label: "A2" },
      { op: "CONNECT_NODES", source: "a", target: "a", relationship: "x" },
    ]);
    expect(errors).toHaveLength(2);
  });
});
