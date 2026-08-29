import { describe, it, expect } from "vitest";
import {
  UNKNOWN_AUTHOR,
  applyOperations,
  createWorkspace,
  reactionTally,
  validateOperations,
  voteRanking,
  voteTally,
} from "../src/index.js";

/**
 * Voting and reactions are model operations, not UI state: a round has to
 * survive reload, undo as one step, and be readable by the AI. Votes are stored
 * individually so one can be withdrawn and attributed.
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
      text: "Cut the form fields",
    },
  ]);
}

describe("voting operations", () => {
  it("records a vote against a node or a shape", () => {
    const ws = applyOperations(board(), [
      { op: "ADD_VOTE", id: "v1", targetId: "n1", by: "a" },
      { op: "ADD_VOTE", id: "v2", targetId: "s1", by: "a" },
    ]);
    expect(voteTally(ws)).toEqual({ n1: 1, s1: 1 });
  });

  it("records the voter the caller supplied", () => {
    const ws = applyOperations(board(), [{ op: "ADD_VOTE", id: "v1", targetId: "n1", by: "a" }]);
    expect(ws.votes.v1?.by).toBe("a");
  });

  it("still counts a vote whose author was never captured", () => {
    // `by` is optional in the contract (the server stamps it on the way in), so
    // the tally this view reads must not depend on an author being present.
    //
    // Since M0.4 this is only reachable on a path that does not validate — an
    // op_log row written before stamping existed, or generate.ts's throwaway
    // summary workspace; `validateOperations` refuses an unstamped ADD_VOTE (see
    // the case below). The record that lands is attributed to UNKNOWN_AUTHOR, not
    // to the old "me" placeholder, and the tally counts it either way: a vote the
    // board holds is a real vote regardless of what is known about who cast it.
    const ws = applyOperations(board(), [{ op: "ADD_VOTE", id: "v1", targetId: "n1" }]);
    expect(voteTally(ws)).toEqual({ n1: 1 });
    expect(ws.votes.v1?.by).toBe(UNKNOWN_AUTHOR);
    expect(JSON.stringify(ws)).not.toContain('"me"');
  });

  it("refuses an unstamped vote at the validator", () => {
    // The reason the fallback above is now unreachable from a live write path.
    const errors = validateOperations(board(), [{ op: "ADD_VOTE", id: "v1", targetId: "n1" }]);
    expect(errors.map((e) => e.op)).toEqual(["ADD_VOTE"]);
    expect(errors[0]?.message).toContain("stamp authorship");
  });

  it("accumulates multiple votes on one target", () => {
    const ws = applyOperations(board(), [
      { op: "ADD_VOTE", id: "v1", targetId: "n1", by: "a" },
      { op: "ADD_VOTE", id: "v2", targetId: "n1", by: "b" },
      { op: "ADD_VOTE", id: "v3", targetId: "n2", by: "a" },
    ]);
    expect(voteTally(ws)).toEqual({ n1: 2, n2: 1 });
  });

  it("withdraws a single vote without touching the others", () => {
    let ws = applyOperations(board(), [
      { op: "ADD_VOTE", id: "v1", targetId: "n1", by: "a" },
      { op: "ADD_VOTE", id: "v2", targetId: "n1", by: "b" },
    ]);
    ws = applyOperations(ws, [{ op: "REMOVE_VOTE", id: "v1" }]);
    expect(voteTally(ws)).toEqual({ n1: 1 });
  });

  it("clears one target or the whole round", () => {
    const seeded = applyOperations(board(), [
      { op: "ADD_VOTE", id: "v1", targetId: "n1", by: "a" },
      { op: "ADD_VOTE", id: "v2", targetId: "n2", by: "a" },
    ]);
    expect(voteTally(applyOperations(seeded, [{ op: "CLEAR_VOTES", targetId: "n1" }]))).toEqual({
      n2: 1,
    });
    expect(voteTally(applyOperations(seeded, [{ op: "CLEAR_VOTES" }]))).toEqual({});
  });

  it("ranks targets by vote count, highest first", () => {
    const ws = applyOperations(board(), [
      { op: "ADD_VOTE", id: "v1", targetId: "n2", by: "a" },
      { op: "ADD_VOTE", id: "v2", targetId: "n1", by: "a" },
      { op: "ADD_VOTE", id: "v3", targetId: "n1", by: "b" },
      { op: "ADD_VOTE", id: "v4", targetId: "n1", by: "c" },
    ]);
    expect(voteRanking(ws)).toEqual([
      { targetId: "n1", votes: 3 },
      { targetId: "n2", votes: 1 },
    ]);
  });

  it("rejects a vote for an object that does not exist", () => {
    expect(
      validateOperations(board(), [{ op: "ADD_VOTE", id: "v1", targetId: "ghost", by: "a" }]),
    ).toHaveLength(1);
  });

  it("rejects a duplicate vote id and an unknown removal", () => {
    const ws = applyOperations(board(), [{ op: "ADD_VOTE", id: "v1", targetId: "n1", by: "a" }]);
    expect(
      validateOperations(ws, [{ op: "ADD_VOTE", id: "v1", targetId: "n2", by: "a" }]),
    ).toHaveLength(1);
    expect(validateOperations(ws, [{ op: "REMOVE_VOTE", id: "nope" }])).toHaveLength(1);
  });

  it("drops votes when the voted object is deleted", () => {
    let ws = applyOperations(board(), [
      { op: "ADD_VOTE", id: "v1", targetId: "n1", by: "a" },
      { op: "ADD_VOTE", id: "v2", targetId: "s1", by: "a" },
    ]);
    ws = applyOperations(ws, [
      { op: "DELETE_NODE", id: "n1" },
      { op: "DELETE_SHAPE", id: "s1" },
    ]);
    // A tally must never count votes pointing at something that is gone.
    expect(voteTally(ws)).toEqual({});
  });
});

describe("reaction operations", () => {
  it("groups reaction counts by emoji per target", () => {
    const ws = applyOperations(board(), [
      { op: "ADD_REACTION", id: "r1", targetId: "n1", emoji: "👍", by: "a" },
      { op: "ADD_REACTION", id: "r2", targetId: "n1", emoji: "👍", by: "b" },
      { op: "ADD_REACTION", id: "r3", targetId: "n1", emoji: "🎉", by: "a" },
      { op: "ADD_REACTION", id: "r4", targetId: "s1", emoji: "⚠️", by: "a" },
    ]);
    expect(reactionTally(ws)).toEqual({
      n1: { "👍": 2, "🎉": 1 },
      s1: { "⚠️": 1 },
    });
  });

  it("removes one reaction at a time", () => {
    let ws = applyOperations(board(), [
      { op: "ADD_REACTION", id: "r1", targetId: "n1", emoji: "👍", by: "a" },
      { op: "ADD_REACTION", id: "r2", targetId: "n1", emoji: "👍", by: "b" },
    ]);
    ws = applyOperations(ws, [{ op: "REMOVE_REACTION", id: "r1" }]);
    expect(reactionTally(ws)).toEqual({ n1: { "👍": 1 } });
  });

  it("rejects a reaction on a missing target and an unknown removal", () => {
    expect(
      validateOperations(board(), [
        { op: "ADD_REACTION", id: "r1", targetId: "ghost", emoji: "👍", by: "a" },
      ]),
    ).toHaveLength(1);
    expect(validateOperations(board(), [{ op: "REMOVE_REACTION", id: "nope" }])).toHaveLength(1);
  });

  it("drops reactions when the object is deleted", () => {
    let ws = applyOperations(board(), [
      { op: "ADD_REACTION", id: "r1", targetId: "n1", emoji: "👍", by: "a" },
    ]);
    ws = applyOperations(ws, [{ op: "DELETE_NODE", id: "n1" }]);
    expect(reactionTally(ws)).toEqual({});
  });
});

describe("annotations and the rest of the model", () => {
  it("leaves votes and reactions empty on a fresh workspace", () => {
    const ws = createWorkspace();
    expect(ws.votes).toEqual({});
    expect(ws.reactions).toEqual({});
    expect(voteTally(ws)).toEqual({});
    expect(reactionTally(ws)).toEqual({});
  });

  it("does not mutate the input workspace", () => {
    const before = board();
    const snapshot = JSON.stringify(before);
    applyOperations(before, [{ op: "ADD_VOTE", id: "v1", targetId: "n1", by: "a" }]);
    expect(JSON.stringify(before)).toBe(snapshot);
  });
});
