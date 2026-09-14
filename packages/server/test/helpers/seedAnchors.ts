import type { Db } from "../../src/db/client.js";
import { boards, organizations, users } from "../../src/db/schema.js";

/**
 * Seed the FK anchors a Postgres test needs (P5).
 *
 * WHY THIS EXISTS. Half the Postgres suites assert store behaviour — "does
 * presence merge across instances", "does the outbox deliver" — and never
 * cared about foreign keys. The constraints are real (`presence.board_id →
 * boards`, which FKs org and owner), so those suites only ever passed while
 * they were not being run against a real database. Several of them were not,
 * which is how the latent defects in `pg-integrations` and `presence` were
 * hiding.
 *
 * Seeding the anchors once, here, is the fix: a suite that wants to assert
 * semantics should not have to reconstruct identity to do it. Idempotent, so
 * it is safe in a `beforeEach`.
 *
 * NOTE the explicit `emailVerifiedAt: null`. Drizzle's insert overloads
 * cannot infer it from omission on a nullable column, and the resulting
 * type error is noise that hides real ones.
 */
export interface AnchorOptions {
  orgId?: string;
  userId?: string;
  boardIds?: string[];
  email?: string;
}

export async function seedAnchors(db: Db, options: AnchorOptions = {}): Promise<void> {
  const orgId = options.orgId ?? "org-test";
  const userId = options.userId ?? "usr_test";
  const now = Date.now();

  await db.db
    .insert(organizations)
    .values({ id: orgId, name: `Org ${orgId}`, createdAt: now })
    .onConflictDoNothing();

  await db.db
    .insert(users)
    .values({
      id: userId,
      email: options.email ?? `${userId}@example.com`,
      name: userId,
      passwordHash: "x",
      tokenVersion: 0,
      emailVerifiedAt: null,
      createdAt: now,
    })
    .onConflictDoNothing();

  for (const boardId of options.boardIds ?? []) {
    await db.db
      .insert(boards)
      .values({
        id: boardId,
        orgId,
        ownerId: userId,
        name: `Board ${boardId}`,
        workspace: { nodes: {}, edges: {}, groups: {} } as never,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();
  }
}
