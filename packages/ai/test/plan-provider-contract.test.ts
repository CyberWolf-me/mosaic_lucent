import { describe, it, expect, vi } from "vitest";
import {
  OpenAICompatibleProvider,
  AnthropicProvider,
  generateSemanticPlan,
  requestBoundedEdgeRepair,
} from "../src/index.js";
import {
  createWorkspace,
  compileSemanticPlan,
  applyOperations,
  type SemanticPlan,
} from "@lucent/core";
import { PLAN_TOOL_NAME } from "../src/intent.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("Finding B1: Real Provider Plan Generation & Contract Integrity", () => {
  const samplePlan: SemanticPlan = {
    intent: {
      userObjective: "Build auth microservice",
      targetKind: "architecture",
      expectedTopology: "relational_network",
      mutationScope: "new_canvas",
      focusNodeIds: [],
    },
    nodes: [
      { ref: "n1", label: "Client App", role: "client" },
      { ref: "n2", label: "Auth Gateway", role: "service" },
      { ref: "n3", label: "User Directory DB", role: "database" },
    ],
    edges: [
      { from: "n1", to: "n2", relation: "calls", label: "POST /login" },
      { from: "n2", to: "n3", relation: "reads_writes", label: "validate hash" },
    ],
    groups: [
      { ref: "g1", label: "Security Perimeter", memberRefs: ["n2", "n3"] },
    ],
    explanation: "Constructed authentication microservice architecture.",
  };

  it("OpenAICompatibleProvider sends PLAN tool definition and parses valid tool call into SemanticPlan", async () => {
    let capturedBody: any = null;

    const mockFetch = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      capturedBody = JSON.parse((init?.body as string) ?? "{}");
      return jsonResponse(200, {
        choices: [
          {
            message: {
              tool_calls: [
                {
                  function: {
                    name: PLAN_TOOL_NAME,
                    arguments: JSON.stringify(samplePlan),
                  },
                },
              ],
            },
          },
        ],
      });
    });

    const provider = new OpenAICompatibleProvider({
      apiKey: "test-key",
      baseUrl: "https://mock.api/v1/chat/completions",
      model: "gpt-4o",
      fetchImpl: mockFetch as typeof fetch,
      maxRetries: 1,
    });

    const ws = createWorkspace();
    const result = await generateSemanticPlan(provider, ws, "Build auth microservice");

    // 1. Tool definition was passed to the model
    expect(capturedBody).toBeDefined();
    expect(capturedBody.tools).toBeDefined();
    const planTool = capturedBody.tools.find((t: any) => t.function?.name === PLAN_TOOL_NAME);
    expect(planTool).toBeDefined();
    expect(planTool.function.parameters.required).toContain("intent");
    expect(planTool.function.parameters.required).toContain("nodes");

    // 2. Structured response parsed correctly
    expect(result.nodes).toHaveLength(3);
    expect(result.nodes[0].label).toBe("Client App");
    expect(result.nodes[1].label).toBe("Auth Gateway");
    expect(result.nodes[2].label).toBe("User Directory DB");
    expect(result.edges).toHaveLength(2);

    // 3. Survives compilation into valid operations
    const compiled = compileSemanticPlan(ws, result);
    expect(compiled.ok).toBe(true);
    expect(compiled.operations.length).toBeGreaterThan(0);
    const updatedWs = applyOperations(ws, compiled.operations);
    expect(Object.keys(updatedWs.nodes)).toHaveLength(3);
    expect(Object.keys(updatedWs.edges)).toHaveLength(2);
    expect(Object.keys(updatedWs.groups)).toHaveLength(1);
  });

  it("Real provider never silently falls back to mock canned diagram on error", async () => {
    const brokenFetch = vi.fn<typeof fetch>().mockImplementation(async () => {
      return jsonResponse(200, {
        choices: [
          {
            message: {
              content: "I am unable to generate that diagram as requested.",
            },
          },
        ],
      });
    });

    const provider = new OpenAICompatibleProvider({
      apiKey: "test-key",
      baseUrl: "https://mock.api/v1/chat/completions",
      model: "gpt-4o",
      fetchImpl: brokenFetch as typeof fetch,
      maxRetries: 1,
    });

    const ws = createWorkspace();
    // Must throw an explicit error rather than silently returning canned mock nodes ("Option A: PostgreSQL", "Web Client")
    await expect(generateSemanticPlan(provider, ws, "Create payment workflow")).rejects.toThrow();
  });

  it("AnthropicProvider sends PLAN tool definition and parses valid tool call into SemanticPlan", async () => {
    let capturedBody: any = null;

    const mockFetch = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      capturedBody = JSON.parse((init?.body as string) ?? "{}");
      return jsonResponse(200, {
        content: [
          {
            type: "tool_use",
            name: PLAN_TOOL_NAME,
            input: samplePlan,
          },
        ],
      });
    });

    const provider = new AnthropicProvider({
      apiKey: "test-anthropic-key",
      model: "claude-3-7-sonnet",
      fetchImpl: mockFetch as typeof fetch,
      maxRetries: 1,
    });

    const ws = createWorkspace();
    const result = await generateSemanticPlan(provider, ws, "Build auth microservice");

    expect(capturedBody).toBeDefined();
    expect(capturedBody.tools).toBeDefined();
    const planTool = capturedBody.tools.find((t: any) => t.name === PLAN_TOOL_NAME);
    expect(planTool).toBeDefined();

    expect(result.nodes).toHaveLength(3);
    expect(result.edges).toHaveLength(2);
    expect(result.explanation).toBe("Constructed authentication microservice architecture.");
  });

  it("Real provider bounded edge repair passes repair context and returns repaired plan", async () => {
    let capturedBody: any = null;

    const repairedPlan: SemanticPlan = {
      ...samplePlan,
      edges: [
        ...samplePlan.edges,
        { from: "n1", to: "n3", relation: "relates_to", label: "session lookup" },
      ],
      explanation: "Repaired edge connectivity.",
    };

    const mockFetch = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      capturedBody = JSON.parse((init?.body as string) ?? "{}");
      return jsonResponse(200, {
        choices: [
          {
            message: {
              tool_calls: [
                {
                  function: {
                    name: PLAN_TOOL_NAME,
                    arguments: JSON.stringify(repairedPlan),
                  },
                },
              ],
            },
          },
        ],
      });
    });

    const provider = new OpenAICompatibleProvider({
      apiKey: "test-key",
      baseUrl: "https://mock.api/v1/chat/completions",
      model: "gpt-4o",
      fetchImpl: mockFetch as typeof fetch,
      maxRetries: 1,
    });

    const ws = createWorkspace();
    const result = await requestBoundedEdgeRepair(provider, ws, samplePlan, ["User Directory DB"]);

    expect(result.edges).toHaveLength(3);
    expect(capturedBody.messages[1].content).toContain("REPAIR CONTEXT");
    expect(capturedBody.messages[1].content).toContain("User Directory DB");
  });
});
