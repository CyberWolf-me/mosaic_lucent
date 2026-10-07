import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { PostgresFanout } from "../src/store/pg-fanout.js";
import { FANOUT_CHANNEL, type FanoutMessage } from "../src/fanout.js";
import type { Db } from "../src/db/client.js";
import { EventEmitter } from "node:events";

const createdClients: any[] = [];

vi.mock("pg", () => {
  return {
    Client: vi.fn().mockImplementation(function (this: any) {
      const emitter = new EventEmitter();
      this.connect = vi.fn().mockResolvedValue(undefined);
      this.query = vi.fn().mockResolvedValue({ rows: [] });
      this.end = vi.fn().mockResolvedValue(undefined);
      this.on = emitter.on.bind(emitter);
      this.emit = emitter.emit.bind(emitter);
      this.removeAllListeners = emitter.removeAllListeners.bind(emitter);
      createdClients.push(this);
      return this;
    }),
  };
});

describe("PostgresFanout recovery and reconnection", () => {
  let mockPoolQuery: ReturnType<typeof vi.fn>;
  let mockDb: Db;

  beforeEach(() => {
    createdClients.length = 0;
    mockPoolQuery = vi.fn().mockResolvedValue({ rows: [] });
    mockDb = {
      db: {} as any,
      pool: {
        query: mockPoolQuery,
      } as any,
      url: "postgres://localhost:5432/test",
    };
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("publishes via the connection pool, never via the listenClient", async () => {
    const fanout = await PostgresFanout.open(mockDb);

    await fanout.publish({ boardId: "brd_1", kind: "op", seq: 5 });

    // Ensure publish hit target.pool.query, not listenClient.query for pg_notify
    expect(mockPoolQuery).toHaveBeenCalledWith("SELECT pg_notify($1, $2)", [
      FANOUT_CHANNEL,
      expect.stringContaining('"boardId":"brd_1"'),
    ]);

    await fanout.close();
  });

  it("recovers from connection drops and triggers replayResyncs() on reconnect", async () => {
    const fanout = await PostgresFanout.open(mockDb);
    const firstClient = fanout.getListenClient();
    expect(firstClient).toBeDefined();

    const delivered: FanoutMessage[] = [];
    fanout.subscribe("brd_100", (msg) => delivered.push(msg));

    // Simulate database connection error on LISTEN client
    const errorEvent = new Error("Connection reset by peer");
    firstClient!.emit("error", errorEvent);

    // Ensure client cleanup and listenClient is cleared
    expect(fanout.getListenClient()).toBeNull();

    // Trigger immediate reconnect
    await fanout.reconnect();

    // New client connected and re-issued LISTEN
    const reconnectedClient = fanout.getListenClient();
    expect(reconnectedClient).toBeDefined();
    expect(reconnectedClient!.query).toHaveBeenCalledWith(`LISTEN ${FANOUT_CHANNEL}`);

    // replayResyncs() MUST have fired delivering exactly one resync message to brd_100
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toEqual({ boardId: "brd_100", kind: "resync" });

    await fanout.close();
  });
});
