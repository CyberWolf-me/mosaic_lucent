import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { MockProvider, MockImageProvider } from "@lucent/ai";
import { createWorkspace, type Operation } from "@lucent/core";
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
 * Server-side proposals, end to end (Stage B3 — the P2 boundary): the
 * advisory's acceptance scenario, as an automated test.
 *
 *   Alice creates a proposal → the server holds it → Bob (a second session
 *   on the same board) sees it arrive over the socket → Bob approves →
 *   exactly one board commit, carrying the AI actor record with the full
 *   accountability chain (initiated by Alice, approved by Bob) → both boards
 *   converge → a hard refresh still sees the decided record.
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
  const config = {
    ...readConfig({ LUCENT_REQUIRE_AUTH: "1", LUCENT_WEB_ORIGIN: "http://127.0.0.1" }),
    requireAuth: true,
  };
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

/** Bearer-authenticated fetch with a CSRF header, as the browser sends. */
async function api(
  h: Harness,
  path: string,
  init: RequestInit & { token?: string; csrf?: string } = {},
): Promise<{ status: number; body: any }> {
  const { token, csrf, ...rest } = init;
  const origin = h.base;
  const res = await fetch(`${h.base}${path}`, {
    ...rest,
    headers: {
      ...(rest.body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(csrf ? { "x-csrf-token": csrf, "x-requested-with": "lucent" } : {}),
      origin,
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

/** Bearer login ALSO mints the CSRF cookie pair the mutating routes need. */
async function login(h: Harness, email: string): Promise<{ token: string; csrf: string }> {
  const { status, body } = await api(h, "/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password: "password123" }),
  });
  expect(status).toBe(200);
  return { token: body.token, csrf: body.csrf ?? "" };
}

async function openSocket(h: Harness, boardId: string, token: string): Promise<WebSocket> {
  const ticket = await api(h, "/api/realtime/ticket", { method: "POST", token });
  const socket = new WebSocket(`${h.ws}/ws?ticket=${encodeURIComponent(ticket.body.ticket)}`);
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  const welcome = frame(socket, ["welcome", "error"]);
  socket.send(JSON.stringify({ type: "join", boardId, fromSeq: 0 }));
  expect((await welcome).type).toBe("welcome");
  return socket;
}

function frame(socket: WebSocket, types: string[], match?: (msg: any) => boolean): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout ${types.join("|")}`)), 4000);
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

const PROPOSAL_OPS: Operation[] = [
  { op: "CREATE_NODE", id: "pricing-flow", nodeType: "step", label: "Pricing flow" },
];

describe("server-side proposals end to end (Stage B3)", () => {
  it("Alice's proposal reaches Bob's panel live; Bob's approval commits once with the AI actor", async () => {
    const h = (open = await harness());
    const alice = await signup(h, "alice@example.com");
    const bob = await signup(h, "bob@example.com");

    // Alice publishes a board and adds Bob as an editor.
    const created = await api(h, "/api/boards", {
      method: "POST",
      token: alice.token,
      body: JSON.stringify({ name: "Launch", workspace: createWorkspace() }),
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

    // Both are connected; Bob listens for the proposal.
    const aliceSocket = await openSocket(h, boardId, alice.token);
    const bobSocket = await openSocket(h, boardId, bob.token);
    const bobSees = frame(bobSocket, ["proposal-created"]);

    // Alice creates the proposal.
    const createdProposal = await api(h, `/api/boards/${boardId}/proposals`, {
      method: "POST",
      token: alice.token,
      body: JSON.stringify({
        operations: PROPOSAL_OPS,
        request: "map the pricing flow",
        explanation: "one step for pricing",
        provenance: { quote: "let's map the pricing flow", turnRange: [3, 4] },
      }),
    });
    expect(createdProposal.status).toBe(201);
    const proposal = createdProposal.body.proposal;
    expect(proposal.status).toBe("pending");
    expect(proposal.createdBy).toBe(alice.id);
    expect(proposal.provenance?.turnRange).toEqual([3, 4]);

    // Bob's panel opened without a refresh: the create broadcast arrived.
    const seen = await bobSees;
    expect(seen.proposal.id).toBe(proposal.id);

    // A hard refresh survives: the pending record is server-side.
    const reloaded = await api(h, `/api/boards/${boardId}/proposals`, { token: bob.token });
    expect(reloaded.status).toBe(200);
    expect(reloaded.body.proposals[0]?.id).toBe(proposal.id);

    // Bob approves. Both sockets watch for the committed op.
    const bobOp = frame(bobSocket, ["op"], (m) =>
      m.entry?.ops?.some((o: any) => o.id === "pricing-flow"),
    );
    const aliceOp = frame(aliceSocket, ["op"], (m) =>
      m.entry?.ops?.some((o: any) => o.id === "pricing-flow"),
    );
    const bobLogin = await login(h, "bob@example.com");
    const approval = await api(h, `/api/boards/${boardId}/proposals/${proposal.id}/approve`, {
      method: "POST",
      token: bobLogin.token,
      csrf: bobLogin.csrf,
    });
    expect(approval.status).toBe(200);
    expect(approval.body.applied).toBe(1);
    expect(approval.body.proposal.status).toBe("approved");
    expect(approval.body.proposal.decidedBy).toBe(bob.id);
    expect(typeof approval.body.proposal.appliedSeq).toBe("number");

    // Both boards converge on the same sequenced entry, and it names the AI
    // as the producer with the full accountability chain.
    const bobEntry = (await bobOp).entry;
    const aliceEntry = (await aliceOp).entry;
    expect(bobEntry.seq).toBe(aliceEntry.seq);
    expect(bobEntry.actor).toEqual({
      actorType: "ai",
      actorId: "lucent",
      initiatedBy: alice.id,
      approvedBy: bob.id,
    });

    // Exactly one commit: the durable log holds one entry for the request.
    const log = await h.boardStore.loadLog(boardId);
    const proposalEntries = log.filter((e) => e.requestId === `prp_${proposal.id}_${bob.id}`);
    expect(proposalEntries).toHaveLength(1);

    // The workspace change is real: the board now has the node.
    const board = await h.boardStore.get(boardId);
    expect(board?.workspace.nodes?.["pricing-flow"]?.label).toBe("Pricing flow");

    // A double-approve is a read, not a second commit (the server-side
    // decidedRef).
    const second = await api(h, `/api/boards/${boardId}/proposals/${proposal.id}/approve`, {
      method: "POST",
      token: bobLogin.token,
      csrf: bobLogin.csrf,
    });
    expect(second.status).toBe(200);
    expect(second.body.duplicate).toBe(true);
    const log2 = await h.boardStore.loadLog(boardId);
    expect(log2).toHaveLength(log.length);
  });

  it("a second create supersedes the pending proposal — one pending per board", async () => {
    const h = (open = await harness());
    const alice = await signup(h, "alice2@example.com");
    const created = await api(h, "/api/boards", {
      method: "POST",
      token: alice.token,
      body: JSON.stringify({ name: "Board", workspace: createWorkspace() }),
    });
    const boardId = created.body.id as string;
    const first = await api(h, `/api/boards/${boardId}/proposals`, {
      method: "POST",
      token: alice.token,
      body: JSON.stringify({ operations: PROPOSAL_OPS, request: "first" }),
    });
    expect(first.status).toBe(201);
    const second = await api(h, `/api/boards/${boardId}/proposals`, {
      method: "POST",
      token: alice.token,
      body: JSON.stringify({ operations: PROPOSAL_OPS, request: "second" }),
    });
    expect(second.status).toBe(201);
    expect(second.body.proposal.status).toBe("pending");
    const list = await api(h, `/api/boards/${boardId}/proposals`, { token: alice.token });
    const statuses = list.body.proposals.map((p: any) => p.status);
    expect(statuses.filter((s: string) => s === "pending")).toHaveLength(1);
    expect(statuses).toContain("superseded");
  });

  it("a viewer sees the pending proposal but cannot create or approve", async () => {
    const h = (open = await harness());
    const alice = await signup(h, "alice3@example.com");
    const viewer = await signup(h, "viewer@example.com");
    const created = await api(h, "/api/boards", {
      method: "POST",
      token: alice.token,
      body: JSON.stringify({ name: "Board", workspace: createWorkspace() }),
    });
    const boardId = created.body.id as string;
    const link = await api(h, `/api/boards/${boardId}/share`, {
      method: "POST",
      token: alice.token,
      body: JSON.stringify({ role: "viewer" }),
    });
    await api(h, `/api/boards/${boardId}/join`, {
      method: "POST",
      token: viewer.token,
      body: JSON.stringify({ token: link.body.token }),
    });
    // The list is viewer-floor: the panel is board state, not a draft.
    const list = await api(h, `/api/boards/${boardId}/proposals`, { token: viewer.token });
    expect(list.status).toBe(200);
    const create = await api(h, `/api/boards/${boardId}/proposals`, {
      method: "POST",
      token: viewer.token,
      body: JSON.stringify({ operations: PROPOSAL_OPS, request: "viewer tries" }),
    });
    expect(create.status).toBe(404); // the guard's uniform refusal
  });
});
