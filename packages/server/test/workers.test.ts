import { describe, expect, it } from "vitest";
import { MockImageProvider } from "@lucent/ai";
import { InMemoryOutbox } from "../src/outbox.js";
import {
  ASYNC_GENERATE_NODE_THRESHOLD,
  buildAiHandlers,
  shouldGenerateAsync,
  type AiWorkerDeps,
} from "../src/workers/ai.js";
import { buildMediaHandlers, MEDIA_JOB_TYPES } from "../src/workers/media.js";
import { buildIntegrationHandlers, INTEGRATION_JOB_TYPES } from "../src/workers/integration.js";
import { InMemoryJobQueue, JobRunner, type Job } from "../src/jobs.js";

/**
 * P4 (docs/20, advisory §8) — the worker families.
 *
 * The properties docs/20 fixes for this phase:
 *
 *   - "job results appear through the same operation protocol (no worker ever
 *     writes the canvas directly — §38's invariant holds)": the AI handler
 *     announces through the OUTBOX, and nothing in this family touches a board
 *     store;
 *   - the async generate path is a THRESHOLD decision, not a blanket switch,
 *     because the streaming UX depends on small generations staying sync;
 *   - "one expensive image job does not occupy an HTTP slot" — expressed here
 *     as the job running through the queue rather than a request handler.
 */

const JOB = (payload: Record<string, unknown>): Job =>
  ({
    id: "job-1",
    family: "ai",
    type: "image.generate",
    payload,
    status: "claimed",
    attempts: 1,
    runAfter: 0,
    createdAt: 0,
  }) as Job;

function deps(overrides: Partial<AiWorkerDeps> = {}) {
  return {
    imageProvider: new MockImageProvider(),
    outbox: new InMemoryOutbox(),
    logger: { info: () => {} },
    ...overrides,
  } as AiWorkerDeps;
}

describe("the AI family — image.generate", () => {
  it("announces its result through the outbox, never a board write", async () => {
    // §38's invariant as a test: the handler's only output channel is the
    // outbox. There is no board store in AiWorkerDeps to write through, which
    // is the structural half of the guarantee.
    const d = deps();
    const handler = buildAiHandlers(d)["image.generate"]!;
    await handler(JOB({ prompt: "a cat", orgId: "org-1", boardId: "b1" }));

    const pending = await d.outbox.pending(10);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.type).toBe("AssetStored");
    expect(pending[0]!.orgId).toBe("org-1");
    expect(pending[0]!.boardId).toBe("b1");
    const payload = pending[0]!.payload as Record<string, unknown>;
    expect(payload.kind).toBe("image");
    expect(payload.jobId).toBe("job-1");
  });

  it("carries the prompt but NOT the image bytes in the event", async () => {
    // An outbox row is notification-shaped: the fanout payload-size rule
    // applies, and an image is orders of magnitude over it.
    const d = deps();
    await buildAiHandlers(d)["image.generate"]!(JOB({ prompt: "a cat" }));
    const [event] = await d.outbox.pending(10);
    const payload = event!.payload as Record<string, unknown>;
    expect(payload.prompt).toBe("a cat");
    expect(payload).not.toHaveProperty("image");
    expect(payload).not.toHaveProperty("data");
  });

  it("truncates a huge prompt in the event payload", async () => {
    const d = deps();
    const long = "x".repeat(5_000);
    await buildAiHandlers(d)["image.generate"]!(JOB({ prompt: long }));
    const [event] = await d.outbox.pending(10);
    expect(String((event!.payload as { prompt: string }).prompt).length).toBe(200);
  });

  it("a provider failure propagates, so the job is retried not silently lost", async () => {
    const d = deps({
      imageProvider: {
        name: "broken",
        generateImage: async () => {
          throw new Error("provider 502");
        },
      } as never,
    });
    await expect(buildAiHandlers(d)["image.generate"]!(JOB({ prompt: "x" }))).rejects.toThrow(
      "provider 502",
    );
    // Nothing announced for a failure: the job goes back to the queue.
    expect(await d.outbox.pendingCount()).toBe(0);
  });

  it("runs end to end through the queue and runner", async () => {
    const queue = new InMemoryJobQueue();
    const outbox = new InMemoryOutbox();
    await queue.enqueue({ family: "ai", type: "image.generate", payload: { prompt: "a cat" } });
    const runner = new JobRunner({
      queue,
      workerId: "w-ai",
      families: ["ai"],
      handlers: buildAiHandlers({ ...deps(), outbox }),
    });
    const result = await runner.tick();
    expect(result.completed).toBe(1);
    expect(await outbox.pendingCount()).toBe(1);
  });
});

describe("the async-generate threshold (advisory §7's distinction)", () => {
  it("small generations stay streaming-sync even when asked", () => {
    // The streaming UX depends on this: a user watching their diagram appear
    // cannot be handed a job id.
    expect(shouldGenerateAsync(10, true)).toBe(false);
    expect(shouldGenerateAsync(ASYNC_GENERATE_NODE_THRESHOLD - 1, true)).toBe(false);
  });

  it("a large generation may opt into the job path", () => {
    expect(shouldGenerateAsync(ASYNC_GENERATE_NODE_THRESHOLD, true)).toBe(true);
    expect(shouldGenerateAsync(500, true)).toBe(true);
  });

  it("it is OPT-IN: a large board on the default path stays synchronous", () => {
    // The shipped contract is untouched: nothing moves to async unless the
    // caller asks. This is what makes the phase shippable without breaking
    // the endpoint every existing client uses.
    expect(shouldGenerateAsync(500, false)).toBe(false);
  });
});

describe("the media and integration families", () => {
  it("media registers its reserved lane and runs a job through it", async () => {
    const handlers = buildMediaHandlers({ logger: { info: () => {} } });
    for (const type of MEDIA_JOB_TYPES) {
      expect(typeof handlers[type]).toBe("function");
    }
    // The claim path is real end to end, even though the body is reserved.
    const queue = new InMemoryJobQueue();
    await queue.enqueue({ family: "media", type: "export.render" });
    const runner = new JobRunner({ queue, workerId: "w-media", families: ["media"], handlers });
    expect((await runner.tick()).completed).toBe(1);
  });

  it("integration registers its lanes", () => {
    const handlers = buildIntegrationHandlers({ logger: { info: () => {} } });
    for (const type of INTEGRATION_JOB_TYPES) {
      expect(typeof handlers[type]).toBe("function");
    }
  });

  it("a worker claiming one family never picks up another's work", async () => {
    // The §8 split: an AI worker must not run a media export.
    const queue = new InMemoryJobQueue();
    await queue.enqueue({ family: "ai", type: "image.generate", payload: { prompt: "x" } });
    await queue.enqueue({ family: "media", type: "export.render" });
    const runner = new JobRunner({
      queue,
      workerId: "w-ai",
      families: ["ai"],
      handlers: buildAiHandlers(deps()),
    });
    const result = await runner.tick();
    expect(result.claimed).toBe(1);
    // The media job is untouched.
    expect((await queue.depth()).media).toBe(1);
  });
});
