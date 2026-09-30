import { newShareToken, type StoredBoard } from "../boards.js";
import type { RegisterRoutes } from "./context.js";

/**
 * Public read-only board sharing (docs/26). An editor opts a board in and gets
 * an unguessable token; anyone with the token reads a SANITIZED, read-only
 * snapshot with no account. The token lives on the board record, so an
 * operation can never publish a board, and revoking it makes the link go dark.
 *
 *   POST   /api/boards/:id/public    (editor)   -> { token, path }
 *   DELETE /api/boards/:id/public    (editor)   -> { ok: true }
 *   GET    /api/public/boards/:token (no auth)  -> { id, name, workspace }
 *
 * The GET is the one deliberately-unauthenticated route: it serves ONLY boards
 * that carry a token, strips the collaboration/authorship layer
 * (comments, votes, reactions), and never exposes org, members, classification
 * or integration data — only the drawing itself.
 */

const PRIVATE_WORKSPACE_KEYS = ["comments", "votes", "reactions"] as const;

function publicSnapshot(board: StoredBoard): { id: string; name: string; workspace: unknown } {
  const ws: Record<string, unknown> = {
    ...(board.workspace as unknown as Record<string, unknown>),
  };
  for (const k of PRIVATE_WORKSPACE_KEYS) delete ws[k];
  return { id: board.id, name: board.name, workspace: ws };
}

export const registerPublicBoardRoutes: RegisterRoutes = (router, s) => {
  const { send, requireCsrf, requireUser, requireBoardRole, boardStore } = s;

  const setPublic =
    (on: boolean) => async (ctx: Parameters<Parameters<typeof router.post>[1]>[0]) => {
      const { req, res } = ctx;
      const route = "/api/boards/:id/public";
      if (!requireCsrf(req, res, route)) return;
      const user = await requireUser(req, res);
      if (!user) return;
      const boardId = ctx.param("id");
      // Editor floor: publishing a board is a write, not a read.
      const guard = await requireBoardRole(req, res, boardId, "editor", route, user);
      if (!guard.ok) return;
      const board = guard.board;
      if (on && !board.publicToken) {
        board.publicToken = newShareToken();
        board.updatedAt = Date.now();
        await boardStore.put(board);
      } else if (!on && board.publicToken) {
        board.publicToken = null;
        board.updatedAt = Date.now();
        await boardStore.put(board);
      }
      send(
        res,
        200,
        on ? { token: board.publicToken, path: `/p/${board.publicToken}` } : { ok: true },
      );
    };

  router.post("/api/boards/:id/public", setPublic(true));
  router.delete("/api/boards/:id/public", setPublic(false));

  router.get("/api/public/boards/:token", async (ctx) => {
    const { req: _req, res } = ctx;
    // Deliberately unauthenticated (no requireUser) — a safe read of a board
    // its editor chose to publish. A GET, so no CSRF. Anything without a live
    // token 404s, so a private, revoked or deleted board is indistinguishable
    // from one that never existed.
    const token = ctx.param("token");
    const board = token ? await boardStore.findByPublicToken(token) : undefined;
    if (!board || !board.publicToken) {
      send(res, 404, { error: "no public board here" });
      return;
    }
    send(res, 200, publicSnapshot(board));
  });
};
