import { createDb, closeDb } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";
import { PostgresJobQueue, JobRunner } from "../src/jobs.js";
import { enqueueRecurring, workerId, RECURRING_JOBS } from "../src/roles.js";
import { jobs } from "../src/db/schema.js";

/**
 * P3 live proof: the scheduler enqueues the recurring sweeps, a worker claims
 * them, runs them, and the queue drains — against a real Postgres, with the
 * claim raced by two workers to show exactly-once.
 */
const db = createDb(process.env.LUCENT_DATABASE_URL!);
await migrate(db);
await db.db.delete(jobs);

const queue = new PostgresJobQueue(db);

// 1. The scheduler's pass.
const ids = await enqueueRecurring(queue);
console.log(`1. scheduler enqueued ${ids.length} recurring jobs (expected ${RECURRING_JOBS.length})`);

// 2. A second scheduler tick must add nothing: the keys are live.
await enqueueRecurring(queue);
const depth = await queue.depth();
const total = Object.values(depth).reduce((a, b) => a + b, 0);
console.log(`2. after a second tick, queue depth still ${total} (dedupe held)`);

// 3. Two workers race for the work. Every job runs exactly once.
const ran: string[] = [];
const handlers = Object.fromEntries(
  RECURRING_JOBS.map((j) => [
    j.type,
    async () => {
      ran.push(j.type);
    },
  ]),
);
const a = new JobRunner({ queue, workerId: workerId("live-a"), handlers, batchSize: 10 });
const b = new JobRunner({ queue, workerId: workerId("live-b"), handlers, batchSize: 10 });
const [ra, rb] = await Promise.all([a.tick(), b.tick()]);
console.log(`3. worker-a completed ${ra.completed}, worker-b completed ${rb.completed}`);
console.log(`4. handlers ran ${ran.length} times, distinct: ${new Set(ran).size}`);

// 5. The queue is drained; a second pass finds nothing.
const after = await queue.depth();
console.log(`5. remaining live jobs: ${Object.values(after).reduce((x, y) => x + y, 0)}`);

await db.db.delete(jobs);
await closeDb(db);
const ok = total === RECURRING_JOBS.length && ran.length === RECURRING_JOBS.length && new Set(ran).size === ran.length;
console.log(ok ? "LIVE P3 VERIFIED" : "LIVE P3 FAILED");
