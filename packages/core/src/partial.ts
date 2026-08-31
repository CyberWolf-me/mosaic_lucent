import type { Workspace } from "./model.js";
import type { Operation } from "./operations.js";
import { applyOperations, applyOperation } from "./reducer.js";
import { validateOperations, type ValidationError } from "./validator.js";

/**
 * Partial application: apply every operation that validates, skip the rest,
 * and report exactly what was skipped and why (M1 operation reliability).
 *
 * WHY THIS EXISTS. A large AI generation is a batch of creates and connects
 * produced in one tool call; on a 40-op batch a single mis-referenced edge id
 * used to reject the ENTIRE batch — every node and every valid edge went to
 * zero because one `target node "x" does not exist` failed the strict gate.
 * The user saw a rephrase prompt and lost the whole generation. The correct
 * behaviour for an AI canvas is the partial one: 43 ops, 41 valid, 2 invalid
 * → apply 41, report 2.
 *
 * ONE CANONICAL SIMULATOR. There is deliberately no second interpretation of
 * operation semantics here — the classic failure mode of a partial applier is
 * "validator says ✓, applier says ✗" (or worse, the reverse), which happens
 * when the applier re-implements validity differently. This function does not
 * re-implement anything: it partitions the batch using `validateOperations`
 * itself, applied OVER THE SAME PREFIX-STATE the ops will actually run
 * against. A skipped op contributes nothing to the state later ops see, so
 * the simulation and the application provably agree.
 *
 * PREFIX SEMANTICS. Operations depend on earlier ones (create before connect,
 * group before member). An op is valid iff it validates against the state
 * formed by the ops BEFORE it — where "before" counts only ops that
 * themselves applied. That's exactly the sequential model `validateOperations`
 * simulates, re-run on the shrinking prefix after each skip.
 */
export interface PartialApplyResult {
  /** The workspace after applying every valid operation, in order. */
  workspace: Workspace;
  /** The operations that were applied, in application order. */
  applied: Operation[];
  /** The operations that were skipped, each with the validator's reason. */
  skipped: Array<{ op: Operation; reason: string }>;
}

export function applyValidOperations(
  workspace: Workspace,
  ops: readonly Operation[],
): PartialApplyResult {
  // Fast path: a clean batch needs one simulation and one reduce — the
  // common case costs nothing extra.
  if (validateOperations(workspace, [...ops]).length === 0) {
    return {
      workspace: applyOperations(workspace, [...ops]),
      applied: [...ops],
      skipped: [],
    };
  }

  const applied: Operation[] = [];
  const skipped: PartialApplyResult["skipped"] = [];
  let current = workspace;

  // Process one op at a time against the state it will really run against.
  // This is O(n) validations of O(1)-ish length each — validateOperations on a
  // 1-op batch — and keeps the "one simulator" guarantee trivially true.
  for (const op of ops) {
    const errors: ValidationError[] = validateOperations(current, [op]);
    if (errors.length === 0) {
      current = applyOperation(current, op);
      applied.push(op);
    } else {
      skipped.push({ op, reason: errors[0]?.message ?? "invalid operation" });
    }
  }

  return { workspace: current, applied, skipped };
}

/** True when every op in the batch passed validation (nothing was skipped). */
export function isCleanPartial(result: PartialApplyResult): boolean {
  return result.skipped.length === 0;
}
