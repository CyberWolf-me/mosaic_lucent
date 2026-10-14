import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CALL_ATTRIBUTES, callRoomName } from "../../src/calls.js";
import {
  ackLatencies,
  assertConverged,
  canvasTrack,
  createTeam,
  percentile,
  report,
  type Team,
} from "./teamHarness.js";
import { captureMeeting, correctLines, endAndSummarize } from "./meetingTrack.js";

/**
 * Scenario 5 — the live call, with the meeting and the canvas running at the
 * same time. Twelve people are on the call (in-memory LiveKit): six members
 * of the board's workspace and six who hold the board only by a share link,
 * who knock and are let in (or not) by the host. Hands go up and down, a
 * co-host mutes everyone, someone is removed, the call is locked and ended.
 * Meanwhile Bob keeps the meeting and the other half edits the canvas; at the
 * end the board must have converged for all 24.
 */

const MEMBERS = ["Bob", "Carol", "Dave", "Erin", "Frank", "Grace"] as const;
const GUESTS = ["Heidi", "Ivan", "Judy", "Walter", "Xena", "Zane"] as const;

let team: Team;
beforeAll(async () => {
  team = await createTeam({ orgMembers: MEMBERS });
  await team.connectAll();
}, 30_000);
afterAll(async () => {
  await team?.close();
});

async function callTrack(team: Team) {
  const room = callRoomName(team.boardId);
  const callPath = `/api/boards/${team.boardId}/call`;
  /** Ask for a token and — as LiveKit would — put the person in the room. */
  const enter = async (name: string) => {
    const who = team.user(name);
    const res = await team.post("/api/livekit/token", who, { boardId: team.boardId, room });
    if (res.status === 200) {
      team.calls.join(room, {
        identity: who.id,
        name,
        tracks: [
          { sid: `TR_mic_${who.id}`, source: "microphone", muted: false },
          { sid: `TR_cam_${who.id}`, source: "camera", muted: false },
        ],
      });
    }
    return res;
  };
  const participants = () => team.calls.rooms.get(room)?.participants ?? [];
  const meta = () => team.calls.rooms.get(room)!.meta!;
  const id = (name: string) => team.user(name).id;

  // The first workspace member in hosts the call; the rest join as themselves.
  const host = await enter("Bob");
  expect(host.status).toBe(200);
  expect(host.body.host).toBe(true);
  const members = await Promise.all(MEMBERS.slice(1).map((n) => enter(n)));
  expect(members.map((r) => [r.status, r.body.host])).toEqual(Array(5).fill([200, false]));

  // Six link-holders knock at once; all wait.
  const knocks = await Promise.all(GUESTS.map((n) => enter(n)));
  expect(knocks.map((r) => r.status)).toEqual(Array(6).fill(202));
  expect(knocks.every((r) => r.body.waiting === true)).toBe(true);
  expect(
    meta()
      .waiting!.map((w) => w.userId)
      .sort(),
  ).toEqual(GUESTS.map(id).sort());

  // Only a host answers; Bob lets five in and keeps Zane out, all at once.
  expect(
    (await team.post(`${callPath}/admit`, "Carol", { userId: id("Heidi"), allow: true })).status,
  ).toBe(403);
  const answers = await Promise.all(
    GUESTS.map((n) =>
      team.post(`${callPath}/admit`, "Bob", { userId: id(n), allow: n !== "Zane" }),
    ),
  );
  expect(answers.map((r) => r.status)).toEqual(Array(6).fill(200));
  expect(meta().waiting ?? []).toEqual([]);
  const admitted = await Promise.all(GUESTS.filter((n) => n !== "Zane").map((n) => enter(n)));
  expect(admitted.map((r) => [r.status, r.body.host])).toEqual(Array(5).fill([200, false]));
  const denied = await enter("Zane");
  expect(denied.status).toBe(403);
  expect(denied.body.denied).toBe(true);

  // The waiting room off: a guest comes straight in.
  const opened = await team.post(`${callPath}/settings`, "Bob", { openToGuests: true });
  expect(opened.body.openToGuests).toBe(true);
  expect((await enter("Yara")).status).toBe(200);
  expect(participants()).toHaveLength(12);

  // Four hands go up at once; the host lowers one of them.
  const raised = ["Carol", "Heidi", "Walter", "Xena"];
  const hands = await Promise.all(
    raised.map((n) => team.post(`${callPath}/state`, n, { hand: true })),
  );
  expect(hands.map((r) => r.status)).toEqual([200, 200, 200, 200]);
  expect(
    (await team.post(`${callPath}/state`, "Dave", { identity: id("Walter"), hand: false })).status,
  ).toBe(403);
  const lowered = await team.post(`${callPath}/state`, "Bob", {
    identity: id("Walter"),
    hand: false,
  });
  expect(lowered.status).toBe(200);
  const handsUp = participants()
    .filter((p) => p.attributes[CALL_ATTRIBUTES.hand])
    .map((p) => p.name)
    .sort();
  expect(handsUp).toEqual(["Carol", "Heidi", "Xena"]);

  // A co-host gets host powers and mutes everyone else.
  expect((await team.post(`${callPath}/hosts`, "Bob", { identity: id("Carol") })).status).toBe(200);
  const muted = await team.post(`${callPath}/mute`, "Carol", { everyone: true });
  expect(muted.status).toBe(200);
  const mic = (name: string) =>
    participants()
      .find((p) => p.identity === id(name))!
      .tracks.find((t) => t.source === "microphone")!;
  expect(mic("Carol").muted).toBe(false);
  // Recorded, not asserted: "mute everyone" spares only the caller (routes/calls.ts),
  // so a co-host's mute-all also mutes the original host.
  const hostMutedByCoHost = mic("Bob").muted;
  for (const p of participants()) {
    if (p.identity === id("Carol") || p.identity === id("Bob")) continue;
    expect(mic(p.name).muted, `${p.name} muted`).toBe(true);
  }

  // The host removes Judy; she can't come back to this call.
  const removed = await team.post(`${callPath}/remove`, "Bob", { identity: id("Judy") });
  expect(removed.status).toBe(200);
  const back = await enter("Judy");
  expect(back.status).toBe(403);
  expect(back.body.removed).toBe(true);

  // Locked: a late joiner — even the board's owner — stays out.
  expect((await team.post(`${callPath}/settings`, "Bob", { locked: true })).body.locked).toBe(true);
  const late = await enter("Alice");
  expect(late.status).toBe(403);
  expect(late.body.locked).toBe(true);

  // Everyone on the board can see who's in; the count is the room's.
  const seen = await team.get(callPath, "Uma");
  expect(seen.status).toBe(200);
  expect(seen.body.live).toBe(true);
  expect(seen.body.participants).toHaveLength(11);
  expect(
    seen.body.participants
      .filter((p: { host: boolean }) => p.host)
      .map((p: any) => p.name)
      .sort(),
  ).toEqual(["Bob", "Carol"]);

  // The keeper marks that their device transcribes.
  expect((await team.post(`${callPath}/state`, "Bob", { capture: true })).status).toBe(200);
  expect(
    Number(
      participants().find((p) => p.identity === id("Bob"))!.attributes[CALL_ATTRIBUTES.capture],
    ),
  ).toBeGreaterThan(0);

  // The host ends it for everyone.
  expect((await team.post(`${callPath}/end`, "Bob")).status).toBe(200);
  const after = await team.get(callPath, "Carol");
  expect(after.body).toMatchObject({ live: false, participants: [] });

  return {
    peak: 12,
    admitted: admitted.length,
    denied: 1,
    handsUp: handsUp.length,
    mutedByCoHost: muted.body.muted as number,
    hostMutedByCoHost,
    finalParticipants: seen.body.participants.length as number,
  };
}

describe("scenario 5: live call alongside the meeting and the canvas", () => {
  it("call, meeting and canvas run at once; the board converges for all 24", async () => {
    const started = Date.now();
    const [call, meeting, canvas] = await Promise.all([
      callTrack(team),
      (async () => {
        const m = await captureMeeting(team);
        const corrections = await correctLines(team, m);
        const recap = await endAndSummarize(team, m.meetingId);
        return { turns: m.turns, corrections, recap: Boolean(recap) };
      })(),
      canvasTrack(team, { rounds: 5, prefix: "cv5" }),
    ]);
    expect(canvas.rejected).toBe(0);
    const convergence = await assertConverged(team);
    const latency = ackLatencies(team);
    report("S5 live call", {
      call,
      meeting,
      canvasBatches: canvas.acked,
      head: convergence.head,
      p95AckMs: Math.round(percentile(latency, 95)),
      ms: Date.now() - started,
    });
  }, 30_000);
});

describe("scenario 5: starting the call", () => {
  // Regression (was a bug, fixed): the CallControl contract says "of two people starting the same call at once exactly
  // one becomes host" (src/calls.ts:105), but the token route decides hosting from who is
  // already CONNECTED to LiveKit (src/app.ts:4082-4085 → admitToCall's hand-off,
  // src/calls.ts:225-231). Until the first host's client has connected (after its token
  // returns), every workspace member who asks for a token is made a host too.
  it("two members asking for a token at the same moment: exactly one hosts", async () => {
    const room = callRoomName(team.boardId);
    // The previous call ended; this is a fresh start.
    expect(team.calls.rooms.has(room)).toBe(false);
    const answers = await Promise.all(
      ["Dave", "Erin"].map((n) =>
        team.post("/api/livekit/token", n, { boardId: team.boardId, room }),
      ),
    );
    expect(answers.map((r) => r.status)).toEqual([200, 200]);
    const hosts = answers.map((r) => r.body.host === true);
    report("S5 call start race", { hosts });
    expect(hosts.filter(Boolean)).toHaveLength(1);
  });
});
