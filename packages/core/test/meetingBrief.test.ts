import { describe, it, expect } from "vitest";
import { createWorkspace } from "../src/model.js";
import { computeMeetingDeltaBrief } from "../src/meetingBrief.js";

describe("computeMeetingDeltaBrief", () => {
  it("computes comprehensive meeting delta: decisions settled, tasks created, architecture added", () => {
    const before = createWorkspace();
    before.nodes.auth = {
      id: "auth",
      nodeType: "service",
      label: "Auth Service",
      position: { x: 0, y: 0 },
      statement: { kind: "decision", status: "open", topic: "Auth" },
    };
    before.nodes.oldTask = {
      id: "oldTask",
      nodeType: "task",
      label: "Audit Auth",
      position: { x: 100, y: 0 },
      issue: { type: "task", status: "Todo", statusCategory: "todo" },
    };

    const after = createWorkspace();
    after.nodes.auth = {
      id: "auth",
      nodeType: "service",
      label: "Auth Service",
      position: { x: 0, y: 0 },
      statement: { kind: "decision", status: "resolved", topic: "Security" },
    };
    after.nodes.oldTask = {
      id: "oldTask",
      nodeType: "task",
      label: "Audit Auth",
      position: { x: 100, y: 0 },
      issue: { type: "task", status: "In Progress", statusCategory: "in_progress" },
    };
    after.nodes.db = {
      id: "db",
      nodeType: "database",
      label: "Redis Cache",
      position: { x: 200, y: 0 },
    };
    after.nodes.newTask = {
      id: "newTask",
      nodeType: "task",
      label: "Deploy Redis Cluster",
      position: { x: 300, y: 0 },
      issue: { type: "task", status: "Todo", statusCategory: "todo", assignee: "alex", priority: "high" },
    };
    after.edges.e1 = { id: "e1", source: "auth", target: "db", relationship: "caches" };

    const brief = computeMeetingDeltaBrief(before, after, "Sprint 24 Architecture Review");

    expect(brief.title).toBe("Sprint 24 Architecture Review");
    expect(brief.decisions.settled).toHaveLength(1);
    expect(brief.decisions.settled[0].label).toBe("Auth Service");
    expect(brief.decisions.settled[0].topic).toBe("Security");

    expect(brief.architecture.addedNodes).toHaveLength(2);
    expect(brief.architecture.newEdges).toHaveLength(1);

    expect(brief.execution.createdTasks).toHaveLength(1);
    expect(brief.execution.createdTasks[0].label).toBe("Deploy Redis Cluster");
    expect(brief.execution.createdTasks[0].assignee).toBe("alex");

    expect(brief.execution.updatedTasks).toHaveLength(1);
    expect(brief.execution.updatedTasks[0].label).toBe("Audit Auth");
    expect(brief.execution.updatedTasks[0].fromStatus).toBe("Todo");
    expect(brief.execution.updatedTasks[0].toStatus).toBe("In Progress");

    expect(brief.markdown).toContain("# Meeting Delta Brief: Sprint 24 Architecture Review");
    expect(brief.markdown).toContain("Key Architectural Decisions Settled");
    expect(brief.markdown).toContain("Action Items & Execution Progress");
    expect(brief.markdown).toContain("@alex");
  });
});
