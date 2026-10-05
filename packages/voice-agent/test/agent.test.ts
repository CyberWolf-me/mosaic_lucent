import { describe, expect, it, vi } from "vitest";
import {
  type AgentContextConfig,
  applyToolParameters,
  createApplyOpsTool,
  createGetBoardSummaryTool,
  extractConfigFromJob,
  resolveLlmConfig,
} from "../src/agent.js";
import type { JobContext } from "@livekit/agents";

describe("Voice Agent Context and Tools", () => {
  describe("extractConfigFromJob", () => {
    it("extracts boardId and the board grant from job metadata", () => {
      const mockCtx = {
        job: {
          metadata: JSON.stringify({
            boardId: "brd_test123",
            grant: "ag1.body.sig",
          }),
        },
        room: { name: "voice_room" },
      } as unknown as JobContext;

      const config = extractConfigFromJob(mockCtx);
      expect(config.boardId).toBe("brd_test123");
      expect(config.grant).toBe("ag1.body.sig");
    });

    it("falls back to extracting boardId from room name if metadata is missing", () => {
      const mockCtx = {
        job: {},
        room: { name: "voice_brd_abc789" },
      } as unknown as JobContext;

      const config = extractConfigFromJob(mockCtx);
      expect(config.boardId).toBe("brd_abc789");
    });

    it("handles plain brd_ room names cleanly", () => {
      const mockCtx = {
        job: { metadata: "" },
        room: { name: "brd_standalone999" },
      } as unknown as JobContext;

      const config = extractConfigFromJob(mockCtx);
      expect(config.boardId).toBe("brd_standalone999");
    });
  });

  describe("createApplyOpsTool", () => {
    it("rejects tool call when boardId is missing", async () => {
      const config: AgentContextConfig = {
        boardId: "",
        grant: "",
        serverUrl: "http://127.0.0.1:4387",
      };
      const tool = createApplyOpsTool(config);
      const res = (await tool.execute(
        {
          operations: [{ op: "CREATE_NODE", id: "n1", label: "Test" }],
        },
        {} as never,
      )) as { success: boolean; error?: string };

      expect(res.success).toBe(false);
      expect(res.error).toMatch(/No boardId/i);
    });

    it("filters human-only operations and dispatches repaired ops to server", async () => {
      const config: AgentContextConfig = {
        boardId: "brd_sample",
        grant: "test_grant",
        serverUrl: "http://127.0.0.1:4387",
      };

      const fetchSpy = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ seq: 42, applied: 1 }),
      });
      vi.stubGlobal("fetch", fetchSpy);

      const tool = createApplyOpsTool(config);
      const res = (await tool.execute(
        {
          operations: [
            { op: "MOVE_NODE", id: "n1", position: { x: 10, y: 20 } }, // AI forbidden / human-only op
            { op: "CREATE_NODE", id: "n1", label: "Auth Service" },
          ],
          explanation: "Added Auth Service",
        },
        {} as never,
      )) as { success: boolean; applied?: number };

      expect(res.success).toBe(true);
      expect(res.applied).toBe(1);
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("http://127.0.0.1:4387/api/boards/brd_sample/ops");
      expect(init.headers).toEqual(
        expect.objectContaining({
          authorization: "Agent test_grant",
          "content-type": "application/json",
        }),
      );

      const payload = JSON.parse(init.body as string) as {
        ops: Array<{ op: string; author?: string }>;
        label: string;
      };
      expect(payload.ops.length).toBe(1);
      expect(payload.ops[0].op).toBe("CREATE_NODE");
      expect(payload.label).toBe("Added Auth Service");

      vi.unstubAllGlobals();
    });
  });

  describe("the operation contract", () => {
    it("offers the model core's derived operation schema, not free-form objects", () => {
      const params = applyToolParameters();
      const json = JSON.stringify(params);
      const properties = params.properties as Record<string, unknown>;
      expect(Object.keys(properties).sort()).toEqual(["clarification", "explanation", "operations"]);
      // Real variants, with their real fields: an edge names its ends as the
      // contract does, which the old hand-written list got wrong (from/to).
      expect(json).toContain('"CONNECT_NODES"');
      expect(json).toContain('"CREATE_NODE"');
      expect(json).not.toContain('"from"');
    });

    it("tells the model nothing changed when the board refuses a batch", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 422,
          text: async () =>
            JSON.stringify({
              error: "operations failed validation",
              errors: [
                { index: 1, op: "CONNECT_NODES", message: 'source node "a" does not exist' },
              ],
            }),
        }),
      );
      const tool = createApplyOpsTool({
        boardId: "brd_sample",
        grant: "g",
        serverUrl: "http://127.0.0.1:4387",
      });
      const res = (await tool.execute(
        { operations: [{ op: "CREATE_NODE", id: "n1", label: "X" }] },
        {} as never,
      )) as { success: boolean; changed?: boolean; error?: string; next?: string };
      expect(res).toMatchObject({ success: false, changed: false });
      expect(res.error).toContain('operation 1 (CONNECT_NODES): source node "a" does not exist');
      expect(res.next).toMatch(/Nothing on the board changed/);
      vi.unstubAllGlobals();
    });
  });

  describe("the board grant", () => {
    it("refuses to write without a grant — no shared service-token fallback", async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);
      const tool = createApplyOpsTool({
        boardId: "brd_sample",
        grant: "",
        serverUrl: "http://127.0.0.1:4387",
      });
      const res = (await tool.execute(
        { operations: [{ op: "CREATE_NODE", id: "n1", label: "X" }] },
        {} as never,
      )) as { success: boolean; error?: string };
      expect(res.success).toBe(false);
      expect(res.error).toMatch(/grant/i);
      expect(fetchSpy).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    });
  });

  describe("resolveLlmConfig", () => {
    it("uses the deployment's own provider variables", () => {
      expect(
        resolveLlmConfig({
          LUCENT_AI_KEY: "k",
          LUCENT_AI_BASE_URL: "https://gw.example/v1/chat/completions",
          LUCENT_AI_MODEL: "m",
        }),
      ).toEqual({ apiKey: "k", baseURL: "https://gw.example/v1", model: "m" });
    });

    it("never falls back to a third-party endpoint", () => {
      expect(() => resolveLlmConfig({})).toThrow(/no AI key/);
      expect(() =>
        resolveLlmConfig({ LUCENT_AI_KEY: "k", LUCENT_AI_BASE_URL: "https://gw.example" }),
      ).toThrow(/LUCENT_AI_MODEL/);
      // An OpenAI key alone means OpenAI itself: no baseURL override.
      expect(resolveLlmConfig({ OPENAI_API_KEY: "sk" })).toEqual({
        apiKey: "sk",
        model: "gpt-4o-mini",
      });
    });
  });

  describe("createGetBoardSummaryTool", () => {
    it("returns formatted components summary from server workspace", async () => {
      const config: AgentContextConfig = {
        boardId: "brd_sample",
        grant: "test_grant",
        serverUrl: "http://127.0.0.1:4387",
      };

      const mockWorkspace = {
        nodes: {
          n1: {
            id: "n1",
            nodeType: "service",
            label: "API Gateway",
            position: { x: 100, y: 100 },
          },
          n2: {
            id: "n2",
            nodeType: "database",
            label: "Users DB",
            position: { x: 350, y: 100 },
          },
        },
        edges: {
          e1: {
            id: "e1",
            source: "n1",
            target: "n2",
            relationship: "queries",
          },
        },
        groups: { g1: { id: "g1", label: "Backend Services" } },
        shapes: { s1: { id: "s1", kind: "sticky", text: "Architecture note", position: { x: 400, y: 200 }, size: { width: 200, height: 160 } } },
        wireframes: {
          w1: {
            id: "w1",
            title: "App Layout",
            viewport: "desktop",
            root: { kind: "screen" },
          },
        },
      };

      const fetchSpy = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          title: "Sample Architecture",
          workspace: mockWorkspace,
        }),
      });
      vi.stubGlobal("fetch", fetchSpy);

      const tool = createGetBoardSummaryTool(config);
      const res = (await tool.execute({}, {} as never)) as {
        success: boolean;
        totalNodes: number;
        nodes: Array<{ id: string; label: string }>;
        totalEdges: number;
        totalGroups: number;
        groups: Array<{ id: string; label: string }>;
        totalShapes: number;
        shapes: Array<{ id: string; x?: number; y?: number }>;
        totalWireframes: number;
      };

      expect(res.success).toBe(true);
      expect(res.totalNodes).toBe(2);
      expect(res.nodes[0].label).toBe("API Gateway");
      expect(res.totalEdges).toBe(1);
      expect(res.totalGroups).toBe(1);
      expect(res.groups[0].label).toBe("Backend Services");
      expect(res.totalShapes).toBe(1);
      expect(res.shapes[0].x).toBe(400);
      expect(res.totalWireframes).toBe(1);

      vi.unstubAllGlobals();
    });
  });
});
