import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inverseOperations } from "@lucent/core";
import {
  CANVAS_HALF,
  MEETING_HALF,
  SEED_NODE,
  ackLatencies,
  assertConverged,
  canvasTrack,
  createTeam,
  op,
  percentile,
  report,
  type Frame,
  type Team,
} from "./teamHarness.js";

/**
 * Scenario 6 — AI, Ask and presence while everyone works. Three editors ask
 * Lucent for diagrams at once (MockProvider) and commit what comes back under
 * their run; the big one goes through the review gate as a proposal. Two
 * people ask questions of the board. An editor leads the room (presence,
 * spotlight, summon) — a viewer can't. @mentions reach the people named. An
 * editor undoes their own batch with core's inverse ops. All while both
 * halves of the team keep editing.
 */

const EMPTY_SUMMARY = {
  diagramKind: "flowchart",
  nodes: [],
  edges: [],
  shapes: [],
  shapeLinks: [],
  groups: [],
  comments: [],
  reactions: [],
  wireframes: [],
};

let team: Team;
/** The actor the log recorded for the share-link editors' commits under their runs. */
let guestRunActors: string[] = [];
beforeAll(async () => {
  team = await createTeam();
  await team.connectAll();
}, 30_000);
afterAll(async () => {
  await team?.close();
});

const markAll = () => new Map([...team.clients.values()].map((c) => [c.name, c.mark()] as const));
async function everyoneBut(
  except: string | null,
  marks: Map<string, number>,
  pred: (f: Frame) => boolean,
): Promise<Frame[]> {
  return Promise.all(
    [...team.clients.values()]
      .filter((c) => c.name !== except)
      .map((c) => c.waitFor(pred, 5000, marks.get(c.name))),
  );
}

async function inbox(name: string, kind: string): Promise<any[]> {
  for (let i = 0; i < 100; i += 1) {
    const res = await team.get("/api/notifications", name);
    expect(res.status).toBe(200);
    const hits = res.body.notifications.filter((n: { kind: string }) => n.kind === kind);
    if (hits.length > 0) return hits;
    await new Promise((r) => setTimeout(r, 10));
  }
  return [];
}

describe("scenario 6: AI + Ask + presence while everyone works", () => {
  it("generate → commit under the run / review gate, ask, lead the room, mention, undo", async () => {
    const started = Date.now();
    const stats: Record<string, unknown> = {};

    const aiFlow = async () => {
      // Three editors ask at once (the web's body: the board rides `run`), and the
      // owner too — a workspace member, the positive control for run linking.
      const asks = [
        { by: "Mallory", message: "Design an e-commerce online store flow" },
        { by: "Niaj", message: "Sketch zebra idea alpha" },
        { by: "Olivia", message: "Sketch zebra idea beta" },
        { by: "Alice", message: "Sketch zebra idea gamma" },
      ];
      const generated = await Promise.all(
        asks.map((a) =>
          team.post("/api/generate", a.by, {
            message: a.message,
            summary: EMPTY_SUMMARY,
            run: { boardId: team.boardId, surface: "canvas" },
          }),
        ),
      );
      for (const g of generated) {
        expect(g.status).toBe(200);
        expect(g.body.runId).toMatch(/^run_/);
        expect(g.body.operations.length).toBeGreaterThan(0);
      }
      const [big, alpha, beta, gamma] = generated as [any, any, any, any];
      expect(big.body.operations).toHaveLength(16);

      // The small ones: committed by their requesters over the socket, under their run.
      const commits = await Promise.all([
        team.client("Niaj").send(alpha.body.operations, { runId: alpha.body.runId, label: "AI" }),
        team.client("Olivia").send(beta.body.operations, { runId: beta.body.runId, label: "AI" }),
        team.client("Alice").send(gamma.body.operations, { runId: gamma.body.runId, label: "AI" }),
      ]);
      expect(commits.map((f) => f.type)).toEqual(["op-ack", "op-ack", "op-ack"]);
      // Someone else's run can't be borrowed: logged as the sender's own batch.
      const borrowed = await team
        .client("Peggy")
        .send([op.node("borrowed-run")], { runId: gamma.body.runId });
      expect(borrowed.type).toBe("op-ack");

      // The big one is a review-gate proposal; every socket opens the panel.
      let marks = markAll();
      const proposed = await team.post(`/api/boards/${team.boardId}/proposals`, "Mallory", {
        operations: big.body.operations,
        request: asks[0]!.message,
        explanation: big.body.explanation,
        runId: big.body.runId,
      });
      expect(proposed.status).toBe(201);
      const pid = proposed.body.proposal.id as string;
      await everyoneBut(
        null,
        marks,
        (f) => f.type === "proposal-created" && f.proposal?.id === pid,
      );
      marks = markAll();
      const approved = await team.post(
        `/api/boards/${team.boardId}/proposals/${pid}/approve`,
        "Peggy",
      );
      expect(approved.status).toBe(200);
      expect(approved.body.applied).toBe(16);
      await everyoneBut(null, marks, (f) => f.type === "op" && f.entry?.seq === approved.body.seq);

      const log = await team.store.loadLog(team.boardId);
      const bySeq = new Map(log.map((e) => [e.seq, e] as const));
      // The owner's generation, committed under its run: AI, asked and approved by her.
      expect(bySeq.get(commits[2]!.seq)!.actor).toMatchObject({
        actorType: "ai",
        initiatedBy: team.user("Alice").id,
        approvedBy: team.user("Alice").id,
      });
      expect(bySeq.get(borrowed.seq)!.actor).toMatchObject({ actorType: "user" });
      expect(bySeq.get(approved.body.seq)!.actor).toMatchObject({
        actorType: "ai",
        initiatedBy: team.user("Mallory").id,
        approvedBy: team.user("Peggy").id,
      });
      // The share-link editors' commits: recorded for the regression test below.
      guestRunActors = [commits[0]!, commits[1]!].map(
        (f) => bySeq.get(f.seq)!.actor?.actorType ?? "user",
      );
      stats.ai = {
        generated: generated.map((g) => g.body.operations.length),
        committedUnderRun: commits.length,
        guestRunActors,
        proposalSeq: approved.body.seq,
      };
    };

    const askFlow = async () => {
      const [editor, viewer] = await Promise.all(
        ["Rupert", "Quinn"].map((n) =>
          team.post(`/api/boards/${team.boardId}/ask`, n, {
            question: "Give me an overview of the board",
          }),
        ),
      );
      for (const answer of [editor!, viewer!]) {
        expect(answer.status).toBe(200);
        expect(answer.body.answer).toMatch(/This board/);
        expect(answer.body.citations.length).toBeGreaterThan(0);
        expect(answer.body.citations[0]).toMatchObject({ kind: "node" });
      }
      stats.ask = { answers: 2, citations: editor!.body.citations.length };
    };

    const leadFlow = async () => {
      const sybil = team.client("Sybil");
      const id = team.user("Sybil").id;
      let marks = markAll();
      sybil.raw({
        type: "presence",
        cursor: { x: 10, y: 20 },
        selection: [SEED_NODE],
        viewport: { x: 100, y: 50, zoom: 125 },
      });
      const seen = await everyoneBut(
        "Sybil",
        marks,
        (f) => f.type === "presence" && f.presence?.userId === id,
      );
      expect(seen).toHaveLength(23);
      expect(
        seen.every((f) => f.presence.cursor?.x === 10 && f.presence.selection[0] === SEED_NODE),
      ).toBe(true);

      marks = markAll();
      sybil.raw({ type: "spotlight", on: true });
      const lit = await everyoneBut(
        null,
        marks,
        (f) => f.type === "spotlight" && f.spotlight?.userId === id,
      );
      expect(lit).toHaveLength(24);

      marks = markAll();
      sybil.raw({ type: "summon", viewport: { x: 300, y: 200, zoom: 90 } });
      const summoned = await everyoneBut("Sybil", marks, (f) => f.type === "summon");
      expect(summoned.every((f) => f.from.userId === id && f.viewport.zoom === 90)).toBe(true);

      // A viewer and a commenter can't direct anyone's view.
      for (const [name, msg, error] of [
        ["Uma", { type: "spotlight", on: true }, "only editors can spotlight"],
        ["Yara", { type: "spotlight", on: true }, "only editors can spotlight"],
        [
          "Uma",
          { type: "summon", viewport: { x: 0, y: 0, zoom: 100 } },
          "only editors can bring everyone here",
        ],
      ] as const) {
        const c = team.client(name);
        const mark = c.mark();
        c.raw(msg as Record<string, unknown>);
        expect((await c.waitFor((f) => f.type === "error", 4000, mark)).message).toBe(error);
      }

      marks = markAll();
      sybil.raw({ type: "spotlight", on: false });
      await everyoneBut(null, marks, (f) => f.type === "spotlight" && f.spotlight === null);
      stats.lead = {
        presenceSeenBy: seen.length,
        spotlightSeenBy: lit.length,
        summonedSeenBy: summoned.length,
      };
    };

    const mentionFlow = async () => {
      const yara = await team
        .client("Yara")
        .send([
          op.comment("mention-1", SEED_NODE, "@Bob @Carol please review the kickoff, @Nobody too"),
        ]);
      const trent = await team
        .client("Trent")
        .send([op.comment("mention-2", SEED_NODE, "@Alice ship it")]);
      expect([yara.type, trent.type]).toEqual(["op-ack", "op-ack"]);
      const [bob, carol, alice] = await Promise.all(
        ["Bob", "Carol", "Alice"].map((n) => inbox(n, "comment.mention")),
      );
      expect(bob).toHaveLength(1);
      expect(carol).toHaveLength(1);
      expect(alice).toHaveLength(1);
      // Nobody else was named; the author isn't told about their own comment.
      const others = await Promise.all(
        ["Yara", "Dave"].map(async (n) =>
          (await team.get("/api/notifications", n)).body.notifications.filter(
            (x: { kind: string }) => x.kind === "comment.mention",
          ),
        ),
      );
      expect(others).toEqual([[], []]);
      stats.mentions = { notified: 3 };
    };

    const undoFlow = async () => {
      const victor = team.client("Victor");
      const ack = await victor.send([
        op.node("undo-me", "Regret"),
        op.connect("undo-me", SEED_NODE, "regrets"),
        op.sticky("undo-me-note", "regret note"),
      ]);
      expect(ack.type).toBe("op-ack");
      await victor.untilSeq(ack.seq);
      // The inverse of exactly that entry, against the state right before it.
      const entry = victor.entries.get(ack.seq)!;
      const inverse = inverseOperations(entry.ops, victor.state(ack.seq - 1));
      const undone = await victor.send(inverse, { label: "undo" });
      expect(undone.type).toBe("op-ack");
      await Promise.all([...team.clients.values()].map((c) => c.untilSeq(undone.seq)));
      for (const c of team.clients.values()) {
        const ws = c.state(undone.seq);
        expect(ws.nodes["undo-me"], `${c.name} undo`).toBeUndefined();
        expect(ws.shapes["undo-me-note"]).toBeUndefined();
        expect(Object.values(ws.edges).some((e) => e.source === "undo-me")).toBe(false);
      }
      stats.undo = { undoneSeq: ack.seq, inverseOps: inverse.length };
    };

    const [, , , , , canvasA, canvasB] = await Promise.all([
      aiFlow(),
      askFlow(),
      leadFlow(),
      mentionFlow(),
      undoFlow(),
      canvasTrack(team, { names: CANVAS_HALF, prefix: "cv6a", rounds: 3 }),
      canvasTrack(team, { names: MEETING_HALF, prefix: "cv6b", rounds: 3 }),
    ]);
    expect(canvasA.rejected + canvasB.rejected).toBe(0);

    const convergence = await assertConverged(team);
    const ws = (await team.get(`/api/boards/${team.boardId}`, team.owner)).body.workspace;
    for (const id of ["customer", "checkout", "shipping"]) expect(ws.nodes[id]).toBeDefined();
    expect(ws.nodes["undo-me"]).toBeUndefined();
    const latency = ackLatencies(team);
    report("S6 AI/ask/presence", {
      ...stats,
      canvasBatches: canvasA.acked + canvasB.acked,
      head: convergence.head,
      outOfOrderLive: convergence.outOfOrder,
      p95AckMs: Math.round(percentile(latency, 95)),
      ms: Date.now() - started,
    });
  }, 30_000);

  // Regression (was a bug, fixed): /api/generate resolves the billed org from the TOP-LEVEL boardId only
  // (src/app.ts:5096 → resolveAiContext, :1792-1802); the web sends the board in
  // `run.boardId`, so for an editor who is not a member of the board's workspace (every
  // share-link collaborator) the billed org is their own and recordGenerateRun drops the
  // board (src/app.ts:699). Committing the output under its runId then fails realtime's
  // own-run check (src/realtime.ts:446) and the log records a plain user batch, losing
  // ADR 0047's "AI, asked and approved by them" — while the owner's identical flow is AI.
  it("a share-link editor's generation committed under its run is logged as AI", () => {
    expect(guestRunActors).toHaveLength(2);
    expect(guestRunActors).toEqual(["ai", "ai"]);
  });
});
