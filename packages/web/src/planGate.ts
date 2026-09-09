import type { Operation } from "@lucent/core";

/**
 * The plan gate (Stage D2, ADR 0028): when a request is a PLAN, the model's
 * ops are filtered against an allowlist before they touch the board. The
 * acceptance rule is MECHANICAL, not taught: proposals and questions can
 * never silently convert, because the one op that converts them
 * (UPDATE_STATEMENT) is not in the list — no plan can resolve a question or
 * confirm a proposal; a human does that through the HUD, visibly.
 *
 * The MEETING_SAFE_OPS precedent (meeting-extract.ts) is the shape; this is
 * its plan sibling. Skipped ops surface through the existing partial-
 * application reporting (skippedNote rides the reply), so a gated plan is
 * honest about what it dropped.
 */

/**
 * The ops a plan may emit: creation and organization only. NOT UPDATE_
 * STATEMENT (lifecycle conversion is a human act), not DELETE_* (a plan
 * never destroys), not CHANGE_TEXT (a plan never rewrites existing
 * content), not the human-only ops (MOVE_NODE — already forbidden to the AI
 * everywhere).
 */
export const PLAN_SAFE_OPS: ReadonlySet<string> = new Set([
  "CREATE_NODE",
  "SET_STATEMENT",
  "SET_ISSUE",
  "UPDATE_ISSUE",
  "CREATE_GROUP",
  "CONNECT_NODES",
  "SET_GROUP_KIND",
]);

/** A skipped op as the reply's skippedNote renders it. */
export interface GatedOp {
  op: string;
  reason: string;
}

/**
 * Filter a plan batch to the allowlist. Returns the in-list ops (order
 * preserved) plus a descriptor for every skipped op — the caller appends
 * them to the chat reply's skippedNote so the user sees what the gate
 * refused, never a silent drop.
 */
export function gatePlanOps(
  ops: readonly Operation[],
): { allowed: Operation[]; skipped: GatedOp[] } {
  const allowed: Operation[] = [];
  const skipped: GatedOp[] = [];
  for (const op of ops) {
    if (PLAN_SAFE_OPS.has(op.op)) {
      allowed.push(op);
    } else {
      const record = op as unknown as Record<string, unknown>;
      const id = typeof record.id === "string" ? record.id : "?";
      skipped.push({
        op: op.op,
        reason: `plans cannot ${op.op.replace(/_/g, " ").toLowerCase()} (${id}) — lifecycle changes are a human act`,
      });
    }
  }
  return { allowed, skipped };
}

/**
 * The plan request text the Intelligence surface sends — the model sees the
 * instruction and the user sees an honest summary of what was asked. Pure
 * so the surface is node-tested.
 */
export function planRequestText(statementCount: number): string {
  const tail =
    "organize the decisions into a plan region, preserve existing actions with their owners and deadlines, derive new actions for requirements and risks, and link each derived action to the decision that drives it with a drives relationship. Proposals and questions are context — never create confirmed work from them.";
  return statementCount === 1
    ? `Create the work from this statement: ${tail}`
    : `Create the work from these ${statementCount} statements: ${tail}`;
}
