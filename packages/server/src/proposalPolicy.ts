import type { Operation, SemanticPlan } from "@lucent/core";

export const DESTRUCTIVE_OPS: ReadonlySet<string> = new Set([
  "DELETE_NODE",
  "DELETE_GROUP",
  "DELETE_SHAPE",
  "DELETE_WIREFRAME",
  "TRANSFORM_DIAGRAM",
  "DISCONNECT_NODES",
  "DISCONNECT_SHAPES",
  "CLEAR_VOTES",
  "REMOVE_VOTE",
  "REMOVE_REACTION",
  "DELETE_COMMENT",
]);

export const HIGH_IMPACT_SCOPES: ReadonlySet<string> = new Set([
  "reorganize_only",
  "restructure_board",
  "transform_family",
  "reorganize",
]);

export type ProposalPolicyMode = "auto" | "propose" | "never" | "always";

export interface ProposalPolicyInput {
  operations: readonly Operation[];
  plan?: SemanticPlan;
  mode?: ProposalPolicyMode;
  existingNodeCount?: number;
  threshold?: number;
  forceApply?: boolean;
}

export interface ProposalPolicyDecision {
  requiresProposal: boolean;
  reason?: string;
  riskLevel: "low" | "medium" | "high" | "critical";
  destructiveOps: string[];
  isHighImpact: boolean;
}

export function isDestructiveOperation(op: Operation): boolean {
  return DESTRUCTIVE_OPS.has(op.op);
}

export function isHighImpactOperation(op: Operation): boolean {
  if (isDestructiveOperation(op)) return true;
  if (op.op === "SET_GROUP_KIND") return true;
  return false;
}

/**
 * Evaluates whether an incoming plan or set of operations must be gated behind
 * a human-reviewed Proposal instead of being committed directly.
 *
 * Invariant: Destructive or high-impact plans MUST NOT bypass human review
 * simply because operation count <= threshold (e.g. single-op deletions).
 */
export function evaluateProposalPolicy(input: ProposalPolicyInput): ProposalPolicyDecision {
  const {
    operations,
    plan,
    mode = "auto",
    existingNodeCount = 0,
    threshold = 5,
    forceApply = false,
  } = input;

  const destructiveOps = operations
    .filter((op) => {
      // Transforming an empty canvas to the target diagram kind is non-destructive initialization.
      // Transforming an existing diagram with nodes is high-impact / destructive restructuring.
      if (op.op === "TRANSFORM_DIAGRAM" && existingNodeCount === 0) {
        return false;
      }
      return isDestructiveOperation(op);
    })
    .map((o) => o.op);
  const hasDestructive = destructiveOps.length > 0;

  const mutationScope = plan?.intent.mutationScope;
  const isHighImpactScope = Boolean(mutationScope && HIGH_IMPACT_SCOPES.has(mutationScope));
  const hasHighImpactOp = operations.some((op) => {
    if (op.op === "TRANSFORM_DIAGRAM" && existingNodeCount === 0) {
      return false;
    }
    return isHighImpactOperation(op);
  });
  const isHighImpact = hasDestructive || isHighImpactScope || hasHighImpactOp;

  let riskLevel: ProposalPolicyDecision["riskLevel"] = "low";
  if (hasDestructive) {
    riskLevel = "critical";
  } else if (isHighImpact || (existingNodeCount > 0 && operations.length > threshold)) {
    riskLevel = "high";
  } else if (operations.length > threshold) {
    riskLevel = "medium";
  }

  if (forceApply) {
    return {
      requiresProposal: false,
      reason: "Force applied by authorized caller",
      riskLevel,
      destructiveOps,
      isHighImpact,
    };
  }

  // Explicit proposal requested
  if (mode === "always" || mode === "propose") {
    return {
      requiresProposal: true,
      reason: "Proposal required by explicit policy or user preference",
      riskLevel,
      destructiveOps,
      isHighImpact,
    };
  }

  // Destructive operations always require human review, even under mode="never"
  // ("Never — auto-apply, still review destructive/external")
  if (hasDestructive) {
    const names = [...new Set(destructiveOps)].join(", ");
    return {
      requiresProposal: true,
      reason: `Plan contains destructive operation (${names}) requiring human review before applying`,
      riskLevel: "critical",
      destructiveOps,
      isHighImpact: true,
    };
  }

  // High-impact architectural scope requires review
  if (isHighImpactScope) {
    return {
      requiresProposal: true,
      reason: `Architectural restructuring scope '${mutationScope}' requires human review`,
      riskLevel: "high",
      destructiveOps,
      isHighImpact: true,
    };
  }

  // If mode is "never" and there are no destructive ops, allow auto-apply
  if (mode === "never") {
    return {
      requiresProposal: false,
      reason: "Auto-applied under mode='never' (non-destructive)",
      riskLevel,
      destructiveOps,
      isHighImpact,
    };
  }

  // Standard threshold check on existing board
  if (existingNodeCount > 0 && operations.length > threshold) {
    return {
      requiresProposal: true,
      reason: `Large batch of ${operations.length} operations exceeds threshold (${threshold}) on non-empty board`,
      riskLevel: "high",
      destructiveOps,
      isHighImpact,
    };
  }

  return {
    requiresProposal: false,
    riskLevel,
    destructiveOps,
    isHighImpact,
  };
}
