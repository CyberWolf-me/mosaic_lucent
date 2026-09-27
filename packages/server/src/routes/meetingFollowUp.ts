import { statementRows } from "@lucent/core";
import { personNamed } from "../automation.js";
import type { RegisterRoutes } from "./context.js";

/**
 * Follow-up after a meeting (docs/28 S11):
 *
 *   POST /api/boards/:id/meetings/:mid/notify-owners   tell each owner what they own from it
 *
 * The meeting's open actions that a person has reviewed (not suggestions
 * still waiting) and that name an owner. An owner is matched exactly to one
 * person who can open the board (`personNamed`, as `work.assigned` does);
 * one notification each, with everything they own from the meeting. The
 * answer says who was told and which owners matched nobody, so the page
 * can say so instead of implying everyone heard.
 *
 * The other follow-ups need no route of their own: tasks go through the
 * external-action gate, the next meeting through scheduling, and a board
 * section through a proposal.
 */
export const registerMeetingFollowUpRoutes: RegisterRoutes = (router, s) => {
  const { send, requireCsrf, requireBoardRole, meetings, userStore, orgStore, notifyUser } = s;

  router.post("/api/boards/:id/meetings/:mid/notify-owners", async (ctx) => {
    const { req, res } = ctx;
    const route = "/api/boards/:id/meetings/:mid/notify-owners";
    if (!requireCsrf(req, res, route)) return;
    const boardId = ctx.param("id");
    const guard = await requireBoardRole(req, res, boardId, "editor", route);
    if (!guard.ok) return;
    if (!meetings) return send(res, 503, { error: "meeting transcripts are not configured" });
    const meeting = await meetings.get(boardId, ctx.param("mid"));
    if (!meeting) return send(res, 404, { error: "meeting not found" });
    const board = guard.board;

    const owned = statementRows(board.workspace).filter(
      (r) =>
        r.kind === "action" &&
        r.status === "open" &&
        r.assignee &&
        r.trust !== "ai-suggested" &&
        r.provenance?.meetingId === meeting.id,
    );

    // Who can be told: the board's owner and the workspace's members — and
    // only those who can open the board, so a meeting's actions reach no one
    // who couldn't read them there.
    const people = new Map<string, { id: string; email: string; name: string }>();
    const owner = await userStore.findById(board.ownerId);
    if (owner) people.set(owner.id, { id: owner.id, email: owner.email, name: owner.name });
    for (const m of (await orgStore?.membersOf(board.orgId)) ?? []) {
      if (m.email) people.set(m.userId, { id: m.userId, email: m.email, name: m.name });
    }
    const byPerson = new Map<string, { email: string; name: string; items: typeof owned }>();
    const unmatched = new Set<string>();
    for (const row of owned) {
      const person = personNamed(people.values(), row.assignee!);
      if (!person) {
        unmatched.add(row.assignee!);
        continue;
      }
      const role = await s.boardStore.memberRole(board.id, person.id, (uid) =>
        s.orgRoleFor(uid, board.orgId),
      );
      if (!role) {
        unmatched.add(row.assignee!);
        continue;
      }
      const entry = byPerson.get(person.id) ?? {
        email: person.email,
        name: person.name,
        items: [],
      };
      entry.items.push(row);
      byPerson.set(person.id, entry);
    }

    const title = meeting.title ?? `the meeting on ${new Date(meeting.startedAt).toDateString()}`;
    const told = [];
    for (const [userId, entry] of byPerson) {
      const items = entry.items.map((r) => ({
        nodeId: r.id,
        label: r.label,
        dueDate: r.dueDate ?? null,
      }));
      // Your own actions aren't news to you.
      if (userId !== guard.user.id) {
        notifyUser({
          kind: "meeting.followup",
          to: { userId, email: entry.email },
          orgId: board.orgId,
          payload: {
            boardId: board.id,
            boardName: board.name,
            meetingId: meeting.id,
            title,
            byName: guard.user.name || guard.user.email,
            items,
          },
        });
      }
      told.push({ name: entry.name, you: userId === guard.user.id, actions: items.length });
    }
    send(res, 200, { told, unmatched: [...unmatched], actions: owned.length });
  });
};
