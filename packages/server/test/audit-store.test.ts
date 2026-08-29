import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AUDIT_PAGE_MAX,
  InMemoryOrgStore,
  PostgresOrgStore,
  clampAuditLimit,
  normalizeAuditEntry,
  type AuditCursor,
  type AuditEntry,
  type OrgStore,
  type StoredAuditEntry,
} from "../src/orgs.js";
import { closeDb, createDb, type Db } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";

/**
 * Audit-store parity contract (M2.6).
 *
 * This file exists because of a defect, and its job is to make that defect
 * unmergeable. `PostgresOrgStore.audit()` was `void _entry;` and `auditFor()`
 * returned `[]`, while `InMemoryOrgStore` recorded and read back correctly.
 * Every audit assertion in the suite ran against the in-memory store, so the
 * suite stayed green while production wrote nothing at all: the audit viewer
 * (`GET /api/orgs/:id/audit`) answered `{ entries: [] }` forever and the
 * Enterprise-tier requirement was satisfied only in tests.
 *
 * So each property below is written once and asserted against BOTH
 * implementations of `OrgStore`. A stub cannot pass them, and a change that
 * teaches one store something the other does not know fails here instead of in
 * production.
 *
 * The Postgres half is gated on LUCENT_TEST_DATABASE_URL — the same convention
 * as pg-store.test.ts, pg-bootstrap.test.ts and boardListing.test.ts; CI
 * supplies a `postgres:16` service and runs `db:migrate` first. Without the
 * variable that describe block is reported as skipped rather than quietly
 * disappearing, which is the whole point: `npm test` locally proves the shape,
 * `npm test` in CI proves the SQL.
 */

const URL = process.env.LUCENT_TEST_DATABASE_URL;

/**
 * Unique per run, so this file needs no TRUNCATE: wiping the shared tables
 * would race the other pg suites, which truncate in their own `beforeAll`.
 * Every id here carries the tag and every assertion is scoped to it.
 */
const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

interface Impl {
  name: string;
  enabled: boolean;
  open: () => Promise<OrgStore>;
  close: () => Promise<void>;
}

let db: Db | undefined;

const impls: Impl[] = [
  {
    name: "InMemoryOrgStore",
    enabled: true,
    open: async () => new InMemoryOrgStore(),
    close: async () => {},
  },
  {
    name: "PostgresOrgStore",
    enabled: Boolean(URL),
    open: async () => {
      db = createDb(URL!);
      await migrate(db);
      return new PostgresOrgStore(db);
    },
    close: async () => {
      if (!db) return;
      // Leave the shared CI database as it was found. Audit rows cascade with
      // the org, so deleting this run's orgs is enough.
      await db.pool
        .query("DELETE FROM organizations WHERE id LIKE $1", [`org_aud_${tag}%`])
        .catch(() => {});
      await closeDb(db);
      db = undefined;
    },
  },
];

/**
 * Walk every page with `size`-row pages and return the ids in the order they
 * came back, asserting no row is ever handed out twice.
 */
async function pageAll(store: OrgStore, orgId: string, size: number): Promise<string[]> {
  const seen: string[] = [];
  let cursor: AuditCursor | undefined;
  // Bounded, so a broken cursor fails the test instead of hanging the run.
  for (let page = 0; page < 20; page += 1) {
    const rows: StoredAuditEntry[] = await store.auditFor(orgId, size, cursor);
    if (rows.length === 0) return seen;
    for (const row of rows) {
      expect(seen).not.toContain(row.id);
      seen.push(row.id);
    }
    const tail = rows[rows.length - 1]!;
    cursor = { at: tail.at, id: tail.id };
  }
  throw new Error("pagination did not terminate");
}

for (const impl of impls) {
  const suite = impl.enabled ? describe : describe.skip;

  suite(`audit store contract — ${impl.name}`, () => {
    let store: OrgStore;
    let orgCount = 0;

    beforeAll(async () => {
      if (!impl.enabled) return;
      store = await impl.open();
    });

    afterAll(async () => {
      if (!impl.enabled) return;
      await impl.close();
    });

    /**
     * A fresh org per test. One store instance serves the whole file (the
     * Postgres one owns a pool), and `audit_log.org_id` is a real FK, so the
     * org row has to exist before anything can be written against it.
     */
    async function freshOrg(): Promise<string> {
      orgCount += 1;
      const id = `org_aud_${tag}_${orgCount}`;
      await store.insert({ id, name: `Audit ${orgCount}`, createdAt: 1 });
      return id;
    }

    /** Exactly the write shape app.ts passes today: `subject`, no target columns. */
    function legacy(orgId: string, over: Partial<AuditEntry> = {}): AuditEntry {
      return {
        orgId,
        actorId: "usr_aud_actor",
        action: "org.rename",
        subject: orgId,
        ip: "203.0.113.7",
        metadata: { name: "Renamed" },
        at: 1_700_000_000_000,
        ...over,
      };
    }

    /**
     * Five entries where two pairs share a millisecond, so the expected order
     * only holds if the tiebreak works. Returns the ids newest-first.
     */
    async function seedFive(orgId: string, prefix: string): Promise<string[]> {
      const ats = [1000, 2000, 2000, 3000, 3000];
      for (let n = 1; n <= 5; n += 1) {
        await store.audit(
          legacy(orgId, { id: `${prefix}${n}`, at: ats[n - 1]!, action: `org.step${n}` }),
        );
      }
      // (at DESC, id DESC) → 3000/5, 3000/4, 2000/3, 2000/2, 1000/1.
      return [5, 4, 3, 2, 1].map((n) => `${prefix}${n}`);
    }

    it("writes a legacy `subject` entry and reads back every column", async () => {
      const orgId = await freshOrg();
      await store.audit(legacy(orgId));
      const rows = await store.auditFor(orgId, 10);
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row.id.startsWith("aud_")).toBe(true);
      expect(row.orgId).toBe(orgId);
      expect(row.actorId).toBe("usr_aud_actor");
      expect(row.action).toBe("org.rename");
      // subject → target_id, and target_type derived from the action's first
      // segment so `audit_log_target_idx` can still find the row.
      expect(row.targetId).toBe(orgId);
      expect(row.targetType).toBe("org");
      expect(row.subject).toBe(orgId);
      expect(row.ip).toBe("203.0.113.7");
      expect(row.metadata).toEqual({ name: "Renamed" });
      expect(row.at).toBe(1_700_000_000_000);
      // Columns the legacy callers do not send.
      expect(row.actorEmail).toBeNull();
      expect(row.userAgent).toBeNull();
    });

    it("prefers targetType/targetId over subject, and still mirrors subject", async () => {
      const orgId = await freshOrg();
      await store.audit(
        legacy(orgId, {
          action: "board.member.role_changed",
          subject: "superseded_by_target_id",
          targetType: "board",
          targetId: "brd_42",
          actorEmail: "owner@example.com",
          userAgent: "Mozilla/5.0",
        }),
      );
      const row = (await store.auditFor(orgId, 10))[0]!;
      expect(row.targetType).toBe("board");
      expect(row.targetId).toBe("brd_42");
      expect(row.subject).toBe("brd_42");
      expect(row.actorEmail).toBe("owner@example.com");
      expect(row.userAgent).toBe("Mozilla/5.0");
    });

    it("records a targetless, actorless entry — system actions have neither", async () => {
      const orgId = await freshOrg();
      await store.audit({ orgId, actorId: null, action: "plan.downgraded", ip: null, at: 5 });
      const row = (await store.auditFor(orgId, 10))[0]!;
      expect(row.actorId).toBeNull();
      expect(row.targetType).toBeNull();
      expect(row.targetId).toBeNull();
      expect(row.subject).toBe("");
      expect(row.ip).toBeNull();
      expect(row.metadata).toEqual({});
    });

    it("returns newest first, breaking a same-millisecond tie by id", async () => {
      const orgId = await freshOrg();
      const expected = await seedFive(orgId, `aud_ord_${tag}_`);
      const rows = await store.auditFor(orgId, 10);
      expect(rows.map((r) => r.id)).toEqual(expected);
      expect(rows.map((r) => r.at)).toEqual([3000, 3000, 2000, 2000, 1000]);
    });

    it("pages on (at, id) without repeating or skipping a boundary row", async () => {
      const orgId = await freshOrg();
      const expected = await seedFive(orgId, `aud_pag_${tag}_`);
      // Size 1 puts a boundary *inside* each tie group — the case an `at`-only
      // cursor gets wrong, by re-reading or losing the row that shares the ms.
      expect(await pageAll(store, orgId, 1)).toEqual(expected);
      // A boundary that lands between groups must behave identically.
      expect(await pageAll(store, orgId, 2)).toEqual(expected);
      expect(await pageAll(store, orgId, 5)).toEqual(expected);
      // The cursor built from the oldest row yields an empty page, not the
      // first page again.
      const oldest = (await store.auditFor(orgId, 5))[4]!;
      expect(await store.auditFor(orgId, 5, { at: oldest.at, id: oldest.id })).toEqual([]);
    });

    it("reads nothing for a non-positive limit and survives an unbounded one", async () => {
      const orgId = await freshOrg();
      await seedFive(orgId, `aud_lim_${tag}_`);
      expect(await store.auditFor(orgId, 0)).toEqual([]);
      expect(await store.auditFor(orgId, -1)).toEqual([]);
      expect(await store.auditFor(orgId, Number.MAX_SAFE_INTEGER)).toHaveLength(5);
    });

    it("never returns another org's entries", async () => {
      const a = await freshOrg();
      const b = await freshOrg();
      await store.audit(legacy(a, { id: `aud_scope_${tag}_a` }));
      await store.audit(legacy(b, { id: `aud_scope_${tag}_b` }));
      expect((await store.auditFor(a, 10)).map((r) => r.id)).toEqual([`aud_scope_${tag}_a`]);
      expect((await store.auditFor(b, 10)).map((r) => r.id)).toEqual([`aud_scope_${tag}_b`]);
    });

    it("is append-only: a duplicate id is rejected, never an overwrite", async () => {
      const orgId = await freshOrg();
      const id = `aud_append_${tag}`;
      await store.audit(legacy(orgId, { id, action: "org.rename" }));
      await expect(
        store.audit(legacy(orgId, { id, action: "org.history_rewritten" })),
      ).rejects.toThrow();
      const rows = await store.auditFor(orgId, 10);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.action).toBe("org.rename");
    });

    it("keeps both rows when the same action is audited twice", async () => {
      const orgId = await freshOrg();
      await store.audit(legacy(orgId, { at: 10 }));
      await store.audit(legacy(orgId, { at: 20 }));
      const rows = await store.auditFor(orgId, 10);
      expect(rows).toHaveLength(2);
      expect(new Set(rows.map((r) => r.id)).size).toBe(2);
    });

    it("hands out detached rows: mutating a read cannot rewrite history", async () => {
      const orgId = await freshOrg();
      await store.audit(legacy(orgId, { metadata: { name: "before" } }));
      const row = (await store.auditFor(orgId, 10))[0]!;
      row.action = "tampered";
      (row.metadata as { name: string }).name = "after";
      const again = (await store.auditFor(orgId, 10))[0]!;
      expect(again.action).toBe("org.rename");
      expect(again.metadata).toEqual({ name: "before" });
    });

    it("gives metadata JSONB semantics in both stores", async () => {
      const orgId = await freshOrg();
      await store.audit(
        legacy(orgId, {
          metadata: { kept: 1, dropped: undefined, when: new Date(0), nested: { ok: true } },
        }),
      );
      const row = (await store.auditFor(orgId, 10))[0]!;
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

    it("drops an entry whose org is gone instead of throwing, losing the trail with it", async () => {
      const orgId = await freshOrg();
      await store.audit(legacy(orgId));
      expect(await store.auditFor(orgId, 10)).toHaveLength(1);
      await store.delete(orgId);
      // `DELETE /api/orgs/:id` (app.ts) deletes the org and audits `org.delete`
      // *after*. `audit_log.org_id` is a cascading FK, so that write
      // has nothing to point at — and must not turn a completed delete into a
      // 500. It is logged and dropped, in both stores.
      await expect(store.audit(legacy(orgId, { action: "org.delete" }))).resolves.toBeUndefined();
      expect(await store.auditFor(orgId, 10)).toEqual([]);
    });
  });
}

/**
 * The mapping and clamping both stores share, asserted once. These are the
 * pieces that make the contract above the same contract in both directions:
 * if `normalizeAuditEntry` were not idempotent, a row read out of one store
 * could not be written into the other unchanged.
 */
describe("audit entry normalisation", () => {
  it("clamps a page size to AUDIT_PAGE_MAX", () => {
    expect(clampAuditLimit(100)).toBe(100);
    expect(clampAuditLimit(AUDIT_PAGE_MAX)).toBe(AUDIT_PAGE_MAX);
    expect(clampAuditLimit(AUDIT_PAGE_MAX + 100_000)).toBe(AUDIT_PAGE_MAX);
    expect(clampAuditLimit(10.7)).toBe(10);
    expect(clampAuditLimit(0)).toBe(0);
    expect(clampAuditLimit(-5)).toBe(0);
    expect(clampAuditLimit(Number.NaN)).toBe(0);
    expect(clampAuditLimit(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it("maps the legacy write shape onto the table's columns", () => {
    const row = normalizeAuditEntry({
      orgId: "org_x",
      actorId: "usr_x",
      action: "org.create",
      subject: "org_x",
      ip: null,
      metadata: {},
      at: 7,
    });
    expect(row).toMatchObject({
      targetType: "org",
      targetId: "org_x",
      subject: "org_x",
      actorEmail: null,
      userAgent: null,
      metadata: {},
    });
    expect(row.id.startsWith("aud_")).toBe(true);
  });

  it("treats an empty subject as no target at all", () => {
    const row = normalizeAuditEntry({
      orgId: "org_x",
      actorId: null,
      action: "account.deleted",
      subject: "",
      ip: null,
      at: 1,
    });
    expect(row.targetId).toBeNull();
    expect(row.targetType).toBeNull();
    expect(row.subject).toBe("");
  });

  it("is idempotent, so a row read from one store replays into the other", () => {
    const legacyRow = normalizeAuditEntry({
      orgId: "org_x",
      actorId: "usr_x",
      action: "board.deleted",
      subject: "brd_1",
      ip: "198.51.100.4",
      metadata: { n: 1 },
      at: 3,
    });
    const targetlessRow = normalizeAuditEntry({
      orgId: "org_x",
      actorId: null,
      action: "plan.changed",
      ip: null,
      at: 4,
    });
    for (const row of [legacyRow, targetlessRow]) {
      const replayed: AuditEntry = row;
      expect(normalizeAuditEntry(replayed)).toEqual(row);
    }
  });
});
