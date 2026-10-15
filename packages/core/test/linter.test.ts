import { describe, it, expect } from "vitest";
import { createWorkspace } from "../src/model.js";
import { detectSemanticContradictions } from "../src/linter.js";

describe("detectSemanticContradictions", () => {
  it("flags superseded decisions driving active actions", () => {
    const ws = createWorkspace();
    ws.nodes.dec = {
      id: "dec",
      nodeType: "service",
      label: "Old Token Architecture",
      position: { x: 0, y: 0 },
      statement: { kind: "decision", status: "superseded", body: "Deprecated session cookies" },
    };
    ws.nodes.action = {
      id: "action",
      nodeType: "task",
      label: "Implement Cookie Rotation",
      position: { x: 100, y: 0 },
      statement: { kind: "action", status: "accepted", body: "Rotate cookies" },
    };
    ws.edges.e1 = { id: "e1", source: "dec", target: "action", relationship: "drives" };

    const contradictions = detectSemanticContradictions(ws);
    expect(contradictions.some((c) => c.code === "SUPERSEDED_DECISION_DRIVES_ACTION")).toBe(true);
    const found = contradictions.find((c) => c.code === "SUPERSEDED_DECISION_DRIVES_ACTION")!;
    expect(found.severity).toBe("error");
    expect(found.nodeIds).toEqual(["dec", "action"]);
  });

  it("detects circular dependency cycles across service calls", () => {
    const ws = createWorkspace();
    ws.nodes.svc1 = { id: "svc1", nodeType: "service", label: "Svc 1", position: { x: 0, y: 0 } };
    ws.nodes.svc2 = { id: "svc2", nodeType: "service", label: "Svc 2", position: { x: 100, y: 0 } };
    ws.nodes.svc3 = { id: "svc3", nodeType: "service", label: "Svc 3", position: { x: 200, y: 0 } };

    ws.edges.e1 = { id: "e1", source: "svc1", target: "svc2", relationship: "calls" };
    ws.edges.e2 = { id: "e2", source: "svc2", target: "svc3", relationship: "calls" };
    ws.edges.e3 = { id: "e3", source: "svc3", target: "svc1", relationship: "calls" };

    const contradictions = detectSemanticContradictions(ws);
    expect(contradictions.some((c) => c.code === "CIRCULAR_DEPENDENCY")).toBe(true);
  });

  it("warns about orphaned execution tasks with no connections or decisions", () => {
    const ws = createWorkspace();
    ws.nodes.task = {
      id: "task",
      nodeType: "task",
      label: "Floating Task",
      position: { x: 0, y: 0 },
      issue: { type: "task", status: "In Progress", statusCategory: "in_progress" },
    };

    const contradictions = detectSemanticContradictions(ws);
    expect(contradictions.some((c) => c.code === "ORPHANED_EXECUTION_TASK")).toBe(true);
  });

  it("flags architectural layer violations where a database calls the frontend", () => {
    const ws = createWorkspace();
    ws.nodes.db = { id: "db", nodeType: "database", label: "Postgres DB", position: { x: 0, y: 0 } };
    ws.nodes.ui = { id: "ui", nodeType: "frontend", label: "Web UI", position: { x: 100, y: 0 } };
    ws.edges.e1 = { id: "e1", source: "db", target: "ui", relationship: "calls" };

    const contradictions = detectSemanticContradictions(ws);
    expect(contradictions.some((c) => c.code === "ARCHITECTURAL_LAYER_VIOLATION")).toBe(true);
    const found = contradictions.find((c) => c.code === "ARCHITECTURAL_LAYER_VIOLATION")!;
    expect(found.severity).toBe("error");
  });
});
