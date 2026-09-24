import { z } from "zod";
import {
  THEME_LIMITS,
  assembleThemes,
  fallbackThemes,
  type Themes,
  type ThemesRequest,
} from "@lucent/ai";
import { providerFact } from "../modelRouter.js";
import type { StoredBoard } from "../boards.js";
import type { RegisterRoutes } from "./context.js";

/**
 * POST /api/themes (docs/27 D2) — sort sticky notes into titled themes.
 *
 *   body   { items: [{ text }], hint?, maxThemes?, boardId? }
 *   reply  { themes: [{ title, items: number[] }], by, model?, offline? }
 *
 * The same gates as generation — CSRF, auth, the editor floor when a board is
 * named, the board's AI boundary, the org's provider policy, the monthly
 * allowance — with one difference in kind: sorting always has an honest
 * answer without a model. When the boundary refuses, no provider is
 * configured for it, or the model fails, the offline keyword sorter answers
 * and `offline` says why, so a restricted board still gets its wall sorted
 * and nothing leaves the deployment.
 *
 * The reply is indices into the request's items, never ids or positions: the
 * client maps them back and lays the themes out deterministically.
 */

const themesBodySchema = z.object({
  items: z
    .array(z.object({ text: z.string().max(2_000) }))
    .min(1)
    .max(THEME_LIMITS.items),
  hint: z.string().max(200).optional(),
  maxThemes: z.number().int().min(2).max(THEME_LIMITS.themes).optional(),
  boardId: z.string().min(1).max(200).optional(),
});

export const registerThemesRoutes: RegisterRoutes = (router, s) => {
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
  } = s;

  router.post("/api/themes", async ({ req, res }) => {
    const route = "/api/themes";
    if (!requireCsrf(req, res, route)) return;
    const auth = await requireUserIfNeeded(req, res);
    if (!auth.ok) return;
    if (!meter(req, res, route)) return;

    let body: z.infer<typeof themesBodySchema>;
    try {
      const raw = await readBody(req);
      body = themesBodySchema.parse(raw ? JSON.parse(raw) : {});
    } catch (err) {
      send(res, 400, { error: "bad request", detail: (err as Error).message });
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

    const request: ThemesRequest = {
      items: body.items,
      ...(body.hint ? { hint: body.hint } : {}),
      ...(body.maxThemes ? { maxThemes: body.maxThemes } : {}),
    };
    const offline = (why: "policy" | "no-model" | "model-failed"): void => {
      const themes: Themes = assembleThemes(request, fallbackThemes(request), "fallback");
      send(res, 200, { ...themes, offline: why });
    };

    // Sticky text goes into a model prompt only where the board allows it.
    const refusal = board ? await outboundRefusal(board, "ai", { provider }) : null;
    if (refusal) return offline("policy");
    if (!provider.generateThemes) return offline("no-model");

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

    try {
      const draft = await provider.generateThemes(request);
      const themes = assembleThemes(request, draft, "model", draft.model);
      if (aiCtx.orgId) {
        meterUsage(aiCtx.orgId, "ai.generation", 1, {
          boardId: board?.id ?? null,
          provider: provider.name,
          mode: "themes",
          ...(draft.model ? { model: draft.model } : {}),
        });
      }
      send(res, 200, themes);
    } catch {
      // A model failure still sorts the wall — offline, and labelled.
      offline("model-failed");
    }
  });
};
