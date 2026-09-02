import { describe, it, expect } from "vitest";
import { applyOperations, createWorkspace, type Operation } from "@lucent/core";
import { Room } from "../src/room.js";
import { InMemoryBoardStore, newOperationId, type OpAppend } from "../src/boards.js";
import type { LoggedOp } from "../src/room.js";

/**
 * Stage B idempotency: a network retry of the same submit must be answered
 * with the original outcome, never a second effect. These tests pin the
 * contract at the Room level (duplicate → no entry, no broadcast, original
 * seq in the answer) and at the store level (one log row per requestId,
 * including the case that double-applies without the guard: a MOVE_NODE
 * replay, which validation cannot catch because moving twice is "valid").
 */

const OWNER = "usr_owner";

function seededWorkspace() {
  return applyOperations(createWorkspace(), [
    { op: "CREATE_NODE", id: "a", nodeType: "step", label: "A" },
    { op: "CREATE_NODE", id: "b", nodeType: "step", label: "B" },
  ]);
}

function roomWithStore(store: InMemoryBoardStore) {
  const room = new Room("brd_1", seededWorkspace(), OWNER, [], {
    append: (entry) =>
      store.appendOp({
        ...(entry as Omit<LoggedOp, "seq">),
        boardId: "brd_1",
        ...(entry.requestId !== undefined ? { requestId: entry.requestId } : {}),
      } satisfies OpAppend),
    fetch: (fromSeq) =>
      store.loadLog("brd_1", fromSeq).then((rows) => rows.map((e) => ({ ...e }) as LoggedOp)),
  });
  room.setRole("usr_peer", "editor");
  return room;
}

describe("idempotent commits (Stage B)", () => {
  it("a replayed requestId is answered with the original seq and writes nothing", async () => {
    const store = new InMemoryBoardStore();
    const room = roomWithStore(store);
    const ops: Operation[] = [{ op: "CHANGE_TEXT", id: "a", text: "one" }];
    const first = await room.commit(OWNER, ops, "", { requestId: "req_1" });
    expect(first.ok).toBe(true);
    expect(first.duplicate).toBeUndefined();
    const before = await store.loadLog("brd_1");
    const seq = (first as { entry?: LoggedOp }).entry?.seq;

    const replay = await room.commit(OWNER, ops, "", { requestId: "req_1" });
    expect(replay).toMatchObject({ ok: true, duplicate: true, head: seq });
    // No second effect: exactly one log row, and the duplicate answer names
    // the ORIGINAL seq so the retrying client learns where its edit landed.
    const after = await store.loadLog("brd_1");
    expect(after).toHaveLength(before.length);
    expect(replay.entry).toBeUndefined();
  });

  it("a MOVE_NODE replay — valid twice, so validation cannot catch it — applies once", async () => {
    const store = new InMemoryBoardStore();
    const room = roomWithStore(store);
    const ops: Operation[] = [{ op: "MOVE_NODE", id: "a", position: { x: 400, y: 220 } }];
    await room.commit(OWNER, ops, "", { requestId: "req_move" });
    await room.commit(OWNER, ops, "", { requestId: "req_move" });
    const log = await store.loadLog("brd_1");
    // The named bug: without idempotency a retried MOVE double-applies
    // (harmless to validity, wrong as history) or lands a second row.
    expect(log).toHaveLength(1);
    expect(log[0]?.requestId).toBe("req_move");
  });

  it("different requestIds from different users both land", async () => {
    const store = new InMemoryBoardStore();
    const room = roomWithStore(store);
    await room.commit(OWNER, [{ op: "CHANGE_TEXT", id: "a", text: "x" }], "", {
      requestId: "req_a",
    });
    await room.commit("usr_peer", [{ op: "CHANGE_TEXT", id: "b", text: "y" }], "", {
      requestId: "req_b",
    });
    const log = await store.loadLog("brd_1");
    expect(log).toHaveLength(2);
    expect(log.map((e) => e.requestId)).toEqual(["req_a", "req_b"]);
  });

  it("a rejection carries the requestId so the client can correlate it", async () => {
    const store = new InMemoryBoardStore();
    const room = roomWithStore(store);
    // Node "ghost" does not exist: validation must refuse, naming the request.
    const result = await room.commit(OWNER, [{ op: "CHANGE_TEXT", id: "ghost", text: "x" }], "", {
      requestId: "req_bad",
    });
    expect(result).toMatchObject({ ok: false, error: "validation", requestId: "req_bad" });
    expect(await store.loadLog("brd_1")).toHaveLength(0);
  });

  it("every committed entry carries a server-generated operationId", async () => {
    const store = new InMemoryBoardStore();
    const room = roomWithStore(store);
    await room.commit(OWNER, [{ op: "CHANGE_TEXT", id: "a", text: "z" }]);
    const log = await store.loadLog("brd_1");
    expect(log[0]?.operationId).toMatch(/^op_/);
    expect(log[0]?.operationId).not.toBe(newOperationId()); // generated, not shared
  });
});

describe("InMemoryBoardStore idempotency (Stage B)", () => {
  it("returns the original seq with duplicate: true on a replayed requestId", async () => {
    const store = new InMemoryBoardStore();
    const first = await store.appendOp({
      boardId: "brd_1",
      ops: [{ op: "CREATE_NODE", id: "a", nodeType: "step", label: "A" }],
      by: "usr_1",
      label: "",
      at: 1,
      requestId: "req_x",
    });
    expect(first).toMatchObject({ ok: true, seq: 1 });
    if (!first.ok) throw new Error("expected first append to succeed");
    const replay = await store.appendOp({
      boardId: "brd_1",
      ops: [{ op: "CREATE_NODE", id: "a", nodeType: "step", label: "A" }],
      by: "usr_1",
      label: "",
      at: 2,
      requestId: "req_x",
    });
    expect(replay).toMatchObject({ ok: true, seq: 1, duplicate: true });
    if (!replay.ok) throw new Error("expected replay to be answered");
    expect(replay.operationId).toBe(first.operationId);
    expect(await store.loadLog("brd_1")).toHaveLength(1);
  });

  it("the same requestId on a DIFFERENT board is a different submit", async () => {
    const store = new InMemoryBoardStore();
    await store.appendOp({
      boardId: "brd_1",
      ops: [{ op: "CREATE_NODE", id: "a", nodeType: "step", label: "A" }],
      by: "usr_1",
      label: "",
      at: 1,
      requestId: "req_shared",
    });
    const other = await store.appendOp({
      boardId: "brd_2",
      ops: [{ op: "CREATE_NODE", id: "a", nodeType: "step", label: "A" }],
      by: "usr_1",
      label: "",
      at: 1,
      requestId: "req_shared",
    });
    expect(other).toMatchObject({ ok: true, seq: 1 });
    if (!other.ok) throw new Error("expected the second board's append to succeed");
    expect(other.duplicate).toBeUndefined();
  });
});
