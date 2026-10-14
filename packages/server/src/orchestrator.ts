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
  };
}
