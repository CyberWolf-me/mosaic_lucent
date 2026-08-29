import { describe, it, expect } from "vitest";
import { applyOperations, createWorkspace, type Operation } from "@lucent/core";
import {
  ME,
  REACTION_EMOJI,
  clearVotesOps,
  myReactionFor,
  myVoteFor,
  targetLabel,
  toggleReactionOps,
  toggleVoteOps,
  voteResults,
} from "../src/board/engagement.js";

/**
 * The UI layer owns "one vote per person per object" and id minting; the core
 * model deliberately allows many votes so a multiplayer session can record one
 * per participant.
 */

function board() {
  return applyOperations(createWorkspace(), [
    { op: "CREATE_NODE", id: "n1", nodeType: "idea", label: "Guest checkout" },
    { op: "CREATE_NODE", id: "n2", nodeType: "idea", label: "Apple Pay" },
    {
      op: "CREATE_SHAPE",
      id: "s1",
      kind: "sticky",
      position: { x: 0, y: 0 },
      size: { width: 150, height: 110 },
      text: "Cut the form fields\nsecond line",
    },
  ]);
}

const apply = (ws: ReturnType<typeof board>, ops: Operation[]) => applyOperations(ws, ops);

describe("toggleVoteOps", () => {
  it("casts a vote when the participant has not voted", () => {
    const ops = toggleVoteOps(board(), "n1");
    expect(ops).toHaveLength(1);
    expect(ops[0]?.op).toBe("ADD_VOTE");
  });

  it("withdraws the participant's own vote on a second click", () => {
    const ws = apply(board(), toggleVoteOps(board(), "n1"));
    const ops = toggleVoteOps(ws, "n1");
    expect(ops[0]?.op).toBe("REMOVE_VOTE");
    expect(voteResults(apply(ws, ops))).toEqual([]);
  });

  it("does not stack duplicate votes from the same participant", () => {
    let ws = board();
    for (let i = 0; i < 4; i++) ws = apply(ws, toggleVoteOps(ws, "n1"));
    // Four clicks = cast, withdraw, cast, withdraw.
    expect(myVoteFor(ws, "n1")).toBeNull();
  });

  it("leaves another participant's vote alone", () => {
    let ws = apply(board(), [{ op: "ADD_VOTE", id: "other", targetId: "n1", by: "someone-else" }]);
    ws = apply(ws, toggleVoteOps(ws, "n1")); // my vote
    expect(voteResults(ws)[0]?.votes).toBe(2);
    ws = apply(ws, toggleVoteOps(ws, "n1")); // withdraw only mine
    expect(voteResults(ws)[0]?.votes).toBe(1);
    expect(ws.votes.other).toBeDefined();
  });

  it("mints unique vote ids", () => {
    let ws = board();
    ws = apply(ws, toggleVoteOps(ws, "n1"));
    ws = apply(ws, toggleVoteOps(ws, "n2"));
    expect(Object.keys(ws.votes)).toHaveLength(2);
  });

  it("attributes votes to the local participant", () => {
    const ws = apply(board(), toggleVoteOps(board(), "n1"));
    expect(Object.values(ws.votes)[0]?.by).toBe(ME);
  });
});

describe("clearVotesOps", () => {
  it("clears the whole round when no target is given", () => {
    const ops = clearVotesOps();
    expect(ops[0]).toEqual({ op: "CLEAR_VOTES" });
  });

  it("clears one target when given", () => {
    expect(clearVotesOps("n1")[0]).toEqual({ op: "CLEAR_VOTES", targetId: "n1" });
  });
});

describe("toggleReactionOps", () => {
  it("adds then removes the same emoji for this participant", () => {
    let ws = board();
    ws = apply(ws, toggleReactionOps(ws, "n1", "👍"));
    expect(myReactionFor(ws, "n1", "👍")).not.toBeNull();
    ws = apply(ws, toggleReactionOps(ws, "n1", "👍"));
    expect(myReactionFor(ws, "n1", "👍")).toBeNull();
  });

  it("treats different emoji as independent", () => {
    let ws = board();
    ws = apply(ws, toggleReactionOps(ws, "n1", "👍"));
    ws = apply(ws, toggleReactionOps(ws, "n1", "🎉"));
    expect(Object.keys(ws.reactions)).toHaveLength(2);
    ws = apply(ws, toggleReactionOps(ws, "n1", "👍"));
    expect(myReactionFor(ws, "n1", "🎉")).not.toBeNull();
  });

  it("offers a small fixed emoji set", () => {
    expect(REACTION_EMOJI.length).toBeGreaterThan(2);
    expect(new Set(REACTION_EMOJI).size).toBe(REACTION_EMOJI.length);
  });
});

describe("voteResults labels", () => {
  it("resolves a node label", () => {
    const ws = apply(board(), [{ op: "ADD_VOTE", id: "v1", targetId: "n1", by: ME }]);
    expect(voteResults(ws)[0]?.label).toBe("Guest checkout");
  });

  it("uses a sticky's first line as its label", () => {
    const ws = apply(board(), [{ op: "ADD_VOTE", id: "v1", targetId: "s1", by: ME }]);
    expect(voteResults(ws)[0]?.label).toBe("Cut the form fields");
  });

  it("falls back to the shape kind when a sticky has no text", () => {
    const ws = apply(
      applyOperations(createWorkspace(), [
        {
          op: "CREATE_SHAPE",
          id: "blank",
          kind: "rect",
          position: { x: 0, y: 0 },
          size: { width: 10, height: 10 },
        },
      ]),
      [{ op: "ADD_VOTE", id: "v1", targetId: "blank", by: ME }],
    );
    expect(voteResults(ws)[0]?.label).toBe("rect");
  });

  it("falls back to the id for an unknown target", () => {
    expect(targetLabel(board(), "mystery")).toBe("mystery");
  });

  it("orders results by count, highest first", () => {
    const ws = apply(board(), [
      { op: "ADD_VOTE", id: "v1", targetId: "n2", by: "a" },
      { op: "ADD_VOTE", id: "v2", targetId: "n1", by: "a" },
      { op: "ADD_VOTE", id: "v3", targetId: "n1", by: "b" },
    ]);
    expect(voteResults(ws).map((r) => r.targetId)).toEqual(["n1", "n2"]);
  });
});
