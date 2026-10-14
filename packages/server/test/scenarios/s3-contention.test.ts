import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
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
 * Scenario 3 — contention. Twelve editors hit the same node at the same
 * instant (text, then position); a delete races eleven edits of another
 * node; a request id is replayed. The log decides every conflict: the
 * highest seq wins a last-writer race, an edit that lands after a delete is
 * refused as `validation` and never applied, and a replay is a duplicate ack
 * with no second broadcast.
 */

let team: Team;
beforeAll(async () => {
  team = await createTeam();
  await team.connectAll();
}, 30_000);
afterAll(async () => {
  await team?.close();
});

const twelve = () => team.editors.slice(0, 12).map((e) => team.client(e.name));

describe("scenario 3: contention", () => {
  it("last writer by seq wins text and position; delete beats late edits; replays are no-ops", async () => {
    const started = Date.now();
    const owner = team.client(team.owner.name);
    const victimAck = await owner.send([op.node("victim", "Victim")]);
    expect(victimAck.type).toBe("op-ack");

    // A: twelve CHANGE_TEXTs on the seed in one tick.
    const texts = await Promise.all(
      twelve().map((c) => c.submit([op.text(SEED_NODE, `Text by ${c.name}`)]).result),
    );
    expect(texts.every((f) => f.type === "op-ack")).toBe(true);
    const textWinner =
      twelve()[texts.reduce((best, f, i, all) => (f.seq > all[best]!.seq ? i : best), 0)]!;

    // B: twelve MOVE_NODEs on the seed in one tick (MOVE_NODE is WS-only).
    const moves = await Promise.all(
      twelve().map((c, i) => c.submit([op.move(SEED_NODE, i * 100, i * 10)]).result),
    );
    expect(moves.every((f) => f.type === "op-ack")).toBe(true);
    const moveWinner = moves.reduce((best, f, i, all) => (f.seq > all[best]!.seq ? i : best), 0);

    // C: a delete and eleven edits of the victim leave in the same tick.
    const [deleter, ...editors] = twelve();
    const del = deleter!.submit([op.del("victim")]);
    const edits = editors.map((c) => c.submit([op.text("victim", `Saved by ${c.name}`)]));
    const delAck = await del.result;
    const editOutcomes = await Promise.all(edits.map((e) => e.result));
    expect(delAck.type).toBe("op-ack");
    let applied = 0;
    let refused = 0;
    for (const outcome of editOutcomes) {
      if (outcome.type === "op-ack") {
        // An edit that won the race landed BEFORE the delete.
        expect(outcome.seq).toBeLessThan(delAck.seq);
        applied += 1;
      } else {
        expect(outcome.error).toBe("validation");
        refused += 1;
      }
    }
    expect(applied + refused).toBe(11);
    // And one edit that certainly comes after the delete is refused, not applied.
    const late = await editors[0]!.send([op.text("victim", "Too late")]);
    expect(late.type).toBe("op-rejected");
    expect(late.error).toBe("validation");
    expect(late.head).toBeGreaterThanOrEqual(delAck.seq);
    refused += 1;

    // D: a replayed requestId is acked with the original seq, broadcasts nothing.
    const replayer = editors[1]!;
    const first = await replayer.send([op.node("dup", "Dup")], { requestId: "replay-me" });
    expect(first.type).toBe("op-ack");
    await Promise.all([...team.clients.values()].map((c) => c.untilSeq(first.seq)));
    const before = [...team.clients.values()].map((c) => c.liveSeqs.length);
    const again = await replayer.send([op.node("dup", "Dup")], { requestId: "replay-me" });
    expect(again).toMatchObject({ type: "op-ack", seq: first.seq, duplicate: true });
    // A replay is recognised by its key, even with a different body.
    const changed = await replayer.send([op.text("dup", "Other")], { requestId: "replay-me" });
    expect(changed).toMatchObject({ type: "op-ack", seq: first.seq, duplicate: true });
    // A fence: one fresh op, so anything a replay broadcast would have arrived first.
    const fence = await replayer.send([op.text("dup", "Fence")]);
    await Promise.all([...team.clients.values()].map((c) => c.untilSeq(fence.seq)));
    expect(fence.seq).toBe(first.seq + 1);
    [...team.clients.values()].forEach((c, i) => {
      expect(c.liveSeqs.length - before[i]!, `${c.name} live frames after replay`).toBe(1);
    });

    const convergence = await assertConverged(team);
    const ws = (await team.get(`/api/boards/${team.boardId}`, team.owner)).body.workspace;
    expect(ws.nodes[SEED_NODE].label).toBe(`Text by ${textWinner.name}`);
    expect(ws.nodes[SEED_NODE].position).toEqual({ x: moveWinner * 100, y: moveWinner * 10 });
    expect(ws.nodes[SEED_NODE].pinned).toBe(true);
    expect(ws.nodes.victim).toBeUndefined();
    const log = await team.store.loadLog(team.boardId);
    // Nothing touched the victim after its delete.
    expect(
      log.filter((e) => e.seq > delAck.seq && e.ops.some((o: any) => o.id === "victim")),
    ).toEqual([]);
    expect(log.filter((e) => e.requestId === "replay-me")).toHaveLength(1);

    const latency = ackLatencies(team);
    report("S3 contention", {
      textRace: texts.length,
      moveRace: moves.length,
      editsBeforeDelete: applied,
      editsRefusedAfterDelete: refused,
      head: convergence.head,
      p95AckMs: Math.round(percentile(latency, 95)),
      ms: Date.now() - started,
    });
  }, 30_000);

  // Regression (was a bug, fixed): a retry of an IN-FLIGHT request (same requestId, sent before the first is
  // acked — e.g. boardSync's reconnect replay racing the original) is not recognised:
  // the replay guard checks committedRequests before the commit queue
  // (src/room.ts:380-397), so the twin is re-validated after the original lands and
  // a CREATE is refused "validation" instead of answered as a duplicate.
  it(
    "a request id sent twice before its ack is answered once plus one duplicate",
    async () => {
      const c = team.client(team.editors[2]!.name);
      const answers: Frame[] = [];
      const collect = c.waitFor((f) => {
        if ((f.type === "op-ack" || f.type === "op-rejected") && f.requestId === "twin-request") {
          answers.push(f);
        }
        return answers.length === 2;
      });
      c.raw({ type: "op", requestId: "twin-request", label: "twin", ops: [op.node("twin")] });
      c.raw({ type: "op", requestId: "twin-request", label: "twin", ops: [op.node("twin")] });
      await collect;
      expect(answers.map((f) => f.type)).toEqual(["op-ack", "op-ack"]);
      expect(answers.filter((f) => f.duplicate === true)).toHaveLength(1);
      expect(answers[1]!.seq).toBe(answers[0]!.seq);
    },
  );
});
