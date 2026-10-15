import { expect } from "vitest";
import { MEETING_HALF, type Team, type TeamUser } from "./teamHarness.js";

/**
 * The meeting half's capture, shared by scenarios 4 and 5: Bob keeps a live
 * meeting; every other participant's line reaches it both through the
 * keeper's device (the product path: one capture, diarised speakers) and as
 * eleven people appending at the same instant.
 */

export const KEEPER = "Bob";

export interface CapturedMeeting {
  meetingId: string;
  /** The keeper-appended line of each participant: turn index by name. */
  lineOf: Map<string, number>;
  turns: number;
  concurrentAccepted: number;
  concurrentRefused: number;
}

const others = () => MEETING_HALF.filter((n) => n !== KEEPER);

export async function captureMeeting(team: Team): Promise<CapturedMeeting> {
  const keeper = team.user(KEEPER);
  const boardPath = `/api/boards/${team.boardId}/meetings`;
  const t0 = Date.now();

  // A live meeting: no endedAt.
  const created = await team.post(boardPath, keeper, {
    turns: [
      { speaker: keeper.name, at: t0, text: "Let's start the kickoff.", speakerId: keeper.id },
    ],
    mode: "intelligence",
  });
  expect(created.status).toBe(201);
  expect(created.body.endedAt).toBeNull();
  const meetingId = created.body.id as string;
  const turnsPath = `${boardPath}/${meetingId}/turns`;

  // (a) The product path: the keeper's capture appends each speaker's line,
  // one checkpoint at a time, attributed to who said it.
  const lineOf = new Map<string, number>([[keeper.name, 0]]);
  let index = 1;
  for (const name of others()) {
    const who = team.user(name);
    const res = await team.post(turnsPath, keeper, {
      turns: [
        {
          speaker: who.name,
          at: t0 + index * 1000,
          text: `${who.name} raises point ${index}`,
          speakerId: who.id,
        },
      ],
    });
    expect(res.status, `keeper appends ${name}`).toBe(200);
    lineOf.set(name, index);
    index += 1;
  }
  const afterKeeper = await team.get(`${boardPath}/${meetingId}`, keeper);
  expect(afterKeeper.status).toBe(200);
  expect(afterKeeper.body.turns).toHaveLength(12);
  for (const [name, i] of lineOf) {
    expect(afterKeeper.body.turns[i].speaker).toBe(name);
    expect(afterKeeper.body.turns[i].speakerId, `${name}'s line attributed`).toBe(
      team.user(name).id,
    );
  }

  // (b) Eleven people append to the same running meeting at the same instant.
  // Appending is an editor's write: the commenters and the viewer are refused —
  // with the board guard's uniform 404 (src/app.ts requireBoardRole: "refusals are
  // always 404 ... so board ids stay unguessable").
  const concurrent = await Promise.all(
    others().map(async (name) => {
      const who = team.user(name);
      const res = await team.post(turnsPath, who, {
        turns: [
          {
            speaker: who.name,
            at: t0 + 60_000,
            text: `${who.name} adds a live note`,
            speakerId: who.id,
          },
        ],
      });
      return { who, status: res.status };
    }),
  );
  const accepted = concurrent.filter((r) => r.status === 200).map((r) => r.who);
  const refused = concurrent.filter((r) => r.status !== 200);
  for (const r of concurrent) {
    expect(r.status, `${r.who.name} (${r.who.role}) appends`).toBe(
      r.who.role === "editor" ? 200 : 404,
    );
  }
  const final = await team.get(`${boardPath}/${meetingId}`, keeper);
  const turns = final.body.turns as Array<{ speaker: string; text: string; speakerId?: string }>;
  // No turn lost: every accepted append is there exactly once.
  expect(turns).toHaveLength(12 + accepted.length);
  for (const who of accepted) {
    const mine = turns.filter((t) => t.text === `${who.name} adds a live note`);
    expect(mine, `${who.name}'s live note`).toHaveLength(1);
    expect(mine[0]!.speakerId).toBe(who.id);
  }
  return {
    meetingId,
    lineOf,
    turns: turns.length,
    concurrentAccepted: accepted.length,
    concurrentRefused: refused.length,
  };
}

/**
 * Corrections: the person who said it may correct their own line (even a
 * commenter or viewer), any editor may correct anyone's, a viewer may not
 * correct someone else's.
 */
export async function correctLines(team: Team, meeting: CapturedMeeting): Promise<number> {
  const path = (n: number) =>
    `/api/boards/${team.boardId}/meetings/${meeting.meetingId}/turns/${n}/correction`;
  const walterLine = meeting.lineOf.get("Walter")!;
  const zaneLine = meeting.lineOf.get("Zane")!;
  const by = (name: string): TeamUser => team.user(name);

  const ownLine = await team.post(path(walterLine), by("Walter"), { text: "Walter meant point B" });
  expect(ownLine.status, "the speaker corrects their own line").toBe(200);
  const editor = await team.post(path(walterLine), by("Carol"), { text: "Walter meant point C" });
  expect(editor.status, "an editor corrects someone else's line").toBe(200);
  const viewer = await team.post(path(walterLine), by("Zane"), { text: "Zane rewrites Walter" });
  expect(viewer.status, "a viewer can't correct someone else's line").toBe(403);
  const viewerOwn = await team.post(path(zaneLine), by("Zane"), { text: "Zane meant this" });
  expect(viewerOwn.status, "a viewer corrects their own line").toBe(200);

  const row = await team.get(
    `/api/boards/${team.boardId}/meetings/${meeting.meetingId}`,
    by("Zane"),
  );
  expect(row.status).toBe(200);
  const corrections = row.body.corrections as Array<{ turn: number; by: string; text: string }>;
  expect(corrections.map((c) => [c.turn, c.by])).toEqual([
    [walterLine, by("Walter").id],
    [walterLine, by("Carol").id],
    [zaneLine, by("Zane").id],
  ]);
  // The original words stay on record under the overlay.
  expect(row.body.turns[walterLine].text).toMatch(/^Walter raises point/);
  return corrections.length;
}

/** End the meeting and write its summary (MockProvider); returns the recap. */
export async function endAndSummarize(team: Team, meetingId: string): Promise<any> {
  const keeper = team.user(KEEPER);
  const base = `/api/boards/${team.boardId}/meetings/${meetingId}`;
  const ended = await team.post(`${base}/end`, keeper, {});
  expect(ended.status).toBe(200);
  expect(ended.body.endedAt).toEqual(expect.any(Number));
  // Ended minutes are immutable.
  const late = await team.post(`${base}/turns`, keeper, {
    turns: [{ speaker: "Bob", at: Date.now(), text: "one more thing" }],
  });
  expect(late.status).toBe(404);
  const summary = await team.post(`${base}/summary`, keeper, {});
  expect(summary.status).toBe(200);
  expect(summary.body.recap).toBeTruthy();
  expect(summary.body.recap.by).toBe("model");
  expect(Array.isArray(summary.body.recap.sections)).toBe(true);
  return summary.body.recap;
}
