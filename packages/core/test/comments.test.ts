import { describe, it, expect } from "vitest";
import {
  applyOperations,
  commentThreads,
  createWorkspace,
  openCommentCounts,
  openMentions,
  parseMentions,
  validateOperations,
} from "../src/index.js";

/**
 * Comment threads are model operations, so feedback persists, undoes as one
 * step, and is readable by the AI. A thread is a root comment plus replies
 * carrying `parentId`; keeping the store flat means a reply undoes on its own
 * and a future multiplayer session can stream single comments.
 */

function board() {
  return applyOperations(createWorkspace(), [
    { op: "CREATE_NODE", id: "n1", nodeType: "service", label: "Checkout" },
    {
      op: "CREATE_SHAPE",
      id: "s1",
      kind: "sticky",
      position: { x: 0, y: 0 },
      size: { width: 150, height: 110 },
      text: "Payment idea",
    },
  ]);
}

const T0 = 1_700_000_000_000;

describe("comment threads", () => {
  it("anchors a thread to a node or a shape", () => {
    const ws = applyOperations(board(), [
      {
        op: "ADD_COMMENT",
        id: "c1",
        targetId: "n1",
        body: "Is this async?",
        by: "ana",
        createdAt: T0,
      },
      {
        op: "ADD_COMMENT",
        id: "c2",
        targetId: "s1",
        body: "Move this up",
        by: "bo",
        createdAt: T0 + 1,
      },
    ]);
    expect(commentThreads(ws, "n1").map((t) => t.root.id)).toEqual(["c1"]);
    expect(commentThreads(ws, "s1").map((t) => t.root.id)).toEqual(["c2"]);
    expect(commentThreads(ws)).toHaveLength(2);
  });

  it("groups replies under their root in creation order", () => {
    const ws = applyOperations(board(), [
      { op: "ADD_COMMENT", id: "c1", targetId: "n1", body: "Question", by: "ana", createdAt: T0 },
      {
        op: "REPLY_COMMENT",
        id: "r2",
        parentId: "c1",
        body: "Second",
        by: "bo",
        createdAt: T0 + 20,
      },
      {
        op: "REPLY_COMMENT",
        id: "r1",
        parentId: "c1",
        body: "First",
        by: "cy",
        createdAt: T0 + 10,
      },
    ]);
    const [thread] = commentThreads(ws, "n1");
    expect(thread?.replies.map((r) => r.id)).toEqual(["r1", "r2"]);
    // A reply is not itself a thread root.
    expect(commentThreads(ws)).toHaveLength(1);
  });

  it("gives a reply the same anchor as its root", () => {
    const ws = applyOperations(board(), [
      { op: "ADD_COMMENT", id: "c1", targetId: "s1", body: "Root", by: "ana", createdAt: T0 },
      { op: "REPLY_COMMENT", id: "r1", parentId: "c1", body: "Reply", by: "bo", createdAt: T0 + 1 },
    ]);
    expect(ws.comments.r1?.targetId).toBe("s1");
  });

  it("records the author the caller supplied", () => {
    // Nothing invents an author any more: `by` is optional in the contract and
    // the server stamps it (see authorship.ts), so what the caller passes is what
    // the thread shows.
    const ws = applyOperations(board(), [
      { op: "ADD_COMMENT", id: "c1", targetId: "n1", body: "Hi", by: "ana" },
    ]);
    expect(ws.comments.c1?.by).toBe("ana");
  });

  it("stamps a creation time when none is supplied", () => {
    const ws = applyOperations(board(), [
      { op: "ADD_COMMENT", id: "c1", targetId: "n1", body: "Hi" },
    ]);
    expect(ws.comments.c1?.createdAt).toBeGreaterThan(0);
  });
});

describe("resolving", () => {
  const seeded = () =>
    applyOperations(board(), [
      { op: "ADD_COMMENT", id: "c1", targetId: "n1", body: "Fix this", by: "ana", createdAt: T0 },
      {
        op: "ADD_COMMENT",
        id: "c2",
        targetId: "n1",
        body: "And this",
        by: "bo",
        createdAt: T0 + 1,
      },
    ]);

  it("marks a thread resolved and reopens it", () => {
    let ws = applyOperations(seeded(), [{ op: "RESOLVE_COMMENT", id: "c1", resolved: true }]);
    expect(ws.comments.c1?.resolved).toBe(true);
    ws = applyOperations(ws, [{ op: "RESOLVE_COMMENT", id: "c1", resolved: false }]);
    expect(ws.comments.c1?.resolved).toBeUndefined();
  });

  it("counts only unresolved threads per target", () => {
    const ws = applyOperations(seeded(), [{ op: "RESOLVE_COMMENT", id: "c1", resolved: true }]);
    expect(openCommentCounts(ws)).toEqual({ n1: 1 });
  });

  it("does not count replies as separate threads", () => {
    const ws = applyOperations(seeded(), [
      { op: "REPLY_COMMENT", id: "r1", parentId: "c1", body: "ok", by: "bo", createdAt: T0 + 5 },
    ]);
    expect(openCommentCounts(ws)).toEqual({ n1: 2 });
  });
});

describe("mentions", () => {
  it("extracts mention names from a body", () => {
    expect(parseMentions("hey @ana and @bo.smith, look at @ana again")).toEqual([
      "ana",
      "bo.smith",
    ]);
    expect(parseMentions("no mentions here")).toEqual([]);
  });

  it("records mentions on the stored comment", () => {
    const ws = applyOperations(board(), [
      {
        op: "ADD_COMMENT",
        id: "c1",
        targetId: "n1",
        body: "@ana can you check?",
        by: "bo",
        createdAt: T0,
      },
    ]);
    expect(ws.comments.c1?.mentions).toEqual(["ana"]);
  });

  it("records mentions on replies too", () => {
    const ws = applyOperations(board(), [
      { op: "ADD_COMMENT", id: "c1", targetId: "n1", body: "root", by: "bo", createdAt: T0 },
      {
        op: "REPLY_COMMENT",
        id: "r1",
        parentId: "c1",
        body: "cc @cy",
        by: "bo",
        createdAt: T0 + 1,
      },
    ]);
    expect(ws.comments.r1?.mentions).toEqual(["cy"]);
  });

  it("lists open mentions and drops them once resolved", () => {
    let ws = applyOperations(board(), [
      { op: "ADD_COMMENT", id: "c1", targetId: "n1", body: "@ana look", by: "bo", createdAt: T0 },
      {
        op: "ADD_COMMENT",
        id: "c2",
        targetId: "s1",
        body: "@cy look",
        by: "bo",
        createdAt: T0 + 1,
      },
    ]);
    expect(openMentions(ws)).toEqual(["ana", "cy"]);
    ws = applyOperations(ws, [{ op: "RESOLVE_COMMENT", id: "c1", resolved: true }]);
    expect(openMentions(ws)).toEqual(["cy"]);
  });

  it("hides a reply's mention when its thread is resolved", () => {
    let ws = applyOperations(board(), [
      { op: "ADD_COMMENT", id: "c1", targetId: "n1", body: "root", by: "bo", createdAt: T0 },
      { op: "REPLY_COMMENT", id: "r1", parentId: "c1", body: "@dee?", by: "bo", createdAt: T0 + 1 },
    ]);
    expect(openMentions(ws)).toEqual(["dee"]);
    ws = applyOperations(ws, [{ op: "RESOLVE_COMMENT", id: "c1", resolved: true }]);
    expect(openMentions(ws)).toEqual([]);
  });
});

describe("deletion", () => {
  it("deleting a root removes its replies", () => {
    let ws = applyOperations(board(), [
      { op: "ADD_COMMENT", id: "c1", targetId: "n1", body: "root", by: "bo", createdAt: T0 },
      { op: "REPLY_COMMENT", id: "r1", parentId: "c1", body: "reply", by: "bo", createdAt: T0 + 1 },
    ]);
    ws = applyOperations(ws, [{ op: "DELETE_COMMENT", id: "c1" }]);
    expect(Object.keys(ws.comments)).toEqual([]);
  });

  it("deleting a reply leaves the thread intact", () => {
    let ws = applyOperations(board(), [
      { op: "ADD_COMMENT", id: "c1", targetId: "n1", body: "root", by: "bo", createdAt: T0 },
      { op: "REPLY_COMMENT", id: "r1", parentId: "c1", body: "reply", by: "bo", createdAt: T0 + 1 },
    ]);
    ws = applyOperations(ws, [{ op: "DELETE_COMMENT", id: "r1" }]);
    expect(commentThreads(ws, "n1")[0]?.replies).toEqual([]);
    expect(ws.comments.c1).toBeDefined();
  });

  it("deleting the commented object removes its threads and replies", () => {
    let ws = applyOperations(board(), [
      { op: "ADD_COMMENT", id: "c1", targetId: "n1", body: "root", by: "bo", createdAt: T0 },
      { op: "REPLY_COMMENT", id: "r1", parentId: "c1", body: "reply", by: "bo", createdAt: T0 + 1 },
      { op: "ADD_COMMENT", id: "c2", targetId: "s1", body: "other", by: "bo", createdAt: T0 + 2 },
    ]);
    ws = applyOperations(ws, [{ op: "DELETE_NODE", id: "n1" }]);
    // A pin count must never point at something that no longer exists.
    expect(Object.keys(ws.comments)).toEqual(["c2"]);
    ws = applyOperations(ws, [{ op: "DELETE_SHAPE", id: "s1" }]);
    expect(Object.keys(ws.comments)).toEqual([]);
  });
});

describe("validation", () => {
  it("rejects a comment on an object that does not exist", () => {
    expect(
      validateOperations(board(), [
        { op: "ADD_COMMENT", id: "c1", targetId: "ghost", body: "hi", by: "ana" },
      ]),
    ).toHaveLength(1);
  });

  it("rejects a reply to a thread that does not exist", () => {
    expect(
      validateOperations(board(), [
        { op: "REPLY_COMMENT", id: "r1", parentId: "nope", body: "hi", by: "ana" },
      ]),
    ).toHaveLength(1);
  });

  it("rejects a reply to a reply — threads are one level deep", () => {
    const ws = applyOperations(board(), [
      { op: "ADD_COMMENT", id: "c1", targetId: "n1", body: "root", by: "ana", createdAt: T0 },
      {
        op: "REPLY_COMMENT",
        id: "r1",
        parentId: "c1",
        body: "reply",
        by: "ana",
        createdAt: T0 + 1,
      },
    ]);
    expect(
      validateOperations(ws, [
        { op: "REPLY_COMMENT", id: "r2", parentId: "r1", body: "nested", by: "ana" },
      ]),
    ).toHaveLength(1);
  });

  it("accepts a batch that creates a thread and replies to it in order", () => {
    expect(
      validateOperations(board(), [
        { op: "ADD_COMMENT", id: "c1", targetId: "n1", body: "root", by: "ana" },
        { op: "REPLY_COMMENT", id: "r1", parentId: "c1", body: "reply", by: "ana" },
        { op: "RESOLVE_COMMENT", id: "c1", resolved: true },
      ]),
    ).toHaveLength(0);
  });

  it("rejects duplicate ids and unknown resolve/delete targets", () => {
    const ws = applyOperations(board(), [
      { op: "ADD_COMMENT", id: "c1", targetId: "n1", body: "root", by: "ana", createdAt: T0 },
    ]);
    expect(
      validateOperations(ws, [
        { op: "ADD_COMMENT", id: "c1", targetId: "n1", body: "dup", by: "ana" },
      ]),
    ).toHaveLength(1);
    expect(
      validateOperations(ws, [{ op: "RESOLVE_COMMENT", id: "nope", resolved: true }]),
    ).toHaveLength(1);
    expect(validateOperations(ws, [{ op: "DELETE_COMMENT", id: "nope" }])).toHaveLength(1);
  });
});

describe("workspace shape", () => {
  it("starts with no comments and does not mutate on add", () => {
    const ws = createWorkspace();
    expect(ws.comments).toEqual({});
    const before = board();
    const snapshot = JSON.stringify(before);
    applyOperations(before, [{ op: "ADD_COMMENT", id: "c1", targetId: "n1", body: "hi" }]);
    expect(JSON.stringify(before)).toBe(snapshot);
  });
});
