import type { RegisterRoutes } from "./context.js";
import { MAX_FAVORITES, isFavoriteKind } from "../favorites.js";
import { actorNamesFor } from "../historyView.js";
import type { StoredBoard } from "../boards.js";

/**
 * A person's own view across workspaces (docs/26 A6):
 *
 *   GET    /api/me/favorites               what you starred, that you can still open
 *   PUT    /api/me/favorites/:kind/:id     star a board or a project you can open
 *   DELETE /api/me/favorites/:kind/:id     unstar
 *   GET    /api/me/activity                what others changed lately on boards you follow
 *
 * The activity feed reads the boards you've starred, the boards you own or
 * were given, and your workspaces' most recently changed boards — their
 * newest op-log entries by someone other than you, in the last 14 days.
 */

const ACTIVITY_DAYS = 14;
const ACTIVITY_BOARDS = 15;
const ACTIVITY_PER_BOARD = 15;
const ACTIVITY_ITEMS = 50;

export const registerMeRoutes: RegisterRoutes = (router, s) => {
  const { send, requireCsrf, requireUser } = s;
  const favorites = s.favorites;

  /** The board, if this person may open it. */
  const openBoard = async (userId: string, boardId: string): Promise<StoredBoard | undefined> => {
    const board = await s.boardStore.get(boardId);
    if (!board) return undefined;
    const role = await s.boardStore.memberRole(boardId, userId, (uid) =>
      s.orgRoleFor(uid, board.orgId),
    );
    return role ? board : undefined;
  };
  /** The project, if this person can read its workspace. */
  const openProject = async (userId: string, projectId: string) => {
    const project = await s.projects.get(projectId);
    if (!project) return undefined;
    return (await s.orgRoleFor(userId, project.orgId)) ? project : undefined;
  };

  router.get("/api/me/favorites", async (ctx) => {
    const { req, res } = ctx;
    const user = await requireUser(req, res);
    if (!user) return;
    const out = [];
    for (const f of await favorites.list(user.id)) {
      if (f.kind === "board") {
        const board = await openBoard(user.id, f.targetId);
        if (board) {
          out.push({
            kind: "board",
            id: board.id,
            name: board.name,
            orgId: board.orgId,
            updatedAt: board.updatedAt,
          });
        }
      } else {
        const project = await openProject(user.id, f.targetId);
        if (project) {
          out.push({
            kind: "project",
            id: project.id,
            name: project.name,
            orgId: project.orgId,
            updatedAt: project.updatedAt,
          });
        }
      }
    }
    send(res, 200, { favorites: out });
  });

  const favoriteRoute = "/api/me/favorites/:kind/:id";
  const star = (on: boolean) => async (ctx: Parameters<Parameters<typeof router.put>[1]>[0]) => {
    const { req, res } = ctx;
    if (!requireCsrf(req, res, favoriteRoute)) return;
    const user = await requireUser(req, res);
    if (!user) return;
    const kind = ctx.param("kind");
    const id = ctx.param("id");
    if (!isFavoriteKind(kind)) return send(res, 400, { error: "kind is board or project" });
    if (!on) {
      await favorites.remove(user.id, kind, id);
      return send(res, 200, { kind, id, favorite: false });
    }
    const target = kind === "board" ? await openBoard(user.id, id) : await openProject(user.id, id);
    if (!target) return send(res, 404, { error: `no ${kind} you can open with that id` });
    if ((await favorites.list(user.id)).length >= MAX_FAVORITES) {
      return send(res, 409, { error: `you can star up to ${MAX_FAVORITES}` });
    }
    await favorites.add({
      userId: user.id,
      kind,
      targetId: id,
      orgId: target.orgId,
      createdAt: Date.now(),
    });
    send(res, 200, { kind, id, favorite: true });
  };
  router.put(favoriteRoute, star(true));
  router.delete(favoriteRoute, star(false));

  router.get("/api/me/activity", async (ctx) => {
    const { req, res } = ctx;
    const user = await requireUser(req, res);
    if (!user) return;
    const since = Date.now() - ACTIVITY_DAYS * 86_400_000;

    // The boards to follow: starred, your own and given to you, and each of
    // your workspaces' most recently changed ones.
    const boards = new Map<string, StoredBoard>();
    const starred = new Set<string>();
    for (const f of await favorites.list(user.id)) {
      if (f.kind !== "board") continue;
      const board = await openBoard(user.id, f.targetId);
      if (board) {
        boards.set(board.id, board);
        starred.add(board.id);
      }
    }
    for (const { board } of await s.boardStore.listGrantedTo(user.id, 50)) {
      boards.set(board.id, board);
    }
    for (const membership of await s.userStore.membershipsFor(user.id)) {
      for (const board of (await s.boardStore.listForOrg(membership.orgId)).slice(0, 10)) {
        boards.set(board.id, board);
      }
    }
    const followed = [...boards.values()]
      .filter((b) => b.updatedAt >= since)
      .sort(
        (a, b) =>
          Number(starred.has(b.id)) - Number(starred.has(a.id)) || b.updatedAt - a.updatedAt,
      )
      .slice(0, ACTIVITY_BOARDS);

    const collected: Array<{ board: StoredBoard; entry: import("../boards.js").LoggedOpEntry }> =
      [];
    for (const board of followed) {
      const head = await s.boardStore.latestSeq(board.id);
      const tail = await s.boardStore.loadLog(board.id, Math.max(0, head - ACTIVITY_PER_BOARD));
      for (const entry of tail) {
        if (entry.at < since) continue;
        // What you did, or what an AI did because you asked, isn't news to you.
        if (entry.by === user.id || entry.actor?.initiatedBy === user.id) continue;
        collected.push({ board, entry });
      }
    }
    collected.sort((a, b) => b.entry.at - a.entry.at);
    const page = collected.slice(0, ACTIVITY_ITEMS);
    const names = await actorNamesFor(
      s.userStore,
      page.map((p) => p.entry),
    );
    send(res, 200, {
      activity: page.map(({ board, entry }) => {
        const actorId = entry.actor?.actorId ?? entry.by;
        return {
          boardId: board.id,
          boardName: board.name,
          starred: starred.has(board.id),
          seq: entry.seq,
          at: entry.at,
          label: entry.label,
          ops: entry.ops.length,
          actor: names.get(actorId) ?? actorId,
          ...(entry.actor?.actorType && entry.actor.actorType !== "user"
            ? { actorType: entry.actor.actorType }
            : {}),
          // An AI change names who asked for it.
          ...(entry.actor?.actorType === "ai" && entry.actor.initiatedBy
            ? { onBehalfOf: names.get(entry.actor.initiatedBy) ?? entry.actor.initiatedBy }
            : {}),
        };
      }),
    });
  });
};
