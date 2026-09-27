import type { IncomingMessage, ServerResponse } from "node:http";
import type { StoredUser } from "../identity.js";
import {
  parseNewMessages,
  parseThreadScope,
  THREAD_READ_DEFAULT,
  type ThreadScope,
} from "../threads.js";
import type { RegisterRoutes } from "./context.js";

/**
 * Conversation threads (docs/26 J7, ADR 0048):
 *
 *   GET    /api/threads?scope=…&limit=   your thread on a scope, oldest first
 *   POST   /api/threads                   {scope, messages} append to it
 *   DELETE /api/threads?scope=…           start the conversation over
 *
 * A thread is its author's alone — there is no route to anyone else's. The
 * scope must be one the caller can read right now (a board they can open, a
 * meeting on it, a project they can see, a workspace they belong to), so a
 * thread can't outlive access into a place the person has left.
 */
export const registerThreadRoutes: RegisterRoutes = (router, s) => {
  const {
    send,
    readBody,
    requireUser,
    requireCsrf,
    requireBoardRole,
    readableBoards,
    projects,
    meetings,
    threads,
  } = s;

  /** The scope's org, when the caller may converse there; the response is sent otherwise. */
  async function access(
    req: IncomingMessage,
    res: ServerResponse,
    user: StoredUser,
    scope: ThreadScope,
    route: string,
  ): Promise<string | undefined> {
    if (scope.type === "board" || scope.type === "meeting") {
      const guard = await requireBoardRole(req, res, scope.boardId!, "viewer", route, user);
      if (!guard.ok) return undefined;
      if (scope.type === "meeting") {
        const meeting = meetings ? await meetings.get(scope.boardId!, scope.meetingId!) : undefined;
        if (!meeting) {
          send(res, 404, { error: "meeting not found" });
          return undefined;
        }
      }
      return guard.board.orgId;
    }
    const { member, boards } = await readableBoards(user.id, scope.orgId!);
    if (scope.type === "workspace") {
      if (member || boards.length > 0) return scope.orgId;
      send(res, 404, { error: "workspace not found" });
      return undefined;
    }
    const project = await projects.get(scope.projectId!);
    const readable = new Set(boards.map((b) => b.id));
    if (
      project &&
      project.orgId === scope.orgId &&
      (member || project.boardIds.some((id) => readable.has(id)))
    ) {
      return scope.orgId;
    }
    send(res, 404, { error: "project not found" });
    return undefined;
  }

  const scopeOf = (req: IncomingMessage): ThreadScope | null =>
    parseThreadScope(new URL(req.url ?? "/", "http://localhost").searchParams.get("scope"));

  router.get("/api/threads", async (ctx) => {
    const { req, res } = ctx;
    const user = await requireUser(req, res);
    if (!user) return;
    const scope = scopeOf(req);
    if (!scope)
      return send(res, 400, { error: "scope is board:…, meeting:…:…, project:…:… or workspace:…" });
    if (!(await access(req, res, user, scope, "/api/threads"))) return;
    const requested = Number(new URL(req.url ?? "/", "http://localhost").searchParams.get("limit"));
    const limit =
      Number.isInteger(requested) && requested > 0 ? Math.min(requested, 200) : THREAD_READ_DEFAULT;
    send(res, 200, {
      scope: scope.key,
      messages: await threads.messages(user.id, scope.key, limit),
    });
  });

  router.post("/api/threads", async (ctx) => {
    const { req, res } = ctx;
    if (!requireCsrf(req, res, "/api/threads")) return;
    const user = await requireUser(req, res);
    if (!user) return;
    let body: { scope?: unknown; messages?: unknown };
    try {
      const raw = await readBody(req);
      body = raw ? (JSON.parse(raw) as typeof body) : {};
    } catch (err) {
      return send(res, 400, { error: "bad request", detail: (err as Error).message });
    }
    const scope = parseThreadScope(body.scope);
    if (!scope)
      return send(res, 400, { error: "scope is board:…, meeting:…:…, project:…:… or workspace:…" });
    const messages = parseNewMessages(body.messages, Date.now());
    if (!messages) return send(res, 400, { error: "messages: 1–10 of {role, text}" });
    const orgId = await access(req, res, user, scope, "/api/threads");
    if (!orgId) return;
    send(res, 201, { messages: await threads.append(user.id, orgId, scope.key, messages) });
  });

  router.delete("/api/threads", async (ctx) => {
    const { req, res } = ctx;
    if (!requireCsrf(req, res, "/api/threads")) return;
    const user = await requireUser(req, res);
    if (!user) return;
    const scope = scopeOf(req);
    if (!scope)
      return send(res, 400, { error: "scope is board:…, meeting:…:…, project:…:… or workspace:…" });
    // Clearing your own thread needs no access to the scope any more: a
    // person who left a board may still forget what they said there.
    await threads.clear(user.id, scope.key);
    send(res, 200, { scope: scope.key, cleared: true });
  });
};
