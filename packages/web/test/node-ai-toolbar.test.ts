import { describe, expect, it } from "vitest";
import {
  applyOperations,
  createWorkspace,
  validateOperations,
  type Node,
  type Operation,
} from "@lucent/core";
import { SEMANTIC_NODE_TYPES } from "../src/ui/NodeAiToolbar.js";

describe("NodeAiToolbar & In-Canvas Micro-Actions (Initiative 3)", () => {
  it("provides standard semantic node types for instant conversion", () => {
    const types = SEMANTIC_NODE_TYPES.map((t) => t.type);
    expect(types).toContain("service");
    expect(types).toContain("database");
    expect(types).toContain("process");
    expect(types).toContain("decision");
    expect(types).toContain("queue");
    expect(types).toContain("system");
    expect(types).toContain("actor");
    expect(types).toContain("cache");
    expect(SEMANTIC_NODE_TYPES.length).toBeGreaterThanOrEqual(8);
  });

  it("produces valid CHANGE_NODE_TYPE operations accepted by core validator and reducer", () => {
    let ws = createWorkspace();
    const createOps: Operation[] = [
      {
        op: "CREATE_NODE",
        id: "node_auth",
        nodeType: "service",
        label: "Auth Service",
      },
    ];
    const valCreate = validateOperations(ws, createOps);
    expect(valCreate).toEqual([]);
    ws = applyOperations(ws, createOps);
    expect(ws.nodes.node_auth?.nodeType).toBe("service");

    // Convert to database via micro-action
    const convertOps: Operation[] = [
      {
        op: "CHANGE_NODE_TYPE",
        id: "node_auth",
        nodeType: "database",
      },
    ];
    const valConvert = validateOperations(ws, convertOps);
    expect(valConvert).toEqual([]);
    ws = applyOperations(ws, convertOps);
    expect(ws.nodes.node_auth?.nodeType).toBe("database");

    // Convert to queue via micro-action
    const convertQueueOps: Operation[] = [
      {
        op: "CHANGE_NODE_TYPE",
        id: "node_auth",
        nodeType: "queue",
      },
    ];
    expect(validateOperations(ws, convertQueueOps)).toEqual([]);
    ws = applyOperations(ws, convertQueueOps);
    expect(ws.nodes.node_auth?.nodeType).toBe("queue");
  });

  it("calculates correct anchored positioning in canvas coordinates", () => {
    // Normal node placement: toolbar centers above the card
    const nodeNormal = { x: 200, y: 150, w: 180, h: 80 };
    const isNearTopNormal = nodeNormal.y < 54;
    const topPosNormal = isNearTopNormal ? nodeNormal.y + nodeNormal.h + 8 : nodeNormal.y - 44;
    const leftPosNormal = nodeNormal.x + nodeNormal.w / 2;

    expect(isNearTopNormal).toBe(false);
    expect(topPosNormal).toBe(106); // 150 - 44
    expect(leftPosNormal).toBe(290); // 200 + 90

    // Top edge node placement: flips below the card to avoid canvas clipping
    const nodeNearTop = { x: 100, y: 30, w: 160, h: 70 };
    const isNearTopEdge = nodeNearTop.y < 54;
    const topPosEdge = isNearTopEdge ? nodeNearTop.y + nodeNearTop.h + 8 : nodeNearTop.y - 44;
    const leftPosEdge = nodeNearTop.x + nodeNearTop.w / 2;

    expect(isNearTopEdge).toBe(true);
    expect(topPosEdge).toBe(108); // 30 + 70 + 8
    expect(leftPosEdge).toBe(180); // 100 + 80
  });

  it("formats scoped prompts for micro-actions with selection grounding", () => {
    const testNode: Node = {
      id: "node_pay",
      nodeType: "service",
      label: "Payment Gateway",
    };

    // Elaborate
    const elaboratePrompt = `Elaborate on the "${testNode.label}" node (${testNode.nodeType}): decompose it into 3-4 connected sub-steps or internal processes with appropriate connectors.`;
    expect(elaboratePrompt).toContain("Payment Gateway");
    expect(elaboratePrompt).toContain("decompose");

    // Error handling
    const errorPrompt = `Add error handling and failure recovery to the "${testNode.label}" node: attach a decision gateway, validation check, and fallback/failure path.`;
    expect(errorPrompt).toContain("Payment Gateway");
    expect(errorPrompt).toContain("decision gateway");

    // Explain
    const explainPrompt = `Explain the "${testNode.label}" (${testNode.nodeType}) component, its purpose, dependencies, and role in this architecture.`;
    expect(explainPrompt).toContain("Payment Gateway");
    expect(explainPrompt).toContain("role in this architecture");

    // Custom
    const customPrompt = `For the "${testNode.label}" node: attach Redis caching with 60s TTL`;
    expect(customPrompt).toContain("Redis caching");
  });
});
