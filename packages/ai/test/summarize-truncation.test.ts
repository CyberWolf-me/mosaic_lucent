import { describe, it, expect } from "vitest";
import { summarizeWorkspace, SUMMARY_LIMITS } from "../src/index.js";
import { createWorkspace } from "@lucent/core";

/**
 * A large board must not blow the prompt budget. summariseWorkspace caps
 * nodes/edges and surfaces a `truncated` marker so the model knows the view
 * is partial (M0.6e).
 */

describe("summarizeWorkspace truncation", () => {
  it("caps nodes at SUMMARY_LIMITS.nodes and reports the true total", () => {
    const ws = createWorkspace();
    const total = SUMMARY_LIMITS.nodes + 25;
    for (let i = 0; i < total; i++) {
      ws.nodes[`n${i}`] = {
        id: `n${i}`,
        nodeType: "note",
        label: `Node ${i}`,
        position: { x: 0, y: 0 },
      };
    }

    const summary = summarizeWorkspace(ws);
    expect(summary.nodes).toHaveLength(SUMMARY_LIMITS.nodes);
    expect(summary.truncated?.nodes).toBe(total);
  });

  it("caps edges at SUMMARY_LIMITS.edges and reports the true total", () => {
    const ws = createWorkspace();
    // Need enough nodes so every edge has a real source and target.
    const nodeCount = SUMMARY_LIMITS.edges + 10;
    for (let i = 0; i < nodeCount; i++) {
      ws.nodes[`n${i}`] = {
        id: `n${i}`,
        nodeType: "note",
        label: `Node ${i}`,
        position: { x: 0, y: 0 },
      };
    }
    const edgeTotal = SUMMARY_LIMITS.edges + 17;
    for (let i = 0; i < edgeTotal; i++) {
      const id = `e${i}`;
      ws.edges[id] = { id, source: `n${i}`, target: `n${i + 1}`, relationship: "rel" };
    }

    const summary = summarizeWorkspace(ws);
    expect(summary.edges).toHaveLength(SUMMARY_LIMITS.edges);
    expect(summary.truncated?.edges).toBe(edgeTotal);
  });

  it("omits the truncated field on a board that fits", () => {
    const ws = createWorkspace();
    ws.nodes.a = { id: "a", nodeType: "note", label: "A", position: { x: 0, y: 0 } };
    ws.edges.e = { id: "e", source: "a", target: "a", relationship: "self" };

    const summary = summarizeWorkspace(ws);
    expect(summary.truncated).toBeUndefined();
  });
});
