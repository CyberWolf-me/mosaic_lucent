import { describe, it, expect } from "vitest";
import { applyOperations, createWorkspace, type Operation } from "@lucent/core";
import { toScene } from "../src/scene.js";

/**
 * Connector routing. The old rule picked only the dominant axis and always left
 * the source's bottom/right, so an edge pointing up or left exited the wrong
 * face and cut back across its own card. Parallel edges also stacked exactly.
 */
function boardWith(
  nodes: Array<{ id: string; x: number; y: number }>,
  edges: Array<[string, string, string]>,
) {
  let ws = createWorkspace();
  const ops: Operation[] = nodes.flatMap((n) => [
    { op: "CREATE_NODE" as const, id: n.id, nodeType: "service", label: n.id },
    { op: "MOVE_NODE" as const, id: n.id, position: { x: n.x, y: n.y } },
  ]);
  for (const [s, t, rel] of edges) {
    ops.push({ op: "CONNECT_NODES", source: s, target: t, relationship: rel });
  }
  ws = applyOperations(ws, ops);
  return ws;
}

describe("edge face selection", () => {
  it("routes left-to-right edges out the right face into the left face", () => {
    const ws = boardWith(
      [
        { id: "a", x: 0, y: 0 },
        { id: "b", x: 400, y: 0 },
      ],
      [["a", "b", "calls"]],
    );
    const { edges } = toScene(ws);
    expect(edges[0]!.dir).toBe("h");
    expect(edges[0]!.fromSide).toBe("r");
    expect(edges[0]!.toSide).toBe("l");
  });

  it("routes right-to-left edges out the LEFT face (previously wrong)", () => {
    const ws = boardWith(
      [
        { id: "a", x: 400, y: 0 },
        { id: "b", x: 0, y: 0 },
      ],
      [["a", "b", "calls"]],
    );
    const { edges } = toScene(ws);
    expect(edges[0]!.fromSide).toBe("l");
    expect(edges[0]!.toSide).toBe("r");
  });

  it("routes downward edges bottom-to-top", () => {
    const ws = boardWith(
      [
        { id: "a", x: 0, y: 0 },
        { id: "b", x: 0, y: 400 },
      ],
      [["a", "b", "next"]],
    );
    const { edges } = toScene(ws);
    expect(edges[0]!.dir).toBe("v");
    expect(edges[0]!.fromSide).toBe("b");
    expect(edges[0]!.toSide).toBe("t");
  });

  it("routes upward edges top-to-bottom (previously wrong)", () => {
    const ws = boardWith(
      [
        { id: "a", x: 0, y: 400 },
        { id: "b", x: 0, y: 0 },
      ],
      [["a", "b", "returns"]],
    );
    const { edges } = toScene(ws);
    expect(edges[0]!.fromSide).toBe("t");
    expect(edges[0]!.toSide).toBe("b");
  });
});

describe("parallel edges", () => {
  it("assigns increasing fan-out indices to edges sharing a node pair", () => {
    const ws = boardWith(
      [
        { id: "a", x: 0, y: 0 },
        { id: "b", x: 400, y: 0 },
      ],
      [
        ["a", "b", "calls"],
        ["a", "b", "notifies"],
      ],
    );
    const { edges } = toScene(ws);
    expect(edges).toHaveLength(2);
    expect(edges.map((e) => e.parallelIndex).sort()).toEqual([0, 1]);
  });

  it("treats a reverse edge as parallel to its forward twin", () => {
    const ws = boardWith(
      [
        { id: "a", x: 0, y: 0 },
        { id: "b", x: 400, y: 0 },
      ],
      [
        ["a", "b", "calls"],
        ["b", "a", "responds"],
      ],
    );
    const { edges } = toScene(ws);
    expect(edges.map((e) => e.parallelIndex).sort()).toEqual([0, 1]);
  });

  it("keeps unrelated pairs at index 0", () => {
    const ws = boardWith(
      [
        { id: "a", x: 0, y: 0 },
        { id: "b", x: 400, y: 0 },
        { id: "c", x: 800, y: 0 },
      ],
      [
        ["a", "b", "calls"],
        ["b", "c", "calls"],
      ],
    );
    const { edges } = toScene(ws);
    expect(edges.every((e) => e.parallelIndex === 0)).toBe(true);
  });
});
