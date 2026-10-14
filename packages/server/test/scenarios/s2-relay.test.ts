import { performance } from "node:perf_hooks";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ROSTER,
  SEED_NODE,
  assertConverged,
  createTeam,
  op,
  percentile,
  report,
  type Team,
} from "./teamHarness.js";

/**
 * Scenario 2 — the relay. A baton passes through the owner and all 17
 * editors in order. Each one appends " →<Name>" to the same node, computing
 * the new text from the latest state its own client has seen, waits for its
 * ack AND for every one of the 24 clients to hold the entry, then passes on.
 * Strictly one at a time, so the log must read like the relay did.
 */

let team: Team;
beforeAll(async () => {
  team = await createTeam();
  await team.connectAll();
}, 30_000);
afterAll(async () => {
  await team?.close();
});

describe("scenario 2: relay (one by one)", () => {
  it("every runner builds on what the last one wrote; seqs climb by exactly one", async () => {
    const started = Date.now();
    const runners = [ROSTER.owner, ...ROSTER.editors];
    expect(runners).toHaveLength(18);
    const seqs: number[] = [];
    const hopMs: number[] = [];
    const everyone = [...team.clients.values()];

    for (const name of runners) {
      const c = team.client(name);
      // The text is computed from what THIS client has seen: if the previous
      // hop had not reached it, the relay would lose a name.
      const current = c.state().nodes[SEED_NODE]!.label;
      const t0 = performance.now();
      const ack = await c.send([op.text(SEED_NODE, `${current} →${name}`)], {
        label: `baton ${name}`,
      });
      expect(ack.type, `${name}'s hop`).toBe("op-ack");
      seqs.push(ack.seq as number);
      await Promise.all(everyone.map((peer) => peer.untilSeq(ack.seq as number)));
      hopMs.push(performance.now() - t0);
    }

    expect(seqs).toEqual(Array.from({ length: 18 }, (_, i) => i + 1));
    const expected = `Kickoff ${runners.map((n) => `→${n}`).join(" ")}`;
    for (const c of everyone) {
      expect(c.state().nodes[SEED_NODE]!.label, `${c.name}'s view`).toBe(expected);
    }

    const convergence = await assertConverged(team);
    expect(convergence.head).toBe(18);
    // One at a time: nothing could arrive out of order.
    expect(convergence.outOfOrder).toBe(0);
    const log = await team.store.loadLog(team.boardId);
    expect(log.map((e) => e.by)).toEqual(runners.map((n) => team.user(n).id));

    report("S2 relay", {
      hops: seqs.length,
      head: convergence.head,
      p50HopToAll24Ms: Math.round(percentile(hopMs, 50)),
      p95HopToAll24Ms: Math.round(percentile(hopMs, 95)),
      ms: Date.now() - started,
    });
  }, 30_000);
});
