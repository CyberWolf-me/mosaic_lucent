import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { closeDb, createDb, type Db } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";
import { PostgresUserStore } from "../src/store/pg-users.js";
import { PostgresBoardStore } from "../src/store/pg-boards.js";
import { RealtimeServer } from "../src/realtime.js";
import { newBoardId } from "../src/boards.js";
import { handleSignup } from "../src/accounts.js";
import { InMemoryTicketStore } from "../src/realtimeTicket.js";
import type { Role } from "../src/identity.js";

/**
 * Cold-restart integration test (docs/06). Boots the realtime server against a
 * real Postgres, creates a user and board, joins the WS room, commits an op,
 * then tears the whole server down and brings a fresh one up on a new port.
 * The second instance must rebuild the room from the persisted op log so a
 * joiner still receives the op as catchup — that is the property that makes
 * collaboration survive a deploy.
 *
 * Gated on LUCENT_TEST_DATABASE_URL, same as pg-store.test.ts.
 */

const URL = process.env.LUCENT_TEST_DATABASE_URL;
const describeIf = URL ? describe : describe.skip;
const SECRET = "test-secret-at-least-16-chars";
/**
 * Unique per run. This file used to TRUNCATE the shared tables so its fixed
 * signup email was free again, which raced every other pg suite against the
 * same database (they all note it in their headers and avoid TRUNCATE); the
 * observed symptom was pg-store's op-log tests failing when a sibling wiped
 * `boards` mid-test. A tagged email needs no wipe.
 */
const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
/**
 * Shared across boots so a ticket can be minted without an HTTP app in front
 * of the socket. In production /api/realtime/ticket mints these; here the test
 * is the minting authority.
 */
const tickets = new InMemoryTicketStore(60_000);

interface Instance {
  baseUrl: string;
  wsUrl: string;
  server: Server;
  db: Db;
  close: () => Promise<void>;
}

/** Boot an HTTP+WS server on an ephemeral port, backed by Postgres. */
async function boot(): Promise<Instance> {
  const db = createDb(URL!);
  await migrate(db);
  const userStore = new PostgresUserStore(db);
  const boardStore = new PostgresBoardStore(db);
  const server = createServer();
  // `tickets` and `orgRoleFor` are both required deps. This call had rotted to
  // just { userStore, boardStore, secret } and would have thrown on the first
  // upgrade (no ticket store to consume from); `orgRoleFor` is what makes a
  // socket join resolve the same effective role the HTTP guard does (M2.2).
  const orgRoleFor = async (userId: string, orgId: string): Promise<Role | undefined> => {
    const memberships = await userStore.membershipsFor(userId);
    return memberships.find((m) => m.orgId === orgId)?.role;
  };
  new RealtimeServer({ userStore, boardStore, secret: SECRET, tickets, orgRoleFor }).attach(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}`,
    server,
    db,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await closeDb(db);
    },
  };
}

interface Welcome {
  type: string;
  boardId: string;
  version: number;
  role: "owner" | "editor" | "viewer";
  catchup: Array<{ seq: number; ops: unknown[] }>;
}

/**
 * Open a socket, send `join`, and resolve with the `welcome` frame. The
 * upgrade authenticates with a single-use ticket; `?token=` (a bearer token in
 * the query string) has not been accepted since M0.3 and would 401 here.
 */
async function join(
  wsUrl: string,
  boardId: string,
  userId: string,
): Promise<{ socket: WebSocket; welcome: Welcome }> {
  const ticket = await tickets.mint(userId);
  const socket = new WebSocket(`${wsUrl}/ws?ticket=${encodeURIComponent(ticket)}`);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  const welcome = waitFor<Welcome>(socket, "welcome");
  socket.send(JSON.stringify({ type: "join", boardId, fromSeq: 0 }));
  return { socket, welcome: await welcome };
}

/** Resolve on the next frame of a given `type`. */
function waitFor<T>(socket: WebSocket, type: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${type}`)), 5000);
    const onMessage = (data: unknown) => {
      const msg = JSON.parse(String(data)) as { type: string };
      if (msg.type !== type) return;
      clearTimeout(timer);
      socket.off("message", onMessage);
      resolve(msg as T);
    };
    socket.on("message", onMessage);
  });
}

describeIf("server cold-restart with Postgres", () => {
  let instance: Instance;
  const email = `restart_${tag}@example.com`;
  let userId = "";
  let boardId = "";

  beforeAll(async () => {
    instance = await boot();
    // Create the account through the real handler so the row shape matches
    // what production writes.
    const store = new PostgresUserStore(instance.db);
    // `handleSignup` takes an AuthContext, not the legacy (store, secret, body)
    // triple. This call had rotted into the old 3-argument shape and only ever
    // stayed green because it sits behind the LUCENT_TEST_DATABASE_URL gate, so
    // it never actually ran. No mailer or verification-token store is wired
    // here: signup skips the verification mail when they are absent, which is
    // what this test wants - it is exercising the persisted user row shape.
    const signup = await handleSignup(
      { userStore: store, secret: SECRET },
      { email, password: "password123", name: "R" },
    );
    expect(signup.status).toBe(201);
    userId = (signup.body as { user: { id: string } }).user.id;

    boardId = newBoardId();
    const boardStore = new PostgresBoardStore(instance.db);
    // Every board lives in exactly one org (M2.1) and `boards.org_id` is a
    // NOT NULL foreign key, so the personal org signup just created is the
    // tenant this fixture belongs to.
    const [membership] = await store.membershipsFor(userId);
    expect(membership).toBeDefined();
    await boardStore.put({
      id: boardId,
      orgId: membership!.orgId,
      ownerId: userId,
      name: "Restart test",
      workspace: { ...(await import("@lucent/core")).createWorkspace(), name: "Restart test" },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });

  afterAll(async () => {
    if (instance) await instance.close().catch(() => {});
  });

  it("replays the persisted op log to a joiner after a full restart", async () => {
    // --- First instance: join as owner, commit one op. ---
    const owner = await join(instance.wsUrl, boardId, userId);
    expect(owner.welcome.role).toBe("owner");
    expect(owner.welcome.version).toBe(0);

    const applied = waitFor<{ entry: { seq: number } }>(owner.socket, "op");
    owner.socket.send(
      JSON.stringify({
        type: "op",
        ops: [{ op: "CREATE_NODE", id: "n1", nodeType: "step", label: "N1" }],
        label: "create n1",
      }),
    );
    expect((await applied).entry.seq).toBe(1);
    owner.socket.close();

    // The op is durable before the server goes away.
    const persisted = await new PostgresBoardStore(instance.db).loadLog(boardId);
    expect(persisted).toHaveLength(1);

    // --- Restart: tear the whole server down, boot a fresh one. ---
    await instance.close();
    instance = await boot();

    // --- Second instance: a joiner gets the op from the rebuilt log. ---
    const rejoin = await join(instance.wsUrl, boardId, userId);
    expect(rejoin.welcome.version).toBe(1);
    expect(rejoin.welcome.catchup).toHaveLength(1);
    expect((rejoin.welcome.catchup[0]?.ops[0] as { id?: string }).id).toBe("n1");
    // The workspace snapshot survived too, so the board isn't rebuilt from zero.
    const board = await new PostgresBoardStore(instance.db).get(boardId);
    expect(Object.keys(board!.workspace.nodes)).toContain("n1");
    rejoin.socket.close();
  });
});
