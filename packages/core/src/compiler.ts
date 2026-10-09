import type { Workspace } from "./model.js";
import type { Operation } from "./operations.js";
import type { SemanticPlan } from "./plan.js";

export interface CompileDiagnostic {
  severity: "error" | "warning";
  code:
    | "AMBIGUOUS_LABEL"
    | "INVALID_EXISTING_ID"
    | "UNRESOLVED_ENDPOINT"
    | "UNRESOLVED_REFERENCE"
    | "SELF_CONNECTION";
  message: string;
  ref?: string;
}

export interface CompileResult {
  ok: boolean;
  operations: Operation[];
  diagnostics: CompileDiagnostic[];
  idMap: Map<string, string>; // symbolic ref -> canonical ID
}

/**
 * Deterministic Operation Compiler.
 *
 * Compiles an intermediate symbolic SemanticPlan into canonical Lucent Operations.
 * Enforces strict reference resolution, prevents edge-ID hallucination by construction,
 * preserves relationship types, and surfaces ambiguous or invalid references as diagnostics.
 */
export function compileSemanticPlan(
  workspace: Workspace,
  plan: SemanticPlan,
  idGenerator: () => string = () => Math.random().toString(36).slice(2, 10),
): CompileResult {
  const operations: Operation[] = [];
  const diagnostics: CompileDiagnostic[] = [];
  const refToCanonicalId = new Map<string, string>();

  const existingNodeIds = new Set(Object.keys(workspace.nodes));
  const labelCounts = new Map<string, number>();
  const singleLabelNode = new Map<string, string>();

  for (const node of Object.values(workspace.nodes)) {
    const norm = node.label.trim().toLowerCase();
    labelCounts.set(norm, (labelCounts.get(norm) ?? 0) + 1);
    singleLabelNode.set(norm, node.id);
  }

  // 1. Pre-allocate Group IDs and map node membership
  const refToGroupId = new Map<string, string>();
  const nodeRefToGroupId = new Map<string, string>();

  for (const group of plan.groups) {
    const groupId = `grp_${idGenerator()}`;
    refToGroupId.set(group.ref, groupId);
    for (const memberRef of group.memberRefs) {
      nodeRefToGroupId.set(memberRef, groupId);
    }
  }

  // 2. Resolve Node IDs (pre-pass to map all refs)
  for (const node of plan.nodes) {
    if (node.existingNodeId) {
      if (existingNodeIds.has(node.existingNodeId)) {
        refToCanonicalId.set(node.ref, node.existingNodeId);
      } else {
        diagnostics.push({
          severity: "error",
          code: "INVALID_EXISTING_ID",
          message: `Referenced node ID "${node.existingNodeId}" does not exist on canvas.`,
          ref: node.ref,
        });
      }
      continue;
    }

    const normLabel = node.label.trim().toLowerCase();
    if (plan.intent.mutationScope !== "new_canvas") {
      const count = labelCounts.get(normLabel) ?? 0;
      if (count === 1) {
        // Unique verified alias resolution on existing board
        refToCanonicalId.set(node.ref, singleLabelNode.get(normLabel)!);
        continue;
      } else if (count > 1) {
        diagnostics.push({
          severity: "error",
          code: "AMBIGUOUS_LABEL",
          message: `Label "${node.label}" matches multiple nodes on canvas. Disambiguate with explicit existingNodeId.`,
          ref: node.ref,
        });
        continue;
      }
    }

    const canonicalId = `node_${idGenerator()}`;
    refToCanonicalId.set(node.ref, canonicalId);
  }

  // 3. Emit TRANSFORM_DIAGRAM if target representation differs on empty canvas or new_canvas
  if (
    plan.intent.targetKind &&
    plan.intent.targetKind !== workspace.diagramKind &&
    (plan.intent.mutationScope === "new_canvas" || Object.keys(workspace.nodes).length === 0)
  ) {
    operations.push({
      op: "TRANSFORM_DIAGRAM",
      to: plan.intent.targetKind,
    });
  }

  // 4. Emit CREATE_GROUP operations (must precede CREATE_NODE for validator)
  for (const group of plan.groups) {
    const groupId = refToGroupId.get(group.ref)!;
    const children = group.memberRefs
      .map((r) => refToCanonicalId.get(r))
      .filter((id): id is string => Boolean(id));

    operations.push({
      op: "CREATE_GROUP",
      id: groupId,
      label: group.label,
      children,
    });
  }

  // 4. Emit CREATE_NODE operations (for newly allocated nodes)
  for (const node of plan.nodes) {
    const canonicalId = refToCanonicalId.get(node.ref);
    if (!canonicalId || node.existingNodeId) continue;
    const normLabel = node.label.trim().toLowerCase();
    if (plan.intent.mutationScope !== "new_canvas" && (labelCounts.get(normLabel) ?? 0) === 1) {
      continue; // already exists on board
    }

    const assignedGroupId = nodeRefToGroupId.get(node.ref);
    operations.push({
      op: "CREATE_NODE",
      id: canonicalId,
      label: node.label,
      nodeType: node.role ?? "default",
      ...(assignedGroupId ? { groupId: assignedGroupId } : {}),
    });
  }

  // 3. Compile Edges with Strict Endpoint Verification and Relationship Preservation
  for (const edge of plan.edges) {
    const sourceId =
      refToCanonicalId.get(edge.from) ?? (existingNodeIds.has(edge.from) ? edge.from : null);
    const targetId =
      refToCanonicalId.get(edge.to) ?? (existingNodeIds.has(edge.to) ? edge.to : null);

    if (!sourceId || !targetId) {
      diagnostics.push({
        severity: "error",
        code: "UNRESOLVED_REFERENCE",
        message: `Edge connects unresolved reference: from="${edge.from}", to="${edge.to}".`,
      });
      continue;
    }

    if (sourceId === targetId) {
      diagnostics.push({
        severity: "error",
        code: "SELF_CONNECTION",
        message: `Self-connection on node "${sourceId}" is invalid.`,
      });
      continue;
    }

    // Preserve semantic relation in Core's relationship field
    const relationship =
      edge.relation && edge.relation !== "relates_to"
        ? edge.relation
        : edge.label || edge.relation || "";

    operations.push({
      op: "CONNECT_NODES",
      source: sourceId,
      target: targetId,
      relationship,
    });
  }

  const hasFatalErrors = diagnostics.some((d) => d.severity === "error");
  return {
    ok: !hasFatalErrors,
    operations,
    diagnostics,
    idMap: refToCanonicalId,
  };
}
