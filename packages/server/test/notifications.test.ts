import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  InMemoryNotificationStore,
  NOTIFICATION_CATALOGUE,
  NOTIFICATION_KINDS,
  NOTIFICATION_PAGE_MAX,
  clampNotificationLimit,
  composeNotification,
  defaultPreference,
  isNotificationKind,
  newNotificationId,
  normalizeNotification,
  notificationEmail,
  notify,
  resolvePreference,
  resolvePreferences,
  type NotificationCursor,
  type NotificationKind,
  type NotificationMailer,
  type NotificationPayloads,
  type NotificationStore,
  type StoredNotification,
  type Toggle,
} from "../src/notifications.js";
import { PostgresNotificationStore } from "../src/store/pg-notifications.js";
import { closeDb, createDb, type Db } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";

/**
 * NotificationStore parity contract (M2.6).
 *
 * Every property below is written once and asserted against BOTH
 * implementations, the same shape as `audit-store.test.ts` and
 * `usageStore.test.ts` -- and for the same reason. This project already shipped
 * one silent Postgres stub: `PostgresOrgStore.audit()` was `void _entry;` while
 * `InMemoryOrgStore` recorded correctly, so every audit assertion ran against
 * the in-memory store and the suite stayed green over a feature that wrote
 * nothing in production. A notification service is exactly as easy to fake and
 * exactly as invisible when it silently does nothing, so implementation parity
 * is the deliverable, not a nicety.
 *
 * The Postgres half is gated on LUCENT_TEST_DATABASE_URL, the convention
 * pg-store.test.ts, audit-store.test.ts and usageStore.test.ts already use:
 * without the variable it is reported as skipped rather than quietly vanishing.
 * CI supplies a `postgres:16` service and runs `db:migrate` first.
 */

const URL = process.env.LUCENT_TEST_DATABASE_URL;

/** Unique per run, so this file needs no TRUNCATE and cannot race a sibling suite. */
const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

interface Harness {
  store: NotificationStore;
  /** Create the rows the FKs require. No-ops for the in-memory store. */
  newUser: (id: string) => Promise<void>;
  newOrg: (id: string) => Promise<void>;
}

interface Impl {
  name: string;
  enabled: boolean;
  open: () => Promise<Harness>;
  close: () => Promise<void>;
}

let db: Db | undefined;

const impls: Impl[] = [
  {
    name: "InMemoryNotificationStore",
    enabled: true,
    open: async () => ({
      store: new InMemoryNotificationStore(),
      newUser: async () => {},
      newOrg: async () => {},
    }),
    close: async () => {},
  },
  {
    name: "PostgresNotificationStore",
    enabled: Boolean(URL),
    open: async () => {
      db = createDb(URL!);
      await migrate(db);
      const target = db;
      return {
        store: new PostgresNotificationStore(target),
        // notifications.user_id and notification_prefs.user_id are real FKs, so
        // the user has to exist before anything can be delivered to them.
        newUser: async (id: string) => {
          await target.pool.query(
            "INSERT INTO users (id, email, name, password_hash, created_at)" +
              " VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING",
            [id, `${id}@example.test`, id, "x", 1],
          );
        },
        newOrg: async (id: string) => {
          await target.pool.query(
            "INSERT INTO organizations (id, name, created_at) VALUES ($1, $2, $3)" +
              " ON CONFLICT (id) DO NOTHING",
            [id, id, 1],
          );
        },
      };
    },
    close: async () => {
      if (!db) return;
      // Leave the shared database as it was found. Notifications and preferences
      // both cascade with the user, and notifications cascade with the org, so
      // deleting this run's tagged rows is enough -- and unlike a TRUNCATE it
      // cannot wipe a sibling suite's fixtures mid-run.
      await db.pool.query("DELETE FROM users WHERE id LIKE $1", [`usr_ntf_${tag}%`]);
      await db.pool.query("DELETE FROM organizations WHERE id LIKE $1", [`org_ntf_${tag}%`]);
      await closeDb(db);
      db = undefined;
    },
  },
];

/** A mailer that records what it was asked to send. */
function mailbox(): NotificationMailer & { sent: { to: string; subject: string; text: string }[] } {
  const sent: { to: string; subject: string; text: string }[] = [];
  return {
    sent,
    send: async (msg) => {
      sent.push({ to: msg.to, subject: msg.subject, text: msg.text });
    },
  };
}

/** The failure case that must never cost the user their notification. */
const brokenMailer: NotificationMailer = {
  send: async () => {
    throw new Error("smtp unreachable");
  },
};

/**
 * Walk every page with `size`-row pages and return the ids in order, asserting
 * no row is handed out twice. Bounded, so a broken cursor fails instead of
 * hanging the run. Copied in spirit from audit-store.test.ts's `pageAll`.
 */
async function pageAll(store: NotificationStore, userId: string, size: number): Promise<string[]> {
  const seen: string[] = [];
  let cursor: NotificationCursor | undefined;
  for (let page = 0; page < 20; page += 1) {
    const rows: StoredNotification[] = await store.list(userId, size, cursor);
    if (rows.length === 0) return seen;
    for (const row of rows) {
      expect(seen).not.toContain(row.id);
      seen.push(row.id);
    }
    const tail = rows[rows.length - 1]!;
    cursor = { createdAt: tail.createdAt, id: tail.id };
  }
  throw new Error("pagination did not terminate");
}

for (const impl of impls) {
  const suite = impl.enabled ? describe : describe.skip;

  suite(`notification store contract — ${impl.name}`, () => {
    let store: NotificationStore;
    let harness: Harness;
    let count = 0;

    beforeAll(async () => {
      if (!impl.enabled) return;
      harness = await impl.open();
      store = harness.store;
    });

    afterAll(async () => {
      if (!impl.enabled) return;
      await impl.close();
    });

    /** A fresh user per test: one store instance serves the file. */
    async function freshUser(): Promise<string> {
      count += 1;
      const id = `usr_ntf_${tag}_${count}`;
      await harness.newUser(id);
      return id;
    }

    async function freshOrg(): Promise<string> {
      count += 1;
      const id = `org_ntf_${tag}_${count}`;
      await harness.newOrg(id);
      return id;
    }

    /** Five rows, two pairs sharing a millisecond, newest-first ids returned. */
    async function seedFive(userId: string, prefix: string): Promise<string[]> {
      const ats = [1000, 2000, 2000, 3000, 3000];
      for (let n = 1; n <= 5; n += 1) {
        await store.create({
          id: `${prefix}${n}`,
          userId,
          orgId: null,
          kind: "comment.reply",
          title: `reply ${n}`,
          createdAt: ats[n - 1]!,
          metadata: { n },
        });
      }
      // (createdAt DESC, id DESC) → 3000/5, 3000/4, 2000/3, 2000/2, 1000/1.
      return [5, 4, 3, 2, 1].map((n) => `${prefix}${n}`);
    }

    it("stores every column and reads it back", async () => {
      const userId = await freshUser();
      const orgId = await freshOrg();
      const row = await store.create({
        id: `ntf_col_${tag}`,
        userId,
        orgId,
        kind: "board.invited",
        title: 'Ada shared "Roadmap" with you',
        body: "You can edit this board.",
        link: "/?board=brd_1",
        metadata: { boardId: "brd_1", role: "editor" },
        createdAt: 1_700_000_000_000,
      });
      expect(row.id).toBe(`ntf_col_${tag}`);
      expect(row.readAt).toBeNull();
      const read = (await store.list(userId, 10))[0]!;
      expect(read).toEqual(row);
      expect(read.orgId).toBe(orgId);
      expect(read.kind).toBe("board.invited");
      expect(read.body).toBe("You can edit this board.");
      expect(read.link).toBe("/?board=brd_1");
      expect(read.metadata).toEqual({ boardId: "brd_1", role: "editor" });
      expect(read.createdAt).toBe(1_700_000_000_000);
    });

    it("accepts a null orgId for an account-level notification", async () => {
      const userId = await freshUser();
      // The column is nullable on purpose (schema.ts:441) and an account-level
      // notification belongs to no workspace; it must still be listable.
      await store.create({
        id: `ntf_acct_${tag}`,
        userId,
        orgId: null,
        kind: "org.invited",
        title: "Ada invited you to Acme",
        createdAt: 10,
      });
      const rows = await store.list(userId, 10);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.orgId).toBeNull();
      // Omitted optional columns are null in both stores, never undefined.
      expect(rows[0]!.body).toBeNull();
      expect(rows[0]!.link).toBeNull();
      expect(rows[0]!.metadata).toEqual({});
    });

    it("is append-only: a duplicate id is rejected, never an overwrite", async () => {
      const userId = await freshUser();
      const id = `ntf_dup_${tag}`;
      await store.create({
        id,
        userId,
        orgId: null,
        kind: "comment.reply",
        title: "first",
        createdAt: 1,
      });
      await expect(
        store.create({
          id,
          userId,
          orgId: null,
          kind: "comment.reply",
          title: "rewritten",
          createdAt: 2,
        }),
      ).rejects.toThrow();
      const rows = await store.list(userId, 10);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.title).toBe("first");
    });

    it("hands out detached rows: mutating a read cannot rewrite what was said", async () => {
      const userId = await freshUser();
      await store.create({
        id: `ntf_det_${tag}`,
        userId,
        orgId: null,
        kind: "comment.mention",
        title: "before",
        metadata: { name: "before" },
        createdAt: 1,
      });
      const row = (await store.list(userId, 10))[0]!;
      row.title = "tampered";
      (row.metadata as { name: string }).name = "after";
      const again = (await store.list(userId, 10))[0]!;
      expect(again.title).toBe("before");
      expect(again.metadata).toEqual({ name: "before" });
    });

    it("gives metadata JSONB semantics in both stores", async () => {
      const userId = await freshUser();
      await store.create({
        id: `ntf_meta_${tag}`,
        userId,
        orgId: null,
        kind: "comment.mention",
        title: "meta",
        metadata: { kept: 1, dropped: undefined, when: new Date(0), nested: { ok: true } },
        createdAt: 1,
      });
      const row = (await store.list(userId, 10))[0]!;
      // The column stores JSON: `undefined` has no representation and a Date
      // becomes a string. The in-memory store does the same, so a test cannot
      // pass on a richer object than production will ever see.
      expect(row.metadata).toEqual({
        kept: 1,
        when: "1970-01-01T00:00:00.000Z",
        nested: { ok: true },
      });
      expect("dropped" in row.metadata).toBe(false);
    });

    it("returns newest first, breaking a same-millisecond tie by id", async () => {
      const userId = await freshUser();
      const expected = await seedFive(userId, `ntf_ord_${tag}_`);
      const rows = await store.list(userId, 10);
      expect(rows.map((r) => r.id)).toEqual(expected);
      expect(rows.map((r) => r.createdAt)).toEqual([3000, 3000, 2000, 2000, 1000]);
    });

    it("pages on (createdAt, id) without repeating or skipping a boundary row", async () => {
      const userId = await freshUser();
      const expected = await seedFive(userId, `ntf_pag_${tag}_`);
      // Size 1 puts a boundary *inside* each tie group -- the case a
      // createdAt-only cursor gets wrong, and one comment mentioning three
      // people makes that group real rather than theoretical.
      expect(await pageAll(store, userId, 1)).toEqual(expected);
      expect(await pageAll(store, userId, 2)).toEqual(expected);
      expect(await pageAll(store, userId, 5)).toEqual(expected);
      // A cursor built from the oldest row yields an empty page, not page one.
      const oldest = (await store.list(userId, 5))[4]!;
      expect(await store.list(userId, 5, { createdAt: oldest.createdAt, id: oldest.id })).toEqual(
        [],
      );
    });

    it("reads nothing for a non-positive limit and clamps an unbounded one", async () => {
      const userId = await freshUser();
      await seedFive(userId, `ntf_lim_${tag}_`);
      expect(await store.list(userId, 0)).toEqual([]);
      expect(await store.list(userId, -1)).toEqual([]);
      expect(await store.list(userId, Number.MAX_SAFE_INTEGER)).toHaveLength(5);
      expect(await store.list(userId, Number.NaN)).toEqual([]);
    });

    it("counts, marks one, and marks all read for one user", async () => {
      const userId = await freshUser();
      const ids = await seedFive(userId, `ntf_read_${tag}_`);
      expect(await store.unreadCount(userId)).toBe(5);

      // Marking returns whether THIS call changed the row, so a double-click
      // cannot report two reads.
      expect(await store.markRead(userId, ids[0]!, 9_000)).toBe(true);
      expect(await store.markRead(userId, ids[0]!, 9_001)).toBe(false);
      expect(await store.unreadCount(userId)).toBe(4);
      const marked = (await store.list(userId, 10)).find((r) => r.id === ids[0]!)!;
      expect(marked.readAt).toBe(9_000);

      expect(await store.markAllRead(userId, 9_100)).toBe(4);
      expect(await store.unreadCount(userId)).toBe(0);
      // Already-read rows keep their original timestamp; mark-all is not a reset.
      expect((await store.list(userId, 10)).find((r) => r.id === ids[0]!)!.readAt).toBe(9_000);
      // Nothing left to change.
      expect(await store.markAllRead(userId, 9_200)).toBe(0);
      // A row that does not exist is false, not a throw.
      expect(await store.markRead(userId, `ntf_missing_${tag}`, 9_300)).toBe(false);
    });

    it("keeps one user's tray out of another's, including the writes", async () => {
      const mine = await freshUser();
      const theirs = await freshUser();
      await store.create({
        id: `ntf_mine_${tag}`,
        userId: mine,
        orgId: null,
        kind: "comment.reply",
        title: "mine",
        createdAt: 1,
      });
      await store.create({
        id: `ntf_yours_${tag}`,
        userId: theirs,
        orgId: null,
        kind: "comment.reply",
        title: "theirs",
        createdAt: 2,
      });

      expect((await store.list(mine, 10)).map((r) => r.id)).toEqual([`ntf_mine_${tag}`]);
      expect((await store.list(theirs, 10)).map((r) => r.id)).toEqual([`ntf_yours_${tag}`]);
      expect(await store.unreadCount(mine)).toBe(1);

      // The tenancy boundary is on the WRITE too: knowing another user's
      // notification id must not be enough to mark it, and must not error in a
      // way that tells the caller the row exists.
      expect(await store.markRead(theirs, `ntf_mine_${tag}`, 5)).toBe(false);
      expect(await store.markAllRead(theirs, 6)).toBe(1);
      expect(await store.unreadCount(mine)).toBe(1);
      expect((await store.list(mine, 10))[0]!.readAt).toBeNull();
    });

    it("resolves the shipped default for every kind when no row exists", async () => {
      const userId = await freshUser();
      for (const kind of NOTIFICATION_KINDS) {
        const resolved = await store.preference(userId, kind);
        const shipped = defaultPreference(kind);
        // The point of the design (schema.ts:456-460): a kind needs no backfill,
        // so absence has to answer with the catalogue's default in both stores.
        expect(resolved).toEqual({
          kind,
          inApp: shipped.inApp,
          email: shipped.email,
          explicit: false,
        });
      }
      // And the settings screen's one query answers for every kind, in order.
      const all = await store.preferences(userId);
      expect(all.map((p) => p.kind)).toEqual([...NOTIFICATION_KINDS]);
      expect(all.every((p) => p.explicit === false)).toBe(true);
    });

    it("stores an explicit preference, reports it as explicit, and clears back to the default", async () => {
      const userId = await freshUser();
      await store.setPreference({
        userId,
        kind: "comment.mention",
        inApp: "off",
        email: "off",
        updatedAt: 50,
      });
      expect(await store.preference(userId, "comment.mention")).toEqual({
        kind: "comment.mention",
        inApp: "off",
        email: "off",
        explicit: true,
      });
      // One row per (user, kind): a second write updates rather than duplicating.
      await store.setPreference({
        userId,
        kind: "comment.mention",
        inApp: "on",
        email: "off",
        updatedAt: 60,
      });
      const after = await store.preferences(userId);
      expect(after.filter((p) => p.explicit)).toHaveLength(1);
      expect(after.find((p) => p.kind === "comment.mention")).toEqual({
        kind: "comment.mention",
        inApp: "on",
        email: "off",
        explicit: true,
      });
      // Other kinds are untouched by a write to this one.
      expect(await store.preference(userId, "board.invited")).toMatchObject({ explicit: false });

      // Clearing deletes the row, so the kind follows the catalogue again -- and
      // reports whether there was anything to clear.
      expect(await store.clearPreference(userId, "comment.mention")).toBe(true);
      expect(await store.clearPreference(userId, "comment.mention")).toBe(false);
      const shipped = defaultPreference("comment.mention");
      expect(await store.preference(userId, "comment.mention")).toEqual({
        kind: "comment.mention",
        inApp: shipped.inApp,
        email: shipped.email,
        explicit: false,
      });
    });

    it("keeps one user's preferences out of another's", async () => {
      const mine = await freshUser();
      const theirs = await freshUser();
      await store.setPreference({
        userId: mine,
        kind: "board.invited",
        inApp: "off",
        email: "off",
        updatedAt: 1,
      });
      expect(await store.preference(theirs, "board.invited")).toMatchObject({ explicit: false });
      expect((await store.preferences(theirs)).every((p) => !p.explicit)).toBe(true);
    });

    const origin = "https://app.example.test";

    it("notify() writes the row and sends the mail when both defaults are on", async () => {
      const userId = await freshUser();
      const orgId = await freshOrg();
      const mailer = mailbox();
      // board.invited defaults to email:on -- without the link the recipient has
      // no route to the board at all.
      expect(defaultPreference("board.invited").email).toBe("on");
      const outcome = await notify(
        { store, mailer, siteOrigin: origin },
        {
          kind: "board.invited",
          to: { userId, email: "ada@example.test" },
          orgId,
          payload: { boardId: "brd_9", boardName: "Roadmap", inviterName: "Ada", role: "editor" },
          at: 4_000,
        },
      );
      expect(outcome.emailed).toBe(true);
      expect(outcome.emailSkipped).toBeUndefined();
      // The row stores what it said (title/body/link composed once, at write
      // time) and the payload it said it from.
      const row = outcome.notification!;
      expect(row.title).toBe('Ada shared "Roadmap" with you');
      expect(row.link).toBe("/?board=brd_9");
      expect(row.createdAt).toBe(4_000);
      expect(row.orgId).toBe(orgId);
      expect(row.metadata).toMatchObject({ boardId: "brd_9", role: "editor" });
      expect((await store.list(userId, 10)).map((r) => r.id)).toEqual([row.id]);
      expect(await store.unreadCount(userId)).toBe(1);
      // The mail carries the same words plus an absolute link.
      expect(mailer.sent).toHaveLength(1);
      expect(mailer.sent[0]!.to).toBe("ada@example.test");
      expect(mailer.sent[0]!.subject).toBe('Ada shared "Roadmap" with you');
      expect(mailer.sent[0]!.text).toContain(`${origin}/?board=brd_9`);
    });

    it("notify() delivers in-app only for a kind whose email default is off", async () => {
      const userId = await freshUser();
      const mailer = mailbox();
      // comment.reply volume scales with how lively a thread is, so it must not
      // reach the inbox by default.
      expect(defaultPreference("comment.reply").email).toBe("off");
      const outcome = await notify(
        { store, mailer, siteOrigin: origin },
        {
          kind: "comment.reply",
          to: { userId, email: "ada@example.test" },
          orgId: null,
          payload: {
            boardId: "brd_1",
            boardName: "Roadmap",
            authorName: "Bo",
            body: "shipped",
            commentId: "c1",
          },
          at: 1,
        },
      );
      expect(outcome.notification).toBeDefined();
      expect(outcome.emailed).toBe(false);
      expect(outcome.emailSkipped).toBe("preference");
      expect(mailer.sent).toHaveLength(0);
    });

    it("notify() honours an explicit off on each channel independently", async () => {
      const userId = await freshUser();
      const mailer = mailbox();
      const payload = {
        boardId: "brd_2",
        boardName: "Atlas",
        inviterName: "Ada",
        role: "viewer",
      } as const;

      // In-app off, email on: mail goes out, nothing lands in the tray.
      await store.setPreference({
        userId,
        kind: "board.invited",
        inApp: "off",
        email: "on",
        updatedAt: 1,
      });
      const first = await notify(
        { store, mailer, siteOrigin: origin },
        {
          kind: "board.invited",
          to: { userId, email: "ada@example.test" },
          orgId: null,
          payload,
          at: 1,
        },
      );
      expect(first.notification).toBeUndefined();
      expect(first.emailed).toBe(true);
      expect(await store.list(userId, 10)).toEqual([]);

      // In-app on, email off: the reverse, and the two decisions are independent.
      await store.setPreference({
        userId,
        kind: "board.invited",
        inApp: "on",
        email: "off",
        updatedAt: 2,
      });
      const second = await notify(
        { store, mailer, siteOrigin: origin },
        {
          kind: "board.invited",
          to: { userId, email: "ada@example.test" },
          orgId: null,
          payload,
          at: 2,
        },
      );
      expect(second.notification).toBeDefined();
      expect(second.emailed).toBe(false);
      expect(second.emailSkipped).toBe("preference");
      expect(mailer.sent).toHaveLength(1);

      // Both off: the notification is dropped entirely, which is the user's
      // stated wish and must not be an error.
      await store.setPreference({
        userId,
        kind: "board.invited",
        inApp: "off",
        email: "off",
        updatedAt: 3,
      });
      const third = await notify(
        { store, mailer, siteOrigin: origin },
        {
          kind: "board.invited",
          to: { userId, email: "ada@example.test" },
          orgId: null,
          payload,
          at: 3,
        },
      );
      expect(third.notification).toBeUndefined();
      expect(third.emailed).toBe(false);
      expect(await store.list(userId, 10)).toHaveLength(1);
      expect(mailer.sent).toHaveLength(1);
    });

    it("notify() with no mailer delivers in-app and never throws", async () => {
      const userId = await freshUser();
      // A deployment with no SMTP configured is a supported deployment, the same
      // way `AuthContext.mailer` is optional (accounts.ts:226).
      const outcome = await notify(
        { store, siteOrigin: origin },
        {
          kind: "org.invited",
          to: { userId, email: "ada@example.test" },
          orgId: null,
          payload: { orgName: "Acme", inviterName: "Ada", role: "editor" },
          at: 7,
        },
      );
      expect(outcome.notification).toBeDefined();
      expect(outcome.emailed).toBe(false);
      expect(outcome.emailSkipped).toBe("no-mailer");
      expect(await store.unreadCount(userId)).toBe(1);
    });

    it("notify() keeps the in-app row when the mailer throws", async () => {
      const userId = await freshUser();
      // THE case this ordering exists for: the tray is the record, the mail is
      // the optional channel, so a dead SMTP server must not cost the user the
      // notification -- and must not fail the request that triggered it.
      const outcome = await notify(
        { store, mailer: brokenMailer, siteOrigin: origin },
        {
          kind: "board.role_changed",
          to: { userId, email: "ada@example.test" },
          orgId: null,
          payload: { boardId: "brd_3", boardName: "Atlas", role: "viewer", byName: "Ada" },
          at: 8,
        },
      );
      expect(outcome.emailed).toBe(false);
      expect(outcome.emailSkipped).toBe("send-failed");
      expect(outcome.notification).toBeDefined();
      const rows = await store.list(userId, 10);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.title).toBe('Your role on "Atlas" is now a viewer');
      expect(await store.unreadCount(userId)).toBe(1);
    });

    it("notify() skips the mail when there is no address and when there is no origin", async () => {
      const userId = await freshUser();
      const mailer = mailbox();
      const payload = { orgName: "Acme", inviterName: "Ada", role: "editor" } as const;

      // A user row with no usable address (or a recipient resolved from a
      // membership rather than an account) still gets the tray entry.
      const noAddress = await notify(
        { store, mailer, siteOrigin: origin },
        { kind: "org.invited", to: { userId, email: null }, orgId: null, payload, at: 1 },
      );
      expect(noAddress.notification).toBeDefined();
      expect(noAddress.emailSkipped).toBe("no-address");

      // A relative link in a mail goes nowhere, so without an origin the mail is
      // not worth sending -- but the notification still is.
      const noOrigin = await notify(
        { store, mailer },
        {
          kind: "board.invited",
          to: { userId, email: "ada@example.test" },
          orgId: null,
          payload: { boardId: "brd_4", boardName: "Atlas", inviterName: "Ada", role: "editor" },
          at: 2,
        },
      );
      expect(noOrigin.notification).toBeDefined();
      expect(noOrigin.emailSkipped).toBe("no-site-origin");
      expect(mailer.sent).toHaveLength(0);
      expect(await store.unreadCount(userId)).toBe(2);
    });

    it("notify() writes the catalogue's text for every kind it can be asked for", async () => {
      const userId = await freshUser();
      // Walks the whole catalogue rather than the kinds this file happens to
      // name: a kind added without text, or with an unrenderable payload, fails
      // here instead of shipping an empty tray row.
      for (const [n, kind] of NOTIFICATION_KINDS.entries()) {
        const content = composeNotification(kind, samplePayload(kind));
        const outcome = await notify(
          { store, siteOrigin: origin },
          {
            kind,
            to: { userId },
            orgId: null,
            payload: samplePayload(kind),
            id: `ntf_cat_${tag}_${n}`,
            at: 100 + n,
          },
        );
        // Every kind defaults to in-app on, so every kind lands.
        expect(outcome.notification).toBeDefined();
        expect(outcome.notification!.title).toBe(content.title);
        expect(outcome.notification!.title.length).toBeGreaterThan(0);
        expect(outcome.notification!.body).toBe(content.body);
        expect(outcome.notification!.link).toBe(content.link);
      }
      expect(await store.unreadCount(userId)).toBe(NOTIFICATION_KINDS.length);
    });
  });
}

/** One valid payload per kind, so a test can walk the whole catalogue. */
const SAMPLE_PAYLOADS: { [K in NotificationKind]: NotificationPayloads[K] } = {
  "org.invited": {
    orgName: "Acme",
    inviterName: "Ada",
    role: "editor",
    acceptPath: "/invite?token=t1",
  },
  "org.member_joined": { orgName: "Acme", memberName: "Bo", orgId: "org_1" },
  "board.invited": { boardId: "brd_1", boardName: "Roadmap", inviterName: "Ada", role: "viewer" },
  "board.member_joined": { boardId: "brd_1", boardName: "Roadmap", memberName: "Bo" },
  "board.role_changed": { boardId: "brd_1", boardName: "Roadmap", role: "editor", byName: "Ada" },
  "comment.mention": {
    boardId: "brd_1",
    boardName: "Roadmap",
    authorName: "Bo",
    body: "@ada look",
    commentId: "c1",
  },
  "comment.reply": {
    boardId: "brd_1",
    boardName: "Roadmap",
    authorName: "Bo",
    body: "agreed",
    commentId: "c2",
  },
  "meeting.invited": {
    boardId: "brd_1",
    boardName: "Roadmap",
    meetingId: "mtg_1",
    title: "Launch sync",
    scheduledFor: Date.UTC(2026, 9, 3, 14, 0),
    durationMin: 30,
    hostName: "Ada",
    updated: false,
  },
  "meeting.cancelled": {
    boardId: "brd_1",
    boardName: "Roadmap",
    meetingId: "mtg_1",
    title: "Launch sync",
    scheduledFor: Date.UTC(2026, 9, 3, 14, 0),
    durationMin: 30,
    byName: "Ada",
  },
};

function samplePayload<K extends NotificationKind>(kind: K): NotificationPayloads[K] {
  return SAMPLE_PAYLOADS[kind];
}

/**
 * The catalogue and the helpers both stores share, asserted once. These are what
 * make the contract above the same contract in both directions: if
 * `normalizeNotification` were not idempotent, a row read out of one store could
 * not be written into the other unchanged.
 */
describe("notification catalogue", () => {
  it("cannot drift from the kind list", () => {
    expect(Object.keys(NOTIFICATION_CATALOGUE).sort()).toEqual([...NOTIFICATION_KINDS].sort());
    expect(new Set(NOTIFICATION_KINDS).size).toBe(NOTIFICATION_KINDS.length);
  });

  it("ships the delivery defaults the product decided on", () => {
    // Written out rather than derived, so changing a default is a deliberate
    // edit to this table and not a silent change to everyone's inbox.
    const expected: Record<NotificationKind, { inApp: Toggle; email: Toggle }> = {
      "org.invited": { inApp: "on", email: "on" },
      "org.member_joined": { inApp: "on", email: "off" },
      "board.invited": { inApp: "on", email: "on" },
      "board.member_joined": { inApp: "on", email: "off" },
      "board.role_changed": { inApp: "on", email: "on" },
      "comment.mention": { inApp: "on", email: "on" },
      "comment.reply": { inApp: "on", email: "off" },
      // docs/28 A3.4: the mail carries the calendar invite.
      "meeting.invited": { inApp: "on", email: "on" },
      "meeting.cancelled": { inApp: "on", email: "on" },
    };
    for (const kind of NOTIFICATION_KINDS) expect(defaultPreference(kind)).toEqual(expected[kind]);
    // In-app is on everywhere: the tray is the cheap, pull-based channel.
    expect(NOTIFICATION_KINDS.every((k) => defaultPreference(k).inApp === "on")).toBe(true);
    // Email only where the recipient cannot get the information by opening the
    // app later, or is addressed by name.
    expect(NOTIFICATION_KINDS.filter((k) => defaultPreference(k).email === "on")).toEqual([
      "org.invited",
      "board.invited",
      "board.role_changed",
      "comment.mention",
      "meeting.invited",
      "meeting.cancelled",
    ]);
  });

  it("gives every kind settings copy and renderable text", () => {
    for (const kind of NOTIFICATION_KINDS) {
      const spec = NOTIFICATION_CATALOGUE[kind];
      expect(spec.label.length).toBeGreaterThan(0);
      expect(spec.description.length).toBeGreaterThan(0);
      const content = composeNotification(kind, samplePayload(kind));
      expect(content.title.length).toBeGreaterThan(0);
      // No unresolved placeholder ever reaches a user.
      expect(content.title).not.toContain("undefined");
      expect(content.body ?? "").not.toContain("undefined");
    }
  });

  it("links a board notification at the SPA's deep link, encoded", () => {
    const content = composeNotification("comment.mention", {
      boardId: "brd/1 2",
      boardName: "Roadmap",
      authorName: "Bo",
      body: "  @ada    look   here  ",
      commentId: "c1",
    });
    // `?board=` is the workspace route's param (ui/Chrome.tsx:126), and an id is
    // encoded rather than concatenated.
    expect(content.link).toBe("/?board=brd%2F1%202");
    // Comment bodies are collapsed for a one-line tray entry.
    expect(content.body).toBe("@ada look here");
    // A kind with nowhere to go says so rather than linking at the root.
    expect(
      composeNotification("org.member_joined", samplePayload("org.member_joined")).link,
    ).toBeNull();
  });

  it("truncates a long comment body instead of storing an essay in the tray", () => {
    const content = composeNotification("comment.reply", {
      boardId: "brd_1",
      boardName: "Roadmap",
      authorName: "Bo",
      body: "x".repeat(500),
      commentId: "c1",
    });
    expect(content.body!.length).toBeLessThanOrEqual(140);
    expect(content.body!.endsWith("…")).toBe(true);
  });

  it("narrows a kind from the wire and rejects anything else", () => {
    // The prefs route's gate: the column is free text, so this is what keeps a
    // preference from being stored for a kind nothing will ever read.
    for (const kind of NOTIFICATION_KINDS) expect(isNotificationKind(kind)).toBe(true);
    expect(isNotificationKind("comment.mentions")).toBe(false);
    expect(isNotificationKind("")).toBe(false);
    expect(isNotificationKind("__proto__")).toBe(false);
  });
});

describe("notification helpers", () => {
  it("clamps a page size to NOTIFICATION_PAGE_MAX", () => {
    expect(clampNotificationLimit(20)).toBe(20);
    expect(clampNotificationLimit(NOTIFICATION_PAGE_MAX)).toBe(NOTIFICATION_PAGE_MAX);
    expect(clampNotificationLimit(NOTIFICATION_PAGE_MAX + 10_000)).toBe(NOTIFICATION_PAGE_MAX);
    expect(clampNotificationLimit(10.7)).toBe(10);
    expect(clampNotificationLimit(0)).toBe(0);
    expect(clampNotificationLimit(-5)).toBe(0);
    expect(clampNotificationLimit(Number.NaN)).toBe(0);
    expect(clampNotificationLimit(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it("mints sortable, unique ids", () => {
    expect(newNotificationId()).toMatch(/^ntf_[0-9a-z]+$/);
    expect(newNotificationId()).not.toBe(newNotificationId());
  });

  it("fills a write shape's optional columns and is idempotent", () => {
    const row = normalizeNotification({
      userId: "usr_1",
      orgId: null,
      kind: "comment.mention",
      title: "Bo mentioned you",
      createdAt: 3,
    });
    expect(row.id.startsWith("ntf_")).toBe(true);
    expect(row).toMatchObject({ body: null, link: null, metadata: {}, readAt: null });
    // A row read out of one store replays into the other unchanged, which is what
    // lets a single contract test assert against both.
    expect(normalizeNotification(row)).toEqual(row);
  });

  it("resolves absence to the default and a row to itself", () => {
    expect(resolvePreference("comment.mention", undefined)).toEqual({
      kind: "comment.mention",
      ...defaultPreference("comment.mention"),
      explicit: false,
    });
    expect(
      resolvePreference("comment.mention", {
        userId: "usr_1",
        kind: "comment.mention",
        inApp: "off",
        email: "off",
        updatedAt: 1,
      }),
    ).toEqual({ kind: "comment.mention", inApp: "off", email: "off", explicit: true });
    // Every kind is answered, in catalogue order, from however few rows exist.
    const all = resolvePreferences([
      { userId: "usr_1", kind: "board.invited", inApp: "off", email: "off", updatedAt: 1 },
    ]);
    expect(all.map((p) => p.kind)).toEqual([...NOTIFICATION_KINDS]);
    expect(all.filter((p) => p.explicit).map((p) => p.kind)).toEqual(["board.invited"]);
  });

  it("renders mail with an absolute link and escaped copy", () => {
    const content = composeNotification("comment.mention", {
      boardId: "brd_1",
      boardName: "<script>Roadmap</script>",
      authorName: "Bo",
      body: "look & see",
      commentId: "c1",
    });
    // A trailing slash on the configured origin must not double up.
    const mail = notificationEmail(content, {
      siteOrigin: "https://app.example.test/",
      productName: "Lucent",
    });
    expect(mail.subject).toBe(content.title);
    expect(mail.text).toContain("https://app.example.test/?board=brd_1");
    expect(mail.text).toContain("look & see");
    // A board name is user input and goes into HTML mail; `templates.ts` escapes
    // for the same reason.
    expect(mail.html).not.toContain("<script>");
    expect(mail.html).toContain("&lt;script&gt;");
    expect(mail.html).toContain("look &amp; see");
  });

  it("renders mail for a notification with nowhere to go", () => {
    const content = composeNotification("org.member_joined", samplePayload("org.member_joined"));
    const mail = notificationEmail(content, { siteOrigin: "https://app.example.test" });
    expect(mail.subject).toBe("Bo joined Acme");
    expect(mail.html).not.toContain("<a href");
    expect(mail.text).not.toContain("https://");
  });
});
