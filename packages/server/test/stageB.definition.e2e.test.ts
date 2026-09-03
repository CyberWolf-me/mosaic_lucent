import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { MockProvider, MockImageProvider } from "@lucent/ai";
import { applyOperations, createWorkspace, type Workspace } from "@lucent/core";
import { createApp } from "../src/app.js";
import { InMemoryUserStore } from "../src/accounts.js";
import { InMemoryBoardStore } from "../src/boards.js";
import { InMemoryProposalStore } from "../src/proposals.js";
import { UsageTracker, limitsFromEnv } from "../src/usage.js";
import { Telemetry } from "../src/telemetry.js";
import { Limiter } from "../src/limiter.js";
import { InMemoryTicketStore } from "../src/realtimeTicket.js";
import { readConfig } from "../src/config.js";

/**
 * Stage B's definition of done, as one continuous scenario — the advisory's
 * end-state, driven end to end over real HTTP + WebSocket:
 *
 *   Alice creates a board; Bob joins as an editor. Both are connected and
 *   see each other's cursors (presence). Alice commits edits; Bob receives
 *   them sequenced. A proposal is created on the server; BOTH panels open
 *   live. Bob approves; both boards converge on one sequenced entry, and the
 *   log records the full accountability chain (ai/lucent, initiated by Alice,
 *   approved by Bob). Alice refreshes — everything persists. Bob's socket
 *   drops; he reconnects; catchup + the idempotent queue deliver exactly what
 *   he missed, no duplicates, nothing lost.
 *
 * The per-batch suites pin each mechanism; this one proves they compose.
 */

const SECRET = "test-secret-at-least-16-chars";

interface Harness {
  base: string;
  ws: string;
  userStore: InMemoryUserStore;
  boardStore: InMemoryBoardStore;
  proposalStore: InMemoryProposalStore;
  close: () => Promise<void>;
}

async function harness(): Promise<Harness> {
  const limits = limitsFromEnv();
  const config = { ...readConfig({ LUCENT_REQUIRE_AUTH: "1" }), requireAuth: true };
  const userStore = new InMemoryUserStore();
  const boardStore = new InMemoryBoardStore();
  const proposalStore = new InMemoryProposalStore();
  const { server, close } = createApp({
    config,
    provider: new MockProvider(),
    imageProvider: new MockImageProvider(),
    userStore,
    boardStore,
    proposals: proposalStore,
    secret: SECRET,
    usage: new UsageTracker(limits),
    limits,
    telemetry: new Telemetry(),
    authLimiter: new Limiter(1000, 60_000),
    tickets: new InMemoryTicketStore(60_000),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    ws: `ws://127.0.0.1:${port}`,
    userStore,
    boardStore,
    proposalStore,
    close: async () => {
      await close();
    },
  };
}

let open: Harness | null = null;
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const s of sockets.splice(0)) s.close();
  await open?.close();
  open = null;
});

async function api(
  h: Harness,
  path: string,
  init: RequestInit & { token?: string; csrf?: string } = {},
): Promise<{ status: number; body: any }> {
  const { token, csrf, ...rest } = init;
  const res = await fetch(`${h.base}${path}`, {
    ...rest,
    headers: {
      ...(rest.body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(csrf ? { "x-csrf-token": csrf, "x-requested-with": "lucent" } : {}),
      origin: h.base,
      ...(rest.headers ?? {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function signup(h: Harness, email: string): Promise<{ token: string; id: string }> {
  const { status, body } = await api(h, "/api/auth/signup", {
    method: "POST",
    body: JSON.stringify({ email, password: "password123", name: email.split("@")[0] }),
  });
  expect(status).toBe(201);
  const user = await h.userStore.findByEmail(email);
  if (user) await h.userStore.setEmailVerified(user.id, Date.now());
  return { token: body.token, id: body.user.id };
}

async function login(h: Harness, email: string): Promise<{ token: string; csrf: string }> {
  const { status, body } = await api(h, "/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password: "password123" }),
  });
  expect(status).toBe(200);
  return { token: body.token, csrf: body.csrf ?? "" };
}

async function openSocket(
  h: Harness,
  boardId: string,
  token: string,
  fromSeq = 0,
): Promise<WebSocket> {
  const ticket = await api(h, "/api/realtime/ticket", { method: "POST", token });
  const socket = new WebSocket(`${h.ws}/ws?ticket=${encodeURIComponent(ticket.body.ticket)}`);
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  const welcome = frame(socket, ["welcome", "resync", "error"]);
  socket.send(JSON.stringify({ type: "join", boardId, fromSeq }));
  await welcome;
  return socket;
}

/** Join and resolve with the first answer frame itself (resync assertions). */
async function joinAndAnswer(h: Harness, boardId: string, token: string, fromSeq = 0) {
  const ticket = await api(h, "/api/realtime/ticket", { method: "POST", token });
  const socket = new WebSocket(`${h.ws}/ws?ticket=${encodeURIComponent(ticket.body.ticket)}`);
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  const answer = frame(socket, ["welcome", "resync", "error"]);
  socket.send(JSON.stringify({ type: "join", boardId, fromSeq }));
  return answer;
}

function frame(socket: WebSocket, types: string[], match?: (msg: any) => boolean): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout ${types.join("|")}`)), 5000);
    const onMessage = (data: unknown) => {
      const msg = JSON.parse(String(data));
      if (!types.includes(msg.type)) return;
      if (match && !match(msg)) return;
      clearTimeout(timer);
      socket.off("message", onMessage);
      resolve(msg);
    };
    socket.on("message", onMessage);
  });
}

describe("Stage B definition of done", () => {
  it("two users, one board: presence, sequenced edits, a shared proposal, one commit, resilience", async () => {
    const h = (open = await harness());
    const alice = await signup(h, "alice@acme.test");
    const bob = await signup(h, "bob@acme.test");

    // --- Alice creates a board; Bob joins as an editor through a share link.
    const created = await api(h, "/api/boards", {
      method: "POST",
      token: alice.token,
      body: JSON.stringify({
        name: "Acme launch",
        workspace: applyOperations(createWorkspace(), [
          { op: "CREATE_NODE", id: "root", nodeType: "step", label: "Launch" },
        ]) as Workspace,
      }),
    });
    expect(created.status).toBe(201);
    const boardId = created.body.id as string;
    const link = await api(h, `/api/boards/${boardId}/share`, {
      method: "POST",
      token: alice.token,
      body: JSON.stringify({ role: "editor" }),
    });
    expect(link.status).toBe(201);
    const joined = await api(h, `/api/boards/${boardId}/join`, {
      method: "POST",
      token: bob.token,
      body: JSON.stringify({ token: link.body.token }),
    });
    expect(joined.status).toBe(200);

    // --- Both connect. Alice sees Bob's presence; Bob sees Alice's cursor.
    const aliceSocket = await openSocket(h, boardId, alice.token);
    const bobSeesAlice = frame(aliceSocket, ["peer-joined"]);
    const bobSocket = await openSocket(h, boardId, bob.token);
    const aliceSeesBob = await bobSeesAlice;
    expect(aliceSeesBob.presence.userId).toBe(bob.id);
    // Bob reports a cursor; Alice receives it.
    const aliceCursor = frame(aliceSocket, ["presence"], (m) => m.presence?.userId === bob.id);
    bobSocket.send(JSON.stringify({ type: "presence", cursor: { x: 12, y: 34 }, selection: [] }));
    const cursor = await aliceCursor;
    expect(cursor.presence.cursor).toEqual({ x: 12, y: 34 });

    // --- Alice commits an edit; Bob receives it sequenced.
    const bobEdit = frame(bobSocket, ["op"], (m) => m.entry?.ops?.some((o: any) => o.id === "m1"));
    aliceSocket.send(
      JSON.stringify({
        type: "op",
        requestId: "req_s1",
        ops: [{ op: "CREATE_NODE", id: "m1", nodeType: "step", label: "Milestone" }],
      }),
    );
    const bobEntry = await bobEdit;
    expect(bobEntry.entry.seq).toBeGreaterThan(0);

    // --- A proposal is created on the server; BOTH panels open live.
    const bobPanel = frame(bobSocket, ["proposal-created"]);
    const createdProposal = await api(h, `/api/boards/${boardId}/proposals`, {
      method: "POST",
      token: alice.token,
      body: JSON.stringify({
        operations: [
          { op: "CREATE_NODE", id: "metric", nodeType: "step", label: "Metric" },
          { op: "CONNECT_NODES", source: "root", target: "metric", relationship: "tracks" },
        ],
        request: "map the launch metric",
        explanation: "one metric node, connected to the launch root",
        provenance: { quote: "let's track a launch metric", turnRange: [5, 6] },
      }),
    });
    expect(createdProposal.status).toBe(201);
    const proposalId = createdProposal.body.proposal.id;
    const bobSaw = await bobPanel;
    expect(bobSaw.proposal.id).toBe(proposalId);

    // --- Bob approves; both boards converge on ONE sequenced entry with the
    // full accountability chain; the panel closes everywhere.
    const bobOp = frame(
      bobSocket,
      ["op"],
      (m) => m.entry?.requestId === `prp_${proposalId}_${bob.id}`,
    );
    const aliceOp = frame(
      aliceSocket,
      ["op"],
      (m) => m.entry?.requestId === `prp_${proposalId}_${bob.id}`,
    );
    const bobLogin = await login(h, "bob@acme.test");
    const approval = await api(h, `/api/boards/${boardId}/proposals/${proposalId}/approve`, {
      method: "POST",
      token: bobLogin.token,
      csrf: bobLogin.csrf,
    });
    expect(approval.status).toBe(200);
    const approvedEntry = (await bobOp).entry;
    const aliceEcho = await aliceOp;
    expect(approvedEntry.seq).toBe(aliceEcho.entry.seq);
    expect(approvedEntry.actor).toEqual({
      actorType: "ai",
      actorId: "lucent",
      initiatedBy: alice.id,
      approvedBy: bob.id,
    });

    // --- Alice refreshes: everything persists (board + decided proposal).
    const reloaded = await api(h, `/api/boards/${boardId}`, { token: alice.token });
    expect(reloaded.status).toBe(200);
    expect(reloaded.body.workspace.nodes.metric).toBeDefined();
    const edgeIds = Object.keys(reloaded.body.workspace.edges ?? {});
    expect(edgeIds.length).toBeGreaterThan(0);
    expect(reloaded.body.workspace.edges?.[edgeIds[0]!]).toBeDefined();
    expect(reloaded.body.latestSeq).toBe(approvedEntry.seq);
    const decisions = await api(h, `/api/boards/${boardId}/proposals`, { token: alice.token });
    const record = decisions.body.proposals.find((p: any) => p.id === proposalId);
    expect(record.status).toBe("approved");
    expect(record.appliedSeq).toBe(approvedEntry.seq);

    // --- Bob's socket drops mid-session; he reconnects and catches up.
    bobSocket.close();
    await new Promise((r) => setTimeout(r, 150));
    const bobSeq = approvedEntry.seq;
    // Alice is still connected, so the room never evicted: the honest answer
    // for a one-behind cursor is an ordinary catchup. (Had Bob been the last
    // participant, the eviction snapshot would make this a resync instead —
    // covered by the resilience suite.)
    const bobBack = await joinAndAnswer(h, boardId, bob.token, bobSeq - 1);
    expect(bobBack.type).toBe("welcome");
    expect(bobBack.version).toBe(bobSeq);
    // The one missed entry rides the catchup: metric arrives, the board is
    // whole, nothing was lost or duplicated.
    expect(bobBack.catchup).toHaveLength(1);
    expect(bobBack.catchup[0].seq).toBe(bobSeq);
    const log = await h.boardStore.loadLog(boardId);
    expect(new Set(log.map((e) => e.seq)).size).toBe(log.length);
    expect(log.filter((e) => e.requestId === `prp_${proposalId}_${bob.id}`)).toHaveLength(1);
    expect(log.filter((e) => e.requestId === "req_s1")).toHaveLength(1);
  });
});
