import type { Operation } from "@lucent/core";
import {
  applyOperations,
  isHumanOnlyOperation,
  repairOperations,
  stampAuthorship,
  validateOperations,
} from "@lucent/core";
import type { RegisterRoutes } from "./context.js";

/**
 * The agent/MCP op-apply endpoint (E3): `POST /api/boards/:id/ops`.
 *
 * Ops reach a stored board through exactly two paths today — the WebSocket
 * room (`{type:"op"}` → `Room.commit`, with server-assigned seq and
 * re-validation on every absorb round) and `/api/generate`'s authoritative
 * pipeline (provider → repair → validate → persist). An agent client fits
 * neither: it has no socket lifecycle, and it is not a model. This route is
 * the third path, and it is deliberately the *simplest correct* one:
 *
 *   filter human-only → stamp the CALLER's authorship → repair → validate
 *   against the stored workspace → append to the op log → persist.
 *
 * That mirrors `Room.commit`'s pipeline without the room: single-writer
 * HTTP, `appendOp` assigning the seq, `expectedSeq` offered so a caller that
 * read the board can be told it went stale rather than silently landing on
 * top of someone else's edit.
 *
 * CSRF does not fire for bearer-authenticated callers (the cookie check in
 * `requireCsrf` is what gates it), which is the documented intent — the
 * MCP client and programmatic API keys ride the bearer path. Cookie
 * sessions from the browser get the full CSRF check.
 *
 * Editor floor, not owner: an org editor can already edit every board in
 * the org through the room, so a stricter floor here would only split the
 * same permission across surfaces.
 */
export const registerBoardOpsRoutes: RegisterRoutes = (router, s) => {
  const { boardStore, readBody, requireUser, requireBoardRole, send, requestOrigin, orgStore } = s;

  router.post("/api/boards/:id/ops", async (ctx) => {
    const { req, res } = ctx;
    // No requireCsrf on this route: the guard only fires for cookie
    // sessions, and adding it would silently break bearer clients that the
    // comment in createApp's `requireCsrf` explicitly anticipates.
    const user = await requireUser(req, res);
    if (!user) return;
    const boardId = ctx.param("id");
    const guard = await requireBoardRole(req, res, boardId, "editor", "/api/boards/:id/ops", user);
    if (!guard.ok) return;

    let body: {
      ops?: unknown;
      label?: unknown;
      expectedSeq?: unknown;
      requestId?: unknown;
    };
    try {
      const raw = await readBody(req);
      body = raw ? (JSON.parse(raw) as typeof body) : {};
    } catch (err) {
      send(res, 400, { error: "bad request", detail: (err as Error).message });
      return;
    }

    if (!Array.isArray(body.ops) || body.ops.length === 0) {
      send(res, 400, { error: "ops must be a non-empty array" });
      return;
    }
    // `label` rides the op log for the history timeline; bounded so an agent
    // cannot park an essay in a text column.
    const label =
      typeof body.label === "string" && body.label.trim().length > 0
        ? body.label.trim().slice(0, 120)
        : "agent ops";
    // The idempotency key (Stage B): an HTTP client's retry of the same
    // submit must be answered with the original outcome, not a second effect.
    const requestId =
      typeof body.requestId === "string" && body.requestId.length > 0 && body.requestId.length <= 64
        ? body.requestId
        : undefined;

    // The idempotency guard runs BEFORE validation, for the same reason the
    // room's does: the original submit changed the workspace, so a replay
    // re-validated against current state would be refused ("node already
    // exists") instead of answered with its original outcome. The KEY names
    // the request; what that key already did is the answer.
    if (requestId !== undefined) {
      const prior = await boardStore.findRequest(boardId, requestId);
      if (prior) {
        send(res, 200, {
          seq: prior.seq,
          applied: 0,
          updatedAt: Date.now(),
          duplicate: true,
          ...(prior.operationId !== undefined ? { operationId: prior.operationId } : {}),
          requestId,
        });
        return;
      }
    }

    // The pipeline. Every step is the one Room.commit performs, in the same
    // order, for the same reasons; the comments there are the long form.
    const candidate = body.ops.filter(
      (op): op is Operation =>
        typeof op === "object" &&
        op !== null &&
        "op" in op &&
        typeof (op as { op: unknown }).op === "string",
    );
    const filtered = candidate.filter((op) => !isHumanOnlyOperation(op.op));
    if (filtered.length === 0) {
      // Every op was human-only (MOVE_NODE and friends): nothing to apply,
      // and saying so beats an empty 200 that reads as success.
      send(res, 422, {
        error: "operations failed validation",
        errors: [
          { index: 0, op: "unknown", message: "batch contains no agent-applicable operations" },
        ],
      });
      return;
    }
    // The caller's real user id, not ASSISTANT_AUTHOR: this is an
    // authenticated human's (or their agent's) act on their board, and the
    // authorship stamp is what comments/votes/reactions attribute to.
    const stamped = stampAuthorship(filtered, user.id);
    const operations = repairOperations(stamped);
    const errors = validateOperations(guard.board.workspace, operations);
    if (errors.length > 0) {
      send(res, 422, { error: "operations failed validation", errors });
      return;
    }

    // Append before persist: the log is the record, the workspace is the
    // projection. A crash between the two leaves a log entry the next
    // `catchUp` replays — the same ordering the room uses.
    const append = await boardStore.appendOp({
      boardId,
      ops: operations,
      by: user.id,
      label,
      at: Date.now(),
      ...(typeof body.expectedSeq === "number" ? { expectedSeq: body.expectedSeq } : {}),
      ...(requestId !== undefined ? { requestId } : {}),
    });
    if (!append.ok) {
      // Stale or raced: the caller re-reads and re-validates. `head` is
      // included so the retry saves the round trip, per AppendResult.
      send(res, 409, { error: "stale board", reason: append.reason, head: append.head });
      return;
    }
    // A replayed requestId: the original submit already applied and
    // persisted; answer with its outcome and change nothing. The 200 (not
    // 409) is deliberate — from the caller's side the request succeeded.
    if (append.duplicate) {
      send(res, 200, {
        seq: append.seq,
        applied: 0,
        updatedAt: Date.now(),
        duplicate: true,
        ...(requestId !== undefined ? { requestId } : {}),
      });
      return;
    }
    const updated = applyOperations(guard.board.workspace, operations);
    await boardStore.put({ ...guard.board, workspace: updated, updatedAt: Date.now() });

    // Audit: who drove an agent over whose board is exactly the question an
    // org owner asks after a bad batch, and it is not answerable from the op
    // log alone (which records `by` but not that it arrived via this route).
    await orgStore
      ?.audit({
        orgId: guard.board.orgId,
        actorId: user.id,
        action: "board.agent_ops",
        targetId: boardId,
        targetType: "board",
        metadata: { count: operations.length, label },
        ...requestOrigin(req),
        at: Date.now(),
      })
      .catch(() => {
        // The audit contract is warn-and-continue (orgs.ts): a failed audit
        // write must not 500 an op batch that already landed.
      });

    send(res, 200, {
      seq: append.seq,
      applied: operations.length,
      updatedAt: Date.now(),
      ...(append.operationId !== undefined ? { operationId: append.operationId } : {}),
      ...(requestId !== undefined ? { requestId } : {}),
    });
  });
};
