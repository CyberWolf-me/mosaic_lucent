import type { Operation, SemanticPlan, TrustCommitter } from "@lucent/core";
import {
  compileSemanticPlan,
  evaluateTopologyQuality,
  stampAuthorship,
  stampTrust,
  validateOperations,
} from "@lucent/core";
import { generateSemanticPlan, requestBoundedEdgeRepair } from "@lucent/ai";
import { commitBatch, type CommitOutcome } from "./commitBatch.js";
import { aiActor, userActor, type OperationActor } from "./boards.js";
import type { RouteServices } from "./routes/context.js";

import { evaluateProposalPolicy, type ProposalPolicyMode } from "./proposalPolicy.js";

export interface OrchestrateRequest {
  boardId: string;
  userId: string;
  prompt: string;
  actor: OperationActor | "user" | "agent";
  requestId?: string;
  expectedSeq?: number;
  /** Caller-supplied SemanticPlan (e.g. from agent or MCP). When provided, skips generation. */
  plan?: SemanticPlan;
  /** The role the route authorized (seeds the live room for a socket-less caller). */
  role?: import("./identity.js").Role;
  /** Policy mode: "auto" | "propose" | "never" | "always". */
  mode?: ProposalPolicyMode;
  /** Explicit override to apply directly without proposal gating. */
  forceApply?: boolean;
}

export type OrchestrateOutcome =
  | {
      ok: true;
      outcome: "committed";
      seq: number;
      operations: Operation[];
      plan: SemanticPlan;
      explanation: string;
      duplicate?: boolean;
    }
  | {
      ok: true;
      outcome: "proposed";
      proposalId: string;
      operations: Operation[];
      plan: SemanticPlan;
      explanation: string;
      reason: string;
    }
  | {
      ok: false;
      outcome: "unresolved";
      reason: string;
      partialPlan: SemanticPlan;
      diagnostics?: unknown[];
    }
  | {
      ok: false;
      outcome: "conflict";
      reason: string;
      headSeq?: number;
    }
  | {
      ok: false;
      outcome: "not_found";
      reason: string;
    };

/**
 * Unified Diagram Generation Orchestrator.
 *
 * Implements the single canonical pipeline from Multimodal Intent -> Semantic Plan ->
 * Deterministic Compilation -> Topology Quality Gate -> Canonical Mutation (ADR 0041).
 */
export async function orchestrateGeneration(
  services: RouteServices,
  req: OrchestrateRequest,
): Promise<OrchestrateOutcome> {
  // 1. Authoritative Board Load from Server Store (Never trust caller-supplied snapshot)
  const board = await services.boardStore.get(req.boardId);
  if (!board) {
    return {
      ok: false,
      outcome: "not_found",
      reason: `Board ${req.boardId} not found`,
    };
  }

  // 1.5 Optimistic Concurrency Pre-check: if caller specified expectedSeq, verify before expensive generation
  if (req.expectedSeq !== undefined) {
    const headSeq = await services.boardStore.latestSeq(req.boardId);
    if (req.expectedSeq !== headSeq) {
      return {
        ok: false,
        outcome: "conflict",
        reason: `Board sequence conflict: expected ${req.expectedSeq}, but current sequence is ${headSeq}`,
        headSeq,
      };
    }
  }

  // 2. Idempotency Check: if this requestId was already processed, return original outcome
  if (req.requestId) {
    const prior = await services.boardStore.findRequest(req.boardId, req.requestId);
    if (prior) {
      return {
        ok: true,
        outcome: "committed",
        seq: prior.seq,
        operations: [],
        plan: {
          intent: {
            userObjective: req.prompt,
            targetKind: board.workspace.diagramKind,
            expectedTopology: "directed_flow",
            mutationScope: "extend_region",
            focusNodeIds: [],
          },
          nodes: [],
          edges: [],
          groups: [],
          explanation: "Duplicate request already processed",
        },
        explanation: "Duplicate request already processed",
        duplicate: true,
      };
    }
  }

  // 3. Single-Turn Structured Semantic Plan Generation
  let plan = req.plan ?? (await generateSemanticPlan(services.provider, board.workspace, req.prompt));

  // 4. Deterministic Operation Compilation
  let compileRes = compileSemanticPlan(board.workspace, plan);
  if (!compileRes.ok) {
    return {
      ok: false,
      outcome: "unresolved",
      reason: `Plan compilation failed: ${compileRes.diagnostics.map((d) => d.message).join("; ")}`,
      partialPlan: plan,
      diagnostics: compileRes.diagnostics,
    };
  }

  // 5. Topology-Aware Quality Gate Evaluation (Pass 1)
  let quality = evaluateTopologyQuality(board.workspace, plan, compileRes.operations, false);

  // 6. Bounded Repair Pass (Only if REPAIRABLE)
  if (quality.outcome === "REPAIRABLE") {
    plan = await requestBoundedEdgeRepair(
      services.provider,
      board.workspace,
      plan,
      quality.missingConnections,
    );
    compileRes = compileSemanticPlan(board.workspace, plan);
    if (!compileRes.ok) {
      return {
        ok: false,
        outcome: "unresolved",
        reason: `Repaired plan compilation failed: ${compileRes.diagnostics.map((d) => d.message).join("; ")}`,
        partialPlan: plan,
        diagnostics: compileRes.diagnostics,
      };
    }

    // Pass 2 Quality Gate
    quality = evaluateTopologyQuality(board.workspace, plan, compileRes.operations, true);
    if (quality.outcome === "UNRESOLVED") {
      // Truthful Failure: Do NOT claim the graph is complete!
      return {
        ok: false,
        outcome: "unresolved",
        reason: quality.details,
        partialPlan: plan,
      };
    }
  }

  // 7. Authorship and Trust Stamping (ADR 0017, ADR 0047)
  const committer: TrustCommitter =
    req.actor === "agent" || (typeof req.actor === "object" && req.actor.actorType === "ai")
      ? "agent"
      : "requested";
  const stampedOps = stampTrust(
    stampAuthorship(compileRes.operations, req.userId),
    committer,
    board.workspace,
  );

  // 8. Final Invariant Validation before commit
  const valErrors = validateOperations(board.workspace, stampedOps);
  if (valErrors.length > 0) {
    return {
      ok: false,
      outcome: "unresolved",
      reason: `Validator rejected operations: ${valErrors[0]?.message ?? "invalid"}`,
      partialPlan: plan,
    };
  }

  // 8.5 Risk-based proposal policy evaluation (destructive and high-impact operations gate behind proposals)
  const existingNodeCount = Object.keys(board.workspace.nodes).length;
  const policy = evaluateProposalPolicy({
    operations: stampedOps,
    plan,
    mode: req.mode,
    existingNodeCount,
    forceApply: req.forceApply,
  });

  if (policy.requiresProposal && services.proposals) {
    const record = await services.proposals.create({
      boardId: req.boardId,
      orgId: board.orgId,
      request: req.prompt,
      explanation: plan.explanation || "AI Proposed Changes",
      operations: stampedOps,
      createdBy: req.userId,
      createdAt: Date.now(),
    });

    if (services.broadcastProposal) {
      services.broadcastProposal(req.boardId, {
        type: "proposal-opened",
        proposal: record.proposal,
      });
    }

    return {
      ok: true,
      outcome: "proposed",
      proposalId: record.proposal.id,
      operations: stampedOps,
      plan,
      explanation: plan.explanation || "AI Proposed Changes",
      reason: policy.reason ?? "Gated behind review",
    };
  }

  // 9. Commit via the Canonical Mutation Path (Room.commit -> Op Log -> Store, ADR 0041)
  const opActor: OperationActor =
    typeof req.actor === "object" && "actorType" in req.actor
      ? req.actor
      : req.actor === "agent"
        ? aiActor(req.userId)
        : userActor(req.userId);

  const outcome: CommitOutcome = await commitBatch(
    services,
    board,
    req.userId,
    stampedOps,
    plan.explanation || "AI Diagram Construction",
    opActor,
    {
      expectedSeq: req.expectedSeq,
      requestId: req.requestId,
      ...(req.role ? { role: req.role } : {}),
    },
  );

  if (!outcome.ok) {
    return {
      ok: false,
      outcome: "conflict",
      reason: outcome.reason,
      headSeq: outcome.head,
    };
  }

  return {
    ok: true,
    outcome: "committed",
    seq: outcome.seq,
    operations: stampedOps,
    plan,
    explanation: plan.explanation || "Applied diagram updates.",
    ...(outcome.duplicate ? { duplicate: true } : {}),
  };
}
