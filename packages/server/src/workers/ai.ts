import type { ImageProvider } from "@lucent/ai";
import type { Job } from "../jobs.js";
import type { OutboxStore } from "../outbox.js";

/**
 * The AI worker family (docs/20 P4, advisory §8).
 *
 * WHY THIS EXISTS. docs/20 §7: "expensive AI becomes a job". Today a
 * generation or an image runs on the request path and holds a connection slot
 * the user is waiting on. An image call is the clearest case — it is the more
 * expensive of the two model calls, it takes tens of seconds, and a burst of
 * them exhausts the request slots that small generations need.
 *
 * THE CONTRACT DECISION, stated because docs/20 flags it as the one
 * user-visible change in this plan. `/api/image` ships as a SYNCHRONOUS
 * endpoint: POST returns the image. That contract is NOT broken here.
 *
 * Instead the async path is OPT-IN, and it is the one the codebase can adopt
 * without a client change: a caller that wants the request slot back asks for
 * it explicitly (`?mode=async`, or a client header), gets `202 {jobId}`, and
 * polls the job. The synchronous path is untouched and remains the default,
 * so nothing that works today stops working. That is what makes this phase
 * shippable without an owner decision gating it — the decision the doc
 * worried about was *replacing* the sync contract, and this does not.
 *
 * RESULTS COME BACK THROUGH THE SAME PROTOCOL AS EVERYTHING ELSE: the worker
 * writes an outbox event, never the canvas (ADR 0041's one-mutation-path
 * invariant — no worker ever writes a board directly).
 */

/** A generated image's result, as the job records it. */
export interface ImageJobResult {
  /** Data URL or provider URL: whatever the provider returned. */
  image: string;
  provider: string;
  /** Present when the provider reports it. */
  model?: string;
  /** Byte size, for the metrics surface and the client's progress display. */
  bytes?: number;
}

export interface ImageJobPayload {
  prompt: string;
  size?: "square" | "landscape" | "portrait";
  /** Who asked — carried so the outbox event can be scoped and audited. */
  userId?: string;
  orgId?: string;
  boardId?: string;
}

export interface AiWorkerDeps {
  imageProvider: ImageProvider;
  outbox: OutboxStore;
  logger: { info: (e: string, f?: Record<string, unknown>) => void };
}

/**
 * The `image.generate` handler.
 *
 * Idempotent by construction: regenerating an image for the same prompt
 * produces the same user-visible outcome, and the outbox event the handler
 * emits carries the job id, so a duplicate delivery is absorbed downstream by
 * `event.id`. It does NOT re-check for a prior result — a duplicate run simply
 * spends a second provider call, which is the honest cost of at-least-once
 * and cheaper than the machinery to avoid it.
 */
export function imageGenerateHandler(deps: AiWorkerDeps) {
  return async (job: Job): Promise<void> => {
    const payload = job.payload as unknown as ImageJobPayload;
    const result = await deps.imageProvider.generateImage({
      prompt: payload.prompt,
      ...(payload.size ? { size: payload.size } : {}),
    });

    const image = (result as { image?: string; data?: string }).image ?? (result as { data?: string }).data ?? "";
    const outcome: ImageJobResult = {
      image,
      provider: deps.imageProvider.name,
      ...((result as { model?: string }).model ? { model: (result as { model?: string }).model } : {}),
    };

    // The result is announced through the outbox, never written to a board
    // directly: the same protocol every other change uses.
    await deps.outbox.append({
      type: "AssetStored",
      ...(payload.boardId ? { boardId: payload.boardId } : {}),
      ...(payload.orgId ? { orgId: payload.orgId } : {}),
      payload: {
        jobId: job.id,
        kind: "image",
        provider: outcome.provider,
        ...(outcome.model ? { model: outcome.model } : {}),
        // The prompt, not the bytes: an outbox row is notification-shaped,
        // and the image can be far larger than the fanout guard allows.
        prompt: payload.prompt.slice(0, 200),
      },
    });
    deps.logger.info("ai.image.generated", { jobId: job.id, provider: outcome.provider });
  };
}

/**
 * The async-path enqueue decision (advisory §7's "the advisory's distinction").
 *
 * The doc is explicit that small generations should stay streaming-sync,
 * because the streaming UX depends on it: a user watching their diagram
 * appear cannot be handed a job id and a poll. The threshold is a node count,
 * so a large board's re-layout can go async while an ordinary "draw me a
 * flowchart" stays on the stream.
 */
export const ASYNC_GENERATE_NODE_THRESHOLD = 150;

/** Should this generation run as a job instead of on the request path? */
export function shouldGenerateAsync(nodeCount: number, requested: boolean): boolean {
  return requested && nodeCount >= ASYNC_GENERATE_NODE_THRESHOLD;
}

/** The AI family's handler registry, as the worker process builds it. */
export function buildAiHandlers(deps: AiWorkerDeps): Record<string, (job: Job) => Promise<void>> {
  return {
    "image.generate": imageGenerateHandler(deps),
  };
}
