import * as z from "zod/v4";
import { parseWorkspace, type Workspace } from "@lucent/core";
import {
  REQUEST_LIMITS,
  type AnswerCitation,
  type AnswerRequest,
  type AnswerRetrievalHit,
} from "@lucent/ai";
import type { RegisterRoutes } from "./context.js";
import { outputHash } from "../aiRuns.js";
import { providerFact } from "../modelRouter.js";
import { ASK_DIGEST_LIMITS, buildAnswerRequest, projectMeetings } from "../askContext.js";
import { answerConfidence, type CitedEvidence } from "../confidence.js";
import { loadVisibleLog } from "../historyView.js";
import { visibleMeetings } from "../meetingsWindow.js";
import type { MeetingTranscript } from "../meetings.js";
import { parseScope, resolveScope } from "../workspaceScope.js";
import { searchWorkspace } from "../workspaceSearch.js";
import type { StoredBoard } from "../boards.js";

/**
 * Search and Ask beyond one stored board (docs/26 J4, ADR 0048):
 *
 *   GET  /api/orgs/:id/search?q=…&project=&board=&meeting=&since=&until=
 *   POST /api/orgs/:id/ask   {question, scope?, history?}
 *   POST /api/ask/local      {question, workspace, history?}   (a board in this browser)
 *
 * Every scope resolves through the boards the caller can read. A board whose
 * classification forbids AI (restricted, or its org's policy) stays out of an
 * answer's context and is named as excluded; the history-depth entitlement
 * windows each board's meetings exactly as board Ask does. Every answer
 * carries its confidence, computed from the citations that survive.
 */

const historySchema = z
  .array(
    z.object({ role: z.enum(["user", "ai"]), text: z.string().max(REQUEST_LIMITS.historyChars) }),
  )
  .max(REQUEST_LIMITS.historyTurns)
  .optional();

const scopedAskSchema = z.object({
  question: z.string().min(1).max(REQUEST_LIMITS.messageChars),
  scope: z.record(z.string(), z.unknown()).optional(),
  history: historySchema,
});

/** A browser's own board, sent whole: bounded well below the body cap. */
const MAX_LOCAL_WORKSPACE_CHARS = 2_000_000;
/** Statements the workspace digest shows. */
const DIGEST_STATEMENTS = 250;

interface CitationView {
  kind: AnswerCitation["kind"];
  id: string;
  label: string;
  boardId?: string;
  boardName?: string;
  detail?: string;
  why?: string;
}

export const registerScopedAskRoutes: RegisterRoutes = (router, s) => {
  const {
    config,
    boardStore,
    userStore,
    meetings,
    projects,
    intelligence,
    entitlements,
    provider,
    send,
    readBody,
    requireUser,
    requireCsrf,
    readableBoards,
    outboundRefusal,
    providerGate,
    meter,
    trace,
    gateMonthly,
    meterUsage,
    withAllowance,
    telemetry,
  } = s;

  /** Bill a member's question to the org; anyone else to their own first org. */
  const billFor = async (userId: string, orgId: string | null): Promise<string | undefined> => {
    const memberships = await userStore.membershipsFor(userId);
    if (orgId && memberships.some((m) => m.orgId === orgId)) return orgId;
    return memberships[0]?.orgId;
  };

  /** Meetings windowed per board by the history-depth entitlement, as board Ask does. */
  async function windowed(orgId: string, list: MeetingTranscript[]): Promise<MeetingTranscript[]> {
    let depth: number | null = 25;
    if (entitlements) depth = (await entitlements.entitlement(orgId, "history.depth")).limit;
    if (depth === null) return list;
    const out: MeetingTranscript[] = [];
    const byBoard = new Map<string, MeetingTranscript[]>();
    for (const m of list) byBoard.set(m.boardId, [...(byBoard.get(m.boardId) ?? []), m]);
    for (const [boardId, ms] of byBoard) {
      const { entries } = await loadVisibleLog(boardStore, boardId, depth);
      const floor = entries.length > 0 ? entries[entries.length - 1]!.at : 0;
      out.push(...visibleMeetings(ms, floor));
    }
    return out.sort((a, b) => b.startedAt - a.startedAt);
  }

  router.get("/api/orgs/:id/search", async (ctx) => {
    const { req, res } = ctx;
    const user = await requireUser(req, res);
    if (!user) return;
    if (!meter(req, res, "/api/orgs/:id/search")) return;
    const url = new URL(req.url ?? "/", "http://localhost");
    const q = (url.searchParams.get("q") ?? "").trim();
    if (!q) return send(res, 400, { error: "q query parameter required" });
    const input = parseScope(url.searchParams);
    if (!input)
      return send(res, 400, {
        error: "scope is malformed (project, board, meeting, since, until)",
      });
    const orgId = ctx.param("id");
    const resolved = await resolveScope(
      { readableBoards: (u, o) => readableBoards(u, o, req), projects, meetings },
      user.id,
      orgId,
      input,
    );
    if (!resolved.ok) return send(res, 404, { error: resolved.error });
    const scope = resolved.scope;
    const hits = searchWorkspace(q, {
      ...scope,
      meetings: await windowed(orgId, scope.meetings),
    });
    send(res, 200, {
      query: q,
      scope: { label: scope.label, boards: scope.boards.length, meetings: scope.meetings.length },
      results: hits,
    });
  });

  router.post("/api/orgs/:id/ask", async (ctx) => {
    const { req, res } = ctx;
    const route = "/api/orgs/:id/ask";
    if (!requireCsrf(req, res, route)) return;
    const user = await requireUser(req, res);
    if (!user) return;
    if (!meter(req, res, route)) return;
    const orgId = ctx.param("id");
    let body: z.infer<typeof scopedAskSchema>;
    try {
      const raw = await readBody(req);
      body = scopedAskSchema.parse(raw ? JSON.parse(raw) : {});
    } catch (err) {
      return send(res, 400, { error: "bad request", detail: (err as Error).message });
    }
    const input = parseScope(body.scope ?? {});
    if (!input)
      return send(res, 400, {
        error: "scope is malformed (project, board, meeting, since, until)",
      });
    const resolved = await resolveScope(
      { readableBoards, projects, meetings },
      user.id,
      orgId,
      input,
    );
    if (!resolved.ok) return send(res, 404, { error: resolved.error });

    // A board the AI boundary refuses never enters the prompt.
    const allowed: StoredBoard[] = [];
    const excluded: string[] = [];
    for (const board of resolved.scope.boards) {
      if (await outboundRefusal(board, "ai", { provider })) excluded.push(board.name);
      else allowed.push(board);
    }
    if (allowed.length === 0) {
      return send(res, 403, {
        error: excluded.length
          ? "every board in this scope keeps its content away from AI"
          : "nothing in this scope to answer from",
        excluded,
      });
    }
    if (
      !(await providerGate(
        req,
        res,
        orgId,
        providerFact({ provider, byok: false }, config.aiSelfHosted),
        route,
      ))
    )
      return;
    const billTo = await billFor(user.id, orgId);
    if (!billTo) return send(res, 402, { error: "no organization to bill this question to" });
    const allowance = await gateMonthly(req, res, billTo, "ai.generationsPerMonth", route);
    if (allowance === false) return;

    const boardIds = new Set(allowed.map((b) => b.id));
    const boardById = new Map(allowed.map((b) => [b.id, b] as const));
    const scopeMeetings = await windowed(
      orgId,
      resolved.scope.meetings.filter((m) => boardIds.has(m.boardId)),
    );
    await intelligence.freshen(allowed);
    const rows = await intelligence.store.query([...boardIds]);

    // The workspace digest: every statement in scope, by board, with the
    // qualified id the model cites (board:node).
    const lines: string[] = [
      `A workspace view across ${allowed.length} ${allowed.length === 1 ? "board" : "boards"} (${resolved.scope.label}). Cite a statement by its id in braces, board:node.`,
    ];
    let shown = 0;
    for (const board of allowed) {
      const own = rows.filter((r) => r.boardId === board.id);
      if (own.length === 0) continue;
      lines.push(`Board “${board.name}”:`);
      for (const r of own) {
        if (shown >= DIGEST_STATEMENTS) break;
        shown += 1;
        lines.push(
          `- [${r.kind} · ${r.status}${r.topic ? ` · topic ${r.topic}` : ""}${r.trust === "ai-suggested" ? " · unreviewed suggestion" : ""}] ${r.label} {${board.id}:${r.id}}${r.assignee ? ` — owner ${r.assignee}` : ""}${r.dueDate ? `, due ${r.dueDate}` : ""}${r.provenance ? ` — from meeting ${r.provenance.meetingId}${r.provenance.turnRange ? ` turns ${r.provenance.turnRange[0]}–${r.provenance.turnRange[1]}` : ""}` : ""}`,
        );
      }
    }
    if (rows.length > shown) lines.push(`(${rows.length - shown} more statements not shown.)`);
    if (excluded.length) {
      lines.push(`Excluded by policy (never shown to you): ${excluded.join(", ")}.`);
    }

    const retrieved: AnswerRetrievalHit[] = [];
    for (const hit of searchWorkspace(body.question, {
      boards: allowed,
      meetings: scopeMeetings,
      ...(resolved.scope.since !== undefined ? { since: resolved.scope.since } : {}),
      ...(resolved.scope.until !== undefined ? { until: resolved.scope.until } : {}),
    }).slice(0, 12)) {
      if (hit.kind === "node") {
        retrieved.push({
          kind: "node",
          id: `${hit.boardId}:${hit.id}`,
          label: hit.label,
          matched: hit.matched,
        });
      } else if (hit.kind === "turn") {
        retrieved.push({
          kind: "turn",
          id: hit.meetingId,
          meetingId: hit.meetingId,
          turnIndex: hit.turnIndex,
          label: `${hit.speaker}: ${hit.snippet}`,
          matched: hit.matched,
        });
      } else if (hit.kind === "comment") {
        retrieved.push({
          kind: "node",
          id: `${hit.boardId}:${hit.targetId}`,
          label: `comment: ${hit.snippet}`,
          matched: hit.matched,
        });
      }
    }

    const request: AnswerRequest = {
      question: body.question,
      boardName: resolved.scope.label,
      boardDigest: lines.join("\n"),
      history: [],
      historyTruncated: false,
      historyDepth: null,
      meetings: projectMeetings(scopeMeetings),
      meetingsTruncated: scopeMeetings.length > ASK_DIGEST_LIMITS.meetings,
      ...(retrieved.length ? { retrieved } : {}),
      nodeIndex: rows
        .slice(0, ASK_DIGEST_LIMITS.nodeIndex)
        .map((r) => ({
          id: `${r.boardId}:${r.id}`,
          label: r.label.slice(0, ASK_DIGEST_LIMITS.nodeLabel),
        })),
      ...(body.history ? { conversation: body.history } : {}),
    };

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
      return send(res, 502, { error: "provider failed", detail: (err as Error).message });
    }

    const byKey = new Map<string, (typeof rows)[number]>(
      rows.map((r) => [`${r.boardId}:${r.id}`, r] as const),
    );
    const meetingById = new Map(scopeMeetings.map((m) => [m.id, m] as const));
    const citations: CitationView[] = [];
    const evidence: CitedEvidence[] = [];
    const warnings: Array<{ citation: AnswerCitation; reason: string }> = [];
    for (const citation of result.citations) {
      if (citation.kind === "node") {
        const [bId, ...rest] = citation.id.split(":");
        const nodeId = rest.join(":");
        const board = bId ? boardById.get(bId) : undefined;
        const node = board && nodeId ? board.workspace.nodes[nodeId] : undefined;
        if (!board || !node) {
          warnings.push({ citation, reason: "not a statement in this scope" });
          continue;
        }
        citations.push({
          kind: "node",
          id: nodeId,
          boardId: board.id,
          boardName: board.name,
          label: node.label.slice(0, 80),
          ...(citation.detail ? { why: citation.detail } : {}),
        });
        evidence.push({
          kind: "node",
          key: citation.id,
          label: node.label,
          ...(byKey.get(citation.id)?.status
            ? { statementStatus: byKey.get(citation.id)!.status }
            : {}),
        });
      } else if (citation.kind === "meeting") {
        const meeting = meetingById.get(citation.id);
        if (!meeting) {
          warnings.push({ citation, reason: "meeting not in this scope" });
          continue;
        }
        const board = boardById.get(meeting.boardId)!;
        const label =
          meeting.title ?? `Meeting · ${new Date(meeting.startedAt).toISOString().slice(0, 10)}`;
        citations.push({
          kind: "meeting",
          id: meeting.id,
          boardId: board.id,
          boardName: board.name,
          label,
          ...(citation.detail ? { why: citation.detail } : {}),
        });
        evidence.push({ kind: "meeting", key: meeting.id, label });
      } else {
        warnings.push({ citation, reason: "revisions aren't in a workspace answer's context" });
      }
    }
    const confidence = answerConfidence(evidence);

    meterUsage(billTo, "ai.generation", 1, {
      provider: provider.name,
      mode: "ask",
      scope: resolved.scope.label,
      ...(result.model ? { model: result.model } : {}),
    });
    void s.recordRun({
      orgId,
      boardId: allowed.length === 1 ? allowed[0]!.id : null,
      initiatedBy: user.id,
      surface: "ask",
      provider: provider.name,
      model: result.model ?? null,
      contextScope: input.meeting
        ? "meeting"
        : input.project
          ? "project"
          : input.board
            ? "board"
            : "workspace",
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
          confidence,
          ...(warnings.length ? { warnings } : {}),
          scope: {
            label: resolved.scope.label,
            boards: allowed.length,
            meetings: scopeMeetings.length,
            ...(excluded.length ? { excluded } : {}),
          },
          provider: provider.name,
          ...(result.model ? { model: result.model } : {}),
        },
        allowance,
      ),
    );
  });

  router.post("/api/ask/local", async (ctx) => {
    const { req, res } = ctx;
    const route = "/api/ask/local";
    if (!requireCsrf(req, res, route)) return;
    const user = await requireUser(req, res);
    if (!user) return;
    if (!meter(req, res, route)) return;
    let raw: string;
    try {
      raw = (await readBody(req)) ?? "";
    } catch (err) {
      return send(res, 400, { error: "bad request", detail: (err as Error).message });
    }
    if (raw.length > MAX_LOCAL_WORKSPACE_CHARS) {
      return send(res, 413, {
        error: "this board is too large to ask about from the browser — share it first",
      });
    }
    let parsedBody: { question?: unknown; workspace?: unknown; history?: unknown; name?: unknown };
    try {
      parsedBody = raw ? (JSON.parse(raw) as typeof parsedBody) : {};
    } catch (err) {
      return send(res, 400, { error: "bad request", detail: (err as Error).message });
    }
    const checked = z
      .object({
        question: z.string().min(1).max(REQUEST_LIMITS.messageChars),
        history: historySchema,
      })
      .safeParse(parsedBody);
    if (!checked.success) return send(res, 400, { error: "a question is required" });
    const parsed = parseWorkspace(parsedBody.workspace);
    if (!parsed.ok || !parsed.workspace) return send(res, 400, { error: "workspace is malformed" });
    const workspace: Workspace = parsed.workspace;
    const billTo = await billFor(user.id, null);
    if (!billTo) return send(res, 402, { error: "no organization to bill this question to" });
    if (
      !(await providerGate(
        req,
        res,
        billTo,
        providerFact({ provider, byok: false }, config.aiSelfHosted),
        route,
      ))
    )
      return;
    const allowance = await gateMonthly(req, res, billTo, "ai.generationsPerMonth", route);
    if (allowance === false) return;

    const request = buildAnswerRequest({
      question: checked.data.question,
      boardName:
        typeof parsedBody.name === "string" && parsedBody.name.trim()
          ? parsedBody.name.trim().slice(0, 120)
          : "this board",
      workspace,
      log: [],
      actorNames: new Map(),
      meetings: [],
      window: { depth: null, hasMore: false },
      ...(checked.data.history ? { conversation: checked.data.history } : {}),
    });
    let result;
    try {
      result = await provider.generateAnswer(request);
    } catch (err) {
      return send(res, 502, { error: "provider failed", detail: (err as Error).message });
    }
    const citations: CitationView[] = [];
    const evidence: CitedEvidence[] = [];
    const warnings: Array<{ citation: AnswerCitation; reason: string }> = [];
    for (const citation of result.citations) {
      const node = citation.kind === "node" ? workspace.nodes[citation.id] : undefined;
      if (!node) {
        warnings.push({
          citation,
          reason: "a board in this browser has no meetings or history to cite — only its nodes",
        });
        continue;
      }
      citations.push({
        kind: "node",
        id: citation.id,
        label: node.label.slice(0, 80),
        ...(citation.detail ? { why: citation.detail } : {}),
      });
      evidence.push({
        kind: "node",
        key: citation.id,
        label: node.label,
        ...(node.statement ? { statementStatus: node.statement.status } : {}),
      });
    }
    meterUsage(billTo, "ai.generation", 1, {
      provider: provider.name,
      mode: "ask",
      scope: "local",
      ...(result.model ? { model: result.model } : {}),
    });
    void s.recordRun({
      orgId: billTo,
      boardId: null,
      initiatedBy: user.id,
      surface: "ask",
      provider: provider.name,
      model: result.model ?? null,
      contextScope: "local-board",
      tools: [],
      outputHash: outputHash(result.answer),
      opCount: 0,
      createdAt: Date.now(),
    });
    send(
      res,
      200,
      withAllowance(
        {
          answer: result.answer,
          citations,
          confidence: answerConfidence(evidence),
          ...(warnings.length ? { warnings } : {}),
          historyDepth: null,
          hasMore: false,
          provider: provider.name,
          ...(result.model ? { model: result.model } : {}),
        },
        allowance,
      ),
    );
  });
};
