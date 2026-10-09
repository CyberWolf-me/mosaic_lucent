import { describe, expect, it } from "vitest";
import { createWorkspace } from "@lucent/core";
import { classifyIntentFastPath } from "../src/intent.js";

describe("classifyIntentFastPath", () => {
  it("classifies explicit flowchart requests", () => {
    const ws = createWorkspace();
    const intent = classifyIntentFastPath("Make a flowchart of our login process", ws);
    expect(intent).not.toBeNull();
    expect(intent?.targetKind).toBe("flowchart");
    expect(intent?.expectedTopology).toBe("directed_flow");
    expect(intent?.mutationScope).toBe("new_canvas");
  });

  it("classifies explicit architecture requests", () => {
    const ws = createWorkspace();
    const intent = classifyIntentFastPath("Design our backend microservices architecture", ws);
    expect(intent).not.toBeNull();
    expect(intent?.targetKind).toBe("architecture");
    expect(intent?.expectedTopology).toBe("relational_network");
  });

  it("classifies brainstorming and discussion requests as independent_clusters", () => {
    const ws = createWorkspace();
    const intent = classifyIntentFastPath("Brainstorm four ideas for our product launch", ws);
    expect(intent).not.toBeNull();
    expect(intent?.targetKind).toBe("flowchart");
    expect(intent?.expectedTopology).toBe("independent_clusters");
  });

  it("classifies extend_region on existing boards with add requests", () => {
    const ws = createWorkspace({ diagramKind: "architecture" });
    ws.nodes["auth"] = { id: "auth", label: "Auth Service", nodeType: "service" };

    const intent = classifyIntentFastPath("Add payment gateway connected to auth", ws);
    expect(intent).not.toBeNull();
    expect(intent?.targetKind).toBe("architecture");
    expect(intent?.expectedTopology).toBe("relational_network");
    expect(intent?.mutationScope).toBe("extend_region");
  });

  it("classifies explicit ER diagram and database schema requests", () => {
    const ws = createWorkspace();
    const intent = classifyIntentFastPath(
      "Design database schema and ER diagram for users and orders",
      ws,
    );
    expect(intent).not.toBeNull();
    expect(intent?.targetKind).toBe("er");
    expect(intent?.expectedTopology).toBe("relational_network");
  });

  it("classifies explicit mind map and tree hierarchy requests", () => {
    const ws = createWorkspace();
    const intent = classifyIntentFastPath("Mind map of our Q4 goals and initiatives", ws);
    expect(intent).not.toBeNull();
    expect(intent?.targetKind).toBe("mindmap");
    expect(intent?.expectedTopology).toBe("tree_hierarchy");
  });

  it("classifies matrix and comparison table requests", () => {
    const ws = createWorkspace();
    const intent = classifyIntentFastPath(
      "Create a comparison matrix between PostgreSQL and MongoDB",
      ws,
    );
    expect(intent).not.toBeNull();
    expect(intent?.targetKind).toBe("matrix");
    expect(intent?.expectedTopology).toBe("independent_clusters");
  });

  it("classifies decision tree requests", () => {
    const ws = createWorkspace();
    const intent = classifyIntentFastPath("Build a decision tree for refund authorization", ws);
    expect(intent).not.toBeNull();
    expect(intent?.targetKind).toBe("decisiontree");
    expect(intent?.expectedTopology).toBe("tree_hierarchy");
  });

  it("returns null for ambiguous requests on empty canvas rather than guessing", () => {
    const ws = createWorkspace();
    const intent = classifyIntentFastPath("make something cool and interesting", ws);
    expect(intent).toBeNull();
  });

  it("returns null for unsupported out-of-domain requests", () => {
    const ws = createWorkspace();
    const intent = classifyIntentFastPath("Render a 3D CAD model of an airplane engine", ws);
    expect(intent).toBeNull();
  });
});
