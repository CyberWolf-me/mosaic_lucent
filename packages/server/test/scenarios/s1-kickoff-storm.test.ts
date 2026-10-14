import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ROSTER,
  SEED_NODE,
  ackLatencies,
  assertConverged,
  createTeam,
  op,
  percentile,
  report,
  type Frame,
  type Team,
} from "./teamHarness.js";

/**
 * Scenario 1 — kickoff storm. All 24 people open the board at the same
 * instant, then everyone acts at once: every editor fires three batches back
 * to back (a node, a link to the owner's seed, a sticky), commenters comment,
 * vote and react, viewers (and one commenter) try to edit and are refused.
 */

let team: Team;
beforeAll(async () => {
  team = await createTeam();
}, 30_000);
afterAll(async () => {
  await team?.close();
});

/** A permission refusal carries its requestId (see the regression test below). */
const unnamedPermission = (f: Frame) =>
  f.type === "op-rejected" && f.error === "permission" && f.requestId === undefined;

describe("scenario 1: kickoff storm (simultaneous)", () => {
  it("24 people join at once, see each other, and a simultaneous edit storm converges", async () => {
    const started = Date.now();
    const welcomes = await team.connectAll();
    expect(welcomes.map((w) => w.type)).toEqual(Array(24).fill("welcome"));
    const roles = new Map(team.users.map((u) => [u.name, u.role] as const));
    for (const c of team.clients.values()) {
      expect(c.welcome?.role).toBe(roles.get(c.name));
    }

    // Presence: everyone ends up seeing the other 23, via welcome + peer-joined.
    await Promise.all([...team.clients.values()].map((c) => c.until(() => c.peers.size === 23)));
    for (const c of team.clients.values()) {
      expect(c.peers.size, `${c.name} peers`).toBe(23);
      expect(c.peers.has(c.user.id)).toBe(false);
    }

    // The storm: every send below leaves in the same tick.
    const pending: Array<{ who: string; kind: string; result: Promise<Frame> }> = [];
    for (const editor of team.editors) {
      const c = team.client(editor.name);
      const id = `k-${editor.name.toLowerCase()}`;
      pending.push({ who: editor.name, kind: "node", result: c.submit([op.node(id)]).result });
      pending.push({
        who: editor.name,
        kind: "link",
        result: c.submit([op.connect(id, SEED_NODE, "kicks off")]).result,
      });
      pending.push({
        who: editor.name,
        kind: "sticky",
        result: c.submit([op.sticky(`${id}-sticky`, `${editor.name} idea`)]).result,
      });
    }
    for (const commenter of team.commenters) {
      const c = team.client(commenter.name);
      const id = commenter.name.toLowerCase();
      pending.push({
        who: commenter.name,
        kind: "comment",
        result: c.submit([op.comment(`cm-${id}`, SEED_NODE, `${commenter.name} likes this`)])
          .result,
      });
      pending.push({
        who: commenter.name,
        kind: "vote",
        result: c.submit([op.vote(`vt-${id}`, SEED_NODE)]).result,
      });
      pending.push({
        who: commenter.name,
        kind: "react",
        result: c.submit([op.react(`rx-${id}`, SEED_NODE, "🎉")]).result,
      });
    }
    for (const viewer of team.viewers) {
      const c = team.client(viewer.name);
      pending.push({
        who: viewer.name,
        kind: "forbidden",
        result: c.submit([op.node(`nope-${viewer.name.toLowerCase()}`)], {
          fallback: unnamedPermission,
        }).result,
      });
    }
    const sneaky = team.client(ROSTER.commenters[0]);
    pending.push({
      who: sneaky.name,
      kind: "forbidden",
      result: sneaky.submit([op.node("nope-commenter")], { fallback: unnamedPermission }).result,
    });

    const outcomes = await Promise.all(pending.map((p) => p.result));
    const acked = outcomes.filter((f) => f.type === "op-ack");
    const refused = outcomes.filter((f) => f.type === "op-rejected");
    // 17 editors × 3 + 3 commenters × 3 = 60 accepted; 3 viewers + 1 commenter refused.
    expect(acked).toHaveLength(60);
    expect(refused).toHaveLength(4);
    expect(refused.every((f) => f.error === "permission")).toBe(true);
    pending.forEach((p, i) => {
      const expected = p.kind === "forbidden" ? "op-rejected" : "op-ack";
      expect(outcomes[i]!.type, `${p.who} ${p.kind}`).toBe(expected);
    });
    // Seqs are a permutation of 1..60: one per accepted batch, none shared.
    expect(acked.map((f) => f.seq as number).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 60 }, (_, i) => i + 1),
    );

    const convergence = await assertConverged(team);
    expect(convergence.head).toBe(60);
    expect(convergence.clients).toBe(24);
    expect(convergence.ackedRequests).toBe(60);

    const board = (await team.get(`/api/boards/${team.boardId}`, team.owner)).body;
    const ws = board.workspace;
    expect(Object.keys(ws.nodes)).toHaveLength(18);
    expect(Object.keys(ws.edges)).toHaveLength(17);
    expect(Object.values(ws.shapes).filter((s: any) => s.kind === "sticky")).toHaveLength(17);
    expect(Object.keys(ws.comments)).toHaveLength(3);
    expect(Object.keys(ws.votes)).toHaveLength(3);
    expect(Object.keys(ws.reactions)).toHaveLength(3);
    expect(ws.nodes["nope-commenter"]).toBeUndefined();
    // Authorship is the server's stamp, never the client's claim.
    for (const commenter of team.commenters) {
      expect(ws.comments[`cm-${commenter.name.toLowerCase()}`].by).toBe(commenter.id);
    }

    const latency = ackLatencies(team);
    report("S1 kickoff storm", {
      acked: acked.length,
      refused: refused.length,
      head: convergence.head,
      p50AckMs: Math.round(percentile(latency, 50)),
      p95AckMs: Math.round(percentile(latency, 95)),
      outOfOrderLive: convergence.outOfOrder,
      catchupOverlaps: convergence.catchupOverlaps,
      ms: Date.now() - started,
    });
  }, 30_000);

  // Regression (was a bug, fixed): Room.commit's permission (and empty) refusals omit the submit's requestId, so
  // op-rejected{error:"permission"} is uncorrelated — src/room.ts:362-368, also "empty" at :401 (realtime.ts:465-471
  // only echoes result.requestId). The Stage B contract says every refusal names its request.
  it(
    "a permission refusal names the request it refuses (Stage B correlated refusal)",
    async () => {
      const viewer = team.client(ROSTER.viewers[0]);
      const refusal = await viewer.send([op.node("nope-again")], {
        requestId: "viewer-named-request",
        fallback: unnamedPermission,
      });
      expect(refusal.type).toBe("op-rejected");
      expect(refusal.error).toBe("permission");
      expect(refusal.requestId).toBe("viewer-named-request");
    },
  );
});
