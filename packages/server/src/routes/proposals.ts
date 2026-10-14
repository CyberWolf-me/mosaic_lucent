import { applyValidOperations, repairOperations, stampTrust, withoutTrust } from "@lucent/core";
import type { RegisterRoutes } from "./context.js";

/**
 * Review-gate proposal routes (Stage B3 — closing the P2 boundary):
 *
 *   POST  /api/boards/:id/proposals            create; supersedes pending (editor)
 *   GET   /api/boards/:id/proposals            list, newest first (viewer)
 *   POST  /api/boards/:id/proposals/:pid/approve   apply + record (editor)
 *   POST  /api/boards/:id/proposals/:pid/reject    record refusal (editor)
 *
 * Reads are viewer-floor: every member of the board can see what Lucent is
 * proposing — the panel is the board's pending state, not a private draft.
 * Writes are editor-floor: proposing extraction is a board edit in waiting,
 * and deciding one certainly is.
 *
 * The approval is the whole pipeline in one request:
 *   guard → CSRF → transition check → re-validate against CURRENT state →
 *   commit through the live room (broadcast + AI actor + requestId
 *   idempotency) or the store directly when no room is live → record the
 *   decision with the applied seq → broadcast proposal-decided.
 *
 * Re-validation is `applyValidOperations` (partial application): a proposal
 * written against yesterday's board may reference a node deleted overnight —
 * the valid remainder applies, the skips are reported. Refusing wholesale
 * would make every proposal hostage to the first concurrent edit.
 */
export const registerProposalRoutes: RegisterRoutes = (router, s) => {
  const {
    send,
    readBody,
    requireBoardRole,
    requireCsrf,
    proposals,
    commitForBoard,
    broadcastProposal,
    auditRow,
  } = s;

  router.post("/api/boards/:id/proposals", async (ctx) => {
    const { req, res } = ctx;
    // docs/28 F17: the decide routes checked CSRF; creating did not.
    if (!requireCsrf(req, res, "/api/boards/:id/proposals")) return;
    const boardId = ctx.param("id");
    // Guard before the store check: a 503 for an unconfigured store must not
    // become an oracle over which boards exist.
    const guard = await requireBoardRole(req, res, boardId, "editor", "/api/boards/:id/proposals");
    if (!guard.ok) return;
    if (!proposals) return send(res, 503, { error: "proposals are not configured" });

    let raw: string | undefined;
    try {
      raw = await readBody(req);
    } catch (err) {
      send(res, 400, { error: "bad request", detail: (err as Error).message });
      return;
    }
    let parsed: unknown;
    try {
      parsed = raw ? JSON.parse(raw) : {};
    } catch (err) {
      send(res, 400, { error: "bad request", detail: (err as Error).message });
      return;
    }
    const { validateProposalInput } = await import("../proposals.js");
    const checked = validateProposalInput(parsed);
    if (!checked.ok) {
      send(res, 400, { error: checked.error });
      return;
    }

    // ADR 0047: a run id is kept only when the run is the caller's own, on
    // this board — a proposal can't borrow someone else's run.
    let runId: string | null = null;
    if (checked.value.runId) {
      const run = await s.aiRuns.get(checked.value.runId);
      if (run && run.initiatedBy === guard.user.id && run.boardId === boardId) runId = run.id;
    }

    let record;
    try {
      record = await proposals.create({
        ...checked.value,
        runId,
        boardId,
        orgId: guard.board.orgId,
        createdBy: guard.user.id,
        createdAt: Date.now(),
      });
    } catch {
      // The race loser: another browser's create retired ours and won the
      // pending slot. The invariant held — one pending per board — just not
      // in our favour. The client re-reads and shows the winner's proposal.
      send(res, 409, { error: "another proposal is pending; refresh to see it" });
      return;
    }

    if (runId) await s.aiRuns.linkProposal(runId, record.proposal.id).catch(() => {});

    // Fan the new proposal out to every connected peer: their panel opens
    // without a refresh. Durable either way — the next GET finds it.
    broadcastProposal(boardId, {
      type: "proposal-created",
      proposal: record.proposal,
      ...(record.supersededId !== null ? { supersededId: record.supersededId } : {}),
    });

    send(res, 201, { proposal: record.proposal });
  });

  router.get("/api/boards/:id/proposals", async (ctx) => {
    const { req, res } = ctx;
    const boardId = ctx.param("id");
    const guard = await requireBoardRole(req, res, boardId, "viewer", "/api/boards/:id/proposals");
    if (!guard.ok) return;
    if (!proposals) return send(res, 503, { error: "proposals are not configured" });
    send(res, 200, { proposals: await proposals.forBoard(boardId) });
  });

  /** Approvals in flight on this instance, per proposal (one at a time). */
  const approving = new Map<string, Promise<void>>();

  const decide =
    (verdict: "approved" | "rejected") =>
    async (ctx: {
      req: import("node:http").IncomingMessage;
      res: import("node:http").ServerResponse;
      param: (name: string) => string;
    }) => {
      const { req, res } = ctx;
      const boardId = ctx.param("id");
      const pid = ctx.param("pid");
      const route = `/api/boards/:id/proposals/:pid/${verdict}`;
      const guard = await requireBoardRole(req, res, boardId, "editor", route);
      if (!guard.ok) return;
      if (!proposals) return send(res, 503, { error: "proposals are not configured" });
      if (!requireCsrf(req, res, route)) return;

      const proposal = await proposals.get(boardId, pid);
      if (!proposal) return send(res, 404, { error: "proposal not found" });
      // The transition guard, checked before any work: a decided proposal is a
      // record, not a queue entry. The store enforces it again on write; this
      // check keeps the rejection cheap and the answer informative.
      if (proposal.status !== "pending") {
        send(res, 200, { proposal, duplicate: true });
        return;
      }

      if (verdict === "rejected") {
        const decided = await proposals.decide(boardId, pid, {
          status: "rejected",
          decidedBy: guard.user.id,
          decidedAt: Date.now(),
        });
        broadcastProposal(boardId, {
          type: "proposal-decided",
          id: pid,
          status: "rejected",
          by: guard.user.id,
        });
        // docs/26 F9: an AI proposal's fate is a human decision the log keeps.
        void auditRow(req, guard.user.id, guard.board.orgId, "board.proposal.rejected", boardId, {
          proposalId: pid,
          operations: proposal.operations.length,
          ...(proposal.meetingId ? { meetingId: proposal.meetingId } : {}),
        });
        return send(res, 200, { proposal: decided });
      }

      // One approval at a time per proposal on this instance: a double click,
      // or two people approving together, waits for the first and gets its
      // answer instead of committing the batch a second time. (Across
      // instances the per-proposal requestId below is the guard.) Released
      // when this response is done, whichever way it ends.
      const prior = approving.get(pid);
      if (prior) {
        await prior;
        const fresh = await proposals.get(boardId, pid);
        if (fresh && fresh.status !== "pending") {
          send(res, 200, { proposal: fresh, duplicate: true });
          return;
        }
      }
      let release!: () => void;
      const mine = new Promise<void>((resolve) => (release = resolve));
      approving.set(pid, mine);
      const done = () => {
        release();
        if (approving.get(pid) === mine) approving.delete(pid);
      };
      res.once("finish", done);
      res.once("close", done);

      // APPROVED: re-validate against the CURRENT workspace and apply the valid
      // remainder. The ops were never validated against this board before (they
      // arrive from the client's extraction), so this is the first honest check
      // — and a stale proposal may partially skip, by design: refusing wholesale
      // would make every proposal hostage to the first concurrent edit.
      //
      // Stage C2 (ADR 0022): before anything is judged, the batch is enriched
      // with the proposal's full evidence — meeting id, turns, the words said.
      // The old client post-pass stamped only the proposer's browser; here the
      // enrichment happens on the ops THEMSELVES, so the approval that commits
      // through the room carries provenance to every peer, the log, and undo.
      // Idempotent per op (attachProvenance), so a proposal whose ops were
      // already enriched on the client keeps the client's copy.
      const { attachProvenance, existingTopics, foldStatementTopics } = await import(
        "@lucent/core"
      );
      const evidence =
        proposal.meetingId !== null
          ? {
              meetingId: proposal.meetingId,
              ...(proposal.provenance?.turnRange
                ? { turnRange: proposal.provenance.turnRange }
                : {}),
              ...(proposal.provenance?.quote ? { quote: proposal.provenance.quote } : {}),
              ...(proposal.provenance?.turnKinds?.length
                ? { turnKinds: proposal.provenance.turnKinds }
                : {}),
            }
          : undefined;
      const enriched = evidence
        ? attachProvenance(proposal.operations, evidence)
        : proposal.operations;
      // The topic fold (Stage C5): a proposal is the model's output, so its
      // statement topics fold against the board's existing authored keys at
      // commit — alongside the provenance enrichment, same reasoning: what
      // lands through the room must converge for every peer. A proposal
      // stored before C5 with a variant topic folds on approval.
      const folded = foldStatementTopics(enriched, existingTopics(guard.board.workspace));
      // ADR 0047: a proposal is the model's output — whatever trust it carries
      // is dropped, then stamped for what approving it means. A meeting's
      // extraction applied as a whole stays a suggestion until each claim is
      // reviewed; a canvas request the person reviewed in the panel is theirs.
      const trusted = stampTrust(
        withoutTrust(folded),
        proposal.meetingId ? "agent" : "requested",
        guard.board.workspace,
      );
      const repaired = repairOperations(trusted, guard.board.workspace);
      const partial = applyValidOperations(guard.board.workspace, repaired);
      if (partial.applied.length === 0) {
        send(res, 422, {
          error: "proposal no longer applies to this board",
          skipped: partial.skipped.map((s) => s.reason),
        });
        return;
      }
      const ok = partial.applied;

      // Commit through the live room so peers receive the same sequenced entry
      // any edit produces — with the AI actor recording the accountability
      // chain: the model produced it, the proposer asked, this user approved.
      //
      // One requestId per PROPOSAL, not per approver: two people approving at
      // once used to both pass the pending check and both commit — the second
      // as a direct store append the room never saw. With one key, the room's
      // replay guard (and the store's, across instances) answers the second
      // approval as the duplicate it is.
      const requestId = `prp_${proposal.id}_${guard.user.id}`;
      const actor = {
        actorType: "ai" as const,
        actorId: "lucent",
        initiatedBy: proposal.createdBy,
        approvedBy: guard.user.id,
      };
      const alreadyDecided = async () => {
        const fresh = await proposals.get(boardId, pid);
        return fresh && fresh.status !== "pending" ? fresh : null;
      };
      let seq: number;
      const roomResult = await commitForBoard(boardId, guard.user.id, ok, "proposal approved", {
        requestId,
        actor,
        role: guard.role,
      });
      if (roomResult) {
        // A live room is the only writer while it lives: a refusal is the
        // answer, never a cue to write behind its back (that append left the
        // durable log holding an entry no socket received and the room never
        // applied).
        if (roomResult.duplicate) {
          const fresh = await alreadyDecided();
          send(res, 200, { proposal: fresh ?? proposal, duplicate: true });
          return;
        }
        if (!roomResult.ok || !roomResult.entry) {
          const fresh = await alreadyDecided();
          if (fresh) return send(res, 200, { proposal: fresh, duplicate: true });
          send(res, 409, {
            error: "the board changed under this proposal — review it again",
            reason: roomResult.error,
            ...(roomResult.detail ? { detail: roomResult.detail } : {}),
            ...(roomResult.head !== undefined ? { head: roomResult.head } : {}),
          });
          return;
        }
        // commitForBoard broadcast the entry and saved the room's state.
        seq = roomResult.entry.seq;
      } else {
        // No live room (nobody connected): the store is the only writer, and
        // the next join replays the entry.
        const append = await s.boardStore.appendOp({
          boardId,
          ops: ok,
          by: guard.user.id,
          label: "proposal approved",
          at: Date.now(),
          requestId,
          actor,
        });
        if (!append.ok) {
          send(res, 409, { error: "stale board", reason: append.reason, head: append.head });
          return;
        }
        if (append.duplicate) {
          const fresh = await alreadyDecided();
          send(res, 200, { proposal: fresh ?? proposal, duplicate: true });
          return;
        }
        seq = append.seq;
        const { applyOperations } = await import("@lucent/core");
        const current = (await s.boardStore.get(boardId)) ?? guard.board;
        await s.boardStore.put({
          ...current,
          workspace: applyOperations(current.workspace, ok),
          updatedAt: Date.now(),
        });
      }

      const decided = await proposals.decide(boardId, pid, {
        status: "approved",
        decidedBy: guard.user.id,
        decidedAt: Date.now(),
        appliedSeq: seq,
      });
      broadcastProposal(boardId, {
        type: "proposal-decided",
        id: pid,
        status: "approved",
        by: guard.user.id,
        appliedSeq: seq,
      });
      // ADR 0047: the run learns what it became, and who approved it.
      if (proposal.runId && seq !== undefined) {
        await s.aiRuns.linkCommit(proposal.runId, seq, guard.user.id, Date.now()).catch(() => {});
      }
      void auditRow(req, guard.user.id, guard.board.orgId, "board.proposal.approved", boardId, {
        proposalId: pid,
        operations: proposal.operations.length,
        applied: ok.length,
        ...(seq !== undefined ? { seq } : {}),
        ...(proposal.meetingId ? { meetingId: proposal.meetingId } : {}),
      });
      send(res, 200, { proposal: decided, applied: ok.length, seq });
    };

  router.post("/api/boards/:id/proposals/:pid/approve", decide("approved"));
  router.post("/api/boards/:id/proposals/:pid/reject", decide("rejected"));
};
