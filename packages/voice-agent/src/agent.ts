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

# Canvas Tools
- 'apply_canvas_operations' changes the board. Call it whenever the user asks to build, add, modify, organize, or connect diagram elements.
- Never give nodes positions or coordinates — Lucent's layout engine places them automatically.
- 'get_board_summary' lists what is currently on the board. Call it before editing or connecting things that already exist, or to answer questions about the board.
- Only confirm a diagram or element is created after 'apply_canvas_operations' succeeds.

# Conversational Flow
- When asked to build or add something: immediately call 'apply_canvas_operations', then speak 1-2 friendly sentences explaining what is now on the board and asking what to add next.
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

    // Proactively greet the user once connected so they know the voice session is live
    session.say("Hey, I'm Lucent! What would you like to build or design on the canvas today?");
  },
});
