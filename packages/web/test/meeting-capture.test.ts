import { describe, it, expect } from "vitest";
import { createCaptureDurability, type CaptureStore } from "../src/meetingCapture.js";
import type { MeetingTranscript, MeetingTurn } from "../src/meetings.js";

/**
 * docs/28 F13: a live capture's turns reach the server as they land, not at
 * Stop. The view used to open the transcript with `turns: []`, which the
 * server refuses, so no live transcript ever existed and a reload lost the
 * whole meeting. The fake below keeps the server's rules: an open needs at
 * least one turn (`server/src/meetings.ts validateTurns`), an ended
 * transcript refuses appends, and end is idempotent.
 */
function fakeServer() {
  const rows = new Map<string, MeetingTranscript>();
  const calls: string[] = [];
  let seq = 0;
  let failing = 0;
  let throwing = 0;
  let gate: Promise<void> | null = null;
  const trip = async (): Promise<"fail" | "throw" | null> => {
    if (gate) await gate;
    if (throwing > 0) {
      throwing--;
      return "throw";
    }
    if (failing > 0) {
      failing--;
      return "fail";
    }
    return null;
  };
  const copy = (row: MeetingTranscript): MeetingTranscript => ({ ...row, turns: [...row.turns] });
  const store: CaptureStore = {
    async open(boardId, input) {
      calls.push(`open ${boardId} ${input.turns.length}`);
      const t = await trip();
      if (t === "throw") throw new Error("network down");
      if (t === "fail" || input.turns.length === 0) return null;
      const row: MeetingTranscript = {
        id: `mtg_${++seq}`,
        boardId,
        orgId: "org_1",
        startedAt: input.startedAt,
        endedAt: null,
        turns: [...input.turns],
        createdBy: "u_1",
        createdAt: input.startedAt,
        ...(input.mode ? { mode: input.mode } : {}),
      };
      rows.set(row.id, row);
      return copy(row);
    },
    async append(boardId, meetingId, turns) {
      calls.push(`append ${meetingId} ${turns.length}`);
      const t = await trip();
      if (t === "throw") throw new Error("network down");
      const row = rows.get(meetingId);
      if (t === "fail" || !row || row.boardId !== boardId || row.endedAt !== null) return null;
      row.turns.push(...turns);
      return copy(row);
    },
    async end(boardId, meetingId) {
      calls.push(`end ${meetingId}`);
      const t = await trip();
      if (t === "throw") throw new Error("network down");
      const row = rows.get(meetingId);
      if (t === "fail" || !row || row.boardId !== boardId) return null;
      row.endedAt ??= 99_000;
      return copy(row);
    },
  };
  return {
    store,
    rows,
    calls,
    failNext(n = 1) {
      failing = n;
    },
    throwNext(n = 1) {
      throwing = n;
    },
    /** Hold every request until the returned release is called. */
    hold(): () => void {
      let release = (): void => {};
      gate = new Promise<void>((resolve) => {
        release = () => {
          gate = null;
          resolve();
        };
      });
      return release;
    },
  };
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const turn = (text: string, at = 1_000): MeetingTurn => ({ speaker: "You", at, text });

/** The view's live list: a new array per final, as `appendTurn` builds it. */
function liveList() {
  let turns: MeetingTurn[] = [];
  return {
    say(text: string): MeetingTurn[] {
      turns = [...turns, turn(text, 1_000 + turns.length)];
      return turns;
    },
    get turns() {
      return turns;
    },
  };
}

describe("capture durability (F13)", () => {
  it("opens the transcript with the first turn — never empty — and appends the rest as they land", async () => {
    const server = fakeServer();
    const capture = createCaptureDurability({
      startedAt: 500,
      mode: "assistant",
      board: () => "b1",
      store: server.store,
    });
    const live = liveList();

    await capture.persist(live.say("We ship on Friday."));
    await capture.persist(live.say("Alice owns the rollout."));
    await capture.persist(live.say("Is the migration reversible?"));

    expect(server.calls).toEqual(["open b1 1", "append mtg_1 1", "append mtg_1 1"]);
    const row = server.rows.get("mtg_1");
    expect(row?.endedAt).toBeNull();
    expect(row?.startedAt).toBe(500);
    expect(row?.mode).toBe("assistant");
    expect(row?.turns.map((t) => t.text)).toEqual([
      "We ship on Friday.",
      "Alice owns the rollout.",
      "Is the migration reversible?",
    ]);
    expect(capture.meetingId).toBe("mtg_1");
    expect(capture.persisted).toBe(3);
  });

  it("sends nothing while nobody has spoken, so a silent capture leaves no empty record", async () => {
    const server = fakeServer();
    const capture = createCaptureDurability({
      startedAt: 0,
      board: () => "b1",
      store: server.store,
    });
    await capture.persist([]);
    expect(await capture.finish([])).toBeNull();
    expect(server.calls).toEqual([]);
    expect(server.rows.size).toBe(0);
  });

  it("serializes bursts: finals landing while the open is in flight never open a second transcript or re-send a span", async () => {
    const server = fakeServer();
    const capture = createCaptureDurability({
      startedAt: 0,
      board: () => "b1",
      store: server.store,
    });
    const live = liveList();

    // The first final's open is in flight when two more land.
    const release = server.hold();
    const a = capture.persist(live.say("one"));
    await tick();
    const b = capture.persist(live.say("two"));
    const c = capture.persist(live.say("three"));
    release();
    await Promise.all([a, b, c]);

    expect(server.calls).toEqual(["open b1 1", "append mtg_1 2"]);
    expect(server.rows.size).toBe(1);
    expect(server.rows.get("mtg_1")?.turns.map((t) => t.text)).toEqual(["one", "two", "three"]);
  });

  it("keeps the gap after a refused or failed request and closes it on the next final", async () => {
    const server = fakeServer();
    const capture = createCaptureDurability({
      startedAt: 0,
      board: () => "b1",
      store: server.store,
    });
    const live = liveList();

    server.failNext();
    await capture.persist(live.say("one"));
    expect(capture.meetingId).toBeNull();
    expect(capture.persisted).toBe(0);

    await capture.persist(live.say("two"));
    expect(capture.meetingId).toBe("mtg_1");

    server.throwNext();
    await expect(capture.persist(live.say("three"))).resolves.toBeUndefined();
    expect(capture.persisted).toBe(2);

    await capture.persist(live.say("four"));
    expect(server.rows.get("mtg_1")?.turns.map((t) => t.text)).toEqual([
      "one",
      "two",
      "three",
      "four",
    ]);
    expect(capture.persisted).toBe(4);
  });

  it("reports the open once, with the stored record", async () => {
    const server = fakeServer();
    const opened: string[] = [];
    const capture = createCaptureDurability({
      startedAt: 0,
      board: () => "b1",
      store: server.store,
      onOpened: (stored) => opened.push(stored.id),
    });
    const live = liveList();
    await capture.persist(live.say("one"));
    await capture.persist(live.say("two"));
    expect(opened).toEqual(["mtg_1"]);
  });

  it("waits for a board, then keeps the one it got (share mid-capture; switching boards never moves the meeting)", async () => {
    const server = fakeServer();
    let board: string | null = null;
    const capture = createCaptureDurability({
      startedAt: 0,
      board: () => board,
      store: server.store,
    });
    const live = liveList();

    await capture.persist(live.say("said on a local board"));
    expect(server.calls).toEqual([]);

    board = "shared";
    await capture.persist(live.say("after sharing"));
    expect(server.calls).toEqual(["open shared 2"]);

    board = "another";
    await capture.persist(live.say("after switching boards"));
    expect(capture.boardId).toBe("shared");
    expect(server.calls.at(-1)).toBe("append mtg_1 1");
  });
});

describe("finishing a capture", () => {
  it("flushes the unsaved tail before ending, so the last words make it into the minutes", async () => {
    const server = fakeServer();
    const capture = createCaptureDurability({
      startedAt: 0,
      board: () => "b1",
      store: server.store,
    });
    const live = liveList();
    await capture.persist(live.say("one"));
    live.say("two"); // captured, not yet persisted when Stop is pressed

    const ended = await capture.finish(live.turns);
    expect(server.calls).toEqual(["open b1 1", "append mtg_1 1", "end mtg_1"]);
    expect(ended?.endedAt).not.toBeNull();
    expect(ended?.turns.map((t) => t.text)).toEqual(["one", "two"]);
  });

  it("opens and ends in one go when nothing reached the server during the meeting", async () => {
    const server = fakeServer();
    const capture = createCaptureDurability({
      startedAt: 0,
      board: () => "b1",
      store: server.store,
    });
    const live = liveList();
    live.say("one");
    live.say("two");

    const ended = await capture.finish(live.turns);
    expect(server.calls).toEqual(["open b1 2", "end mtg_1"]);
    expect(ended?.turns).toHaveLength(2);
  });

  it("leaves the transcript open when the flush falls short, and a retry finishes the same transcript", async () => {
    const server = fakeServer();
    const capture = createCaptureDurability({
      startedAt: 0,
      board: () => "b1",
      store: server.store,
    });
    const live = liveList();
    await capture.persist(live.say("one"));
    live.say("two");

    server.throwNext();
    expect(await capture.finish(live.turns)).toBeNull();
    expect(server.rows.get("mtg_1")?.endedAt).toBeNull();

    const ended = await capture.finish(live.turns);
    expect(ended?.id).toBe("mtg_1");
    expect(ended?.turns.map((t) => t.text)).toEqual(["one", "two"]);
    expect(server.rows.size).toBe(1);
  });

  it("resolves null (never rejects) when the end itself fails", async () => {
    const server = fakeServer();
    const capture = createCaptureDurability({
      startedAt: 0,
      board: () => "b1",
      store: server.store,
    });
    const live = liveList();
    await capture.persist(live.say("one"));
    server.throwNext();
    await expect(capture.finish(live.turns)).resolves.toBeNull();
  });

  it("does nothing on a local board", async () => {
    const server = fakeServer();
    const capture = createCaptureDurability({
      startedAt: 0,
      board: () => null,
      store: server.store,
    });
    const live = liveList();
    live.say("one");
    expect(await capture.finish(live.turns)).toBeNull();
    expect(server.calls).toEqual([]);
  });
});
