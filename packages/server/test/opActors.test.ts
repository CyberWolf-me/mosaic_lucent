import { describe, it, expect } from "vitest";
import { applyOperations, createWorkspace, type Operation } from "@lucent/core";
import { Room } from "../src/room.js";
import { InMemoryBoardStore, aiActor, userActor, type OpAppend } from "../src/boards.js";
import type { LoggedOp } from "../src/room.js";

/**
 * The actor model (Stage B2): every log entry records WHO/WHAT produced it
 * (`actor`), WHO ASKED (`initiatedBy`), and WHO AUTHORIZED (`approvedBy`).
 * `by` — the workspace authorship stamp — stays exactly what it was; the
 * actor is log-level accountability, so a review-gated AI commit can say
 * both "Lucent created this" and "initiated by Alex, approved by Sarah".
 *
 * These tests pin the three paths that produce entries today: the human
 * edit (default actor), the agent acting under a caller's token, and the AI
 * approval shape Batch 3 will emit.
 */

const OWNER = "usr_owner";
const INITIATOR = "usr_alex";
const APPROVER = "usr_sarah";

function seededWorkspace() {
  return applyOperations(createWorkspace(), [
    { op: "CREATE_NODE", id: "a", nodeType: "step", label: "A" },
  ]);
}

function roomWithStore(store: InMemoryBoardStore) {
  const room = new Room("brd_1", seededWorkspace(), OWNER, [], {
    append: (entry) =>
      store.appendOp({
        ...(entry as Omit<LoggedOp, "seq">),
        boardId: "brd_1",
      } satisfies OpAppend),
    fetch: (fromSeq) =>
      store.loadLog("brd_1", fromSeq).then((rows) => rows.map((e) => ({ ...e }) as LoggedOp)),
  });
  room.setRole("usr_peer", "editor");
  room.setRole(APPROVER, "editor");
  return room;
}

describe("operation actors (Stage B2)", () => {
  it("a human edit defaults to the user actor with initiatedBy", async () => {
    const store = new InMemoryBoardStore();
    const room = roomWithStore(store);
    const result = await room.commit(OWNER, [{ op: "CHANGE_TEXT", id: "a", text: "x" }]);
    expect(result.ok).toBe(true);
    const log = await store.loadLog("brd_1");
    expect(log[0]?.actor).toEqual({ actorType: "user", actorId: OWNER, initiatedBy: OWNER });
  });

  it("the broadcast entry carries the actor so peers can attribute it", async () => {
    const store = new InMemoryBoardStore();
    const room = roomWithStore(store);
    const result = await room.commit(OWNER, [{ op: "CHANGE_TEXT", id: "a", text: "y" }]);
    if (!result.ok || !result.entry) throw new Error("expected commit to succeed");
    expect(result.entry.actor).toEqual({ actorType: "user", actorId: OWNER, initiatedBy: OWNER });
  });

  it("an AI act names the model as actor, the requester as initiatedBy, the approver as approvedBy", async () => {
    const store = new InMemoryBoardStore();
    const room = roomWithStore(store);
    const ops: Operation[] = [
      { op: "CREATE_NODE", id: "pricing", nodeType: "step", label: "Pricing" },
    ];
    // The shape Batch 3's proposal approval will send: the approver's socket
    // commits the model's operations, credited to the model, traced to the
    // human who asked and the human who said yes.
    const result = await room.commit(APPROVER, ops, "proposal approved", {
      requestId: "req_prop_1",
      actor: aiActor(INITIATOR, APPROVER),
    });
    expect(result.ok).toBe(true);
    const log = await store.loadLog("brd_1");
    expect(log[0]?.actor).toEqual({
      actorType: "ai",
      actorId: "lucent",
      initiatedBy: INITIATOR,
      approvedBy: APPROVER,
    });
    // `by` stays the approver's id — the workspace authorship stamp is the
    // person who pressed approve, exactly as before the actor model existed.
    expect(log[0]?.by).toBe(APPROVER);
  });

  it("userActor and aiActor build the documented shapes", () => {
    expect(userActor("usr_1")).toEqual({
      actorType: "user",
      actorId: "usr_1",
      initiatedBy: "usr_1",
    });
    expect(aiActor("usr_1")).toEqual({
      actorType: "ai",
      actorId: "lucent",
      initiatedBy: "usr_1",
    });
    expect(aiActor("usr_1", "usr_2").approvedBy).toBe("usr_2");
  });

  it("the actor survives a log replay (a restarted room re-reads it)", async () => {
    const store = new InMemoryBoardStore();
    const room = roomWithStore(store);
    await room.commit(
      APPROVER,
      [{ op: "CREATE_NODE", id: "z", nodeType: "step", label: "Z" }],
      "",
      {
        requestId: "req_ai",
        actor: aiActor(INITIATOR, APPROVER),
      },
    );
    // Cold start: the log replays into a new room, actor included.
    const log = await store.loadLog("brd_1");
    const room2 = new Room(
      "brd_1",
      seededWorkspace(),
      OWNER,
      log.map((e) => ({ ...e })),
    );
    const since = room2.since(0);
    expect(since[0]?.actor?.actorType).toBe("ai");
    expect(since[0]?.actor?.approvedBy).toBe(APPROVER);
  });
});
