import { and, desc, eq, inArray, notInArray } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { threadMessages, threads } from "../db/schema.js";
import {
  newThreadId,
  newThreadMessageId,
  THREAD_KEEP,
  THREAD_READ_DEFAULT,
  type NewThreadMessage,
  type ThreadMessage,
  type ThreadRole,
  type ThreadStore,
  type ThreadSurface,
} from "../threads.js";

/**
 * Postgres-backed conversation threads (docs/26 J7, ADR 0048). One thread row
 * per (person, scope), created on first append; messages trimmed to the
 * latest THREAD_KEEP after each append.
 */
export class PostgresThreadStore implements ThreadStore {
  constructor(private readonly target: Db) {}

  private async threadId(userId: string, scopeKey: string): Promise<string | undefined> {
    const rows = await this.target.db
      .select({ id: threads.id })
      .from(threads)
      .where(and(eq(threads.userId, userId), eq(threads.scopeKey, scopeKey)))
      .limit(1);
    return rows[0]?.id;
  }

  async messages(userId: string, scopeKey: string, limit = THREAD_READ_DEFAULT) {
    const id = await this.threadId(userId, scopeKey);
    if (!id) return [];
    const rows = await this.target.db
      .select()
      .from(threadMessages)
      .where(eq(threadMessages.threadId, id))
      .orderBy(desc(threadMessages.at), desc(threadMessages.id))
      .limit(limit);
    return rows.reverse().map(
      (r): ThreadMessage => ({
        id: r.id,
        role: r.role as ThreadRole,
        text: r.text,
        reply: r.reply,
        citations: Array.isArray(r.citations) ? (r.citations as unknown[]) : null,
        surface: r.surface as ThreadSurface,
        at: r.at,
      }),
    );
  }

  async append(
    userId: string,
    orgId: string,
    scopeKey: string,
    messages: readonly NewThreadMessage[],
  ) {
    const now = Date.now();
    return this.target.db.transaction(async (tx) => {
      await tx
        .insert(threads)
        .values({ id: newThreadId(), userId, orgId, scopeKey, createdAt: now, updatedAt: now })
        .onConflictDoUpdate({
          target: [threads.userId, threads.scopeKey],
          set: { updatedAt: now },
        });
      const [thread] = await tx
        .select({ id: threads.id })
        .from(threads)
        .where(and(eq(threads.userId, userId), eq(threads.scopeKey, scopeKey)))
        .limit(1);
      const added = messages.map((m) => ({ ...m, id: newThreadMessageId() }));
      if (added.length > 0) {
        await tx.insert(threadMessages).values(added.map((m) => ({ ...m, threadId: thread!.id })));
      }
      // Keep the latest THREAD_KEEP.
      const keep = await tx
        .select({ id: threadMessages.id })
        .from(threadMessages)
        .where(eq(threadMessages.threadId, thread!.id))
        .orderBy(desc(threadMessages.at), desc(threadMessages.id))
        .limit(THREAD_KEEP);
      if (keep.length === THREAD_KEEP) {
        await tx.delete(threadMessages).where(
          and(
            eq(threadMessages.threadId, thread!.id),
            notInArray(
              threadMessages.id,
              keep.map((k) => k.id),
            ),
          ),
        );
      }
      return added;
    });
  }

  async clear(userId: string, scopeKey: string) {
    const id = await this.threadId(userId, scopeKey);
    if (id)
      await this.target.db.delete(threadMessages).where(inArray(threadMessages.threadId, [id]));
  }
}
