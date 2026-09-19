import {
  type JobContext,
  defineAgent,
  llm,
  voice,
} from "@livekit/agents";
import * as deepgram from "@livekit/agents-plugin-deepgram";
import * as openai from "@livekit/agents-plugin-openai";
import * as silero from "@livekit/agents-plugin-silero";
import {
  type Operation,
  isHumanOnlyOperation,
  repairOperations,
  stampAuthorship,
  type Workspace,
} from "@lucent/core";
import { z } from "zod";

export const VOICE_AGENT_INSTRUCTIONS = `You are Lucent Voice, an expert visual architecture, design, and diagramming AI co-pilot.
You are interacting with the user over a real-time duplex voice call while they look at an infinite visual canvas.

# Spoken Voice Rules
- Keep your spoken responses concise, conversational, and natural (1 to 3 sentences maximum).
- Respond in plain conversational text only. NEVER use markdown, bullet points, asterisks, tables, or raw JSON in your speech.
- Never recite technical IDs (like "node_123" or "brd_456") to the user. Refer to components by their human labels (e.g. "the Auth Service", "the API Gateway").
- Confirm visual actions naturally as you do them (e.g., "I've created the architecture diagram with your API gateway, auth, and database services.").

# Canvas Tools
- You have the 'apply_canvas_operations' tool to create and edit diagrams, flowcharts, mind maps, architecture diagrams, sticky notes, and wireframes.
- When the user asks you to create, build, add, connect, move, or delete elements, use 'apply_canvas_operations' to update the canvas.
- Supported operations include:
  - CREATE_NODE: { op: "CREATE_NODE", id: string, nodeType: "service"|"database"|"queue"|"gateway"|"storage"|"compute"|"external"|"client"|"decision"|"process"|"start"|"end", label: string, position: { x: number, y: number }, description?: string }
  - CONNECT_NODES: { op: "CONNECT_NODES", id: string, from: string, to: string, label?: string, style?: "solid"|"dashed" }
  - MOVE_NODE: { op: "MOVE_NODE", id: string, position: { x: number, y: number } }
  - DELETE_NODE: { op: "DELETE_NODE", id: string }
  - CREATE_SHAPE: { op: "CREATE_SHAPE", id: string, kind: "sticky"|"box"|"circle"|"frame", x: number, y: number, width: number, height: number, text?: string, color?: string }
  - CREATE_WIREFRAME: { op: "CREATE_WIREFRAME", id: string, kind: "button"|"input"|"card"|"table"|"modal"|"navbar"|"sidebar", x: number, y: number, width: number, height: number, props?: Record<string, unknown> }
- Always position nodes cleanly with spacing (e.g. horizontal flow x: 100, 350, 600, 850; vertical flow y: 100, 250, 400).
- You have the 'get_board_summary' tool to inspect what is currently on the user's canvas. Call this if you need to know what exists before modifying or answering specific questions about the layout.

# Conversational Flow
- When asked to build something:
  1. Call 'apply_canvas_operations' with the operations.
  2. Briefly tell the user what you constructed and ask if they'd like to refine or expand it.
- If the user interrupts mid-sentence, immediately adapt to their new instruction.
`;

export interface AgentContextConfig {
  boardId: string;
  token: string;
  serverUrl: string;
}

export function extractConfigFromJob(ctx: JobContext): AgentContextConfig {
  let boardId = "";
  let token = process.env.LUCENT_MCP_TOKEN || process.env.LUCENT_VOICE_AGENT_TOKEN || "";
  const serverUrl = (
    process.env.LUCENT_SERVER_URL ||
    process.env.LUCENT_MCP_URL ||
    "http://127.0.0.1:4387"
  ).replace(/\/+$/, "");

  if (ctx.job.metadata) {
    try {
      const parsed = JSON.parse(ctx.job.metadata) as {
        boardId?: string;
        token?: string;
      };
      if (parsed.boardId) boardId = parsed.boardId;
      if (parsed.token) token = parsed.token;
    } catch {
      // Ignored if metadata is not JSON
    }
  }

  if (!boardId && ctx.room.name) {
    const match = ctx.room.name.match(/brd_[a-zA-Z0-9_-]+/i);
    if (match) {
      boardId = match[0];
    }
  }

  return { boardId, token, serverUrl };
}

export function createApplyOpsTool(config: AgentContextConfig) {
  return llm.tool({
    description:
      "Apply structured visual operations to create, edit, connect, or delete elements on the Lucent canvas.",
    parameters: z.object({
      operations: z
        .array(z.record(z.unknown()))
        .describe(
          "List of canvas operations: CREATE_NODE, CONNECT_NODES, MOVE_NODE, DELETE_NODE, CREATE_SHAPE, CREATE_WIREFRAME, etc.",
        ),
      explanation: z
        .string()
        .optional()
        .describe("Brief 1-sentence explanation of what was changed on the canvas"),
    }),
    execute: async ({ operations, explanation }) => {
      if (!config.boardId) {
        return { success: false, error: "No boardId available in context" };
      }

      // Filter out human-only operations and repair candidate operations
      const candidate = operations.filter(
        (op): op is Operation =>
          typeof op === "object" &&
          op !== null &&
          "op" in op &&
          typeof (op as { op: unknown }).op === "string",
      );
      const filtered = candidate.filter((op) => !isHumanOnlyOperation(op.op));
      if (filtered.length === 0) {
        return { success: false, error: "No valid operations provided" };
      }

      const stamped = stampAuthorship(filtered, "assistant");
      const repaired = repairOperations(stamped);

      try {
        const headers: Record<string, string> = {
          "content-type": "application/json",
        };
        if (config.token) {
          headers["authorization"] = `Bearer ${config.token}`;
        }

        const res = await fetch(`${config.serverUrl}/api/boards/${config.boardId}/ops`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            ops: repaired,
            label: explanation || "Voice Agent",
          }),
        });

        if (!res.ok) {
          const errText = await res.text();
          return {
            success: false,
            error: `Server rejected operations (${res.status}): ${errText}`,
          };
        }

        const data = (await res.json()) as { seq?: number; applied?: number };
        return {
          success: true,
          applied: data.applied ?? repaired.length,
          seq: data.seq,
          message: `Successfully applied ${repaired.length} operations to the canvas.`,
        };
      } catch (err) {
        return {
          success: false,
          error: `Failed to dispatch operations: ${(err as Error).message}`,
        };
      }
    },
  });
}

export function createGetBoardSummaryTool(config: AgentContextConfig) {
  return llm.tool({
    description:
      "Get a concise summary of all components currently on the Lucent canvas (nodes, edges, shapes, wireframes).",
    parameters: z.object({}),
    execute: async () => {
      if (!config.boardId) {
        return { success: false, error: "No boardId available in context" };
      }

      try {
        const headers: Record<string, string> = {};
        if (config.token) {
          headers["authorization"] = `Bearer ${config.token}`;
        }

        const res = await fetch(`${config.serverUrl}/api/boards/${config.boardId}`, {
          headers,
        });

        if (!res.ok) {
          return {
            success: false,
            error: `Failed to fetch board (${res.status})`,
          };
        }

        const data = (await res.json()) as { workspace: Workspace; title?: string };
        const ws = data.workspace || {};

        const nodes = Object.values(ws.nodes || {}).map((n) => ({
          id: n.id,
          type: n.nodeType,
          label: n.label,
          pos: n.position,
        }));
        const edges = Object.values(ws.edges || {}).map((e) => ({
          from: e.source,
          to: e.target,
          label: e.relationship,
        }));
        const shapes = Object.values(ws.shapes || {}).map((s) => ({
          id: s.id,
          kind: s.kind,
          text: s.text,
        }));
        const wireframes = Object.values(ws.wireframes || {}).map((w) => ({
          id: w.id,
          title: w.title,
          viewport: w.viewport,
        }));

        return {
          success: true,
          boardId: config.boardId,
          title: data.title,
          totalNodes: nodes.length,
          nodes,
          totalEdges: edges.length,
          edges,
          totalShapes: shapes.length,
          shapes,
          totalWireframes: wireframes.length,
          wireframes,
        };
      } catch (err) {
        return {
          success: false,
          error: `Failed to read board: ${(err as Error).message}`,
        };
      }
    },
  });
}

export default defineAgent({
  entry: async (ctx: JobContext) => {
    // 1. Connect agent worker to the LiveKit room
    await ctx.connect();

    // 2. Extract configuration (boardId, token, serverUrl)
    const config = extractConfigFromJob(ctx);

    // 3. Initialize STT, TTS, VAD, and LLM
    const deepgramKey =
      process.env.DEEPGRAM_API_KEY ||
      process.env.LUCENT_STT_KEY ||
      process.env.LUCENT_TTS_KEY;

    const llmKey =
      process.env.LUCENT_AI_KEY ||
      process.env.OPENAI_API_KEY ||
      "";
    const llmBaseUrl =
      process.env.LUCENT_AI_BASE_URL ||
      "https://kiosapi.com/v1";
    const llmModel =
      process.env.LUCENT_AI_MODEL ||
      "agnes-2.5-flash";

    const stt = new deepgram.STT({
      apiKey: deepgramKey,
      model: "nova-3",
      language: "en",
    });

    const tts = new deepgram.TTS({
      apiKey: deepgramKey,
      model: "aura-asteria-en",
    });

    const vad = await silero.VAD.load();

    const llmInstance = new openai.LLM({
      apiKey: llmKey,
      baseURL: llmBaseUrl,
      model: llmModel,
    });

    // 4. Create Voice Agent Tools
    const applyOps = createApplyOpsTool(config);
    const getSummary = createGetBoardSummaryTool(config);

    // 5. Initialize the AgentSession orchestrator
    const session = new voice.AgentSession({
      stt,
      tts,
      vad,
      llm: llmInstance,
    });

    const agent = new voice.Agent({
      instructions: VOICE_AGENT_INSTRUCTIONS,
      tools: {
        apply_canvas_operations: applyOps,
        get_board_summary: getSummary,
      },
    });

    // 6. Start the voice session in the room
    await session.start({
      room: ctx.room,
      agent,
    });
  },
});
