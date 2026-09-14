import { createDb, closeDb } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";
import { MockImageProvider } from "@lucent/ai";
import { PostgresJobQueue, JobRunner } from "../src/jobs.js";
import { PostgresOutbox } from "../src/outbox.js";
import { buildAiHandlers } from "../src/workers/ai.js";
import { enqueueRecurring, workerId, RECURRING_JOBS } from "../src/roles.js";
import { jobs, outboxEvents } from "../src/db/schema.js";

/**
 * P4 live proof: an AI-family job claimed by a worker and run to completion,
 * with its result announced through the outbox — the §38 invariant
 * ("no worker ever writes the canvas directly") held end to end.
 */
const db = createDb(process.env.LUCENT_DATABASE_URL!);
await migrate(db);
await db.db.delete(jobs);
await db.db.delete(outboxEvents);

const queue = new PostgresJobQueue(db);
const outbox = new PostgresOutbox(db);

// An AI-family image job, as the async path would enqueue it.
await queue.enqueue({
  family: "ai",
  type: "image.generate",
  payload: { prompt: "a lighthouse at dusk", orgId: "org-live", boardId: "b-live" },
});
console.log("1. enqueued an ai/image.generate job");

const worker = new JobRunner({
  queue,
  workerId: workerId("live-ai"),
  families: ["ai"],
  handlers: buildAiHandlers({
    imageProvider: new MockImageProvider(),
    outbox,
    logger: { info: (e, f) => console.log(`   event: ${e} ${JSON.stringify(f ?? {})}`) },
  }),
});

const result = await worker.tick();
console.log(`2. worker claimed ${result.claimed}, completed ${result.completed}, failed ${result.failed}`);

const events = await db.db.select().from(outboxEvents);
console.log(`3. outbox rows: ${events.length}, type=${events[0]?.type ?? "none"}`);
const payload = (events[0]?.payload ?? {}) as Record<string, unknown>;
console.log(`4. payload kind=${payload.kind} prompt=${String(payload.prompt)} hasBytes=${"image" in payload}`);

// The recurring sweeps still work alongside a family job.
await enqueueRecurring(queue);
const depth = await queue.depth();
console.log(`5. recurring sweeps still enqueue: depth=${JSON.stringify(depth)}`);

await db.db.delete(jobs);
await db.db.delete(outboxEvents);
await closeDb(db);

const ok =
  result.completed === 1 &&
  events.length >= 1 &&
  events[0]?.type === "AssetStored" &&
  payload.kind === "image" &&
  !("image" in payload) &&
  Object.values(depth).reduce((a, b) => a + b, 0) === RECURRING_JOBS.length;
console.log(ok ? "LIVE P4 VERIFIED" : "LIVE P4 FAILED");
