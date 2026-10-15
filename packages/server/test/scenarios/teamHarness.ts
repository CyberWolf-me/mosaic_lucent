import { performance } from "node:perf_hooks";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { expect } from "vitest";
import { MockImageProvider, MockProvider } from "@lucent/ai";
import { applyOperations, createWorkspace, type Operation, type Workspace } from "@lucent/core";
import { createApp, type App } from "../../src/app.js";
import { InMemoryUserStore } from "../../src/accounts.js";
import {
  InMemoryBoardStore,
  type AppendResult,
  type OpAppend,
  type StoredBoard,
} from "../../src/boards.js";
import { InMemorySessionStore } from "../../src/sessions.js";
import { UsageTracker, limitsFromEnv } from "../../src/usage.js";
import { Telemetry } from "../../src/telemetry.js";
import { Limiter } from "../../src/limiter.js";
import { InMemoryTicketStore } from "../../src/realtimeTicket.js";
import { readConfig } from "../../src/config.js";
import { InMemoryCallControl } from "../../src/calls.js";
import { InMemoryMeetingStore } from "../../src/meetings.js";
import { InMemoryProposalStore } from "../../src/proposals.js";
import { InMemoryNotificationStore } from "../../src/notifications.js";

/**
 * The multi-user scenario harness: one in-process app (in-memory stores,
 * MockProvider, InMemoryCallControl standing in for LiveKit), a team of 24
 * real accounts on one board, and a recording WebSocket client per person.
 *
 * Every client records every frame it receives, so a scenario can drive the
 * team through HTTP + WS concurrently and then ask `assertConverged` whether
 * everyone ended up looking at the same board the server stores.
 */

export type TeamRole = "owner" | "editor" | "commenter" | "viewer";

/** Single-token names so @mentions resolve against display names. */
export const ROSTER = {
  owner: "Alice",
  editors: [
    "Bob",
    "Carol",
    "Dave",
    "Erin",
    "Frank",
    "Grace",
    "Heidi",
    "Ivan",
    "Judy",
    "Mallory",
    "Niaj",
    "Olivia",
    "Peggy",
    "Rupert",
    "Sybil",
    "Trent",
    "Victor",
  ],
  commenters: ["Walter", "Xena", "Yara"],
  viewers: ["Zane", "Quinn", "Uma"],
} as const;

/** Half the team is in the meeting (Bob keeps it), the other half on the canvas. */
export const MEETING_HALF = [
  "Bob",
  "Carol",
  "Dave",
  "Erin",
  "Frank",
  "Grace",
  "Heidi",
  "Ivan",
  "Judy",
  "Walter",
  "Xena",
  "Zane",
] as const;
export const CANVAS_HALF = [
  "Alice",
  "Mallory",
  "Niaj",
  "Olivia",
  "Peggy",
  "Rupert",
  "Sybil",
  "Trent",
  "Victor",
  "Yara",
  "Quinn",
  "Uma",
] as const;

/** The node every team board starts with (part of the base workspace, not the log). */
export const SEED_NODE = "seed";

export const LIVEKIT_ENV = {
  LUCENT_LIVEKIT_API_KEY: "scenario-lk-key",
  LUCENT_LIVEKIT_API_SECRET: "scenario-lk-secret-with-enough-entropy",
  LUCENT_LIVEKIT_URL: "wss://lucent.test.livekit.cloud",
};

export interface TeamUser {
  name: string;
  email: string;
  id: string;
  token: string;
  role: TeamRole;
}

export interface OpEntry {
  seq: number;
  ops: Operation[];
  by: string;
  label: string;
  at: number;
  operationId?: string;
  requestId?: string;
  actor?: { actorType: string; actorId: string; initiatedBy?: string; approvedBy?: string };
}

// The wire is JSON; frames are inspected structurally by the scenarios.
export type Frame = { type: string } & Record<string, any>;

/**
 * A board store whose writes a scenario can hold open — a stand-in for a
 * slow database round trip, used only by the deterministic race tests.
 */
export class InstrumentedBoardStore extends InMemoryBoardStore {
  /** Awaited before every `put` when set. */
  putGate: ((board: StoredBoard) => Promise<void> | void) | null = null;
  /** Observes every `get`. */
  onGet: ((id: string) => void) | null = null;
  /** Awaited before every op-log append when set. */
  appendGate: ((entry: OpAppend) => Promise<void> | void) | null = null;

  override async appendOp(entry: OpAppend): Promise<AppendResult> {
    if (this.appendGate) await this.appendGate(entry);
    return super.appendOp(entry);
  }

  override async put(board: StoredBoard): Promise<void> {
    if (this.putGate) await this.putGate(board);
    return super.put(board);
  }

  override async get(id: string): Promise<StoredBoard | undefined> {
    this.onGet?.(id);
    return super.get(id);
  }
}

/** Poll until `check` holds (in-process, so a few ms is plenty). */
export async function waitUntil(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("waitUntil timed out");
    await new Promise((r) => setTimeout(r, 2));
  }
}

/** A gate a test opens by hand. */
export function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => (open = resolve));
  return { wait, open };
}

export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

const normalize = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

let requestCounter = 0;

/** One person's realtime connection, recording everything it hears. */
export class TeamClient {
  socket: WebSocket | null = null;
  /** Every frame on the current socket, in arrival order. */
  frames: Frame[] = [];
  /** Every frame across every socket this client opened. */
  allFrames: Frame[] = [];
  welcome: Frame | null = null;
  resync: Frame | null = null;
  /** The state this client's entries replay onto, and the seq it stands for. */
  base: Workspace;
  baseSeq = 0;
  /** Deduplicated by seq: the log as this client knows it. */
  readonly entries = new Map<number, OpEntry>();
  /** Seq of every live `op` frame, in arrival order (across sockets). */
  readonly liveSeqs: number[] = [];
  /** Seq of every catchup entry, in arrival order (across sockets). */
  readonly catchupSeqs: number[] = [];
  readonly acks = new Map<string, Frame>();
  readonly rejections: Frame[] = [];
  readonly ackLatencyMs: number[] = [];
  /** userId → presence, as the welcome and peer frames describe it. */
  readonly peers = new Map<string, Frame>();
  /** Every user id ever announced as a peer on this client. */
  readonly peersEverSeen = new Set<string>();
  private readonly sentAt = new Map<string, number>();
  private waiters: Array<{ pred: (f: Frame) => boolean; resolve: (f: Frame) => void }> = [];

  constructor(
    readonly team: Team,
    readonly user: TeamUser,
  ) {
    this.base = team.baseWorkspace;
  }

  get name(): string {
    return this.user.name;
  }

  get open(): boolean {
    return this.socket !== null && this.socket.readyState === WebSocket.OPEN;
  }

  /** Highest seq this client holds with every seq below it present. */
  head(): number {
    let seq = this.baseSeq;
    while (this.entries.has(seq + 1)) seq += 1;
    return seq;
  }

  /** The highest seq heard at all, gaps or not. */
  maxSeq(): number {
    let max = this.baseSeq;
    for (const seq of this.entries.keys()) max = Math.max(max, seq);
    return max;
  }

  /** Replay base + entries in seq order (what a seq-buffering client shows). */
  state(upToSeq = this.head()): Workspace {
    let ws = this.base;
    for (let seq = this.baseSeq + 1; seq <= upToSeq; seq += 1) {
      const entry = this.entries.get(seq);
      if (!entry) throw new Error(`${this.name} has a hole at seq ${seq}`);
      ws = applyOperations(ws, entry.ops);
    }
    return ws;
  }

  /**
   * What the shipped web client (boardSync.ts) would show: it applies `op`
   * frames in ARRIVAL order and drops any whose seq is not above the last
   * one it applied — so an out-of-order delivery silently loses an entry.
   */
  webClientState(): { workspace: Workspace; dropped: number[] } {
    // Every client's first join is from seq 0 onto the board's base state.
    let ws = this.team.baseWorkspace;
    let version = 0;
    const dropped: number[] = [];
    for (const f of this.allFrames) {
      if (f.type === "welcome") {
        for (const e of (f.catchup ?? []) as OpEntry[]) {
          ws = applyOperations(ws, e.ops);
          version = e.seq;
        }
      } else if (f.type === "resync") {
        ws = f.workspace as Workspace;
        version = Number(f.version ?? 0);
      } else if (f.type === "op") {
        const e = f.entry as OpEntry;
        if (e.seq <= version) {
          if (!this.isDuplicateDelivery(e.seq)) dropped.push(e.seq);
          continue;
        }
        ws = applyOperations(ws, e.ops);
        version = e.seq;
      }
    }
    return { workspace: ws, dropped };
  }

  private deliveries = new Map<number, number>();
  private isDuplicateDelivery(seq: number): boolean {
    return (this.deliveries.get(seq) ?? 0) > 1;
  }

  /** Open a socket and join the team board from `fromSeq`. */
  async connect(fromSeq = 0): Promise<Frame> {
    const ticket = await this.team.api("/api/realtime/ticket", {
      method: "POST",
      token: this.user.token,
    });
    expect(ticket.status).toBe(200);
    const socket = new WebSocket(
      `${this.team.wsBase}/ws?ticket=${encodeURIComponent(ticket.body.ticket as string)}`,
    );
    this.socket = socket;
    this.frames = [];
    socket.on("message", (data) => {
      let frame: Frame;
      try {
        frame = JSON.parse(String(data)) as Frame;
      } catch {
        return;
      }
      this.onFrame(frame);
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    const answered = this.waitFor((f) => ["welcome", "resync", "error"].includes(f.type));
    socket.send(JSON.stringify({ type: "join", boardId: this.team.boardId, fromSeq }));
    return answered;
  }

  /** Close the socket and wait until it is gone. */
  async disconnect(): Promise<void> {
    const socket = this.socket;
    if (!socket || socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      socket.once("close", () => resolve());
      socket.close();
    });
  }

  /** Reconnect from the last seq this client holds contiguously. */
  async reconnect(): Promise<Frame> {
    await this.disconnect();
    return this.connect(this.head());
  }

  private onFrame(frame: Frame): void {
    this.frames.push(frame);
    this.allFrames.push(frame);
    switch (frame.type) {
      case "welcome": {
        this.welcome = frame;
        for (const e of (frame.catchup ?? []) as OpEntry[]) {
          this.catchupSeqs.push(e.seq);
          this.deliveries.set(e.seq, (this.deliveries.get(e.seq) ?? 0) + 1);
          if (!this.entries.has(e.seq)) this.entries.set(e.seq, e);
        }
        this.peers.clear();
        for (const p of (frame.peers ?? []) as Frame[]) {
          this.peers.set(p.userId as string, p);
          this.peersEverSeen.add(p.userId as string);
        }
        break;
      }
      case "resync": {
        this.resync = frame;
        this.base = frame.workspace as Workspace;
        this.baseSeq = Number(frame.version ?? 0);
        this.entries.clear();
        this.peers.clear();
        for (const p of (frame.peers ?? []) as Frame[]) this.peers.set(p.userId as string, p);
        break;
      }
      case "op": {
        const e = frame.entry as OpEntry;
        this.liveSeqs.push(e.seq);
        this.deliveries.set(e.seq, (this.deliveries.get(e.seq) ?? 0) + 1);
        if (!this.entries.has(e.seq)) this.entries.set(e.seq, e);
        break;
      }
      case "op-ack": {
        if (typeof frame.requestId === "string") {
          this.acks.set(frame.requestId, frame);
          const at = this.sentAt.get(frame.requestId);
          if (at !== undefined && frame.duplicate !== true) {
            this.ackLatencyMs.push(performance.now() - at);
          }
        }
        break;
      }
      case "op-rejected":
        this.rejections.push(frame);
        break;
      case "peer-joined":
        this.peers.set(frame.presence.userId as string, frame.presence as Frame);
        this.peersEverSeen.add(frame.presence.userId as string);
        break;
      case "presence":
        this.peers.set(frame.presence.userId as string, frame.presence as Frame);
        break;
      case "peer-left":
        this.peers.delete(frame.userId as string);
        break;
    }
    if (this.waiters.length > 0) {
      const remaining: typeof this.waiters = [];
      for (const w of this.waiters) {
        if (w.pred(frame)) w.resolve(frame);
        else remaining.push(w);
      }
      this.waiters = remaining;
    }
  }

  /**
   * The next frame matching `pred`. With `since` (an index into `frames`),
   * a frame already received at or after that index counts too.
   */
  waitFor(pred: (f: Frame) => boolean, timeoutMs = 8000, since?: number): Promise<Frame> {
    if (since !== undefined) {
      const hit = this.frames.slice(since).find(pred);
      if (hit) return Promise.resolve(hit);
    }
    return new Promise<Frame>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.resolve !== done);
        reject(new Error(`${this.name}: timed out waiting for a frame`));
      }, timeoutMs);
      const done = (f: Frame) => {
        clearTimeout(timer);
        resolve(f);
      };
      this.waiters.push({ pred, resolve: done });
    });
  }

  /** The current frame index, for `waitFor(..., since)`. */
  mark(): number {
    return this.frames.length;
  }

  /** Resolve once `check` holds — now, or after some later frame. */
  async until(check: () => boolean, timeoutMs = 8000): Promise<void> {
    if (check()) return;
    await this.waitFor(() => check(), timeoutMs);
  }

  /** Resolve once this client holds every seq up to `seq`. */
  async untilSeq(seq: number, timeoutMs = 8000): Promise<void> {
    return this.until(() => this.head() >= seq, timeoutMs);
  }

  /** A fresh, unique request id (≤ 64 chars, as the server requires). */
  nextRequestId(): string {
    requestCounter += 1;
    return `${this.name.toLowerCase()}-${requestCounter}`;
  }

  /**
   * Send a batch without waiting. The returned promise settles on the ack
   * or rejection for this request. A refusal that does not name its request
   * (see the scenarios' regression notes) is matched by `fallback`, when given.
   */
  submit(
    ops: unknown[],
    options: {
      label?: string;
      requestId?: string;
      runId?: string;
      fallback?: (f: Frame) => boolean;
      timeoutMs?: number;
    } = {},
  ): { requestId: string; result: Promise<Frame> } {
    const socket = this.socket;
    if (!socket) throw new Error(`${this.name} is not connected`);
    const requestId = options.requestId ?? this.nextRequestId();
    const result = this.waitFor(
      (f) =>
        ((f.type === "op-ack" || f.type === "op-rejected") && f.requestId === requestId) ||
        (options.fallback !== undefined && options.fallback(f)),
      options.timeoutMs ?? 8000,
    );
    if (!this.sentAt.has(requestId)) this.sentAt.set(requestId, performance.now());
    socket.send(
      JSON.stringify({
        type: "op",
        ops,
        label: options.label ?? "scenario",
        requestId,
        ...(options.runId !== undefined ? { runId: options.runId } : {}),
      }),
    );
    return { requestId, result };
  }

  /** Send a batch and wait for its ack or rejection. */
  send(ops: unknown[], options: Parameters<TeamClient["submit"]>[1] = {}): Promise<Frame> {
    return this.submit(ops, options).result;
  }

  /** Send raw JSON (presence, spotlight, summon). */
  raw(msg: Record<string, unknown>): void {
    this.socket?.send(JSON.stringify(msg));
  }
}

export interface ApiResult {
  status: number;
  body: any;
}

export interface Team {
  app: App;
  base: string;
  wsBase: string;
  boardId: string;
  orgId: string;
  store: InstrumentedBoardStore;
  userStore: InMemoryUserStore;
  calls: InMemoryCallControl;
  meetings: InMemoryMeetingStore;
  proposals: InMemoryProposalStore;
  notifications: InMemoryNotificationStore;
  baseWorkspace: Workspace;
  users: TeamUser[];
  owner: TeamUser;
  editors: TeamUser[];
  commenters: TeamUser[];
  viewers: TeamUser[];
  clients: Map<string, TeamClient>;
  user(name: string): TeamUser;
  client(name: string): TeamClient;
  api(path: string, init?: RequestInit & { token?: string }): Promise<ApiResult>;
  post(path: string, who: TeamUser | string, body?: unknown): Promise<ApiResult>;
  get(path: string, who: TeamUser | string): Promise<ApiResult>;
  connectAll(names?: readonly string[]): Promise<Frame[]>;
  close(): Promise<void>;
}

/**
 * Spin up the app and the 24-person team on one board: sign everyone up,
 * the owner creates a board holding one seed node, mints one share link
 * per role, and everyone redeems theirs. `orgMembers` names users who are
 * also made members of the board's workspace (teammates, not guests).
 */
export async function createTeam(options: { orgMembers?: readonly string[] } = {}): Promise<Team> {
  const limits = limitsFromEnv({});
  const config = {
    ...readConfig({
      LUCENT_REQUIRE_AUTH: "1",
      LUCENT_WEB_ORIGIN: "http://127.0.0.1",
      ...LIVEKIT_ENV,
    }),
    requireAuth: true,
  };
  const userStore = new InMemoryUserStore();
  const store = new InstrumentedBoardStore();
  const calls = new InMemoryCallControl();
  const meetings = new InMemoryMeetingStore();
  const proposals = new InMemoryProposalStore();
  const notifications = new InMemoryNotificationStore();
  const app = createApp({
    config,
    provider: new MockProvider(),
    imageProvider: new MockImageProvider(),
    userStore,
    boardStore: store,
    sessionStore: new InMemorySessionStore(),
    secret: "scenario-secret-at-least-16-chars",
    usage: new UsageTracker(limits),
    limits,
    telemetry: new Telemetry(),
    authLimiter: new Limiter(10_000, 60_000),
    tickets: new InMemoryTicketStore(60_000),
    callControl: calls,
    meetings,
    proposals,
    notifications,
  });
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const { port } = app.server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  const api = async (
    path: string,
    init: RequestInit & { token?: string } = {},
  ): Promise<ApiResult> => {
    const { token, ...rest } = init;
    const res = await fetch(`${base}${path}`, {
      ...rest,
      headers: {
        ...(rest.body !== undefined ? { "content-type": "application/json" } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...((rest.headers as Record<string, string> | undefined) ?? {}),
      },
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };

  const plan: Array<{ name: string; role: TeamRole }> = [
    { name: ROSTER.owner, role: "owner" },
    ...ROSTER.editors.map((name) => ({ name, role: "editor" as const })),
    ...ROSTER.commenters.map((name) => ({ name, role: "commenter" as const })),
    ...ROSTER.viewers.map((name) => ({ name, role: "viewer" as const })),
  ];
  const tag = Math.random().toString(36).slice(2, 8);
  const users = await Promise.all(
    plan.map(async ({ name, role }): Promise<TeamUser> => {
      // `.test` addresses are verified on signup (share links need it).
      const email = `${name.toLowerCase()}.${tag}@team.test`;
      const res = await api("/api/auth/signup", {
        method: "POST",
        body: JSON.stringify({ email, password: "password123", name }),
      });
      expect(res.status).toBe(201);
      return { name, email, id: res.body.user.id as string, token: res.body.token as string, role };
    }),
  );
  const byName = new Map(users.map((u) => [u.name, u] as const));
  const owner = byName.get(ROSTER.owner)!;

  const seeded = applyOperations(createWorkspace({ name: "Team board" }), [
    { op: "CREATE_NODE", id: SEED_NODE, nodeType: "step", label: "Kickoff" },
  ]);
  const created = await api("/api/boards", {
    method: "POST",
    token: owner.token,
    body: JSON.stringify({ name: "Team board", workspace: seeded }),
  });
  expect(created.status).toBe(201);
  const boardId = created.body.id as string;
  const fetched = await api(`/api/boards/${boardId}`, { token: owner.token });
  expect(fetched.status).toBe(200);
  expect(fetched.body.latestSeq).toBe(0);
  const orgId = fetched.body.orgId as string;
  const baseWorkspace = fetched.body.workspace as Workspace;

  const links = new Map<TeamRole, string>();
  for (const role of ["editor", "commenter", "viewer"] as const) {
    const link = await api(`/api/boards/${boardId}/share`, {
      method: "POST",
      token: owner.token,
      body: JSON.stringify({ role }),
    });
    expect(link.status).toBe(201);
    links.set(role, link.body.token as string);
  }
  await Promise.all(
    users
      .filter((u) => u.role !== "owner")
      .map(async (u) => {
        const joined = await api(`/api/boards/${boardId}/join`, {
          method: "POST",
          token: u.token,
          body: JSON.stringify({ token: links.get(u.role) }),
        });
        expect(joined.status).toBe(200);
        expect(joined.body.role).toBe(u.role);
      }),
  );
  for (const name of options.orgMembers ?? []) {
    const u = byName.get(name);
    if (!u || u.role === "owner") continue;
    // Workspace membership never widens the board role the scenario relies on.
    await userStore.setMembership({
      userId: u.id,
      orgId,
      role: u.role === "editor" ? "editor" : "viewer",
    });
  }

  const team: Team = {
    app,
    base,
    wsBase: `ws://127.0.0.1:${port}`,
    boardId,
    orgId,
    store,
    userStore,
    calls,
    meetings,
    proposals,
    notifications,
    baseWorkspace,
    users,
    owner,
    editors: users.filter((u) => u.role === "editor"),
    commenters: users.filter((u) => u.role === "commenter"),
    viewers: users.filter((u) => u.role === "viewer"),
    clients: new Map(),
    user(name) {
      const u = byName.get(name);
      if (!u) throw new Error(`no team member ${name}`);
      return u;
    },
    client(name) {
      const c = team.clients.get(name);
      if (!c) throw new Error(`${name} has no client`);
      return c;
    },
    api,
    post(path, who, body = {}) {
      const u = typeof who === "string" ? team.user(who) : who;
      return api(path, { method: "POST", token: u.token, body: JSON.stringify(body) });
    },
    get(path, who) {
      const u = typeof who === "string" ? team.user(who) : who;
      return api(path, { token: u.token });
    },
    async connectAll(names = users.map((u) => u.name)) {
      return Promise.all(
        names.map((name) => {
          const c = new TeamClient(team, team.user(name));
          team.clients.set(name, c);
          return c.connect(0);
        }),
      );
    },
    async close() {
      for (const c of team.clients.values()) c.socket?.terminate();
      await app.close();
    },
  };
  return team;
}

export interface ConvergenceReport {
  head: number;
  clients: number;
  /** Live `op` frames that arrived with a seq lower than one already received. */
  outOfOrder: number;
  /** Entries delivered both in a catchup and as a live frame (harmless by protocol). */
  catchupOverlaps: number;
  /** Entries the shipped web client's arrival-order apply would have dropped. */
  webClientDropped: number;
  ackedRequests: number;
}

/**
 * The convergence contract, for every connected client:
 *  (a) it holds a gap-free, contiguous run of seqs from its join point to the head;
 *  (b) replaying its entries onto its base state equals GET /api/boards/:id;
 *  (c) no seq arrived twice as a live `op` frame;
 *  (d) every acked (non-duplicate) requestId appears exactly once in the log.
 */
export async function assertConverged(
  team: Team,
  options: { exclude?: readonly string[] } = {},
): Promise<ConvergenceReport> {
  const head = await team.store.latestSeq(team.boardId);
  const clients = [...team.clients.values()].filter(
    (c) => c.open && !(options.exclude ?? []).includes(c.name),
  );
  await Promise.all(clients.map((c) => c.untilSeq(head, 10_000)));

  const server = await team.get(`/api/boards/${team.boardId}`, team.owner);
  expect(server.status).toBe(200);
  expect(server.body.latestSeq).toBe(head);
  const serverWs = normalize(server.body.workspace as Workspace);

  let outOfOrder = 0;
  let catchupOverlaps = 0;
  let webClientDropped = 0;
  for (const c of clients) {
    // (a) contiguous from the join point, nothing beyond the head.
    expect(c.head(), `${c.name} head`).toBe(head);
    expect(c.maxSeq(), `${c.name} max seq`).toBe(head);
    const seqs = [...c.entries.keys()].filter((s) => s > c.baseSeq).sort((a, b) => a - b);
    expect(seqs.length, `${c.name} entry count`).toBe(head - c.baseSeq);
    // (c) no duplicate live delivery.
    expect(new Set(c.liveSeqs).size, `${c.name} duplicate live seqs`).toBe(c.liveSeqs.length);
    const live = new Set(c.liveSeqs);
    catchupOverlaps += c.catchupSeqs.filter((s) => live.has(s)).length;
    for (let i = 1; i < c.liveSeqs.length; i += 1) {
      if (c.liveSeqs[i]! < c.liveSeqs[i - 1]!) outOfOrder += 1;
    }
    // (b) replay equals the server's board.
    expect(normalize(c.state()), `${c.name} replayed state`).toEqual(serverWs);
    webClientDropped += c.webClientState().dropped.length;
  }

  // (d) the log itself: contiguous 1..head, and each acked request exactly once.
  const log = await team.store.loadLog(team.boardId);
  expect(log.map((e) => e.seq)).toEqual(Array.from({ length: head }, (_, i) => i + 1));
  const counts = new Map<string, number>();
  for (const e of log) {
    if (e.requestId !== undefined) counts.set(e.requestId, (counts.get(e.requestId) ?? 0) + 1);
  }
  let ackedRequests = 0;
  for (const c of team.clients.values()) {
    for (const [requestId, ack] of c.acks) {
      ackedRequests += 1;
      expect(counts.get(requestId), `acked ${requestId} in log`).toBe(1);
      const entry = log.find((e) => e.requestId === requestId);
      expect(entry?.seq, `acked ${requestId} seq`).toBe(ack.seq);
    }
  }
  return {
    head,
    clients: clients.length,
    outOfOrder,
    catchupOverlaps,
    webClientDropped,
    ackedRequests,
  };
}

/** All ack latencies across the team. */
export function ackLatencies(team: Team): number[] {
  return [...team.clients.values()].flatMap((c) => c.ackLatencyMs);
}

/** A labelled one-line summary for the scenario log. */
export function report(label: string, data: Record<string, unknown>): void {
  console.log(`[scenario] ${label}: ${JSON.stringify(data)}`);
}

/** Small op builders. */
export const op = {
  node: (id: string, label = id): Operation => ({
    op: "CREATE_NODE",
    id,
    nodeType: "step",
    label,
  }),
  connect: (source: string, target: string, relationship = "relates"): Operation => ({
    op: "CONNECT_NODES",
    source,
    target,
    relationship,
  }),
  sticky: (id: string, text: string, x = 0, y = 0): Operation => ({
    op: "CREATE_SHAPE",
    id,
    kind: "sticky",
    position: { x, y },
    size: { width: 160, height: 120 },
    text,
  }),
  text: (id: string, text: string): Operation => ({ op: "CHANGE_TEXT", id, text }),
  move: (id: string, x: number, y: number): Operation => ({
    op: "MOVE_NODE",
    id,
    position: { x, y },
  }),
  comment: (id: string, targetId: string, body: string): Operation => ({
    op: "ADD_COMMENT",
    id,
    targetId,
    body,
  }),
  vote: (id: string, targetId: string): Operation => ({ op: "ADD_VOTE", id, targetId }),
  react: (id: string, targetId: string, emoji = "+1"): Operation => ({
    op: "ADD_REACTION",
    id,
    targetId,
    emoji,
  }),
  del: (id: string): Operation => ({ op: "DELETE_NODE", id }),
};

/**
 * The canvas half at work: each canvas editor (and the owner) commits a
 * small chain of nodes, links and stickies over its socket while the rest of
 * the scenario runs; the canvas commenter comments. Returns the counts.
 */
export async function canvasTrack(
  team: Team,
  options: {
    rounds?: number;
    prefix?: string;
    pauseMs?: number;
    names?: readonly string[];
  } = {},
): Promise<{ acked: number; rejected: number }> {
  const rounds = options.rounds ?? 4;
  const prefix = options.prefix ?? "cv";
  const pause = options.pauseMs ?? 5;
  let acked = 0;
  let rejected = 0;
  const names = options.names ?? CANVAS_HALF;
  const writers = names.filter((n) => {
    const r = team.user(n).role;
    return r === "editor" || r === "owner";
  });
  const commenters = names.filter((n) => team.user(n).role === "commenter");
  await Promise.all([
    ...writers.map(async (name) => {
      const c = team.client(name);
      for (let i = 0; i < rounds; i += 1) {
        const id = `${prefix}-${name.toLowerCase()}-${i}`;
        const res = await c.send([
          op.node(id, `${name} ${i}`),
          op.connect(id, SEED_NODE, "feeds"),
          op.sticky(`${id}-note`, `${name} note ${i}`, i * 10, i * 10),
        ]);
        if (res.type === "op-ack") acked += 1;
        else rejected += 1;
        await new Promise((r) => setTimeout(r, pause));
      }
    }),
    ...commenters.map(async (name) => {
      const c = team.client(name);
      for (let i = 0; i < rounds; i += 1) {
        const res = await c.send([
          op.comment(`${prefix}-c-${name.toLowerCase()}-${i}`, SEED_NODE, `${name} thought ${i}`),
        ]);
        if (res.type === "op-ack") acked += 1;
        else rejected += 1;
        await new Promise((r) => setTimeout(r, pause));
      }
    }),
  ]);
  return { acked, rejected };
}
