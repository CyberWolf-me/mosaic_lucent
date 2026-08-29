import { describe, it, expect } from "vitest";
import {
  ALL_OPERATION_NAMES,
  ASSISTANT_AUTHOR,
  UNKNOWN_AUTHOR,
  applyOperations,
  createWorkspace,
  inverseOperations,
  isAuthoredOperation,
  isUnauthored,
  operationUnionSchema,
  parseWorkspace,
  safeParseOperations,
  stampAuthorship,
  validateOperations,
  type Operation,
  type Workspace,
} from "@lucent/core";

/**
 * M0.4 invariants: authorship and inverse fidelity.
 *
 * Each test pins one property that "every AI action reversible" depends on.
 * These are the same properties the server's Room.commit and the client's
 * OperationHistory rely on to keep an undo multiplayer-safe.
 */

const T0 = 1_700_000_000_000;
const T1 = T0 + 1_000;
const T2 = T0 + 2_000;
const ME = "usr_self";
const PEER = "usr_peer";

function board(): Workspace {
  return createWorkspace({ name: "T", id: "ws_t" });
}

function boardWith(node: {
  id: string;
  label: string;
  position?: { x: number; y: number };
  pinned?: boolean;
  issue?: Workspace["nodes"][string]["issue"];
}): Workspace {
  let ws = board();
  ws = applyOperations(ws, [
    { op: "CREATE_NODE", id: node.id, nodeType: "step", label: node.label },
  ]);
  if (node.position) {
    ws = applyOperations(ws, [
      { op: "MOVE_NODE", id: node.id, position: node.position, pinned: node.pinned ?? true },
    ]);
  }
  if (node.issue) {
    ws = applyOperations(ws, [
      {
        op: "SET_ISSUE",
        id: node.id,
        issue: { ...node.issue, statusCategory: node.issue.statusCategory ?? "todo" },
      },
    ]);
  }
  return ws;
}

describe("the operation contract does not invent an author", () => {
  it("parses an authored op with no `by` and leaves the author unset", () => {
    // `by` used to default to "me", so a comment nobody wrote could be persisted
    // as if someone had. The schema now leaves the author absent and the server
    // decides: every validating write path stamps it, and the validator refuses
    // an authored op that arrives without one (see the suite below).
    const parsed = safeParseOperations([
      { op: "ADD_COMMENT", id: "c1", targetId: "n1", body: "hi" },
      { op: "REPLY_COMMENT", id: "r1", parentId: "c1", body: "yo" },
      { op: "ADD_VOTE", id: "v1", targetId: "n1" },
      { op: "ADD_REACTION", id: "x1", targetId: "n1", emoji: "👍" },
    ]);
    if (!parsed.success) throw new Error(parsed.error.message);
    for (const op of parsed.data) {
      expect((op as { by?: string }).by).toBeUndefined();
    }
    expect(JSON.stringify(parsed.data)).not.toContain('"me"');
  });

  it("still accepts an explicit author, so a stamped batch round-trips", () => {
    const parsed = safeParseOperations([
      { op: "ADD_COMMENT", id: "c1", targetId: "n1", body: "hi", by: PEER },
    ]);
    expect(parsed.success).toBe(true);
  });
});

describe("stampAuthorship", () => {
  it("attributes every authored kind to the committing user", () => {
    // A client may legitimately omit `by` — the AI always does, since it cannot
    // know who is asking — and the author is filled in server-side.
    const ops: Operation[] = [
      { op: "ADD_COMMENT", id: "c1", targetId: "n1", body: "hi" },
      { op: "REPLY_COMMENT", id: "r1", parentId: "c1", body: "yo" },
      { op: "ADD_VOTE", id: "v1", targetId: "n1" },
      { op: "ADD_REACTION", id: "x1", targetId: "n1", emoji: "👍" },
    ];
    const out = stampAuthorship(ops, ME, T0);
    for (const op of out) {
      if ("by" in op) expect(op.by).toBe(ME);
    }
  });

  it("overwrites a client-supplied author instead of trusting it", () => {
    // The wire is not a source of identity. If a peer's id survived stamping,
    // any editor could post a comment or cast a vote as a colleague. The cost is
    // that undoing the deletion of a peer's comment re-attributes it — see the
    // note in authorship.ts.
    const ops: Operation[] = [
      { op: "ADD_COMMENT", id: "c1", targetId: "n1", body: "hi", by: PEER },
      { op: "ADD_VOTE", id: "v1", targetId: "n1", by: PEER },
    ];
    const out = stampAuthorship(ops, ME, T0);
    expect(out.map((op) => ("by" in op ? op.by : null))).toEqual([ME, ME]);
  });

  it("leaves no trace of the retired 'me' placeholder", () => {
    const out = stampAuthorship(
      [{ op: "ADD_COMMENT", id: "c1", targetId: "n1", body: "hi", by: "me" }],
      ME,
      T0,
    );
    expect((out[0] as { by: string }).by).toBe(ME);
    expect(JSON.stringify(out)).not.toContain('"me"');
  });

  it("fills a missing createdAt on comments and replies", () => {
    const ops: Operation[] = [
      { op: "ADD_COMMENT", id: "c1", targetId: "n1", body: "hi", by: ME },
      { op: "REPLY_COMMENT", id: "r1", parentId: "c1", body: "yo", by: ME },
    ];
    const out = stampAuthorship(ops, ME, T0);
    expect((out[0] as { createdAt: number }).createdAt).toBe(T0);
    expect((out[1] as { createdAt: number }).createdAt).toBe(T0);
  });

  it("keeps a createdAt the caller supplied, so a restored comment keeps its time", () => {
    const out = stampAuthorship(
      [{ op: "ADD_COMMENT", id: "c1", targetId: "n1", body: "hi", createdAt: T1 }],
      ME,
      T0,
    );
    expect((out[0] as { createdAt: number }).createdAt).toBe(T1);
  });

  it("leaves non-authored ops untouched", () => {
    const ops: Operation[] = [
      { op: "CREATE_NODE", id: "n1", nodeType: "step", label: "L" },
      { op: "DELETE_NODE", id: "n1" },
    ];
    const out = stampAuthorship(ops, ME);
    expect(out).toEqual(ops);
  });
});

describe("inverse fidelity: DELETE_NODE", () => {
  it("captures position so a deleted-and-undone node reappears where it was", () => {
    const before = boardWith({ id: "n1", label: "A", position: { x: 50, y: 60 }, pinned: true });
    const deleted = applyOperations(before, [{ op: "DELETE_NODE", id: "n1" }]);
    const inverses = inverseOperations([{ op: "DELETE_NODE", id: "n1" }], before);
    const restored = applyOperations(deleted, inverses);
    expect(restored.nodes.n1?.position).toEqual({ x: 50, y: 60 });
    expect(restored.nodes.n1?.pinned).toBe(true);
  });

  it("captures a Jira-style issue so a deleted-and-undone node keeps its status", () => {
    const before = boardWith({
      id: "n1",
      label: "A",
      position: { x: 0, y: 0 },
      issue: {
        type: "task",
        status: "In Progress",
        statusCategory: "in_progress",
        priority: "high",
      },
    });
    const deleted = applyOperations(before, [{ op: "DELETE_NODE", id: "n1" }]);
    const inverses = inverseOperations([{ op: "DELETE_NODE", id: "n1" }], before);
    const restored = applyOperations(deleted, inverses);
    expect(restored.nodes.n1?.issue?.status).toBe("In Progress");
    expect(restored.nodes.n1?.issue?.priority).toBe("high");
  });

  it("captures connected edges so the undo restores the full subgraph", () => {
    let ws = board();
    ws = applyOperations(ws, [
      { op: "CREATE_NODE", id: "a", nodeType: "step", label: "A" },
      { op: "CREATE_NODE", id: "b", nodeType: "step", label: "B" },
      { op: "CONNECT_NODES", source: "a", target: "b", relationship: "next" },
    ]);
    const beforeDelete = ws;
    const afterDelete = applyOperations(ws, [{ op: "DELETE_NODE", id: "a" }]);
    const inverses = inverseOperations([{ op: "DELETE_NODE", id: "a" }], beforeDelete);
    const restored = applyOperations(afterDelete, inverses);
    expect(restored.nodes.a).toBeDefined();
    expect(restored.edges).toEqual(beforeDelete.edges);
  });
});

describe("inverse fidelity: RESOLVE_COMMENT", () => {
  it("captures the prior resolved state, not just the negation", () => {
    let ws = board();
    ws = applyOperations(ws, [
      { op: "ADD_COMMENT", id: "c1", targetId: "n1", body: "hi", by: ME, createdAt: T0 },
      { op: "RESOLVE_COMMENT", id: "c1", resolved: true },
    ]);
    // A stale re-open attempt (resolved=false when the thread is already closed).
    const inverses = inverseOperations([{ op: "RESOLVE_COMMENT", id: "c1", resolved: false }], ws);
    expect(inverses).toEqual([{ op: "RESOLVE_COMMENT", id: "c1", resolved: true }]);
  });

  it("restores resolved=false when the thread was open", () => {
    let ws = board();
    ws = applyOperations(ws, [
      { op: "ADD_COMMENT", id: "c1", targetId: "n1", body: "hi", by: ME, createdAt: T0 },
    ]);
    const inverses = inverseOperations([{ op: "RESOLVE_COMMENT", id: "c1", resolved: true }], ws);
    expect(inverses).toEqual([{ op: "RESOLVE_COMMENT", id: "c1", resolved: false }]);
  });
});

describe("inverse fidelity: GROUP_SHAPES", () => {
  it("restores each shape's prior groupId rather than nulling it", () => {
    let ws = board();
    ws = applyOperations(ws, [
      {
        op: "CREATE_SHAPE",
        id: "s1",
        kind: "rect",
        position: { x: 0, y: 0 },
        size: { width: 10, height: 10 },
        groupId: "g_old",
      },
      {
        op: "CREATE_SHAPE",
        id: "s2",
        kind: "rect",
        position: { x: 20, y: 0 },
        size: { width: 10, height: 10 },
      },
    ]);
    const inverses = inverseOperations(
      [{ op: "GROUP_SHAPES", groupId: "g_new", ids: ["s1", "s2"] }],
      ws,
    );
    // s1 should restore to its prior group "g_old"; s2 had no group so it nulls.
    expect(inverses).toContainEqual({ op: "UPDATE_SHAPE", id: "s1", groupId: "g_old" });
    expect(inverses).toContainEqual({ op: "UPDATE_SHAPE", id: "s2", groupId: null });
  });
});

describe("comment thread ordering is deterministic", () => {
  it("sorts replies by (createdAt, id) so ties resolve to a stable order", async () => {
    const { commentThreads } = await import("@lucent/core");
    let ws = board();
    ws = applyOperations(ws, [
      {
        op: "ADD_COMMENT",
        id: "r2",
        targetId: "n1",
        body: "second reply",
        by: PEER,
        createdAt: T1,
      },
      { op: "ADD_COMMENT", id: "r1", targetId: "n1", body: "first reply", by: ME, createdAt: T1 },
      { op: "ADD_COMMENT", id: "root", targetId: "n1", body: "root", by: ME, createdAt: T0 },
    ]);
    // Make r1/r2 replies of root.
    ws = applyOperations(ws, [
      { op: "DELETE_COMMENT", id: "r1" },
      { op: "DELETE_COMMENT", id: "r2" },
      { op: "ADD_COMMENT", id: "r1", targetId: "n1", body: "first reply", by: ME, createdAt: T1 },
      {
        op: "ADD_COMMENT",
        id: "r2",
        targetId: "n1",
        body: "second reply",
        by: PEER,
        createdAt: T1,
      },
    ]);
    // Re-key via parentId by hand: the model only marks a comment as a reply when
    // it's emitted via REPLY_COMMENT. To exercise the (createdAt, id) tiebreaker
    // we need two replies sharing the same parent.
    const replies = [
      { id: "r1", targetId: "n1", body: "first", by: ME, createdAt: T1, parentId: "root" },
      { id: "r2", targetId: "n1", body: "second", by: PEER, createdAt: T1, parentId: "root" },
    ];
    let replyWs = ws;
    for (const r of replies) {
      replyWs = applyOperations(replyWs, [
        { op: "DELETE_COMMENT", id: r.id },
        {
          op: "REPLY_COMMENT",
          id: r.id,
          parentId: r.parentId!,
          body: r.body,
          by: r.by,
          createdAt: r.createdAt,
        },
      ]);
    }
    const threads = commentThreads(replyWs, "n1");
    expect(threads[0]?.replies.map((r) => r.id)).toEqual(["r1", "r2"]);
  });
});

describe("stamping applied ops produces comments/votes whose by is the author", () => {
  it("a freshly-stamped ADD_COMMENT lands in the workspace with the author id", () => {
    let ws = board();
    ws = applyOperations(ws, [{ op: "CREATE_NODE", id: "n1", nodeType: "step", label: "A" }]);
    const stamped = stampAuthorship(
      [{ op: "ADD_COMMENT", id: "c1", targetId: "n1", body: "hi" }],
      ME,
      T0,
    );
    ws = applyOperations(ws, stamped);
    expect(ws.comments.c1?.by).toBe(ME);
    expect(ws.comments.c1?.createdAt).toBe(T0);
  });

  it("votes and reactions stamp in one pass", () => {
    const stamped = stampAuthorship(
      [
        { op: "ADD_VOTE", id: "v1", targetId: "n1" },
        { op: "ADD_REACTION", id: "x1", targetId: "n1", emoji: "👍" },
      ],
      ME,
    );
    expect((stamped[0] as { by: string }).by).toBe(ME);
    expect((stamped[1] as { by: string }).by).toBe(ME);
  });
});

describe("OperationHistory.restoreTo", () => {
  it("walks back through commits with a sequence of undos", async () => {
    const { OperationHistory } = await import("@lucent/core");
    let ws = board();
    ws = applyOperations(ws, [{ op: "CREATE_NODE", id: "a", nodeType: "step", label: "A" }]);
    const h = new OperationHistory(ws);
    h.commit([{ op: "CREATE_NODE", id: "b", nodeType: "step", label: "B" }], "b");
    h.commit([{ op: "CREATE_NODE", id: "c", nodeType: "step", label: "C" }], "c");
    expect(Object.keys(h.current().nodes).sort()).toEqual(["a", "b", "c"]);

    // restoreTo(1) means "back to after 1 commit" — i.e. one undo.
    const { workspace: snap1 } = h.restoreTo(1);
    expect(Object.keys(snap1.nodes).sort()).toEqual(["a", "b"]);

    // restoreTo(0) means "back to initial" — two more undos.
    const { workspace: snap0 } = h.restoreTo(0);
    expect(Object.keys(snap0.nodes)).toEqual(["a"]);

    // redo forward restores them via the redo stack.
    h.redo();
    h.redo();
    expect(Object.keys(h.current().nodes).sort()).toEqual(["a", "b", "c"]);
  });

  it("returns the ops it applied so a multiplayer caller can forward them", async () => {
    const { OperationHistory } = await import("@lucent/core");
    const h = new OperationHistory(board());
    h.commit([{ op: "CREATE_NODE", id: "a", nodeType: "step", label: "A" }], "a");
    h.commit([{ op: "CREATE_NODE", id: "b", nodeType: "step", label: "B" }], "b");
    const { ops } = h.undo();
    expect(ops.some((o) => o.op === "DELETE_NODE" && o.id === "b")).toBe(true);
    const { ops: redoOps } = h.redo();
    expect(redoOps.some((o) => o.op === "CREATE_NODE" && o.id === "b")).toBe(true);
  });
});
describe("the validator refuses an authored op with no author", () => {
  // The structural half of the M0.4 fix. Stamping is a convention every write
  // path is supposed to follow, and "supposed to" is what failed: the MCP path
  // shipped without it and nothing complained, because the reducer's `"me"`
  // fallback made an authorless comment look like a real one. Refusing here
  // turns the convention into an invariant checked at the contract boundary, so
  // the next write path that forgets fails on its first annotation.
  function target(): Workspace {
    let ws = board();
    ws = applyOperations(ws, [{ op: "CREATE_NODE", id: "n1", nodeType: "step", label: "A" }]);
    ws = applyOperations(ws, [
      { op: "ADD_COMMENT", id: "root", targetId: "n1", body: "thread", by: ME, createdAt: T0 },
    ]);
    return ws;
  }

  const unauthored: Operation[] = [
    { op: "ADD_COMMENT", id: "c1", targetId: "n1", body: "hi" },
    { op: "REPLY_COMMENT", id: "r1", parentId: "root", body: "yo" },
    { op: "ADD_VOTE", id: "v1", targetId: "n1" },
    { op: "ADD_REACTION", id: "x1", targetId: "n1", emoji: "👍" },
  ];

  for (const op of unauthored) {
    it(`rejects an unstamped ${op.op}`, () => {
      const errors = validateOperations(target(), [op]);
      expect(errors).toHaveLength(1);
      // The message has to name the fix, not just the symptom: whoever added the
      // path is reading this string in a 422 body.
      expect(errors[0]?.message).toContain("no author");
      expect(errors[0]?.message).toContain("stamp authorship");
      expect(errors[0]?.op).toBe(op.op);
    });
  }

  it("accepts the very same batch once it has been stamped", () => {
    // Proof that the new rule costs a correct caller nothing: the only thing
    // that changed between this and the four rejections above is stampAuthorship.
    const errors = validateOperations(target(), stampAuthorship(unauthored, ME, T0));
    expect(errors).toEqual([]);
  });

  it("accepts the assistant as an author, so the AI and MCP paths pass", () => {
    // ASSISTANT_AUTHOR is a real author id, not a missing one — `/api/generate`
    // with no signed-in user and every MCP call stamp with it.
    const errors = validateOperations(target(), stampAuthorship(unauthored, ASSISTANT_AUTHOR, T0));
    expect(errors).toEqual([]);
  });

  it("leaves unauthored *unauthored* ops alone", () => {
    // Only the four annotation kinds carry a `by`; a node or shape op has no
    // author and must not be caught by the same rule.
    const errors = validateOperations(target(), [
      { op: "CREATE_NODE", id: "n2", nodeType: "step", label: "B" },
      { op: "MOVE_NODE", id: "n2", position: { x: 1, y: 2 }, pinned: true },
      { op: "RESOLVE_COMMENT", id: "root", resolved: true },
    ]);
    expect(errors).toEqual([]);
  });
});

describe("the reducer names an unattributable author instead of inventing one", () => {
  /**
   * The reducer's fallback used to be `"me"` — the same literal the web uses for
   * a signed-in-as-nobody author — so an op with no `by` produced a record
   * indistinguishable from one a person wrote. It is now UNKNOWN_AUTHOR, which
   * says the true thing: nobody recorded who did this.
   *
   * Reaching the fallback at all takes an *unvalidated* apply, because the
   * validator now refuses an unauthored authored op. The two paths that qualify
   * are covered here; both are cases where rejecting would be worse than
   * recording the gap.
   */
  const target = (): Workspace =>
    applyOperations(board(), [{ op: "CREATE_NODE", id: "n1", nodeType: "step", label: "A" }]);

  it("labels an op_log row written before stamping existed", () => {
    // Path: a durable op_log entry replayed into a client through the realtime
    // catch-up (packages/web/src/boardSync.ts), which applies broadcast entries
    // without re-validating — the server already accepted them. Dropping the row
    // would diverge that client from the board, and re-attributing it to whoever
    // happens to be reading would be a fresh lie, so the honest answer is to say
    // the author is unknown.
    const replayed: Operation[] = [
      { op: "ADD_COMMENT", id: "c1", targetId: "n1", body: "from an old row", createdAt: T1 },
      { op: "REPLY_COMMENT", id: "r1", parentId: "c1", body: "also old", createdAt: T2 },
      { op: "ADD_VOTE", id: "v1", targetId: "n1" },
      { op: "ADD_REACTION", id: "x1", targetId: "n1", emoji: "👍" },
    ];
    const ws = applyOperations(target(), replayed);
    expect(ws.comments.c1?.by).toBe(UNKNOWN_AUTHOR);
    expect(ws.comments.r1?.by).toBe(UNKNOWN_AUTHOR);
    expect(ws.votes.v1?.by).toBe(UNKNOWN_AUTHOR);
    expect(ws.reactions.x1?.by).toBe(UNKNOWN_AUTHOR);
    // "unknown" and "the AI did it" are different facts; the fallback must not
    // quietly claim the second.
    expect(ws.comments.c1?.by).not.toBe(ASSISTANT_AUTHOR);
    // And the retired placeholder is gone from the board entirely.
    expect(JSON.stringify(ws)).not.toContain('"me"');
  });

  it("labels the throwaway workspace generate.ts rebuilds from a client summary", () => {
    // Path: `workspaceFromSummary` (packages/server/src/generate.ts) recreates
    // vote and reaction records from per-target *counts*, which carry no voters.
    // The records exist only so a REMOVE_VOTE the model emits has something to
    // resolve against, and the workspace is never persisted — but it must still
    // not name an author it does not have. Same op shape that file emits.
    const rebuilt: Operation[] = [
      { op: "ADD_VOTE", id: "n1#v0", targetId: "n1" },
      { op: "ADD_VOTE", id: "n1#v1", targetId: "n1" },
      { op: "ADD_REACTION", id: "n1#👍#0", targetId: "n1", emoji: "👍" },
    ];
    const ws = applyOperations(target(), rebuilt);
    expect(Object.values(ws.votes).map((v) => v.by)).toEqual([UNKNOWN_AUTHOR, UNKNOWN_AUTHOR]);
    expect(ws.reactions["n1#👍#0"]?.by).toBe(UNKNOWN_AUTHOR);
  });

  it("never overrides an author that is present", () => {
    // The stamped paths — Room.commit, /api/generate, MCP, the web's local emit —
    // all arrive here with `by` already set, and the fallback must be invisible
    // to them, including when the author is one of the two reserved ids.
    const ws = applyOperations(target(), [
      { op: "ADD_COMMENT", id: "c1", targetId: "n1", body: "mine", by: ME, createdAt: T1 },
      { op: "ADD_VOTE", id: "v1", targetId: "n1", by: PEER },
      { op: "ADD_REACTION", id: "x1", targetId: "n1", emoji: "🎯", by: ASSISTANT_AUTHOR },
    ]);
    expect(ws.comments.c1?.by).toBe(ME);
    expect(ws.votes.v1?.by).toBe(PEER);
    expect(ws.reactions.x1?.by).toBe(ASSISTANT_AUTHOR);
  });

  it("round-trips an unknown author through delete and undo", () => {
    // inverse.ts rebuilds a deleted comment from the captured record, so the
    // author it restores is whatever the record held. An unknown author has to
    // survive that: undo must not launder it into a real id, and must not lose
    // it and re-derive it either.
    let ws = applyOperations(target(), [
      { op: "ADD_COMMENT", id: "c1", targetId: "n1", body: "orphan", createdAt: T1 },
    ]);
    expect(ws.comments.c1?.by).toBe(UNKNOWN_AUTHOR);
    const del: Operation[] = [{ op: "DELETE_COMMENT", id: "c1" }];
    const inverses = inverseOperations(del, ws);
    ws = applyOperations(ws, del);
    expect(ws.comments.c1).toBeUndefined();
    ws = applyOperations(ws, inverses);
    expect(ws.comments.c1?.by).toBe(UNKNOWN_AUTHOR);
    expect(ws.comments.c1?.createdAt).toBe(T1);
  });

  it("refuses to parse a stored board whose comment has no author", () => {
    // Path: `parseWorkspace`. It cannot reach the reducer at all — it produces a
    // Workspace, not operations — and the right answer there is rejection rather
    // than a fallback: a persisted record with no `by` is a corrupt row, and the
    // schema has always required the field. Pinned so nobody "fixes" the
    // asymmetry by making the parser tolerant.
    const authorless = {
      ...board(),
      comments: { c1: { id: "c1", targetId: "n1", body: "hi", createdAt: T1 } },
    };
    const parsed = parseWorkspace(JSON.parse(JSON.stringify(authorless)));
    expect(parsed.ok).toBe(false);
    expect(parsed.detail).toContain("comments");

    // Same for a vote and a reaction.
    for (const [key, record] of [
      ["votes", { id: "v1", targetId: "n1" }],
      ["reactions", { id: "x1", targetId: "n1", emoji: "👍" }],
    ] as const) {
      const bad = JSON.parse(JSON.stringify({ ...board(), [key]: { [record.id]: record } }));
      expect(parseWorkspace(bad).ok).toBe(false);
    }
  });
});

describe("OperationHistory.restoreTo returns ops in replay order", () => {
  /**
   * The invariant a multi-step restore has to hold: the workspace the caller
   * ends up with locally, and the workspace a peer reaches by replaying the
   * returned ops in order onto the pre-restore state, are the same board.
   * `packages/web/src/workspace.tsx` forwards those ops straight to
   * `Room.commit`, so if the two disagree the boards silently fork.
   *
   * That equivalence is asserted directly rather than pinning an array order,
   * because the order is only ever a means to it. Each case also reconstructs the
   * order the old `unshift` produced — the older commit's inverses first — and
   * shows it does *not* satisfy the invariant, so the assertions above cannot
   * pass vacuously on a scenario whose steps happen to commute.
   */

  /** The inverses the old collection order would have returned, in that order. */
  async function ascendingOrder(start: Workspace, commits: Operation[][]): Promise<Operation[]> {
    const { OperationHistory } = await import("@lucent/core");
    const h = new OperationHistory(start);
    for (const ops of commits) h.commit(ops);
    // undo() hands back one commit's inverses at a time, newest first; the old
    // code unshifted each batch, which put the oldest commit's batch in front.
    const batches: Operation[][] = [];
    while (h.canUndo()) batches.push(h.undo().ops);
    return batches.reverse().flat();
  }

  it("keeps two moves of one node in the order they were applied", async () => {
    const { OperationHistory } = await import("@lucent/core");
    const initialWs = boardWith({ id: "n1", label: "A", position: { x: 0, y: 0 } });
    const commits: Operation[][] = [
      [{ op: "MOVE_NODE", id: "n1", position: { x: 10, y: 10 } }],
      [{ op: "MOVE_NODE", id: "n1", position: { x: 20, y: 20 } }],
    ];
    const h = new OperationHistory(initialWs);
    for (const ops of commits) h.commit(ops);

    const before = h.current();
    expect(before.nodes.n1?.position).toEqual({ x: 20, y: 20 });

    const { workspace: local, ops } = h.restoreTo(0);
    expect(local.nodes.n1?.position).toEqual({ x: 0, y: 0 });

    // The invariant: a peer replaying `ops` onto the pre-restore board lands on
    // exactly the board the restore produced here.
    expect(validateOperations(before, ops)).toEqual([]);
    expect(applyOperations(before, ops)).toEqual(local);

    // Two moves of one node do not commute, so the old ordering diverged with no
    // error at all: the node simply stopped at the wrong coordinates.
    const ascending = await ascendingOrder(initialWs, commits);
    const forked = applyOperations(before, ascending);
    expect(forked).not.toEqual(local);
    expect(forked.nodes.n1?.position).toEqual({ x: 10, y: 10 });
  });

  it("keeps a delete-then-recreate of one node in the order they were applied", async () => {
    const { OperationHistory } = await import("@lucent/core");
    const initialWs = boardWith({ id: "n1", label: "original", position: { x: 5, y: 5 } });
    const commits: Operation[][] = [
      [{ op: "DELETE_NODE", id: "n1" }],
      [{ op: "CREATE_NODE", id: "n1", nodeType: "step", label: "recreated" }],
    ];
    const h = new OperationHistory(initialWs);
    for (const ops of commits) h.commit(ops);

    const before = h.current();
    expect(before.nodes.n1?.label).toBe("recreated");

    const { workspace: local, ops } = h.restoreTo(0);
    expect(local.nodes.n1?.label).toBe("original");
    expect(local.nodes.n1?.position).toEqual({ x: 5, y: 5 });

    expect(validateOperations(before, ops)).toEqual([]);
    expect(applyOperations(before, ops)).toEqual(local);

    // The louder half of the same bug: recreating before deleting is a node that
    // "already exists", so the server refuses the batch — and a client that
    // applies a broadcast without validating just loses the node.
    const ascending = await ascendingOrder(initialWs, commits);
    const errors = validateOperations(before, ascending);
    expect(errors.some((e) => e.message.includes("already exists"))).toBe(true);
    expect(applyOperations(before, ascending).nodes.n1).toBeUndefined();
  });

  it("still returns a single commit's inverses unchanged", async () => {
    // A one-step restore is where the bug hid: with one batch to collect, unshift
    // and push agree, so every existing test passed.
    const { OperationHistory } = await import("@lucent/core");
    const h = new OperationHistory(boardWith({ id: "n1", label: "A" }));
    h.commit([{ op: "CREATE_NODE", id: "n2", nodeType: "step", label: "B" }], "b");
    const before = h.current();
    const { workspace: local, ops } = h.restoreTo(0);
    expect(ops).toEqual([{ op: "DELETE_NODE", id: "n2" }]);
    expect(applyOperations(before, ops)).toEqual(local);
  });
});

describe("the authored-op list has exactly one source", () => {
  /**
   * `stampAuthorship` (which writes `by`) and the validator (which now requires
   * it) both go through `isAuthoredOperation`. This derives the same set a third
   * way — from the schema, by asking which union members declare a `by` — so a
   * fifth authored op added to the contract cannot end up on one list and not the
   * other. That drift is worse than the bug it would replace: an op stamped but
   * not required silently loses the guarantee, and one required but never stamped
   * makes every write of that op fail validation.
   */
  const declaresAuthor = operationUnionSchema.options
    .filter((option) => "by" in option.shape)
    .map((option) => (option.shape.op as { value: string }).value)
    .sort();

  it("agrees with the schema about which operations carry an author", () => {
    expect(declaresAuthor).toEqual(["ADD_COMMENT", "ADD_REACTION", "ADD_VOTE", "REPLY_COMMENT"]);
    for (const name of ALL_OPERATION_NAMES) {
      // Only the `op` field is read by the guard, so a probe is enough.
      const probe = { op: name } as Operation;
      expect(isAuthoredOperation(probe)).toBe(declaresAuthor.includes(name));
    }
  });

  it("stamps exactly the operations the guard claims are authored", () => {
    const probes = ALL_OPERATION_NAMES.map((name) => ({ op: name }) as Operation);
    const stamped = stampAuthorship(probes, ME, T0);
    const gotAuthor = stamped
      .filter((op) => (op as { by?: string }).by !== undefined)
      .map((op) => op.op)
      .sort();
    expect(gotAuthor).toEqual(declaresAuthor);
  });

  it("requires exactly the operations it stamps", () => {
    // The validator's rule and the stamper, compared against the same derived
    // set: every authored kind is flagged when unstamped, and nothing else is.
    for (const name of ALL_OPERATION_NAMES) {
      const probe = { op: name } as Operation;
      expect(isUnauthored(probe)).toBe(declaresAuthor.includes(name));
    }
  });
});
