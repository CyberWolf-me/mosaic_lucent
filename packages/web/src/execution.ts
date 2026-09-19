import type { Node, Workspace } from "@lucent/core";
import {
  actionNodes,
  blockingChains,
  decisionsBehindAction,
  derivedExecution,
  executionRollup,
  needsAttention,
} from "@lucent/core";

/**
 * The Execution projection (Stage E2, ADR 0037).
 *
 * INTELLIGENCE-IS-A-PROJECTION's sibling doctrine, applied to execution:
 * this module is pure over the workspace the client already holds. No
 * fetches, no routes, no stores — the rollup, the blocking chains, and the
 * decisions-behind rows are derived per render from `actionNodes` +
 * `derivedExecution` + the drives graph, exactly what ADR 0027's
 * read-time-projection clause blesses. The view renders what these
 * functions decide; the tests drive them without the DOM.
 */

/** One chain row: the blocked target and its blocker-first story. */
export interface ChainRow {
  nodeId: string;
  /** Label chips in blocker-first order, ids kept for the reveal jump. */
  chain: Array<{ id: string; label: string }>;
}

/** One "decision behind the work" row: the action and the decision that caused it. */
export interface DecisionBehindRow {
  actionId: string;
  actionLabel: string;
  decisionId: string;
  decisionLabel: string;
}

/** Everything the Execution view renders, derived in one pass. */
export interface ExecutionProjection {
  rollup: ReturnType<typeof executionRollup>;
  chains: ChainRow[];
  decisionsBehind: DecisionBehindRow[];
  /** The empty-state flag: a board with no executable work. */
  empty: boolean;
  /**
   * The attention layer (Phase 3): "What needs my attention?" — blocked,
   * overdue, open decisions, and new meeting statements, each with the node
   * pointer the reveal jump needs. Pure over the workspace, per ADR 0027.
   */
  attention: ReturnType<typeof needsAttention>;
}

/**
 * Stage E3: the plan-derived actions a Send-to-provider bridge carries —
 * the executable nodes whose createdFrom provenance names a plan
 * derivation (ADR 0022's evidence, the bridge's selection). A board with
 * no plan (or a plan whose work is all done and unlinked) answers [].
 */
export function planDerivedActionIds(workspace: Workspace): string[] {
  return actionNodes(workspace)
    .filter((n) => (n.provenance?.createdFrom?.length ?? 0) > 0)
    .map((n) => n.id);
}

/**
 * The full projection. Chains walk the blocking story blocker-first;
 * decisions-behind rows cover the in-progress/blocked actions whose drives
 * edges name a decision — the E1 payoff made visible on the dashboard.
 */
export function executionProjection(workspace: Workspace, now: number): ExecutionProjection {
  const rollup = executionRollup(workspace, now);
  const chains: ChainRow[] = blockingChains(workspace, now).map((c) => ({
    nodeId: c.nodeId,
    chain: c.chain.map((n: Node) => ({ id: n.id, label: n.label })),
  }));
  const decisionsBehind: DecisionBehindRow[] = [];
  for (const action of actionNodes(workspace)) {
    const derived = derivedExecution(workspace, now).get(action.id);
    const active =
      action.issue?.status === "in_progress" ||
      action.issue?.status === "blocked" ||
      (derived?.blockedBy.length ?? 0) > 0;
    if (!active) continue;
    for (const decision of decisionsBehindAction(workspace, action.id)) {
      decisionsBehind.push({
        actionId: action.id,
        actionLabel: action.label,
        decisionId: decision.id,
        decisionLabel: decision.label,
      });
    }
  }
  return {
    rollup,
    chains,
    decisionsBehind,
    empty: rollup.total === 0,
    attention: needsAttention(workspace, now),
  };
}
