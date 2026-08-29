import type { Operation } from "./operations.js";

/**
 * Author id for content the AI wrote itself (M0.4).
 *
 * A `/api/generate` request with no signed-in user still produces comments and
 * annotations, and attributing those to a person would be a lie — that is what
 * the old `"me"` placeholder did. Deliberately outside the `usr_...` namespace
 * that `identity.ts` mints from, so it can never collide with a real account,
 * and it is the author-id spelling of the same actor the chat history already
 * calls `role: "ai"` (packages/ai/src/provider.ts).
 */
export const ASSISTANT_AUTHOR = "assistant";

/**
 * Author id for a record whose author was never captured (M0.4).
 *
 * Distinct from `ASSISTANT_AUTHOR` because "nobody recorded who did this" and
 * "the AI did this" are different facts, and only one of them is true of an
 * op_log row written before stamping existed. Reserved in the same way — no
 * `usr_...` prefix — so it can never be mistaken for an account, and greppable,
 * so it is visible in a board dump rather than hiding behind a plausible name.
 *
 * This is *not* the fallback for a live write path. Every path that validates is
 * refused outright when an authored op arrives without a `by` (see
 * `validator.ts`), so the only ops that land here are ones no live path can
 * reject: an already-durable op replayed out of the op log, and the throwaway
 * workspace `generate.ts` rebuilds from a client summary that carries vote
 * counts but no voters. Neither can be dropped — the first is real board
 * content, the second is what the model validates against — and neither has an
 * author to recover, so the honest answer is to say so.
 */
export const UNKNOWN_AUTHOR = "unknown";

/** The authored operations: the ones carrying a `by`. */
export type AuthoredOperation = Extract<
  Operation,
  { op: "ADD_COMMENT" | "REPLY_COMMENT" | "ADD_VOTE" | "ADD_REACTION" }
>;

/**
 * The single list of authorship-bearing operations.
 *
 * `stampAuthorship` and the validator both read it, because a second list to
 * keep in step is how an op ends up silently unstamped — which is exactly how
 * the MCP write path shipped without authorship at all.
 */
export function isAuthoredOperation(op: Operation): op is AuthoredOperation {
  return (
    op.op === "ADD_COMMENT" ||
    op.op === "REPLY_COMMENT" ||
    op.op === "ADD_VOTE" ||
    op.op === "ADD_REACTION"
  );
}

/**
 * An authored op that arrived without an author. Every member of
 * `AuthoredOperation` carries an `id`, which is what lets the validator name the
 * offending record in its message.
 */
export type UnauthoredOperation = AuthoredOperation & { by?: undefined };

/**
 * True when an authored op is missing the author the server owes it.
 *
 * A type predicate rather than a plain `boolean` so the narrowing is real: inside
 * the guard the operation is one of the four annotation kinds and `op.id` is a
 * field the compiler knows exists. That is what makes the validator's rule
 * *provably* read the same list `stampAuthorship` writes — a fifth authored op
 * added to `isAuthoredOperation` is covered by both automatically, and one that
 * lacked an `id` would fail to compile here rather than at runtime.
 *
 * The asserted type keeps `by?: undefined` so the negative branch stays honest:
 * an authored op that *does* have an author is not assignable to
 * `UnauthoredOperation`, so `!isUnauthored(op)` cannot narrow the four
 * annotation kinds away. Asserting plain `AuthoredOperation` would have.
 */
export function isUnauthored(op: Operation): op is UnauthoredOperation {
  return isAuthoredOperation(op) && op.by === undefined;
}

/**
 * Stamp authorship onto a batch of operations (M0.4).
 *
 * One rule: an authored op belongs to whoever the server says committed it. The
 * `by` a client sends is never trusted — it arrives over the same socket as the
 * rest of the batch, so honouring it would let any editor post a comment or a
 * vote as a colleague. `createdAt` is filled only when missing, so a replayed or
 * restored comment keeps its original time.
 *
 * The accepted cost: undo forwards inverse ops through `Room.commit`
 * (`web/src/workspace.tsx`), and `inverse.ts` rebuilds a deleted comment or a
 * cleared vote with its original author — so undoing the deletion of a peer's
 * comment re-attributes it to whoever pressed undo. Preserving that author
 * instead would mean trusting a client-supplied id, which is the spoofing hole;
 * the durable fix is for the server to derive inverses from its own op log
 * rather than accept them from a client.
 *
 * Returns a new array; the input is not mutated. Pure so the server (Room.commit,
 * generate.ts, MCP) and the client (OperationHistory, the web's send path)
 * can share one implementation.
 */
export function stampAuthorship(
  ops: readonly Operation[],
  userId: string,
  now: number = Date.now(),
): Operation[] {
  const out: Operation[] = [];
  for (const op of ops) {
    if (!isAuthoredOperation(op)) {
      out.push(op);
      continue;
    }
    // Only the comment ops carry a time; a vote or reaction has an author and
    // nothing else to fill in.
    out.push(
      op.op === "ADD_COMMENT" || op.op === "REPLY_COMMENT"
        ? { ...op, by: userId, createdAt: op.createdAt ?? now }
        : { ...op, by: userId },
    );
  }
  return out;
}
