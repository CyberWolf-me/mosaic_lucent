import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { MockProvider, MockImageProvider } from "@lucent/ai";
import { createWorkspace } from "@lucent/core";
import { createApp } from "../src/app.js";
import { InMemoryUserStore } from "../src/accounts.js";
import { InMemoryBoardStore } from "../src/boards.js";
import { InMemorySessionStore } from "../src/sessions.js";
import { UsageTracker, limitsFromEnv } from "../src/usage.js";
import { Telemetry } from "../src/telemetry.js";
import { Limiter } from "../src/limiter.js";
import { InMemoryTicketStore } from "../src/realtimeTicket.js";
import { readConfig } from "../src/config.js";
import { InMemoryMeetingStore } from "../src/meetings.js";
import { InMemoryNotificationStore } from "../src/notifications.js";
import { InMemoryProposalStore } from "../src/proposals.js";

/**
 * ENG-003: the generation commit contract (D-003, ADR 0041).
 *
 * - run.boardId generations validate authoritatively but never auto-commit
 *   (proposeOnly): the caller commits the returned ops itself.
 * - top-level boardId generations commit through the canonical path
 *   (commitBatch -> live room -> broadcast + op log), never a bare
 *   store.put behind the log's back.
 */

const SECRET = "test-secret-at-least-16-chars";
const EMPTY_SUMMARY = { diagramKind: "flowchart", nodes: [], edges: [] };

describe("generate commit contract", () => {
  let close: (() => Promise<void>) | null = null;
  const sockets: WebSocket[] = [];
  afterEach(async () => {
    for (const s of sockets.splice(0)) s.close();
    if (close) await close();
    close = null;
  });

  async function setup() {
    const limits = limitsFromEnv();
    const config = { ...readConfig({ LUCENT_REQUIRE_AUTH: "1" }), requireAuth: true };
    const boardStore = new InMemoryBoardStore();
    const app = createApp({
      config,
      provider: new MockProvider(),
      imageProvider: new MockImageProvider(),
      userStore: new InMemoryUserStore(),
      boardStore,
      sessionStore: new InMemorySessionStore(),
      secret: SECRET,
      usage: new UsageTracker(limits),
      limits,
      telemetry: new Telemetry(),
      authLimiter: new Limiter(10000, 60000),
      tickets: new InMemoryTicketStore(60000),
      meetings: new InMemoryMeetingStore(),
      proposals: new InMemoryProposalStore(),
      notifications: new InMemoryNotificationStore(),
    });
    await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
    close = app.close;
    const { port } = app.server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;
    const api = async (path: string, token?: string, body?: unknown): Promise<{ status: number; body: any }> => {
      const res = await fetch(`${base}${path}`, {
        method: "POST",
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" },
        body: JSON.stringify(body ?? {}),
      });
      return { status: res.status, body: await res.json().catch(() => ({})) };
    };
    const owner = await api("/api/auth/signup", undefined, { email: "gcc@test.test", password: "password123", name: "GCC" });
    const token = owner.body.token as string;
    const created = await api("/api/boards", token, { name: "GCC board", workspace: createWorkspace({ name: "GCC" }) });
    return { base, port, api, token, boardId: created.body.id as string, boardStore };
  }

  async function joinWs(base: string, port: number, api: any, token: string, boardId: string): Promise<{ socket: WebSocket; seen: any[] }> {
    const ticket = (await api("/api/realtime/ticket", token, {})).body.ticket;
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?ticket=${encodeURIComponent(ticket)}`);
    sockets.push(socket);
    const seen: any[] = [];
    socket.on("message", (d) => seen.push(JSON.parse(String(d))));
    await new Promise<void>((res, rej) => {
      socket.once("open", () => res());
      socket.once("error", rej);
    });
    const welcome = new Promise((res) => {
      const check = (d: any) => {
        if (JSON.parse(String(d)).type === "welcome") {
          socket.off("message", check as any);
          res(true);
        }
      };
      socket.on("message", check as any);
    });
    socket.send(JSON.stringify({ type: "join", boardId, fromSeq: 0 }));
    await welcome;
    return { socket, seen };
  }

  it("run.boardId validates authoritatively without auto-committing", async () => {
    const { api, token, boardId, boardStore } = await setup();
    const before = (await boardStore.loadLog(boardId)).length;
    const gen = await api("/api/generate", token, {
      message: "build a checkout flow",
      summary: EMPTY_SUMMARY,
      run: { boardId, surface: "canvas" },
    });
    expect(gen.status).toBe(200);
    expect(gen.body.operations.length).toBeGreaterThan(0);
    // Advisory: no server version (field omitted), no new log entries.
    expect(gen.body.boardVersion ?? 0).toBe(0);
    expect((await boardStore.loadLog(boardId)).length).toBe(before);
  });

  it("run.boardId validates against stored state, not the stale summary", async () => {
    const { api, token, boardId, boardStore } = await setup();
    // Commit the mock's deterministic output once via the top-level path.
    const first = await api("/api/generate", token, {
      message: "build a checkout flow",
      summary: EMPTY_SUMMARY,
      boardId,
    });
    expect(first.status).toBe(200);
    const logAfterFirst = (await boardStore.loadLog(boardId)).length;
    // Same prompt, same deterministic ops — but a STALE empty summary. An
    // advisory pipeline would accept cleanly; the authoritative one sees the
    // already-committed node ids and must say so (warnings) or refuse.
    const second = await api("/api/generate", token, {
      message: "build a checkout flow",
      summary: EMPTY_SUMMARY,
      run: { boardId, surface: "canvas" },
    });
    expect(second.status).toBe(200);
    expect(second.body.boardVersion ?? 0).toBe(0);
    expect((await boardStore.loadLog(boardId)).length).toBe(logAfterFirst);
    const saysDuplicate =
      JSON.stringify(second.body.warnings ?? []).length > 2 || second.body.outcome !== "success";
    expect(saysDuplicate).toBe(true);
  });

  it("top-level boardId commits through the live room (broadcast, op log, AI actor)", async () => {
    const { base, port, api, token, boardId, boardStore } = await setup();
    const { seen } = await joinWs(base, port, api, token, boardId);
    const before = (await boardStore.loadLog(boardId)).length;
    const gen = await api("/api/generate", token, {
      message: "build a checkout flow",
      summary: EMPTY_SUMMARY,
      boardId,
    });
    expect(gen.status).toBe(200);
    expect(gen.body.boardVersion).toBeGreaterThan(0);
    const after = await boardStore.loadLog(boardId);
    expect(after.length).toBe(before + 1);
    expect(after.at(-1)!.actor).toMatchObject({ actorType: "ai" });
    // The live socket saw the commit as a broadcast: proof it traveled the
    // room path (a bare store.put never broadcasts).
    const ops = seen.filter((m) => m.type === "op");
    expect(ops.length).toBeGreaterThan(0);
    expect(ops.at(-1).entry.ops.length).toBe(gen.body.operations.length);
  });
});
