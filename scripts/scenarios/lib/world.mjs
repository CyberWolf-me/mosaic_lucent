/**
 * The team: 24 people on one board, the way a real company would be on it.
 *
 *   Ava              owner (made the workspace and the board)
 *   Ben Cleo Dev     workspace members, editors through the workspace
 *   Eli Fay
 *   Gus … Rosa       12 editors invited by share link (board guests)
 *   Sam Tara Uma     commenters (share link)
 *   Vic Wes Yara     viewers (share link)
 *
 * Half the team is in the meeting (and its call); the other half works on the
 * canvas at the same time.
 */
import { Api, Person, pMap, sleep, waitFor } from "./api.mjs";
import { LiveClient } from "./realtime.mjs";

export const ROSTER = [
  ["Ava", "owner"],
  ["Ben", "member"],
  ["Cleo", "member"],
  ["Dev", "member"],
  ["Eli", "member"],
  ["Fay", "member"],
  ["Gus", "editor"],
  ["Hana", "editor"],
  ["Ivo", "editor"],
  ["Jade", "editor"],
  ["Kai", "editor"],
  ["Lena", "editor"],
  ["Milo", "editor"],
  ["Nia", "editor"],
  ["Omar", "editor"],
  ["Pia", "editor"],
  ["Quinn", "editor"],
  ["Rosa", "editor"],
  ["Sam", "commenter"],
  ["Tara", "commenter"],
  ["Uma", "commenter"],
  ["Vic", "viewer"],
  ["Wes", "viewer"],
  ["Yara", "viewer"],
];

export const MEETING_HALF = ["Ava", "Ben", "Cleo", "Dev", "Eli", "Hana", "Ivo", "Jade", "Kai", "Lena", "Sam", "Vic"];
export const CANVAS_HALF = ["Fay", "Gus", "Milo", "Nia", "Omar", "Pia", "Quinn", "Rosa", "Tara", "Uma", "Wes", "Yara"];

export class World {
  constructor({ stack, report, runId }) {
    this.stack = stack;
    this.report = report;
    this.runId = runId;
    this.api = new Api(stack.apiUrl);
    this.people = [];
    this.byName = new Map();
  }

  p(name) {
    const person = this.byName.get(name);
    if (!person) throw new Error(`no person ${name}`);
    return person;
  }
  who(filter) {
    return this.people.filter(filter);
  }
  get editors() {
    return this.who((p) => ["owner", "member", "editor"].includes(p.role));
  }

  async provision() {
    const r = this.report;
    // 1. Accounts (.test addresses are auto-verified, so the owner may share).
    const accounts = await pMap(
      ROSTER,
      async ([name]) => {
        const t0 = performance.now();
        const a = await this.api.signup(name, `${name.toLowerCase()}_${this.runId}@scenarios.lucent.test`, `pw-${this.runId}-${name}`);
        r.time("signup_ms", performance.now() - t0);
        return a;
      },
      8,
    );
    for (const [i, [, role]] of ROSTER.entries()) {
      const person = new Person(this.api, accounts[i], role);
      this.people.push(person);
      this.byName.set(person.name, person);
    }
    r.check("24 accounts signed up", this.people.length === 24, `${this.people.length}`);

    // 2. A workspace on a team plan — the database's own subscription row, the
    //    same one billing would write — so it has seats to invite people into.
    const ava = this.p("Ava");
    const org = await ava.post("/api/orgs", { name: `Scenario Co ${this.runId}` });
    this.orgId = org.id;
    const now = Date.now();
    this.stack.sql(
      `INSERT INTO subscriptions (org_id, plan, status, seats, created_at, updated_at) ` +
        `VALUES ('${org.id}', 'team', 'active', 50, ${now}, ${now}) ON CONFLICT (org_id) DO UPDATE SET plan='team', seats=50, status='active'`,
    );

    // 3. Five members, invited the product way: the invite reaches an existing
    //    account as an in-app notification carrying the accept path.
    const members = this.who((p) => p.role === "member");
    await pMap(members, (m) => ava.post(`/api/orgs/${org.id}/invites`, { email: m.email, role: "editor" }), 5);
    let accepted = 0;
    await pMap(members, async (m) => {
      const note = await waitFor(
        async () => {
          const { notifications } = await m.get("/api/notifications");
          return notifications.find((n) => n.kind === "org.invited");
        },
        { timeout: 20_000, label: `${m.name}'s invite` },
      );
      const path = note.payload?.acceptPath ?? note.data?.acceptPath ?? note.href ?? note.link ?? "";
      const token = path ? new URL(path, "http://x").searchParams.get("token") : null;
      if (!token) throw new Error(`no invite token in notification: ${JSON.stringify(note).slice(0, 600)}`);
      await m.post("/api/invites/accept", { token });
      accepted++;
    });
    r.check("5 workspace members accepted their invites", accepted === 5, `${accepted}`);

    // 4. The board, in the workspace.
    const board = await ava.post("/api/boards", { name: `Launch planning ${this.runId}`, orgId: org.id });
    this.boardId = board.id;
    // The board as created, before any op: the base every replay starts from.
    this.initialWorkspace = (await ava.get(`/api/boards/${board.id}`)).workspace;

    // 5. Share links per role for everyone outside the workspace.
    const links = {};
    for (const role of ["editor", "commenter", "viewer"]) {
      links[role] = (await ava.post(`/api/boards/${board.id}/share`, { role })).token;
    }
    const guests = this.who((p) => ["editor", "commenter", "viewer"].includes(p.role));
    const joined = await pMap(guests, (g) => g.post(`/api/boards/${board.id}/join`, { token: links[g.role] }), 8);
    r.check(
      "19 guests joined by link with the right role",
      joined.every((j, i) => j.role === guests[i].role),
      joined.map((j, i) => `${guests[i].name}:${j.role}`).filter((_, i) => joined[i].role !== guests[i].role).join(", "),
    );

    const { members: boardMembers } = await ava.get(`/api/boards/${board.id}/members`);
    r.note(`board members listed: ${boardMembers.length} (workspace members reach it through the workspace)`);
    return board;
  }

  /** Everyone opens a socket at once. */
  async connectAll() {
    const r = this.report;
    const t0 = Date.now();
    const results = await Promise.allSettled(
      this.people.map(async (p) => {
        p.rt = new LiveClient(p, this.stack.apiUrl, this.boardId, { record: (k, ms) => r.time(k, ms) });
        await p.rt.connect(0);
        return p.rt.role;
      }),
    );
    const failed = results.filter((x) => x.status === "rejected");
    r.check(
      "all 24 sockets joined the board room at once",
      failed.length === 0,
      failed.map((f) => f.reason?.message).join("; ") || `${Date.now() - t0} ms`,
    );
    const expected = { owner: "owner", member: "editor", editor: "editor", commenter: "commenter", viewer: "viewer" };
    const wrong = this.people.filter((p) => p.rt?.role !== expected[p.role]);
    r.check(
      "each socket's welcome carries the person's effective role",
      wrong.length === 0,
      wrong.map((p) => `${p.name}: ${p.rt?.role} ≠ ${expected[p.role]}`).join(", "),
    );
    // Presence: everyone eventually sees the other 23.
    const ok = await waitFor(() => this.people.every((p) => p.rt.peers.size >= 23), {
      timeout: 20_000,
      label: "23 peers each",
    }).catch(() => false);
    r.check(
      "every socket sees the other 23 people present",
      !!ok,
      this.people.filter((p) => p.rt.peers.size < 23).map((p) => `${p.name}:${p.rt.peers.size}`).join(", "),
    );
  }

  /**
   * The presence store forgets anyone whose cursor hasn't moved for 45 s
   * (presence.ts DEFAULT_PRESENCE_TTL_MS), and a leave evicts the room when
   * the store says nobody is left — dropping every open socket from the
   * broadcast set. Everyone idles past the TTL, one extra tab closes, and the
   * next edit must still reach all 23 others.
   */
  async idleEvictionCheck() {
    const r = this.report;
    r.note("everyone idles past the 45 s presence TTL (nobody moves a cursor)…");
    await sleep(50_000);
    const tab = new LiveClient(this.p("Ava"), this.stack.apiUrl, this.boardId);
    await tab.connect(0);
    tab.close();
    await sleep(3_000);
    const ben = this.p("Ben");
    const ack = await ben.rt.send([{ op: "CREATE_NODE", id: "idle_probe", nodeType: "note", label: "Sent after a tab closed" }]);
    const others = this.people.filter((p) => p !== ben);
    const got = (await Promise.allSettled(others.map((p) => p.rt.waitForSeq(ack.seq, 8_000)))).filter(
      (x) => x.status === "fulfilled",
    ).length;
    r.check(
      "after a quiet minute, one tab closing doesn't cut everyone else off the board",
      got === others.length,
      `${got}/${others.length} received the next edit; their sockets are still open`,
      got === others.length
        ? {}
        : {
            known:
              "a leave evicts the room when the presence store (45 s TTL, refreshed only by cursor moves) reports nobody — and eviction clears the broadcast set of every still-open socket (server/src/realtime.ts:753-773, :251); the web client sends no presence heartbeat",
          },
    );
    if (got < others.length) await this.rejoinAll("the cut-off");
  }

  /** Everyone rejoins from seq 0, the way a page reload would; old sockets close after. */
  async rejoinAll(why) {
    const r = this.report;
    const old = this.people.map((p) => p.rt);
    for (const p of this.people) {
      const fresh = new LiveClient(p, this.stack.apiUrl, this.boardId, { record: (k, ms) => r.time(k, ms) });
      await fresh.connect(0);
      p.rt = fresh;
    }
    for (const rt of old) rt.close();
    r.note(`all 24 rejoined from seq 0 after ${why}`);
  }

  /** Active people move their cursors: keeps presence rows fresh, as real activity would. */
  startHeartbeats(browsersOf = () => []) {
    let k = 0;
    this.heartbeat = setInterval(() => {
      k++;
      for (const p of this.people) if (p.rt?.open) p.rt.presence({ x: 100 + ((k * 37) % 900), y: 100 + ((k * 53) % 600) });
      for (const b of browsersOf()) b.page?.mouse.move(300 + ((k * 41) % 600), 300 + ((k * 29) % 300)).catch(() => {});
    }, 15_000);
  }
  stopHeartbeats() {
    clearInterval(this.heartbeat);
  }

  /** The server's view of the board right now. */
  async serverBoard() {
    return this.p("Ava").get(`/api/boards/${this.boardId}`);
  }
}
