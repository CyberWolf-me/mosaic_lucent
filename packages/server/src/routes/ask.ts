import * as z from "zod/v4";
import type { AnswerCitation } from "@lucent/ai";
import { REQUEST_LIMITS, type AnswerRequest } from "@lucent/ai";
import type { RegisterRoutes } from "./context.js";
import { outputHash } from "../aiRuns.js";
import { providerFact } from "../modelRouter.js";
import { actorNamesFor, loadVisibleLog } from "../historyView.js";
import { buildAnswerRequest } from "../askContext.js";
import { visibleMeetings } from "../meetingsWindow.js";
import type { MeetingStore } from "../meetings.js";

/**
 * The ask route (Stage C1):
 *
 *   POST /api/boards/:id/ask
 *
 * "Understand my workspace" — the read direction of the AI pill's Build/Ask
 * split. A question goes in; an answer plus citations comes out; the board is
 * never touched.
 *
 * Guard order follows the /api/generate ladder: CSRF → user → meter → board
 * role → AI context → monthly allowance. Two deliberate differences from
 * generate:
 *
 * - The board-role floor is VIEWER, not editor. Asking is reading: board
 *   history is already viewer-visible through the history route, and a
 *   reviewer's most natural question is "why is this node here?"
 * - Billing follows the existing anti-vandalism resolution: an editor (who
 *   can already spend the allowance through generate) bills the board's org;
 *   a viewer bills their OWN first org, never the board's — a viewer naming a
 *   stranger's board id must not be able to drain that org's allowance.
 *
 * ENTITLEMENT SCOPE (review amendment 1): the history.depth window bounds the
 * ENTIRE context the model receives. The revision window comes from the same
 * historyWindow() the history route uses, and meetings enter the context only
 * when their content could have landed inside the window — startedAt at/after
 * the oldest visible revision's timestamp. No digest may expose anything the
 * caller could not have read from the timeline itself.
 *
 * CITATION VALIDATION: model output is untrusted input. Every citation is
 * resolved against real, visible state; the ones that fail are dropped into
 * `warnings` while the answer survives (the Stage A partial-application rule,
 * applied to evidence instead of operations).
 */

const askBodySchema = z.object({
  question: z.string().min(1).max(REQUEST_LIMITS.messageChars),
  history: z
    .array(
      z.object({
        role: z.enum(["user", "ai"]),
        text: z.string().max(REQUEST_LIMITS.historyChars),
      }),
    )
    .max(REQUEST_LIMITS.historyTurns)
    .optional(),
});

/** The citation as the client renders it: kind, id, a human label, the anchor. */
interface CitationView {
  kind: AnswerCitation["kind"];
  id: string;
  label: string;
  /** Revision seq / meeting date, depending on kind — the chip's sub-line. */
  detail?: string;
  /** The model's own reason clause, when it gave one. */
  why?: string;
  /** For meetings: the turn range the linked proposal recorded, if any. */
  turnRange?: [number, number];
}

export const registerAskRoutes: RegisterRoutes = (router, s) => {
  const {
    config,
    boardStore,
    userStore,
    meetings,
    proposals,
    entitlements,
    provider,
    send,
    readBody,
    requireUser,
    requireBoardRole,
    outboundRefusal,
    providerGate,
    requireCsrf,
    meter,
    trace,
    resolveAiContext,
    gateMonthly,
    meterUsage,
    withAllowance,
    telemetry,
  } = s;

  /**
   * An org to bill a viewer's question to: their first membership — the same
   * fallback `resolveAiContext` applies to a non-editor caller on the generate
   * path. Derived here from `userStore` directly because the ask path needs it
   * for callers below the editor floor (generate never did: its floor was
   * editor, where the board's org is always the answer).
   */
  const firstOrgId = async (userId: string): Promise<string | undefined> => {
    const memberships = await userStore.membershipsFor(userId);
    return memberships[0]?.orgId;
  };

  router.post("/api/boards/:id/ask", async (ctx) => {
    const { req, res } = ctx;
    const route = "/api/boards/:id/ask";
    if (!requireCsrf(req, res, route)) return;
    const user = await requireUser(req, res);
    if (!user) return;
    if (!meter(req, res, route)) return;
    const boardId = ctx.param("id");
    const guard = await requireBoardRole(req, res, boardId, "viewer", route, user);
    if (!guard.ok) return;

    // docs/23 S1/S2: the ask route reads board content into a model prompt.
    // A `restricted` board (or its org's floor) forbids that; `ai: disabled`
    // at the org level forbids every generation, mock included. The refusal
    // costs no token — it is before the provider call — and keeps the
    // in-process-mock exception that makes the advisory's §24 fallback
    // ("no approved provider → deterministic path") work for Ask offline.
    if (guard.board) {
      const refusal = await outboundRefusal(guard.board, "ai", { provider });
      if (refusal) {
        send(res, 403, {
          error: refusal.error,
          classification: refusal.classification,
          boundary: refusal.boundary,
        });
        return;
      }
    }
    // docs/24 Phase C: the ask provider is always the deployment's (no BYO
    // path here), so the org's provider policy still decides whether THIS
    // provider may serve them — a self-hosted-only org on a cloud
    // deployment is refused here, exactly as generate is.
    if (
      !(await providerGate(
        req,
        res,
        guard.board.orgId,
        providerFact({ provider, byok: false }, config.aiSelfHosted),
        route,
      ))
    )
      return;

    let body: z.infer<typeof askBodySchema>;
    try {
      const raw = await readBody(req);
      body = askBodySchema.parse(raw ? JSON.parse(raw) : {});
    } catch (err) {
      send(res, 400, { error: "bad request", detail: (err as Error).message });
      return;
    }

    // Billing: same resolution the generate ladder uses. An editor bills the
    // board's org; anyone else bills their own first org, and an orgless
    // caller cannot reach a provider at all (there is no allowance to spend).
    const aiCtx = await resolveAiContext(user.id, guard.board);
    const billTo = aiCtx.authoritative ? guard.board.orgId : await firstOrgId(user.id);
    if (!billTo) {
      send(res, 402, { error: "no organization to bill this question to" });
      return;
    }
    const allowance = await gateMonthly(req, res, billTo, "ai.generationsPerMonth", route);
    if (allowance === false) return;

    // The visible window — the same arithmetic the history route uses, so the
    // answer's context and the timeline can never disagree about what is
    // visible. Entitlements unconfigured degrade to Free depth, same as the
    // history route.
    let depth: number | null = 25;
    if (entitlements) {
      const entitlement = await entitlements.entitlement(guard.board.orgId, "history.depth");
      depth = entitlement.limit;
    }
    const { window, entries } = await loadVisibleLog(boardStore, boardId, depth);

    // Meeting context, windowed (amendment 1). The floor is the oldest visible
    // revision's timestamp — the earliest moment the caller's window can show
    // board state changing.
    const oldestVisibleAt = entries.length > 0 ? entries[entries.length - 1]!.at : 0;
    const meetingStore: MeetingStore | undefined = meetings;
    const boardMeetings = meetingStore
      ? visibleMeetings(await meetingStore.forBoard(boardId), oldestVisibleAt)
      : [];

    const names = await actorNamesFor(userStore, entries);
    // The proposal join, same as the history route: appliedSeq ↔ seq links the
    // Stage B3 record to the visible revisions, and a meeting's turnRange
    // rides the proposal's provenance for the citation's "jump to turn".
    const boardProposals = proposals ? await proposals.forBoard(boardId) : [];
    const proposalTurnRanges = new Map<string, [number, number]>();
    for (const p of boardProposals) {
      if (p.meetingId && p.provenance?.turnRange) {
        proposalTurnRanges.set(p.meetingId, p.provenance.turnRange);
      }
    }

    const request: AnswerRequest = buildAnswerRequest({
      question: body.question,
      boardName: guard.board.name,
      workspace: guard.board.workspace,
      log: entries,
      actorNames: names,
      meetings: boardMeetings,
      window: { depth: window.depth, hasMore: window.hasMore },
      ...(body.history ? { conversation: body.history } : {}),
    });

    const started = Date.now();
    let result;
    try {
      result = await provider.generateAnswer(request);
    } catch (err) {
      telemetry.record({
        kind: "error",
        route,
        status: 502,
        message: (err as Error).message,
        requestId: trace(req),
      });
      send(res, 502, { error: "provider failed", detail: (err as Error).message });
      return;
    }

    // ---- Citation validation: model output is untrusted input ----
    const visibleSeqs = new Set(entries.map((e) => e.seq));
    const visibleMeetingIds = new Set(boardMeetings.map((m) => m.id));
    const citations: CitationView[] = [];
    const warnings: Array<{ citation: AnswerCitation; reason: string }> = [];
    for (const citation of result.citations) {
      if (citation.kind === "node") {
        const node = guard.board.workspace.nodes[citation.id];
        if (node) {
          citations.push({
            kind: "node",
            id: citation.id,
            label: node.label.slice(0, 80),
            ...(citation.detail ? { why: citation.detail } : {}),
          });
        } else {
          warnings.push({ citation, reason: "node not found on the board" });
        }
      } else if (citation.kind === "meeting") {
        if (visibleMeetingIds.has(citation.id)) {
          const meeting = boardMeetings.find((m) => m.id === citation.id)!;
          const turnRange = proposalTurnRanges.get(citation.id);
          citations.push({
            kind: "meeting",
            id: citation.id,
            label: `Meeting · ${new Date(meeting.startedAt).toISOString().slice(0, 10)}`,
            ...(turnRange ? { turnRange } : {}),
            ...(citation.detail ? { why: citation.detail } : {}),
          });
        } else {
          // Either invented, or outside the caller's window — both are out.
          warnings.push({ citation, reason: "meeting not visible in your history window" });
        }
      } else {
        const seq = Number(citation.id);
        if (Number.isInteger(seq) && visibleSeqs.has(seq)) {
          const entry = entries.find((e) => e.seq === seq)!;
          citations.push({
            kind: "revision",
            id: citation.id,
            label: `Revision ${seq} · ${entry.label.slice(0, 60)}`,
            detail: new Date(entry.at).toISOString().slice(0, 16).replace("T", " "),
            ...(citation.detail ? { why: citation.detail } : {}),
          });
        } else {
          warnings.push({
            citation,
            reason: "revision outside your visible history window",
          });
        }
      }
    }

    // Metered on success only, same contract as generate. The mode tag keeps
    // the usage rows answerable by surface without a second usage kind.
    meterUsage(billTo, "ai.generation", 1, {
      boardId,
      provider: provider.name,
      mode: "ask",
      ...(result.model ? { model: result.model } : {}),
    });
    // ADR 0047: an answer is an AI run too — read-only, so no ops to link.
    void s.recordRun({
      orgId: billTo,
      boardId,
      initiatedBy: guard.user.id,
      surface: "ask",
      provider: provider.name,
      model: result.model ?? null,
      contextScope: "board",
      tools: [],
      outputHash: outputHash(result.answer),
      opCount: 0,
      createdAt: Date.now(),
    });
    telemetry.record({
      kind: "ask",
      ms: Date.now() - started,
      provider: provider.name,
      citations: citations.length,
      requestId: trace(req),
    });

    send(
      res,
      200,
      withAllowance(
        {
          answer: result.answer,
          citations,
          ...(warnings.length ? { warnings } : {}),
          // The honest-window numbers, so the client can render the same
          // "you see the latest N" statement the model was told to make.
          historyDepth: window.depth,
          hasMore: window.hasMore,
          provider: provider.name,
          ...(result.model ? { model: result.model } : {}),
          ...(result.usage ? { usage: result.usage } : {}),
        },
        allowance,
      ),
    );
  });
};
