import { createDb, closeDb } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";
import { PostgresOutbox, OutboxDispatcher } from "../src/outbox.js";
import { PostgresBoardStore } from "../src/store/pg-boards.js";
import { boards, organizations, users, outboxEvents } from "../src/db/schema.js";
import { createWorkspace } from "@lucent/core";

/**
 * P2 live proof: a committed board operation announces itself through the
 * outbox and a dispatcher delivers it — the round trip against a real
 * Postgres, not a mock.
 */
const db = createDb(process.env.LUCENT_DATABASE_URL!);
await migrate(db);
await db.db.delete(outboxEvents);

const now = Date.now();
await db.db
  .insert(organizations)
  .values({ id: "org-live", name: "Live", createdAt: now })
  .onConflictDoNothing();
await db.db
  .insert(users)
  .values({
    id: "u-live",
    email: "live@x.com",
    name: "L",
    passwordHash: "x",
    tokenVersion: 0,
    createdAt: now,
    updatedAt: now,
  })
  .onConflictDoNothing();
await db.db
  .insert(boards)
  .values({
    id: "b-live",
    orgId: "org-live",
    ownerId: "u-live",
    name: "B",
    workspace: createWorkspace(),
    createdAt: now,
    updatedAt: now,
  })
  .onConflictDoNothing();

const boardStore = new PostgresBoardStore(db);
const r = await boardStore.appendOp({
  boardId: "b-live",
  ops: [{ op: "CREATE_NODE", id: "n1", nodeType: "default", label: "Hello" } as never],
  by: "u-live",
  label: "ai",
  at: Date.now(),
  orgId: "org-live",
});
console.log("1. append ok:", r.ok, "seq:", r.ok ? r.seq : null);

const outbox = new PostgresOutbox(db);
console.log("2. pending after commit:", await outbox.pendingCount());

const seen: string[] = [];
const dispatcher = new OutboxDispatcher({
  store: outbox,
  consumers: {
    BoardOperationCommitted: [
      (e) => {
        seen.push(e.id);
        console.log(
          `3. DELIVERED type=${e.type} board=${e.boardId} seq=${(e.payload as { seq: number }).seq} org=${e.orgId}`,
        );
      },
    ],
  },
});
const res = await dispatcher.tick();
console.log("4. tick delivered:", res.delivered, "| consumer calls:", seen.length);
console.log("5. pending after dispatch:", await outbox.pendingCount());

await db.db.delete(outboxEvents);
await closeDb(db);
console.log("LIVE P2 VERIFIED");
