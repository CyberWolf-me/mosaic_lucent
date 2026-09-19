import { describe, expect, it, vi } from "vitest";
import {
  type AgentContextConfig,
  createApplyOpsTool,
  createGetBoardSummaryTool,
  extractConfigFromJob,
} from "../src/agent.js";
import type { JobContext } from "@livekit/agents";

describe("Voice Agent Context and Tools", () => {
  describe("extractConfigFromJob", () => {
    it("extracts boardId and token from job metadata", () => {
      const mockCtx = {
        job: {
          metadata: JSON.stringify({
            boardId: "brd_test123",
            token: "tok_secret",
          }),
        },
        room: { name: "voice_room" },
      } as unknown as JobContext;

      const config = extractConfigFromJob(mockCtx);
      expect(config.boardId).toBe("brd_test123");
      expect(config.token).toBe("tok_secret");
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
        token: "",
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
        token: "test_token",
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
          authorization: "Bearer test_token",
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

  describe("createGetBoardSummaryTool", () => {
    it("returns formatted components summary from server workspace", async () => {
      const config: AgentContextConfig = {
        boardId: "brd_sample",
        token: "test_token",
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
        shapes: { s1: { id: "s1", kind: "sticky", text: "Architecture note" } },
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
        totalShapes: number;
        totalWireframes: number;
      };

      expect(res.success).toBe(true);
      expect(res.totalNodes).toBe(2);
      expect(res.nodes[0].label).toBe("API Gateway");
      expect(res.totalEdges).toBe(1);
      expect(res.totalShapes).toBe(1);
      expect(res.totalWireframes).toBe(1);

      vi.unstubAllGlobals();
    });
  });
});
