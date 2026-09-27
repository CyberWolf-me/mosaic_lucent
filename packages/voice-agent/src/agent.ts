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
- Talk WITH the person like a teammate at the whiteboard. Never read out a list of what changed or the operations you sent; name the one change that matters, then keep the conversation going: ask ONE short question about what they want next, or suggest the obvious next step.
- When the request is vague, ask one short question before building. When they ask something about the board, answer it (use get_board_summary) instead of changing anything.

# Canvas Tools
- You have the 'apply_canvas_operations' tool to create and edit diagrams, flowcharts, mind maps, architecture diagrams, sticky notes, and wireframes.
- When the user asks you to create, build, add, connect, move, or delete elements, use 'apply_canvas_operations' to update the canvas.
- Supported operations include:
  - CREATE_NODE: { op: "CREATE_NODE", id: string, nodeType: "service"|"database"|"queue"|"gateway"|"storage"|"compute"|"external"|"client"|"decision"|"process"|"start"|"end", label: string, position: { x: number, y: number }, description?: string }
  - CONNECT_NODES: { op: "CONNECT_NODES", id: string, from: string, to: string, label?: string, style?: "solid"|"dashed" }
  - MOVE_NODE: { op: "MOVE_NODE", id: string, position: { x: number, y: number } }
  - DELETE_NODE: { op: "DELETE_NODE", id: string }
  - CREATE_SHAPE: { op: "CREATE_SHAPE", id: string, kind: "sticky"|"box"|"circle"|"frame", x: number, y: number, width: number, height: number, text?: string, color?: string }
  - CREATE_WIREFRAME: { op: "CREATE_WIREFRAME", id: string, title: string, viewport?: "desktop"|"tablet"|"mobile", root: { kind: "screen", children?: Array<{ kind: "header"|"nav"|"sidebar"|"card"|"section"|"row"|"column"|"input"|"button"|"text"|"image"|"table", label?: string, placeholder?: string, variant?: "primary"|"secondary"|"ghost", children?: Array<any> }> } }
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
  /**
   * The board-scoped grant the server minted at dispatch (server
   * agentGrant.ts), sent as `Authorization: Agent <grant>`. There is
   * deliberately no fallback: the agent used to fall back to a static service
   * token from its environment, so every agent edit ran as one shared account
   * regardless of who started it. No grant → the tools refuse to write.
   */
  grant: string;
  serverUrl: string;
}

/** The request headers the agent's server calls carry. */
function authHeaders(config: AgentContextConfig): Record<string, string> {
  return config.grant ? { authorization: `Agent ${config.grant}` } : {};
}

const NO_GRANT = {
  success: false,
  error:
    "This voice agent was not dispatched with a board grant, so it cannot read or change the board. Start it from the board in Lucent.",
} as const;

export function extractConfigFromJob(ctx: JobContext): AgentContextConfig {
  let boardId = "";
  let grant = "";
  const serverUrl = (
    process.env.LUCENT_SERVER_URL ||
    process.env.LUCENT_MCP_URL ||
    "http://127.0.0.1:4387"
  ).replace(/\/+$/, "");

  if (ctx.job.metadata) {
    try {
      const parsed = JSON.parse(ctx.job.metadata) as {
        boardId?: string;
        grant?: string;
      };
      if (parsed.boardId) boardId = parsed.boardId;
      if (parsed.grant) grant = parsed.grant;
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

  return { boardId, grant, serverUrl };
}

/**
 * The model the agent talks to: the deployment's own configured provider
 * (LUCENT_AI_KEY / LUCENT_AI_BASE_URL / LUCENT_AI_MODEL, the server's
 * variables), or OpenAI when only an OpenAI key is set. Anything missing is
 * an error the operator sees at start — never a silent fallback to someone
 * else's endpoint.
 */
export function resolveLlmConfig(env: Record<string, string | undefined>): {
  apiKey: string;
  baseURL?: string;
  model: string;
} {
  const apiKey = env.LUCENT_AI_KEY || env.OPENAI_API_KEY || "";
  const rawBase = env.LUCENT_AI_BASE_URL?.trim() || "";
  const baseURL = rawBase ? rawBase.replace(/\/chat\/completions\/?$/i, "").replace(/\/+$/, "") : undefined;
  const model = env.LUCENT_AI_MODEL?.trim() || (baseURL ? "" : "gpt-4o-mini");
  if (!apiKey) {
    throw new Error(
      "Voice agent: no AI key. Set LUCENT_AI_KEY (and LUCENT_AI_BASE_URL/LUCENT_AI_MODEL for a non-OpenAI provider), the same values the Lucent server uses.",
    );
  }
  if (!model) {
    throw new Error("Voice agent: LUCENT_AI_BASE_URL is set but LUCENT_AI_MODEL is not.");
  }
  return { apiKey, ...(baseURL ? { baseURL } : {}), model };
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
      if (!config.grant) return NO_GRANT;

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
          ...authHeaders(config),
        };

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
      if (!config.grant) return NO_GRANT;

      try {
        const headers = authHeaders(config);

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

    // The same provider the Lucent server is configured with — never a
    // hardcoded third party (it used to default to an external gateway, so
    // board content left the deployment for a model nobody chose).
    const llmConfig = resolveLlmConfig(process.env);

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
      apiKey: llmConfig.apiKey,
      ...(llmConfig.baseURL ? { baseURL: llmConfig.baseURL } : {}),
      model: llmConfig.model,
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
