import { type JobContext, defineAgent, llm, voice } from "@livekit/agents";
import * as deepgram from "@livekit/agents-plugin-deepgram";
import * as openai from "@livekit/agents-plugin-openai";
import * as silero from "@livekit/agents-plugin-silero";
import {
  type JsonSchema,
  type Operation,
  isHumanOnlyOperation,
  repairOperations,
  sanitizeRawOperations,
  stampAuthorship,
  toolParametersJsonSchema,
  type Workspace,
} from "@lucent/core";
import type { JSONSchema7 } from "json-schema";
import { z } from "zod";

export const VOICE_AGENT_INSTRUCTIONS = `You are Lucent Voice, an expert visual architecture, design, and diagramming AI co-pilot.
You are interacting with the user over a real-time duplex voice call while they look at an infinite visual canvas.

# Spoken Voice Rules
- Keep your spoken responses concise, conversational, and natural (1 to 3 sentences maximum).
- Respond in plain conversational text only. NEVER use markdown, bullet points, asterisks, tables, or raw JSON in your speech.
- Never recite technical IDs (like "node_123" or "brd_456") to the user. Refer to components by their human labels (e.g. "the Auth Service", "the API Gateway").
- Talk WITH the person like an active, collaborative teammate at the whiteboard. Never read out raw change lists. Briefly state what you did or answer their question, then suggest the next step or ask what they'd like next.
- When the user asks a question, share advice or ideas proactively, and offer to diagram them.

# Canvas Tools & Organizing Elements
- 'construct_diagram' constructs, extends, connects, or organizes diagrams from conversational speech using Lucent's unified understanding pipeline. Prefer this when building new systems, flows, mind maps, or expanding diagrams.
- 'apply_canvas_operations' applies direct structured operations. Call it when doing explicit edits.
- 'get_board_summary' lists what is currently on the board (nodes, edges, groups, shapes/notes). Call it before modifying or organizing existing elements, or to answer questions.
- Never give nodes positions or coordinates — Lucent's layout engine places nodes automatically.
- Sticky notes and manual shapes DO have explicit (x, y) coordinates:
  - When the user asks to organize, rearrange, or clean up notes/stickies: call 'get_board_summary' to inspect them, then emit 'MOVE_SHAPE' with appropriate coordinates to arrange them into neat columns, rows, or a grid (e.g. 240px horizontal spacing, 180px vertical spacing).
  - To organize semantic nodes: group related nodes using 'CREATE_GROUP' (and update nodes with 'groupId'), connect flows using 'CONNECT_NODES', or transform diagram structure.
  - DO NOT emit 'SET_LAYOUT_INTENT' alone to satisfy an organization request: 'SET_LAYOUT_INTENT' only updates intent metadata and does NOT move, align, or reorganize items on the canvas. To actually reorganize, emit 'MOVE_SHAPE' for shapes or 'CREATE_GROUP' / 'CONNECT_NODES' for nodes.
- CRITICAL: Never claim you created, moved, or reorganized elements unless 'apply_canvas_operations' succeeded with success: true.
- If 'apply_canvas_operations' fails or returns an error, speak truthfully: tell the user you encountered an issue making the canvas change and ask how they would like it adjusted.

# Conversational Flow
- When asked to build or add something: call 'apply_canvas_operations' with valid operations. After the tool succeeds, speak 1-2 friendly sentences explaining what is now on the board and asking what to add next.
- If the user greets you or asks how you can help, warmly introduce yourself as Lucent and suggest what kinds of diagrams (system architectures, flowcharts, user journeys, wireframes) you can create together.
- If the user interrupts mid-sentence, immediately adapt to their new instruction.
`;

/**
 * The apply tool's parameters: the same JSON Schema, derived from core's
 * operation union, that the text pipeline and the MCP server hand their
 * models. It used to be "an array of any objects" beside a hand-written list
 * of operation shapes that had drifted from the contract (CONNECT_NODES with
 * `from`/`to`, nodes with coordinates), so the server refused most of what
 * the agent sent. `reply` is dropped: the agent speaks for itself.
 */
export function applyToolParameters(): JsonSchema {
  const params = toolParametersJsonSchema();
  const properties = { ...(params.properties as Record<string, unknown>) };
  delete properties.reply;
  return { ...params, properties };
}

/** The validator's refusal, as a short list the model can act on. */
function refusalReasons(body: string): string {
  try {
    const parsed = JSON.parse(body) as {
      error?: string;
      errors?: Array<{ index?: number; op?: string; message?: string }>;
    };
    if (Array.isArray(parsed.errors) && parsed.errors.length > 0) {
      return parsed.errors
        .slice(0, 8)
        .map((e) => `operation ${e.index ?? "?"} (${e.op ?? "?"}): ${e.message ?? "invalid"}`)
        .join("; ");
    }
    if (parsed.error) return parsed.error;
  } catch {
    /* not JSON */
  }
  return body.slice(0, 500);
}

/** What the model is told when a write fails — so it can't mistake it for success. */
const NOTHING_CHANGED =
  "Nothing on the board changed. Correct the operations using these errors and call apply_canvas_operations once more; if it fails again, tell the person plainly that it didn't work. Do not say the change is done.";

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
  /** The model the agent talks to, reported on its writes (ADR 0047's run record). */
  model?: string;
}

/** The request headers the agent's server calls carry. */
function authHeaders(config: AgentContextConfig): Record<string, string> {
  return {
    ...(config.grant ? { authorization: `Agent ${config.grant}` } : {}),
    ...(config.model ? { "x-lucent-model": config.model } : {}),
  };
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
  const baseURL = rawBase
    ? rawBase.replace(/\/chat\/completions\/?$/i, "").replace(/\/+$/, "")
    : undefined;
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
      "Apply structured visual operations to create, edit, connect, or delete elements on the Lucent canvas. Returns success: false, with the reasons, when the board refuses them — then nothing changed.",
    parameters: applyToolParameters() as JSONSchema7,
    execute: async (args: { operations?: unknown; explanation?: unknown }) => {
      const operations = Array.isArray(args.operations) ? (args.operations as unknown[]) : [];
      const explanation = typeof args.explanation === "string" ? args.explanation : undefined;
      if (!config.boardId) {
        return { success: false, error: "No boardId available in context" };
      }
      if (!config.grant) return NO_GRANT;

      // Sanitize model operations for field tolerances, then filter human-only operations
      const sanitized = sanitizeRawOperations(operations);
      const opList = Array.isArray(sanitized) ? sanitized : [];
      const candidate = opList.filter(
        (op): op is Operation =>
          typeof op === "object" &&
          op !== null &&
          "op" in op &&
          typeof (op as { op: unknown }).op === "string",
      );
      const filtered = candidate.filter((op) => !isHumanOnlyOperation(op.op));
      if (filtered.length === 0) {
        return {
          success: false,
          error:
            "No valid canvas operations were found. To move or rearrange items, emit MOVE_SHAPE with x/y positions, or CREATE_GROUP/CONNECT_NODES for diagram nodes.",
        };
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
          return {
            success: false,
            changed: false,
            error: `The board refused these operations (${res.status}): ${refusalReasons(await res.text())}`,
            next: NOTHING_CHANGED,
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

export function createOrchestrateDiagramTool(config: AgentContextConfig) {
  return llm.tool({
    description:
      "Construct, extend, or organize structured diagrams on the canvas from conversational speech. Automatically infers diagram type, resolves symbolic relationships, and lays out components.",
    parameters: z.object({
      prompt: z.string().describe("What the user asked to build, connect, or diagram"),
    }),
    execute: async ({ prompt }) => {
      if (!config.boardId) return { success: false, error: "No boardId available in context" };
      if (!config.grant) return NO_GRANT;

      try {
        const headers: Record<string, string> = {
          "content-type": "application/json",
          ...authHeaders(config),
        };

        const res = await fetch(`${config.serverUrl}/api/boards/${config.boardId}/orchestrate`, {
          method: "POST",
          headers,
          body: JSON.stringify({ prompt }),
        });

        if (!res.ok) {
          const text = await res.text();
          return { success: false, error: refusalReasons(text) };
        }

        const data = (await res.json()) as {
          ok: boolean;
          operations?: unknown[];
          explanation?: string;
        };
        return {
          success: true,
          message: data.explanation || "Applied diagram updates to the canvas.",
        };
      } catch (err) {
        return { success: false, error: (err as Error).message };
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
          groupId: n.groupId,
          pos: n.position,
        }));
        const edges = Object.values(ws.edges || {}).map((e) => ({
          from: e.source,
          to: e.target,
          label: e.relationship,
        }));
        const groups = Object.values(ws.groups || {}).map((g) => ({
          id: g.id,
          label: g.label,
          kind: g.kind,
        }));
        const shapes = Object.values(ws.shapes || {}).map((s) => ({
          id: s.id,
          kind: s.kind,
          text: s.text,
          x: s.position?.x,
          y: s.position?.y,
          width: s.size?.width,
          height: s.size?.height,
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
          totalGroups: groups.length,
          groups,
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
      process.env.DEEPGRAM_API_KEY || process.env.LUCENT_STT_KEY || process.env.LUCENT_TTS_KEY;

    // The same provider the Lucent server is configured with — never a
    // hardcoded third party (it used to default to an external gateway, so
    // board content left the deployment for a model nobody chose).
    const llmConfig = resolveLlmConfig(process.env);
    config.model = llmConfig.model;

    const stt = new deepgram.STT({
      apiKey: deepgramKey,
      model: "nova-3",
      language: "en",
      // Its own name, heard as "Lisa" or "Lucid" without a hint.
      keyterm: ["Lucent"],
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
    const constructDiagram = createOrchestrateDiagramTool(config);

    // 5. Initialize the AgentSession orchestrator
    // Disable preemptiveGeneration and raise endpointing minDelay to 1000ms.
    // This stops rapid intermediate STT chunk triggers from generating concurrent
    // LLM calls that exhaust provider rate limits (e.g. 5 req/min) and create latency.
    const session = new voice.AgentSession({
      stt,
      tts,
      vad,
      llm: llmInstance,
      turnHandling: {
        preemptiveGeneration: { enabled: false },
        endpointing: { minDelay: 1000, maxDelay: 4000 },
      },
    });

    const agent = new voice.Agent({
      instructions: VOICE_AGENT_INSTRUCTIONS,
      tools: {
        apply_canvas_operations: applyOps,
        construct_diagram: constructDiagram,
        get_board_summary: getSummary,
      },
    });

    // 6. Start the voice session in the room
    await session.start({
      room: ctx.room,
      agent,
    });

    // Proactively greet the user once connected so they know the voice session is live
    session.say("Hey, I'm Lucent! What would you like to build or design on the canvas today?");
  },
});
