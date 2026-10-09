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
});
