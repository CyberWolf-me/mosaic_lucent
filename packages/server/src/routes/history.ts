import type { RegisterRoutes } from "./context.js";
import { actorNamesFor, historyItems, loadVisibleLog } from "../historyView.js";
import { MAX_HISTORY_WINDOW } from "../historyWindow.js";

/**
 * The board history route (Stage C1):
 *
 *   GET /api/boards/:id/history
 *
 * Viewer-floor read of the board's revision timeline, windowed by the org's
 * `history.depth` entitlement (ADR 0019). The window is an access boundary,
 * not a deletion: the log keeps everything above the snapshot floor, so an
 * upgrade reveals older revisions instantly and this route never prunes.
 *
 * The response is summarized — actor, label, counts, touched ids, the
 * proposal link — not raw operations. `hasMore` plus `historyDepth` tell the
 * UI (and Ask) the window is partial, so "I only see the latest 25" can be
 * said honestly instead of the board quietly appearing to begin there.
 *
 * No CSRF: a GET. Entitlements degrade the same way the billing surface
 * does — an unconfigured store answers Free limits rather than 500ing.
 */
export const registerHistoryRoutes: RegisterRoutes = (router, s) => {
  const { boardStore, userStore, proposals, entitlements, send, requireBoardRole } = s;

  router.get("/api/boards/:id/history", async (ctx) => {
    const { req, res } = ctx;
    const boardId = ctx.param("id");
    const guard = await requireBoardRole(req, res, boardId, "viewer", "/api/boards/:id/history");
    if (!guard.ok) return;

    // The entitlement this route exists to enforce. `null` entitlements
    // (billing unconfigured) degrade to Free-depth reads rather than refusing;
    // `limit: null` inside a resolved plan means unlimited.
    let depth: number | null = 25;
    if (entitlements) {
      const entitlement = await entitlements.entitlement(guard.board.orgId, "history.depth");
      depth = entitlement.limit;
    }

    const { window, entries } = await loadVisibleLog(boardStore, boardId, depth);
    const names = await actorNamesFor(userStore, entries);
    // The proposal join: appliedSeq ↔ seq. One read of the board's proposals
    // (already bounded by PROPOSAL_LIST_LIMIT) covers the whole window.
    const boardProposals = proposals ? await proposals.forBoard(boardId) : [];
    const items = historyItems(
      entries,
      names,
      boardProposals,
      (id) => guard.board.workspace.nodes[id]?.statement?.kind,
    );

    send(res, 200, {
      items,
      // The honest-window contract: the UI and Ask read the same numbers.
      historyDepth: window.depth,
      limit: window.limit,
      hasMore: window.hasMore,
      latestSeq: window.head,
      // The response ceiling for unlimited plans, so the client can tell
      // "unlimited plan" from "everything fits" (limit === items.length here
      // would be ambiguous otherwise).
      windowCeiling: MAX_HISTORY_WINDOW,
    });
  });
};
