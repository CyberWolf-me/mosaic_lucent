import { describe, expect, it } from "vitest";
import {
  FANOUT_CHANNEL,
  FANOUT_MAX_PAYLOAD_BYTES,
  FanoutPayloadTooLargeError,
  InProcessFanout,
  decodeFanoutMessage,
  encodeFanoutMessage,
  resyncMessage,
} from "../src/fanout.js";
import type { FanoutMessage } from "../src/fanout.js";

/**
 * Fanout unit tests (M3, ADR 0004). These pin the contract the Postgres
 * `LISTEN/NOTIFY` implementation has to satisfy, so they are deliberately about
 * boundaries rather than the happy path: the payload cap on the byte, delivery
 * after an unsubscribe, and what a closed bus does.
 */

const BOARD = "brd_1";
const OTHER = "brd_2";

/** Collect delivered messages, one collector per simulated subscriber. */
function collector(): { got: FanoutMessage[]; listen: (m: FanoutMessage) => void } {
  const got: FanoutMessage[] = [];
  return { got, listen: (m) => got.push(m) };
}

/** A board id whose canonical encoding lands on exactly `bytes`. */
function boardIdForEncodedSize(bytes: number): string {
  const overhead = Buffer.byteLength(encodeFanoutMessage({ boardId: "", kind: "op" }), "utf8");
  return "b".repeat(bytes - overhead);
}

describe("publish and subscribe", () => {
  it("delivers one publish to every subscriber on the board, publisher included", async () => {
    const fanout = new InProcessFanout();
    const a = collector();
    const b = collector();
    fanout.subscribe(BOARD, a.listen);
    fanout.subscribe(BOARD, b.listen);

    await fanout.publish({ boardId: BOARD, kind: "op", seq: 7, userId: "usr_1" });

    // Postgres delivers a NOTIFY to every listening session including the
    // notifier's, so an instance hearing its own message is the contract, not a
    // leak — handlers must be idempotent either way.
    expect(a.got).toEqual([{ boardId: BOARD, kind: "op", seq: 7, userId: "usr_1" }]);
    expect(b.got).toEqual(a.got);
  });

  it("does not deliver a board's messages to another board's subscribers", async () => {
    const fanout = new InProcessFanout();
    const here = collector();
    const there = collector();
    fanout.subscribe(BOARD, here.listen);
    fanout.subscribe(OTHER, there.listen);

    await fanout.publish({ boardId: BOARD, kind: "presence", userId: "usr_1" });

    expect(here.got).toHaveLength(1);
    expect(there.got).toEqual([]);
  });

  it("resolves when nobody is listening", async () => {
    const fanout = new InProcessFanout();
    await expect(fanout.publish({ boardId: BOARD, kind: "op", seq: 1 })).resolves.toBeUndefined();
  });
});

describe("delivery isolation", () => {
  it("hands each listener a copy, so a subscriber cannot mutate the publisher's message", async () => {
    const fanout = new InProcessFanout();
    const seen: FanoutMessage[] = [];
    fanout.subscribe(BOARD, (m) => {
      seen.push(m);
      m.seq = 999;
    });
    const published: FanoutMessage = { boardId: BOARD, kind: "op", seq: 3 };

    await fanout.publish(published);

    expect(published.seq).toBe(3);
    expect(seen[0]).not.toBe(published);
  });

  it("keeps delivering when a listener throws, and reports the error", async () => {
    const errors: unknown[] = [];
    const fanout = new InProcessFanout((error) => errors.push(error));
    const after = collector();
    fanout.subscribe(BOARD, () => {
      throw new Error("subscriber is broken");
    });
    fanout.subscribe(BOARD, after.listen);

    // A listener that throws is another process's problem on a real bus; it must
    // not fail the publisher, which here is the instance committing an op.
    await expect(fanout.publish({ boardId: BOARD, kind: "op", seq: 1 })).resolves.toBeUndefined();
    expect(after.got).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("subscriber is broken");
  });
});

describe("unsubscribe", () => {
  it("stops delivery", async () => {
    const fanout = new InProcessFanout();
    const c = collector();
    const off = fanout.subscribe(BOARD, c.listen);

    await fanout.publish({ boardId: BOARD, kind: "op", seq: 1 });
    off();
    await fanout.publish({ boardId: BOARD, kind: "op", seq: 2 });

    expect(c.got.map((m) => m.seq)).toEqual([1]);
    expect(fanout.subscriberCount(BOARD)).toBe(0);
  });

  it("leaves the board's other subscribers alone", async () => {
    const fanout = new InProcessFanout();
    const leaving = collector();
    const staying = collector();
    const off = fanout.subscribe(BOARD, leaving.listen);
    fanout.subscribe(BOARD, staying.listen);

    off();
    await fanout.publish({ boardId: BOARD, kind: "op", seq: 1 });

    expect(leaving.got).toEqual([]);
    expect(staying.got).toHaveLength(1);
    expect(fanout.subscriberCount(BOARD)).toBe(1);
  });

  it("is idempotent, and a second call does not unsubscribe a resubscriber", async () => {
    const fanout = new InProcessFanout();
    const c = collector();
    const off = fanout.subscribe(BOARD, c.listen);
    off();
    // Same board, same listener, a fresh subscription: the stale unsubscribe must
    // not take it down. A leaving socket and a shutdown both call these.
    fanout.subscribe(BOARD, c.listen);
    off();

    await fanout.publish({ boardId: BOARD, kind: "op", seq: 1 });
    expect(c.got).toHaveLength(1);
  });
});

describe("unsubscribe during delivery", () => {
  it("skips a listener that was unsubscribed by an earlier listener in the same publish", async () => {
    const fanout = new InProcessFanout();
    const second = collector();
    // The unsubscribe handle only exists once the second listener is
    // registered — and the first listener must be registered BEFORE it, or the
    // test would not exercise an unsubscribe *during* delivery. Hence the
    // deferred assignment, which prefer-const would otherwise collapse.

    let offSecond: (() => void) | undefined;
    fanout.subscribe(BOARD, () => offSecond?.());

    await fanout.publish({ boardId: BOARD, kind: "op", seq: 1 });

    expect(second.got).toEqual([]);
  });

  it("does not deliver to a listener that subscribes during the same publish", async () => {
    const fanout = new InProcessFanout();
    const late = collector();
    fanout.subscribe(BOARD, () => fanout.subscribe(BOARD, late.listen));

    await fanout.publish({ boardId: BOARD, kind: "op", seq: 1 });

    // Who receives a message is fixed when it is published; the late subscriber
    // gets the next one.
    expect(late.got).toEqual([]);
    await fanout.publish({ boardId: BOARD, kind: "op", seq: 2 });
    expect(late.got.map((m) => m.seq)).toEqual([2]);
  });
});

describe("payload cap", () => {
  it("is the 8000-byte NOTIFY limit the ADR states", () => {
    // docs/adr/0004-postgres-fanout-over-redis.md, second consequence: "NOTIFY
    // payloads are capped at 8000 bytes". If this number ever changes, it changes
    // because Postgres did, not because a message grew.
    expect(FANOUT_MAX_PAYLOAD_BYTES).toBe(8000);
  });

  it("names a channel Postgres can LISTEN on unquoted", () => {
    expect(FANOUT_CHANNEL).toMatch(/^[a-z_][a-z0-9_]*$/);
    expect(Buffer.byteLength(FANOUT_CHANNEL, "utf8")).toBeLessThanOrEqual(63);
  });

  it("accepts a message encoding to exactly the limit", () => {
    const boardId = boardIdForEncodedSize(FANOUT_MAX_PAYLOAD_BYTES);
    const encoded = encodeFanoutMessage({ boardId, kind: "op" });
    expect(Buffer.byteLength(encoded, "utf8")).toBe(FANOUT_MAX_PAYLOAD_BYTES);
  });

  it("refuses one byte over the limit, and says by how much", () => {
    const boardId = boardIdForEncodedSize(FANOUT_MAX_PAYLOAD_BYTES + 1);
    let caught: unknown;
    try {
      encodeFanoutMessage({ boardId, kind: "op" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FanoutPayloadTooLargeError);
    const error = caught as FanoutPayloadTooLargeError;
    expect(error.bytes).toBe(FANOUT_MAX_PAYLOAD_BYTES + 1);
    expect(error.limit).toBe(FANOUT_MAX_PAYLOAD_BYTES);
    expect(error.name).toBe("FanoutPayloadTooLargeError");
  });
});

describe("payload cap on publish", () => {
  it("rejects an oversized publish even with nobody subscribed", async () => {
    const fanout = new InProcessFanout();
    const boardId = boardIdForEncodedSize(FANOUT_MAX_PAYLOAD_BYTES + 1);
    // The guard has to fire without a subscriber, or it is a guard that passes in
    // unit tests and throws in production.
    await expect(fanout.publish({ boardId, kind: "op" })).rejects.toBeInstanceOf(
      FanoutPayloadTooLargeError,
    );
  });

  it("delivers nothing when the message is refused", async () => {
    const fanout = new InProcessFanout();
    const boardId = boardIdForEncodedSize(FANOUT_MAX_PAYLOAD_BYTES + 1);
    const c = collector();
    fanout.subscribe(boardId, c.listen);

    await expect(fanout.publish({ boardId, kind: "op" })).rejects.toThrow(
      /notification, not a payload/,
    );
    expect(c.got).toEqual([]);
  });

  it("counts bytes, not characters", () => {
    // 4000 two-byte characters is 4000 `.length` and 8000 bytes — a cap measured
    // in characters would wave this through and Postgres would refuse it.
    const boardId = "é".repeat(4000);
    expect(boardId.length).toBeLessThan(FANOUT_MAX_PAYLOAD_BYTES);
    expect(() => encodeFanoutMessage({ boardId, kind: "op" })).toThrow(FanoutPayloadTooLargeError);
  });
});

describe("encoding", () => {
  it("is canonical, whatever order the caller built the object in", () => {
    const a: FanoutMessage = { boardId: BOARD, kind: "op", seq: 4, userId: "usr_1" };
    const b: FanoutMessage = { userId: "usr_1", seq: 4, kind: "op", boardId: BOARD };
    // Same message, same bytes: the size check must not depend on key order.
    expect(encodeFanoutMessage(a)).toBe(encodeFanoutMessage(b));
  });

  it("omits absent optional fields", () => {
    expect(encodeFanoutMessage({ boardId: BOARD, kind: "resync" })).toBe(
      '{"boardId":"brd_1","kind":"resync"}',
    );
  });

  it("round-trips every kind", () => {
    const messages: FanoutMessage[] = [
      { boardId: BOARD, kind: "op", seq: 12, userId: "usr_1" },
      { boardId: BOARD, kind: "presence", userId: "usr_2" },
      { boardId: BOARD, kind: "resync" },
    ];
    for (const message of messages) {
      expect(decodeFanoutMessage(encodeFanoutMessage(message))).toEqual(message);
    }
  });
});

describe("decoding a hostile or unfamiliar payload", () => {
  it("returns null rather than throwing, so one bad payload cannot kill the LISTEN connection", () => {
    const rejected = [
      "not json at all",
      "null",
      "[]",
      '"a string"',
      "{}",
      '{"kind":"op"}',
      '{"boardId":"","kind":"op"}',
      '{"boardId":"brd_1"}',
      '{"boardId":"brd_1","kind":"nonsense"}',
      '{"boardId":"brd_1","kind":"op","seq":"7"}',
      '{"boardId":"brd_1","kind":"op","seq":1.5}',
      '{"boardId":"brd_1","kind":"op","seq":-1}',
      '{"boardId":"brd_1","kind":"presence","userId":42}',
      '{"boardId":42,"kind":"op"}',
    ];
    for (const raw of rejected) expect(decodeFanoutMessage(raw)).toBeNull();
  });

  it("ignores unknown fields, so a newer instance's message still decodes", () => {
    // Rolling deploys mean two versions publish onto one channel. An older
    // instance must read what it understands and drop the rest.
    const decoded = decodeFanoutMessage(
      '{"boardId":"brd_1","kind":"op","seq":3,"snapshotId":"snap_9"}',
    );
    expect(decoded).toEqual({ boardId: "brd_1", kind: "op", seq: 3 });
  });
});

describe("close", () => {
  it("stops delivery to existing subscribers and clears the registry", async () => {
    const fanout = new InProcessFanout();
    const c = collector();
    fanout.subscribe(BOARD, c.listen);

    await fanout.close();
    await fanout.publish({ boardId: BOARD, kind: "op", seq: 1 });

    expect(c.got).toEqual([]);
    expect(fanout.subscriberCount()).toBe(0);
  });

  it("publishes and closes without throwing after it is closed", async () => {
    const fanout = new InProcessFanout();
    await fanout.close();
    // Shutdown races are expected: a socket closing mid-shutdown must not throw,
    // and a dropped notification only costs a replay from the op log.
    await expect(fanout.publish({ boardId: BOARD, kind: "op", seq: 1 })).resolves.toBeUndefined();
    await expect(fanout.close()).resolves.toBeUndefined();
  });

  it("registers nothing after close, and its unsubscribe is a safe no-op", async () => {
    const fanout = new InProcessFanout();
    await fanout.close();
    const c = collector();
    const off = fanout.subscribe(BOARD, c.listen);

    expect(fanout.subscriberCount()).toBe(0);
    expect(() => off()).not.toThrow();
    await fanout.publish({ boardId: BOARD, kind: "op", seq: 1 });
    expect(c.got).toEqual([]);
  });
});

describe("the resync contract", () => {
  it("carries no seq: the receiver's own cursor decides what it missed", () => {
    expect(resyncMessage(BOARD)).toEqual({ boardId: BOARD, kind: "resync" });
  });

  it("tracks the joined boards a reconnect owes a resync, and forgets them on leave", () => {
    const fanout = new InProcessFanout();
    const off = fanout.subscribe(OTHER, collector().listen);
    fanout.subscribe(BOARD, collector().listen);

    expect(fanout.subscribedBoards()).toEqual([BOARD, OTHER]);
    off();
    expect(fanout.subscribedBoards()).toEqual([BOARD]);
  });

  it("delivers exactly one resync per joined board when an implementation reconnects", async () => {
    const fanout = new InProcessFanout();
    const here = collector();
    const there = collector();
    fanout.subscribe(BOARD, here.listen);
    fanout.subscribe(OTHER, there.listen);

    // What a reconnecting Postgres implementation must do: walk the subscription
    // registry, not the room map, and resync every board it was listening to.
    for (const boardId of fanout.subscribedBoards()) {
      await fanout.publish(resyncMessage(boardId));
    }

    expect(here.got).toEqual([{ boardId: BOARD, kind: "resync" }]);
    expect(there.got).toEqual([{ boardId: OTHER, kind: "resync" }]);
  });
});
