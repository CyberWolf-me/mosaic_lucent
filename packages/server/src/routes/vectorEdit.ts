import { z } from "zod";
import { vectorDataSchema, type VectorData } from "@lucent/core";
import {
  VECTOR_EDIT_LIMITS,
  assembleVectorEdit,
  vectorEditable,
  type VectorEditRequest,
} from "@lucent/ai";
import { providerFact } from "../modelRouter.js";
import type { StoredBoard } from "../boards.js";
import type { RegisterRoutes } from "./context.js";

/**
 * POST /api/vector/edit (docs/26 §6.3, V3) — "edit with AI" for one vector.
 *
 *   body   { vector, instruction, boardId? }
 *   reply  { vector, summary, dropped, model? }
 *
 * The same gates as generation — CSRF, auth, the editor floor when a board is
 * named, the board's AI boundary, the org's provider policy, the monthly
 * allowance. Unlike sorting stickies there is no honest offline answer to
 * "round the corners", so a refused boundary is a 403 and a provider without
 * the call type a 503, not a silent fallback.
 *
 * The drawing is sent as structured paths (never SVG text); the reply is the
 * edited vector after `assembleVectorEdit` has normalized and schema-checked
 * it. Nothing is written to the board here: the person previews before and
 * after, and applying is their own UPDATE_SHAPE — validated, shared, undoable.
 */

// The vector is checked by core's own schema (zod v4) after this one.
const bodySchema = z.object({
  vector: z.unknown(),
  instruction: z.string().trim().min(2).max(VECTOR_EDIT_LIMITS.instruction),
  boardId: z.string().min(1).max(200).optional(),
});

export const registerVectorEditRoutes: RegisterRoutes = (router, s) => {
  const {
    send,
    readBody,
    requireCsrf,
    requireUserIfNeeded,
    requireBoardRole,
    userStore,
    outboundRefusal,
    providerGate,
    provider,
    config,
    resolveAiContext,
    gateMonthly,
    meterUsage,
    meter,
    withAllowance,
  } = s;

  router.post("/api/vector/edit", async ({ req, res }) => {
    const route = "/api/vector/edit";
    if (!requireCsrf(req, res, route)) return;
    const auth = await requireUserIfNeeded(req, res);
    if (!auth.ok) return;
    if (!meter(req, res, route)) return;

    let body: z.infer<typeof bodySchema>;
    let vector: VectorData;
    try {
      const raw = await readBody(req);
      body = bodySchema.parse(raw ? JSON.parse(raw) : {});
      vector = vectorDataSchema.parse(body.vector) as VectorData;
    } catch (err) {
      send(res, 400, { error: "bad request", detail: (err as Error).message });
      return;
    }
    if (!vectorEditable(vector)) {
      send(res, 413, {
        error: "This vector is too detailed to edit with AI — simplify it first.",
        limits: { paths: VECTOR_EDIT_LIMITS.paths, chars: VECTOR_EDIT_LIMITS.chars },
      });
      return;
    }

    let board: StoredBoard | undefined;
    if (body.boardId) {
      const caller = auth.userId ? await userStore.findById(auth.userId) : undefined;
      if (!caller) {
        send(res, 401, { error: "authentication required" });
        return;
      }
      const guard = await requireBoardRole(req, res, body.boardId, "editor", route, caller);
      if (!guard.ok) return;
      board = guard.board;
    }

    // The drawing goes into a model prompt only where the board allows it.
    const refusal = board ? await outboundRefusal(board, "ai", { provider }) : null;
    if (refusal) {
      send(res, 403, {
        error: refusal.error,
        classification: refusal.classification,
        boundary: refusal.boundary,
      });
      return;
    }
    if (!provider.editVector) {
      send(res, 503, { error: "editing vectors with AI needs a model provider" });
      return;
    }

    const aiCtx = await resolveAiContext(auth.userId, board);
    if (
      !(await providerGate(
        req,
        res,
        aiCtx.orgId,
        providerFact({ provider, byok: false }, config.aiSelfHosted),
        route,
      ))
    )
      return;
    const allowance = aiCtx.orgId
      ? await gateMonthly(req, res, aiCtx.orgId, "ai.generationsPerMonth", route)
      : null;
    if (allowance === false) return;

    const request: VectorEditRequest = { instruction: body.instruction, vector };
    let draft;
    try {
      draft = await provider.editVector(request);
    } catch (err) {
      send(res, 502, {
        error: "the model couldn't edit the vector",
        detail: (err as Error).message,
      });
      return;
    }
    // The model was called: it counts, whether or not its drawing survives.
    if (aiCtx.orgId) {
      meterUsage(aiCtx.orgId, "ai.generation", 1, {
        boardId: board?.id ?? null,
        provider: provider.name,
        mode: "vector-edit",
        ...(draft.model ? { model: draft.model } : {}),
      });
    }
    try {
      const edit = assembleVectorEdit(request, draft, {
        generator: provider.name === "mock" ? "mock" : "llm",
        ...(draft.model ? { model: draft.model } : {}),
      });
      send(
        res,
        200,
        withAllowance({ ...edit, ...(draft.model ? { model: draft.model } : {}) }, allowance),
      );
    } catch (err) {
      send(res, 502, { error: (err as Error).message });
    }
  });
};
