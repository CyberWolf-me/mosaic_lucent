import { describe, it, expect } from "vitest";
import { applyOperations, createWorkspace } from "@lucent/core";
import { Room, colorForUser } from "../src/room.js";

/**
 * The Room is the server-authoritative sync engine. These tests pin the
 * properties multiplayer depends on: operations are validated against live state
 * (not a client's claim), sequenced monotonically, gated by role, and presence
 * is tracked per participant. Transport is not involved.
 */

const OWNER = "usr_owner";

function room() {
  const ws = applyOperations(createWorkspace(), [
    { op: "CREATE_NODE", id: "a", nodeType: "step", label: "A" },
    { op: "CREATE_NODE", id: "b", nodeType: "step", label: "B" },
  ]);
  return new Room("brd_1", ws, OWNER);
}

describe("operation log and sequencing", () => {
  it("accepts a valid edit from the owner and sequences it", async () => {
    const r = room();
    const result = await r.commit(
      OWNER,
      [{ op: "CONNECT_NODES", source: "a", target: "b", relationship: "next" }],
      "connect",
    );
    expect(result.ok).toBe(true);
    expect(result.entry?.seq).toBe(1);
    expect(r.version()).toBe(1);
    expect(Object.keys(r.current().edges)).toHaveLength(1);
  });

  it("assigns monotonically increasing sequence numbers", async () => {
    const r = room();
    await r.commit(OWNER, [{ op: "CREATE_NODE", id: "c", nodeType: "step", label: "C" }]);
    const second = await r.commit(OWNER, [
      { op: "CREATE_NODE", id: "d", nodeType: "step", label: "D" },
    ]);
    expect(second.entry?.seq).toBe(2);
  });

  it("validates against live state, not the client's claim", async () => {
    const r = room();
    await r.commit(OWNER, [{ op: "DELETE_NODE", id: "b" }]);
    // b is gone on the server; connecting to it must be rejected even though a
    // client that missed the delete would think it exists.
    const result = await r.commit(OWNER, [
      { op: "CONNECT_NODES", source: "a", target: "b", relationship: "next" },
    ]);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("validation");
  });

  it("rejects an empty batch", async () => {
    expect((await room().commit(OWNER, [])).error).toBe("empty");
  });

  it("returns catch-up entries after a given sequence", async () => {
    const r = room();
    await r.commit(OWNER, [{ op: "CREATE_NODE", id: "c", nodeType: "step", label: "C" }]);
    await r.commit(OWNER, [{ op: "CREATE_NODE", id: "d", nodeType: "step", label: "D" }]);
    expect(r.since(0)).toHaveLength(2);
    expect(r.since(1)).toHaveLength(1);
    expect(r.since(2)).toHaveLength(0);
  });
});

describe("permissions", () => {
  it("refuses an edit from a viewer", async () => {
    const r = room();
    r.setRole("usr_viewer", "viewer");
    const result = await r.commit("usr_viewer", [{ op: "CHANGE_TEXT", id: "a", text: "X" }]);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("permission");
  });

  // docs/26 F8: viewers could not comment at all — comments needed an editor.
  it("a commenter converses on the board without editing it", async () => {
    const r = room();
    r.setRole("usr_c", "commenter");
    const said = await r.commit("usr_c", [
      { op: "ADD_COMMENT", id: "c1", targetId: "a", body: "Is A still needed?" },
      { op: "ADD_VOTE", id: "v1", targetId: "a" },
      { op: "ADD_REACTION", id: "r1", targetId: "a", emoji: "👍" },
    ]);
    expect(said.ok).toBe(true);
    expect(r.current().comments.c1?.by).toBe("usr_c");
    expect(
      (await r.commit("usr_c", [{ op: "REPLY_COMMENT", id: "c2", parentId: "c1", body: "yes" }]))
        .ok,
    ).toBe(true);
    expect(
      (await r.commit("usr_c", [{ op: "RESOLVE_COMMENT", id: "c1", resolved: true }])).ok,
    ).toBe(true);

    const edit = await r.commit("usr_c", [{ op: "CHANGE_TEXT", id: "a", text: "X" }]);
    expect(edit).toMatchObject({ ok: false, error: "permission", detail: "editor role required" });
    // A batch that smuggles an edit in with a comment is refused whole.
    const mixed = await r.commit("usr_c", [
      { op: "ADD_COMMENT", id: "c3", targetId: "a", body: "and" },
      { op: "CHANGE_TEXT", id: "a", text: "X" },
    ]);
    expect(mixed.ok).toBe(false);
    expect(r.current().comments.c3).toBeUndefined();
  });

  it("a commenter deletes only their own comments", async () => {
    const r = room();
    r.setRole("usr_c", "commenter");
    r.setRole("usr_e", "editor");
    await r.commit("usr_e", [{ op: "ADD_COMMENT", id: "theirs", targetId: "a", body: "x" }]);
    await r.commit("usr_c", [{ op: "ADD_COMMENT", id: "mine", targetId: "a", body: "y" }]);
    const other = await r.commit("usr_c", [{ op: "DELETE_COMMENT", id: "theirs" }]);
    expect(other).toMatchObject({
      ok: false,
      detail: "commenters can delete only their own comments",
    });
    expect((await r.commit("usr_c", [{ op: "DELETE_COMMENT", id: "mine" }])).ok).toBe(true);
    expect(r.current().comments.theirs).toBeDefined();
  });

  it("a viewer still cannot comment — that is what the commenter role is for", async () => {
    const r = room();
    r.setRole("usr_v", "viewer");
    const res = await r.commit("usr_v", [
      { op: "ADD_COMMENT", id: "c1", targetId: "a", body: "hi" },
    ]);
    expect(res.ok).toBe(false);
  });

  it("allows an editor to edit", async () => {
    const r = room();
    r.setRole("usr_editor", "editor");
    expect((await r.commit("usr_editor", [{ op: "CHANGE_TEXT", id: "a", text: "X" }])).ok).toBe(
      true,
    );
  });

  it("refuses a user with no role at all", async () => {
    expect(
      (await room().commit("usr_stranger", [{ op: "CHANGE_TEXT", id: "a", text: "X" }])).error,
    ).toBe("permission");
  });

  it("treats the owner as an editor for commit purposes", async () => {
    expect(room().roleOf(OWNER)).toBe("owner");
  });
});

describe("human-only operations", () => {
  it("allows MOVE_NODE from an editor (it is the human coordinate op)", async () => {
    const r = room();
    const result = await r.commit(OWNER, [
      { op: "MOVE_NODE", id: "a", position: { x: 100, y: 50 } },
    ]);
    expect(result.ok).toBe(true);
    expect(r.current().nodes.a?.position).toEqual({ x: 100, y: 50 });
  });
});

describe("presence", () => {
  it("records and merges a participant's cursor and selection", async () => {
    const r = room();
    r.updatePresence("usr_1", "Ana", { cursor: { x: 10, y: 20 } });
    r.updatePresence("usr_1", "Ana", { selection: ["a"] });
    const [p] = r.peers();
    expect(p?.cursor).toEqual({ x: 10, y: 20 });
    expect(p?.selection).toEqual(["a"]);
  });

  it("excludes a given user from peers (so you don't see your own cursor)", async () => {
    const r = room();
    r.updatePresence("usr_1", "Ana", {});
    r.updatePresence("usr_2", "Bo", {});
    expect(r.peers("usr_1").map((p) => p.userId)).toEqual(["usr_2"]);
  });

  it("removes presence on leave and reports emptiness", async () => {
    const r = room();
    r.updatePresence("usr_1", "Ana", {});
    expect(r.isEmpty()).toBe(false);
    r.removePresence("usr_1");
    expect(r.isEmpty()).toBe(true);
  });

  it("gives each user a stable colour", async () => {
    expect(colorForUser("usr_1")).toBe(colorForUser("usr_1"));
    const p = room();
    p.updatePresence("usr_x", "X", {});
    expect(p.peers()[0]?.color).toBe(colorForUser("usr_x"));
  });

  it("clears a cursor when set to null but keeps the participant present", async () => {
    const r = room();
    r.updatePresence("usr_1", "Ana", { cursor: { x: 5, y: 5 } });
    r.updatePresence("usr_1", "Ana", { cursor: null });
    expect(r.peers()[0]?.cursor).toBeNull();
    expect(r.isEmpty()).toBe(false);
  });
});

describe("concurrent editing", () => {
  it("serializes two editors' commits into one ordered log", async () => {
    const r = room();
    r.setRole("usr_2", "editor");
    const a = await r.commit(OWNER, [{ op: "CHANGE_TEXT", id: "a", text: "from owner" }]);
    const b = await r.commit("usr_2", [{ op: "CHANGE_TEXT", id: "b", text: "from user2" }]);
    expect([a.entry?.seq, b.entry?.seq]).toEqual([1, 2]);
    // Both edits are present; neither clobbered the other.
    expect(r.current().nodes.a?.label).toBe("from owner");
    expect(r.current().nodes.b?.label).toBe("from user2");
  });

  it("rejects the loser of a delete/connect race, keeping the board valid", async () => {
    const r = room();
    r.setRole("usr_2", "editor");
    // Owner deletes b; user2's connect to b arrives after and is rejected.
    await r.commit(OWNER, [{ op: "DELETE_NODE", id: "b" }]);
    const race = await r.commit("usr_2", [
      { op: "CONNECT_NODES", source: "a", target: "b", relationship: "x" },
    ]);
    expect(race.ok).toBe(false);
    // The board never enters the invalid "edge to a missing node" state.
    expect(Object.keys(r.current().edges)).toHaveLength(0);
  });
});

describe("authorship stamping (M0.4)", () => {
  it("attributes a comment with no author to the connecting user", async () => {
    const r = room();
    r.setRole("usr_2", "editor");
    const result = await r.commit("usr_2", [
      { op: "ADD_COMMENT", id: "c1", targetId: "a", body: "hi" },
    ]);
    expect(result.ok).toBe(true);
    expect(r.current().comments.c1?.by).toBe("usr_2");
    // The board must never show the retired placeholder again.
    expect(JSON.stringify(r.current().comments)).not.toContain('"me"');
  });

  it("refuses to let a client-supplied author spoof a peer", async () => {
    // A board id is not an identity: the connection's user owns the batch, so a
    // hand-built socket frame claiming someone else's id is rewritten, not
    // honoured (the trade-off is documented in core's authorship.ts).
    const r = room();
    r.setRole("usr_2", "editor");
    const result = await r.commit("usr_2", [
      { op: "ADD_COMMENT", id: "c1", targetId: "a", body: "hi", by: "usr_peer" },
      { op: "ADD_VOTE", id: "v9", targetId: "a", by: "usr_peer" },
      { op: "ADD_REACTION", id: "x9", targetId: "a", emoji: "👍", by: "usr_peer" },
    ]);
    expect(result.ok).toBe(true);
    expect(r.current().comments.c1?.by).toBe("usr_2");
    expect(r.current().votes.v9?.by).toBe("usr_2");
    expect(r.current().reactions.x9?.by).toBe("usr_2");
  });

  it("fills createdAt when missing on a comment", async () => {
    const r = room();
    r.setRole("usr_2", "editor");
    const before = Date.now();
    const result = await r.commit("usr_2", [
      { op: "ADD_COMMENT", id: "c1", targetId: "a", body: "hi", by: "usr_2" },
    ]);
    expect(result.ok).toBe(true);
    const created = r.current().comments.c1?.createdAt ?? 0;
    expect(created).toBeGreaterThanOrEqual(before);
  });

  it("stamps votes and reactions in one pass", async () => {
    const r = room();
    r.setRole("usr_2", "editor");
    const result = await r.commit("usr_2", [
      { op: "ADD_VOTE", id: "v1", targetId: "a" },
      { op: "ADD_REACTION", id: "x1", targetId: "a", emoji: "👍" },
    ]);
    if (!result.ok) throw new Error(`commit failed: ${result.error} ${result.detail ?? ""}`);
    expect(result.ok).toBe(true);
    expect(r.current().votes.v1?.by).toBe("usr_2");
    expect(r.current().reactions.x1?.by).toBe("usr_2");
  });
});

/**
 * M3: the durable commit path. With an allocator wired (what a store-backed
 * deployment passes), a seq comes from the store, not from `log.length`, and
 * a losing commit catches up through the fetcher before retrying. These tests
 * script the allocator so the race is deterministic instead of lucky.
 */
describe("durable commit (allocator + fetcher)", () => {
  function seededRoom(options: ConstructorParameters<typeof Room>[4] = {}) {
    const ws = applyOperations(createWorkspace(), [
      { op: "CREATE_NODE", id: "a", nodeType: "step", label: "A" },
    ]);
    return new Room("brd_1", ws, OWNER, undefined, options);
  }

  const REMOTE = {
    seq: 1,
    ops: [{ op: "CREATE_NODE", id: "remote", nodeType: "step", label: "R" }] as never,
    by: "usr_other",
    label: "other instance",
    at: 1,
  };

  it("absorbs the winner's entries, re-validates, and lands on the next slot", async () => {
    let calls = 0;
    const r = seededRoom({
      append: async () => {
        calls += 1;
        if (calls === 1) return { ok: false as const, reason: "conflict" as const, head: 1 };
        return { ok: true as const, seq: 2 };
      },
      fetch: async () => [REMOTE],
    });
    const result = await r.commit(
      OWNER,
      [{ op: "CREATE_NODE", id: "mine", nodeType: "step", label: "M" }],
      "lose once",
    );
    expect(result.ok).toBe(true);
    expect(result.entry?.seq).toBe(2);
    expect(result.persisted).toBe(true);
    expect(result.absorbed).toHaveLength(1);
    expect(result.absorbed?.[0]?.seq).toBe(1);
    // Merged state: the absorbed node AND our own, with the head at 2.
    expect(r.current().nodes.remote?.label).toBe("R");
    expect(r.current().nodes.mine?.label).toBe("M");
    expect(r.version()).toBe(2);
  });

  it("re-validates the retry against the merged state", async () => {
    // The loser's edit touches `a`, which survives the merge: valid at round
    // zero AND after absorbing, so the commit lands on the second attempt.
    // (A batch the merge invalidates is the next test — together they pin
    // both directions of the re-validation.)
    let calls = 0;
    const r = seededRoom({
      append: async () => {
        calls += 1;
        if (calls === 1) return { ok: false as const, reason: "conflict" as const, head: 1 };
        return { ok: true as const, seq: 2 };
      },
      fetch: async () => [REMOTE],
    });
    const result = await r.commit(OWNER, [{ op: "CHANGE_TEXT", id: "a", text: "loser wins" }]);
    expect(result.ok).toBe(true);
    expect(calls).toBe(2);
    expect(r.current().nodes.a?.label).toBe("loser wins");
    expect(r.current().nodes.remote?.label).toBe("R");
  });

  it("refuses a batch that the merge made invalid", async () => {
    // Both instances delete the same node. Ours was valid when proposed; once
    // the winner's delete is absorbed, applying it again would fail — so the
    // commit must come back `validation`, not apply garbage.
    let calls = 0;
    const r = seededRoom({
      append: async () => {
        calls += 1;
        if (calls === 1) return { ok: false as const, reason: "conflict" as const, head: 1 };
        return { ok: false as const, reason: "conflict" as const, head: 2 };
      },
      fetch: async () => [
        REMOTE,
        {
          seq: 2,
          ops: [{ op: "DELETE_NODE", id: "a" }] as never,
          by: "usr_other",
          label: "",
          at: 2,
        },
      ],
    });
    const result = await r.commit(OWNER, [{ op: "DELETE_NODE", id: "a" }]);
    expect(result).toMatchObject({ ok: false, error: "validation" });
  });

  it("answers stale once the retries are spent", async () => {
    const r = seededRoom({
      append: async () => ({ ok: false as const, reason: "lost" as const, head: 99 }),
      fetch: async () => [],
      maxRetries: 1,
    });
    const result = await r.commit(OWNER, [{ op: "CHANGE_TEXT", id: "a", text: "x" }]);
    expect(result).toMatchObject({ ok: false, error: "stale" });
  });
});

describe("the topic fold at the room boundary (Stage C5, ADR 0025)", () => {
  function roomWithPricing() {
    const ws = applyOperations(createWorkspace(), [
      { op: "CREATE_NODE", id: "p1", nodeType: "decision", label: "Pricing" },
      {
        op: "SET_STATEMENT",
        id: "p1",
        statement: { kind: "decision", status: "resolved", topic: "pricing" },
      },
    ]);
    return new Room("brd_1", ws, OWNER);
  }

  it("an ai-actor batch folds: the model's variant converges on the existing key", async () => {
    const r = roomWithPricing();
    const result = await r.commit(
      OWNER,
      [
        { op: "CREATE_NODE", id: "p2", nodeType: "decision", label: "Pricing model" },
        {
          op: "SET_STATEMENT",
          id: "p2",
          statement: { kind: "decision", status: "open", topic: "pricing-model" },
        },
      ],
      "model proposal approved",
      { actor: { actorType: "ai", actorId: "lucent", initiatedBy: OWNER, approvedBy: OWNER } },
    );
    expect(result.ok).toBe(true);
    const entry = result.entry;
    const setOp = entry?.ops.find((o) => o.op === "SET_STATEMENT");
    expect(setOp && setOp.op === "SET_STATEMENT" ? setOp.statement?.topic : undefined).toBe(
      "pricing",
    );
  });

  it("a user-actor batch NEVER folds: the human's topic survives exactly as typed", async () => {
    // THE PROTECTED CASE (rule 2): a human who writes 'pricing-model' keeps
    // it. The fold is machine-ops-only, and the room enforces that by the
    // actor the batch carries.
    const r = roomWithPricing();
    const result = await r.commit(
      OWNER,
      [
        { op: "CREATE_NODE", id: "p2", nodeType: "decision", label: "Pricing model" },
        {
          op: "SET_STATEMENT",
          id: "p2",
          statement: { kind: "decision", status: "open", topic: "pricing-model" },
        },
      ],
      "manual edit",
      { actor: { actorType: "user", actorId: OWNER, initiatedBy: OWNER } },
    );
    expect(result.ok).toBe(true);
    const setOp = result.entry?.ops.find((o) => o.op === "SET_STATEMENT");
    expect(setOp && setOp.op === "SET_STATEMENT" ? setOp.statement?.topic : undefined).toBe(
      "pricing-model",
    );
  });

  it("an actorless batch (a plain human submit) never folds either", async () => {
    const r = roomWithPricing();
    const result = await r.commit(OWNER, [
      { op: "CREATE_NODE", id: "p2", nodeType: "decision", label: "Pricing model" },
      {
        op: "SET_STATEMENT",
        id: "p2",
        statement: { kind: "decision", status: "open", topic: "pricing-model" },
      },
    ]);
    expect(result.ok).toBe(true);
    const setOp = result.entry?.ops.find((o) => o.op === "SET_STATEMENT");
    expect(setOp && setOp.op === "SET_STATEMENT" ? setOp.statement?.topic : undefined).toBe(
      "pricing-model",
    );
  });
});
