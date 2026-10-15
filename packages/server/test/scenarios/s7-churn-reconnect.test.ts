import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  SEED_NODE,
  TeamClient,
  assertConverged,
  createTeam,
  op,
  report,
  type Frame,
  type Team,
} from "./teamHarness.js";

/**
 * Scenario 7 — permission churn and reconnects. Four people drop off while
 * twenty batches land and come back from the last seq they held; the owner
 * demotes one editor and removes members while their sockets are open.
 */

let team: Team;
beforeAll(async () => {
  team = await createTeam();
  await team.connectAll();
}, 30_000);
afterAll(async () => {
  await team?.close();
});

const unnamedPermission = (f: Frame) =>
  f.type === "op-rejected" && f.error === "permission" && f.requestId === undefined;

describe("scenario 7: permission churn + reconnect", () => {
  it("four clients drop, twenty batches land, and each catch-up is exactly what they missed", async () => {
    const started = Date.now();
    // Some history first, so the droppers hold a non-zero cursor.
    const owner = team.client(team.owner.name);
    for (let i = 0; i < 3; i += 1) {
      expect((await owner.send([op.node(`pre-${i}`)])).type).toBe("op-ack");
    }
    const droppers = ["Carol", "Niaj", "Walter", "Zane"].map((n) => team.client(n));
    await Promise.all(droppers.map((c) => c.untilSeq(3)));
    const lastSeen = new Map(droppers.map((c) => [c.name, c.head()] as const));
    expect([...lastSeen.values()]).toEqual([3, 3, 3, 3]);
    await Promise.all(droppers.map((c) => c.disconnect()));

    // Twenty batches from five editors at once while they are away.
    const writers = ["Dave", "Erin", "Frank", "Grace", "Mallory"].map((n) => team.client(n));
    const results = await Promise.all(
      writers.flatMap((c) =>
        [0, 1, 2, 3].map(
          (i) =>
            c.submit([
              op.node(`away-${c.name.toLowerCase()}-${i}`),
              op.connect(`away-${c.name.toLowerCase()}-${i}`, SEED_NODE),
            ]).result,
        ),
      ),
    );
    expect(results.every((f) => f.type === "op-ack")).toBe(true);
    const headWhileAway = await team.store.latestSeq(team.boardId);
    expect(headWhileAway).toBe(23);

    // Back, each from its own cursor: the catch-up is exactly seqs 4..23.
    const answers = await Promise.all(droppers.map((c) => c.connect(lastSeen.get(c.name)!)));
    const missed = Array.from({ length: 20 }, (_, i) => i + 4);
    answers.forEach((answer, i) => {
      const c = droppers[i]!;
      if (answer.type === "resync") {
        // Allowed by the protocol: state wholesale at the head.
        expect(answer.version).toBe(headWhileAway);
      } else {
        expect(answer.type, `${c.name} rejoin`).toBe("welcome");
        expect(
          answer.catchup.map((e: { seq: number }) => e.seq),
          `${c.name} catchup`,
        ).toEqual(missed);
        expect(answer.version).toBe(headWhileAway);
      }
    });

    // Life goes on, everyone (back) included.
    const after = await Promise.all(
      [...droppers.slice(0, 2), owner].map((c) => c.send([op.sticky(`back-${c.name}`, "back")])),
    );
    expect(after.every((f) => f.type === "op-ack")).toBe(true);
    const convergence = await assertConverged(team);
    expect(convergence.head).toBe(26);
    report("S7 reconnect", {
      dropped: droppers.length,
      missedPerClient: missed.length,
      rejoinKinds: answers.map((a) => a.type),
      head: convergence.head,
      ms: Date.now() - started,
    });
  }, 30_000);

  // Regression (was a bug, fixed): PATCH /api/boards/:id/members/:userId updates the membership row only; the
  // live Room keeps the role it stamped at join (src/app.ts:4725 — no room update;
  // realtime.ts:396-407 re-resolves a role only when the room has none), so a demoted
  // editor keeps editing on the socket they already have open.
  it("a demoted editor's next op on their open socket is refused", async () => {
    const judy = team.user("Judy");
    const patched = await team.api(`/api/boards/${team.boardId}/members/${judy.id}`, {
      method: "PATCH",
      token: team.owner.token,
      body: JSON.stringify({ role: "viewer" }),
    });
    expect(patched.status).toBe(200);
    // Over REST the demotion is immediate.
    expect((await team.get(`/api/boards/${team.boardId}`, judy)).body.role).toBe("viewer");
    const attempt = await team
      .client("Judy")
      .send([op.text(SEED_NODE, "Judy still edits")], { fallback: unnamedPermission });
    expect(attempt.type).toBe("op-rejected");
    expect(attempt.error).toBe("permission");
  });

  // Regression (was a bug, fixed): DELETE /api/boards/:id/members/:userId removes the grant but never calls
  // realtime.detachUser (src/app.ts:4915-4925), unlike the guest and org-member removal
  // routes (routes/guests.ts:102, routes/orgMembers.ts:115) — the removed member's open
  // socket is not told "access removed" and keeps committing.
  it("removing a board member evicts their open socket", async () => {
    const ivan = team.user("Ivan");
    const ivanClient = team.client("Ivan");
    const mark = ivanClient.mark();
    const removed = await team.api(`/api/boards/${team.boardId}/members/${ivan.id}`, {
      method: "DELETE",
      token: team.owner.token,
    });
    expect(removed.status).toBe(200);
    expect((await team.get(`/api/boards/${team.boardId}`, ivan)).status).toBe(404);
    const told = await ivanClient.waitFor((f) => f.type === "error", 1500, mark).catch(() => null);
    expect(told?.message).toBe("access removed");
  });

  it("removing a guest evicts their open socket and refuses the rejoin", async () => {
    const heidi = team.user("Heidi");
    const heidiClient = team.client("Heidi");
    const mark = heidiClient.mark();
    const ownerMark = team.client(team.owner.name).mark();
    const removed = await team.api(`/api/orgs/${team.orgId}/guests/${heidi.id}`, {
      method: "DELETE",
      token: team.owner.token,
    });
    expect(removed.status).toBe(200);
    const told = await heidiClient.waitFor((f) => f.type === "error", 4000, mark);
    expect(told.message).toBe("access removed");
    const left = await team
      .client(team.owner.name)
      .waitFor((f) => f.type === "peer-left" && f.userId === heidi.id, 4000, ownerMark);
    expect(left.userId).toBe(heidi.id);

    // The detached socket's next op goes nowhere: no ack, nothing in the log.
    const headBefore = await team.store.latestSeq(team.boardId);
    const attempt = heidiClient.submit([op.node("heidi-after")], { timeoutMs: 500 });
    await expect(attempt.result).rejects.toThrow(/timed out/);
    expect(await team.store.latestSeq(team.boardId)).toBe(headBefore);

    // A fresh socket is refused at the door.
    const again = new TeamClient(team, heidi);
    const answer = await again.connect(0);
    expect(answer).toMatchObject({ type: "error", message: "board not found" });
    await again.disconnect();
  });

  it("after the churn, everyone still attached converges", async () => {
    const owner = team.client(team.owner.name);
    expect((await owner.send([op.text(SEED_NODE, "After the churn")])).type).toBe("op-ack");
    const convergence = await assertConverged(team, { exclude: ["Heidi", "Ivan"] });
    report("S7 after churn", { head: convergence.head, clients: convergence.clients });
  });
});
