import type { RegisterRoutes } from "./context.js";
import { actorNamesFor, loadVisibleLog } from "../historyView.js";
import { MAX_HISTORY_WINDOW } from "../historyWindow.js";
import { visibleMeetings } from "../meetingsWindow.js";
import { buildSearchCorpus, retrieve, SEARCH_LIMITS } from "../retrieval.js";

/**
 * The board search route (Stage C4, ADR 0024):
 *
 *   GET /api/boards/:id/search?q=…
 *
 * Search and Ask share one boundary: this route windows its corpus with the
 * exact arithmetic the history and ask routes use — the org's history.depth
 * entitlement through loadVisibleLog, meetings floored at the oldest visible
 * revision — so a Free caller's search can never surface what their history
 * window refuses to show. The window bounds the corpus the retriever scans,
 * not the results: content outside the entitlement is not filtered out of
 * hits, it was never in the corpus to match.
 *
 * Viewer floor, no CSRF (a GET). Metered for abuse prevention (a tight
 * loop over a large corpus is still server work), but not billed — search
 * spends no allowance, the same reasoning as the history route. The response
 * discloses its window the same way the history route does: windowTruncated
 * says older content exists beyond the entitlement and was NOT searched, so
 * "no results" can be read honestly instead of as "nothing else exists".
 */
export const registerSearchRoutes: RegisterRoutes = (router, s) => {
  const { boardStore, userStore, meetings, entitlements, send, requireBoardRole, meter } = s;

  router.get("/api/boards/:id/search", async (ctx) => {
    const { req, res } = ctx;
    const boardId = ctx.param("id");
    if (!meter(req, res, "/api/boards/:id/search")) return;
    const guard = await requireBoardRole(req, res, boardId, "viewer", "/api/boards/:id/search");
    if (!guard.ok) return;

    const url = new URL(ctx.req.url ?? "/", "http://localhost");
    const query = (url.searchParams.get("q") ?? "").slice(0, SEARCH_LIMITS.queryMaxChars).trim();
    if (!query) {
      send(res, 400, { error: "q query parameter required" });
      return;
    }

    // The same window the history and ask routes compute — one entitlement,
    // one floor, one arithmetic, so search can never disagree with the
    // timeline about what exists.
    let depth: number | null = 25;
    if (entitlements) {
      const entitlement = await entitlements.entitlement(guard.board.orgId, "history.depth");
      depth = entitlement.limit;
    }
    const { window, entries } = await loadVisibleLog(boardStore, boardId, depth);
    const oldestVisibleAt = entries.length > 0 ? entries[entries.length - 1]!.at : 0;
    const boardMeetings = meetings
      ? visibleMeetings(await meetings.forBoard(boardId), oldestVisibleAt)
      : [];
    const names = await actorNamesFor(userStore, entries);

    const corpus = buildSearchCorpus({
      workspace: guard.board.workspace,
      meetings: boardMeetings,
      log: entries,
      actorNames: names,
    });
    const results = retrieve(query, corpus, SEARCH_LIMITS.resultsMax);

    send(res, 200, {
      query,
      results,
      historyDepth: window.depth,
      // The honest-window disclosure (the C1/C3 rule, applied to search):
      // when true, older revisions exist beyond the entitlement and were not
      // searched — the UI shows the limit rather than letting "no results"
      // read as "nothing else exists".
      windowTruncated: window.hasMore,
      windowCeiling: MAX_HISTORY_WINDOW,
    });
  });
};
