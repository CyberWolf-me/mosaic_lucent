import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Operation } from "@lucent/core";
import {
  SEED_NODE,
  ackLatencies,
  assertConverged,
  canvasTrack,
  createTeam,
  gate,
  op,
  percentile,
  report,
  waitUntil,
  type Frame,
  type Team,
} from "./teamHarness.js";
import {
  KEEPER,
  captureMeeting,
  correctLines,
  endAndSummarize,
  type CapturedMeeting,
} from "./meetingTrack.js";

/**
 * Scenario 4 — meeting mode. Twelve people are in the meeting Bob keeps
 * (capture, appends, corrections), then the meeting's extraction becomes a
 * proposal every socket hears about, is superseded, approved once, and its
 * statements are reviewed; the meeting ends, is summarised and its owners
 * are told. The other twelve keep editing the canvas the whole time.
 */

let team: Team;
let meeting: CapturedMeeting;
beforeAll(async () => {
  team = await createTeam();
  await team.connectAll();
}, 30_000);
afterAll(async () => {
  await team?.close();
});

/** What a meeting extraction proposes: a decision, an action and a question. */
function extraction(meetingId: string, prefix: string): Operation[] {
  const provenance = { meetingId, turnRange: [1, 3] as [number, number] };
  return [
    {
      op: "CREATE_NODE",
      id: `${prefix}-decision`,
      nodeType: "decision",
      label: "Ship annual pricing",
      provenance,
    },
    {
      op: "SET_STATEMENT",
      id: `${prefix}-decision`,
      statement: { kind: "decision", status: "resolved", topic: "pricing" },
    },
    {
      op: "CREATE_NODE",
      id: `${prefix}-action`,
      nodeType: "process",
      label: "Draft the pricing page",
      provenance,
    },
    {
      op: "SET_STATEMENT",
      id: `${prefix}-action`,
      statement: { kind: "action", status: "open", topic: "pricing" },
    },
    {
      op: "CREATE_NODE",
      id: `${prefix}-question`,
      nodeType: "process",
      label: "Do we grandfather old plans?",
      provenance,
    },
    {
      op: "SET_STATEMENT",
      id: `${prefix}-question`,
      statement: { kind: "question", status: "open", topic: "pricing" },
    },
  ];
}

const proposalsPath = () => `/api/boards/${team.boardId}/proposals`;

async function propose(by: string, meetingId: string, prefix: string) {
  return team.post(proposalsPath(), by, {
    operations: extraction(meetingId, prefix),
    request: "Extract the decisions from the kickoff",
    explanation: "A decision, an action and an open question.",
    meetingId,
    provenance: { quote: "Let's start the kickoff.", turnRange: [1, 3] },
  });
}

/** Every one of the 24 sockets hears `pred` (counting frames since `marks`). */
async function everyoneHears(marks: Map<string, number>, pred: (f: Frame) => boolean) {
  return Promise.all(
    [...team.clients.values()].map((c) => c.waitFor(pred, 5000, marks.get(c.name))),
  );
}
const markAll = () => new Map([...team.clients.values()].map((c) => [c.name, c.mark()] as const));

describe("scenario 4: meeting mode (12 users) while the canvas half works", () => {
  it("live capture: keeper appends, 11 concurrent appends, attribution and corrections", async () => {
    const started = Date.now();
    const [captured, canvas] = await Promise.all([
      (async () => {
        const m = await captureMeeting(team);
        await correctLines(team, m);
        return m;
      })(),
      canvasTrack(team, { rounds: 4, prefix: "cv1" }),
    ]);
    meeting = captured;
    expect(canvas.rejected).toBe(0);
    // A viewer reads the meeting list but cannot write to it (append was refused above).
    const list = await team.get(`/api/boards/${team.boardId}/meetings`, "Zane");
    expect(list.status).toBe(200);
    expect(list.body.meetings.map((m: { id: string }) => m.id)).toContain(meeting.meetingId);

    const convergence = await assertConverged(team);
    report("S4 capture", {
      turns: meeting.turns,
      concurrentAppendsAccepted: meeting.concurrentAccepted,
      concurrentAppendsRefused: meeting.concurrentRefused,
      canvasBatches: canvas.acked,
      head: convergence.head,
      ms: Date.now() - started,
    });
  }, 30_000);

  it("extraction → proposals fan out to all 24, supersede, one approval, review, end, summary, notify", async () => {
    const started = Date.now();
    const mid = meeting.meetingId;
    let approvedSeq = 0;
    let p2 = "";

    const extractionFlow = async () => {
      // P1, then P2 superseding it; every socket opens the panel both times.
      let marks = markAll();
      const first = await propose("Carol", mid, "x1");
      expect(first.status).toBe(201);
      const p1 = first.body.proposal.id as string;
      await everyoneHears(marks, (f) => f.type === "proposal-created" && f.proposal?.id === p1);

      marks = markAll();
      const second = await propose("Dave", mid, "x2");
      expect(second.status).toBe(201);
      p2 = second.body.proposal.id as string;
      const heard = await everyoneHears(
        marks,
        (f) => f.type === "proposal-created" && f.proposal?.id === p2,
      );
      expect(heard.every((f) => f.supersededId === p1)).toBe(true);
      const listed = await team.get(proposalsPath(), "Zane");
      const byId = new Map(listed.body.proposals.map((p: any) => [p.id, p.status]));
      expect(byId.get(p1)).toBe("superseded");
      expect(byId.get(p2)).toBe("pending");

      // A superseded proposal can't be applied.
      const stale = await team.post(`${proposalsPath()}/${p1}/approve`, "Erin");
      expect(stale.status).toBe(200);
      expect(stale.body.duplicate).toBe(true);
      expect(stale.body.proposal.status).toBe("superseded");
      // Viewers and commenters can't decide (the guard's uniform 404).
      expect((await team.post(`${proposalsPath()}/${p2}/approve`, "Zane")).status).toBe(404);
      expect((await team.post(`${proposalsPath()}/${p2}/approve`, "Walter")).status).toBe(404);

      // One approval applies it; everyone gets the entry and the decision.
      marks = markAll();
      const approved = await team.post(`${proposalsPath()}/${p2}/approve`, "Erin");
      expect(approved.status).toBe(200);
      expect(approved.body.applied).toBe(6);
      approvedSeq = approved.body.seq as number;
      await everyoneHears(marks, (f) => f.type === "op" && f.entry?.seq === approvedSeq);
      await everyoneHears(
        marks,
        (f) => f.type === "proposal-decided" && f.id === p2 && f.appliedSeq === approvedSeq,
      );
      // The second approval is a read of the decision, not a second commit.
      const again = await team.post(`${proposalsPath()}/${p2}/approve`, "Frank");
      expect(again.status).toBe(200);
      expect(again.body.duplicate).toBe(true);
    };

    const [, canvas] = await Promise.all([
      extractionFlow(),
      canvasTrack(team, { rounds: 3, prefix: "cv2" }),
    ]);
    expect(canvas.rejected).toBe(0);

    const log = await team.store.loadLog(team.boardId);
    const applied = log.filter((e) => e.label === "proposal approved");
    expect(applied).toHaveLength(1);
    expect(applied[0]!.seq).toBe(approvedSeq);
    expect(applied[0]!.actor).toMatchObject({
      actorType: "ai",
      actorId: "lucent",
      initiatedBy: team.user("Dave").id,
      approvedBy: team.user("Erin").id,
    });
    let ws = (await team.get(`/api/boards/${team.boardId}`, team.owner)).body.workspace;
    for (const kind of ["decision", "action", "question"]) {
      const node = ws.nodes[`x2-${kind}`];
      expect(node.statement.kind).toBe(kind);
      // A meeting's extraction stays a suggestion until a person reviews it.
      expect(node.statement.trust).toBe("ai-suggested");
      expect(node.provenance.meetingId).toBe(mid);
    }
    expect(ws.nodes["x1-decision"]).toBeUndefined();

    // Review: approve the decision, assign the action, reject the question.
    const review = (body: Record<string, unknown>) =>
      team.post(`/api/boards/${team.boardId}/review`, "Grace", body);
    const marks = markAll();
    const approve = await review({ nodeIds: ["x2-decision"], action: "approve" });
    expect(approve.status).toBe(200);
    const assign = await review({
      nodeIds: ["x2-action"],
      action: "assign",
      assignee: "Alice",
      dueDate: "2026-11-02",
    });
    expect(assign.status).toBe(200);
    const reject = await review({ nodeIds: ["x2-question"], action: "reject" });
    expect(reject.status).toBe(200);
    // Viewers can't review.
    expect(
      (
        await team.post(`/api/boards/${team.boardId}/review`, "Zane", {
          nodeIds: ["x2-action"],
          action: "approve",
        })
      ).status,
    ).toBe(404);
    await everyoneHears(marks, (f) => f.type === "op" && f.entry?.seq === reject.body.seq);
    ws = (await team.get(`/api/boards/${team.boardId}`, team.owner)).body.workspace;
    expect(ws.nodes["x2-decision"].statement.trust).toBe("human-approved");
    expect(ws.nodes["x2-action"].statement.trust).toBe("human-approved");
    expect(ws.nodes["x2-action"].issue).toMatchObject({ assignee: "Alice", dueDate: "2026-11-02" });
    expect(ws.nodes["x2-question"]).toBeUndefined();

    // End, summarise, tell the owners.
    const recap = await endAndSummarize(team, mid);
    const notified = await team.post(
      `/api/boards/${team.boardId}/meetings/${mid}/notify-owners`,
      KEEPER,
    );
    expect(notified.status).toBe(200);
    expect(notified.body).toMatchObject({
      actions: 1,
      unmatched: [],
      told: [{ name: "Alice", you: false, actions: 1 }],
    });
    // Notifications are fire-and-forget: poll the owner's inbox briefly.
    let followups: any[] = [];
    for (let i = 0; i < 50 && followups.length === 0; i += 1) {
      const inbox = await team.get("/api/notifications", team.owner);
      followups = inbox.body.notifications.filter((n: any) => n.kind === "meeting.followup");
      if (followups.length === 0) await new Promise((r) => setTimeout(r, 20));
    }
    expect(followups).toHaveLength(1);
    // A viewer still reads the ended meeting, recap included.
    const read = await team.get(`/api/boards/${team.boardId}/meetings/${mid}`, "Zane");
    expect(read.status).toBe(200);
    expect(read.body.endedAt).toEqual(expect.any(Number));
    expect(read.body.recap).toBeTruthy();

    const convergence = await assertConverged(team);
    const latency = ackLatencies(team);
    report("S4 extraction", {
      proposals: 2,
      approvedSeq,
      reviewSeqs: [approve.body.seq, assign.body.seq, reject.body.seq],
      recapSections: recap.sections.length,
      canvasBatches: canvas.acked,
      head: convergence.head,
      outOfOrderLive: convergence.outOfOrder,
      webClientDropped: convergence.webClientDropped,
      p95AckMs: Math.round(percentile(latency, 95)),
      ms: Date.now() - started,
    });
  }, 30_000);

  /*
   * Deterministic races. Each runs in a passing `it` that only checks the race
   * machinery (a held board-row or log write is a slow database round trip, no
   * more) and records what happened; a following `it` then asserts the correct
   * outcome on that record — so each regression test fails for the reason it names.
   */

  let ordering: {
    approvedSeq: number;
    editSeq: number;
    orders: Map<string, number[]>;
    webDiverged: string[];
    storedMatchesLog: boolean;
  } | null = null;

  it("race: an approval's board-row write is slow while a canvas edit lands", async () => {
    const created = await propose("Carol", meeting.meetingId, "x3");
    expect(created.status).toBe(201);
    const pid = created.body.proposal.id as string;
    const held = gate();
    let holding = false;
    team.store.putGate = async () => {
      if (holding) return;
      holding = true;
      await held.wait;
    };
    try {
      const approving = team.post(`${proposalsPath()}/${pid}/approve`, "Erin");
      await waitUntil(() => holding);
      const edit = await team.client("Mallory").send([op.text(SEED_NODE, "Edited mid-approval")]);
      expect(edit.type).toBe("op-ack");
      await Promise.all(
        [...team.clients.values()].map((c) => c.until(() => c.entries.has(edit.seq), 5000)),
      );
      team.store.putGate = null;
      held.open();
      const approved = await approving;
      expect(approved.status).toBe(200);
      const approvedSeq = approved.body.seq as number;
      expect(approvedSeq).toBe(edit.seq - 1);
      await Promise.all([...team.clients.values()].map((c) => c.untilSeq(edit.seq)));
      // What every client SHOULD show: the log replayed in seq order.
      const truth = JSON.stringify(team.client(team.owner.name).state());
      const stored = JSON.stringify(
        (await team.get(`/api/boards/${team.boardId}`, team.owner)).body.workspace,
      );
      const orders = new Map<string, number[]>();
      const webDiverged: string[] = [];
      for (const c of team.clients.values()) {
        expect(JSON.stringify(c.state()), `${c.name} seq-ordered replay`).toBe(truth);
        orders.set(
          c.name,
          c.liveSeqs.filter((s) => s === approvedSeq || s === edit.seq),
        );
        if (JSON.stringify(c.webClientState().workspace) !== truth) webDiverged.push(c.name);
      }
      ordering = {
        approvedSeq,
        editSeq: edit.seq,
        orders,
        webDiverged,
        storedMatchesLog: stored === truth,
      };
      report("S4 ordering race", {
        approvedSeq,
        editSeq: edit.seq,
        clientsHearingEditFirst: [...orders.values()].filter((o) => o[0] === edit.seq).length,
        webClientsDiverged: webDiverged.length,
        storedBoardMatchesLog: stored === truth,
      });
    } finally {
      team.store.putGate = null;
      held.open();
    }
  });

  // Regression (was a bug, fixed): commitForBoard awaits the board-row get+put (src/realtime.ts:999-1006) BEFORE the
  // HTTP caller broadcasts the entry (src/routes/proposals.ts:250, src/commitBatch.ts:42),
  // so a WS edit committed meanwhile is broadcast first: clients receive seq N+1 before N,
  // and the shipped client, which drops seq <= version (web/src/boardSync.ts:246), silently
  // loses the approved proposal.
  it("…the approved entry reaches every client before the edit that followed it", () => {
    expect(ordering).not.toBeNull();
    for (const [name, order] of ordering!.orders) {
      expect(order, `${name} heard the approval first`).toEqual([
        ordering!.approvedSeq,
        ordering!.editSeq,
      ]);
    }
    expect(ordering!.webDiverged).toEqual([]);
  });

  // Regression (was a bug, fixed): board-row writes are unconditional last-writer-wins upserts (src/boards.ts:475,
  // src/store/pg-boards.ts:192-217) of a `room.current()` captured when the write was issued
  // (src/realtime.ts:1002-1006, :542-546). The approval's slow write, issued before the
  // canvas edit committed, lands after the edit's write and rolls the stored board back —
  // GET /api/boards/:id (and a cold start without a snapshot, which trusts the row) loses
  // the edit although it is in the log.
  it("…and the stored board is not rolled back by the late write", () => {
    expect(ordering).not.toBeNull();
    expect(ordering!.storedMatchesLog).toBe(true);
  });

  it("…and a seq-ordered replay still converges for every client after that race", async () => {
    // One more WS op rewrites the stored row from the room (repairing the rollback above),
    // so this checks the clients' replay, not the documented row bug.
    expect((await team.client("Mallory").send([op.text(SEED_NODE, "After the race")])).type).toBe(
      "op-ack",
    );
    const convergence = await assertConverged(team);
    report("S4 after ordering race", {
      head: convergence.head,
      outOfOrderLive: convergence.outOfOrder,
      webClientDropped: convergence.webClientDropped,
    });
  });

  let reviewRace: { stored: any; replayed: any } | null = null;

  it("race: a review reads the board just before a canvas edit commits", async () => {
    const grace = team.client("Grace");
    const setup = await grace.send([
      op.node("rv-stmt", "Review me"),
      { op: "SET_STATEMENT", id: "rv-stmt", statement: { kind: "decision", status: "resolved" } },
    ]);
    expect(setup.type).toBe("op-ack");
    const held = gate();
    let holding = false;
    team.store.appendGate = async () => {
      if (holding) return;
      holding = true;
      await held.wait;
    };
    try {
      const edit = team.client("Mallory").submit([op.text(SEED_NODE, "X marks the spot")]);
      await waitUntil(() => holding);
      let reviewRead = false;
      team.store.onGet = () => {
        reviewRead = true;
      };
      const review = team.post(`/api/boards/${team.boardId}/review`, "Grace", {
        nodeIds: ["rv-stmt"],
        action: "approve",
      });
      await waitUntil(() => reviewRead);
      team.store.onGet = null;
      team.store.appendGate = null;
      held.open();
      expect((await edit.result).type).toBe("op-ack");
      expect((await review).status).toBe(200);
      const head = await team.store.latestSeq(team.boardId);
      await Promise.all([...team.clients.values()].map((c) => c.untilSeq(head)));
      const stored = (await team.get(`/api/boards/${team.boardId}`, team.owner)).body.workspace;
      const replayed = JSON.parse(JSON.stringify(grace.state()));
      reviewRace = { stored, replayed };
      // The room is right: every client agrees with every other.
      for (const c of team.clients.values()) {
        expect(JSON.parse(JSON.stringify(c.state()))).toEqual(replayed);
      }
      report("S4 review race", {
        storedSeedLabel: stored.nodes[SEED_NODE].label,
        roomSeedLabel: replayed.nodes[SEED_NODE].label,
      });
    } finally {
      team.store.onGet = null;
      team.store.appendGate = null;
      held.open();
    }
  });

  // Regression (was a bug, fixed): commitBatch persists `applyOperations(board.workspace, ops)` computed from the board
  // row the route read BEFORE the room commit (src/commitBatch.ts:43), overwriting the newer
  // state commitForBoard just stored — an edit committed between the review's read and its
  // commit vanishes from GET /api/boards/:id (the ops route shares this path) until some
  // later WS op rewrites the row.
  it("…the stored board keeps the canvas edit the review raced", () => {
    expect(reviewRace).not.toBeNull();
    expect(reviewRace!.stored.nodes[SEED_NODE].label).toBe("X marks the spot");
    expect(reviewRace!.stored).toEqual(reviewRace!.replayed);
  });

  let approveRace: { responses: Array<{ status: number; body: any }>; entries: number } | null =
    null;

  it("race: two editors approve the same proposal at the same time", async () => {
    // A WS op first, so the stored row is current again after the review race.
    expect((await team.client("Mallory").send([op.text(SEED_NODE, "Row repaired")])).type).toBe(
      "op-ack",
    );
    const created = await propose("Carol", meeting.meetingId, "x4");
    expect(created.status).toBe(201);
    const pid = created.body.proposal.id as string;
    const held = gate();
    let holding = false;
    team.store.putGate = async () => {
      if (holding) return;
      holding = true;
      await held.wait;
    };
    try {
      const first = team.post(`${proposalsPath()}/${pid}/approve`, "Erin");
      await waitUntil(() => holding);
      // The second approval arrives while the first is still saving; the
      // route makes it wait for the first rather than commit beside it.
      const second = team.post(`${proposalsPath()}/${pid}/approve`, "Frank");
      await new Promise((r) => setTimeout(r, 50));
      team.store.putGate = null;
      held.open();
      const responses = [await first, await second];
      expect(responses.map((r) => r.status)).toEqual([200, 200]);
      const log = await team.store.loadLog(team.boardId);
      // One key per proposal (`prp_<pid>`); the old per-approver keys too.
      const entries = log.filter(
        (e) => e.requestId === `prp_${pid}` || e.requestId?.startsWith(`prp_${pid}_`),
      ).length;
      approveRace = { responses, entries };
      report("S4 approve race", {
        logEntriesForProposal: entries,
        duplicateFlags: responses.map((r) => r.body.duplicate === true),
        seqs: responses.map((r) => r.body.seq),
      });
    } finally {
      team.store.putGate = null;
      held.open();
    }
  });

  // Regression (was a bug, fixed): the approve route's pending check (src/routes/proposals.ts:141) and its decide
  // (:279) are not atomic, and the approval requestId is per approver (`prp_<pid>_<userId>`,
  // :234/:259). Two editors approving at once both commit: the loser's room commit fails
  // validation and falls through to a direct store append (:253) the room never sees — the
  // proposal lands twice in the log and neither answer says `duplicate`.
  it("…the proposal is applied exactly once and one answer is a duplicate", () => {
    expect(approveRace).not.toBeNull();
    expect(approveRace!.entries).toBe(1);
    expect(approveRace!.responses.filter((r) => r.body.duplicate === true)).toHaveLength(1);
  });
});
