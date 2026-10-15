import type { Workspace } from "./model.js";
import type { Operation } from "./operations.js";
import { applyOperations } from "./reducer.js";
import { validateOperations } from "./validator.js";
import { repairOperations } from "./repair.js";

export interface ProposalDiff {
  valid: boolean;
  errors?: string[];
  addedNodes: Array<{ id: string; label: string; nodeType: string }>;
  removedNodes: Array<{ id: string; label: string }>;
  modifiedNodes: Array<{ id: string; label: string; changes: string[] }>;
  addedEdges: Array<{ id: string; source: string; target: string; relationship: string }>;
  removedEdges: Array<{ id: string; source: string; target: string; relationship: string }>;
  markdown: string;
}

/**
 * Computes a human-readable visual pull request (PR) diff comparing the current workspace
 * to the projected workspace state resulting from proposed operations.
 */
export function computeProposalDiff(
  workspace: Workspace,
  rawOps: Operation[],
  title?: string,
): ProposalDiff {
  const repaired = repairOperations(rawOps, workspace);
  const errors = validateOperations(workspace, repaired);
  if (errors.length > 0) {
    return {
      valid: false,
      errors: errors.map((e) => e.message),
      addedNodes: [],
      removedNodes: [],
      modifiedNodes: [],
      addedEdges: [],
      removedEdges: [],
      markdown: `### Proposal Validation Failed\n${errors.map((e) => `- ${e.message}`).join("\n")}`,
    };
  }

  const nextWorkspace = applyOperations(workspace, repaired);

  const addedNodes: Array<{ id: string; label: string; nodeType: string }> = [];
  const removedNodes: Array<{ id: string; label: string }> = [];
  const modifiedNodes: Array<{ id: string; label: string; changes: string[] }> = [];

  for (const [id, nextNode] of Object.entries(nextWorkspace.nodes)) {
    const prevNode = workspace.nodes[id];
    if (!prevNode) {
      addedNodes.push({ id, label: nextNode.label, nodeType: nextNode.nodeType });
    } else {
      const changes: string[] = [];
      if (prevNode.label !== nextNode.label) {
        changes.push(`renamed "${prevNode.label}" → "${nextNode.label}"`);
      }
      if (prevNode.nodeType !== nextNode.nodeType) {
        changes.push(`type changed \`${prevNode.nodeType}\` → \`${nextNode.nodeType}\``);
      }
      if (!prevNode.statement && nextNode.statement) {
        changes.push(
          `added ${nextNode.statement.kind} statement${nextNode.statement.topic ? ` (${nextNode.statement.topic})` : ""}`,
        );
      } else if (prevNode.statement && nextNode.statement) {
        if (prevNode.statement.status !== nextNode.statement.status) {
          changes.push(`statement status \`${prevNode.statement.status}\` → \`${nextNode.statement.status}\``);
        }
      }
      if (!prevNode.issue && nextNode.issue) {
        changes.push(`attached issue "${nextNode.issue.type}" (${nextNode.issue.status})`);
      }
      if (changes.length > 0) {
        modifiedNodes.push({ id, label: nextNode.label, changes });
      }
    }
  }

  for (const [id, prevNode] of Object.entries(workspace.nodes)) {
    if (!nextWorkspace.nodes[id]) {
      removedNodes.push({ id, label: prevNode.label });
    }
  }

  const addedEdges: Array<{ id: string; source: string; target: string; relationship: string }> = [];
  const removedEdges: Array<{ id: string; source: string; target: string; relationship: string }> = [];

  for (const [id, nextEdge] of Object.entries(nextWorkspace.edges)) {
    if (!workspace.edges[id]) {
      addedEdges.push({
        id,
        source: nextWorkspace.nodes[nextEdge.source]?.label ?? nextEdge.source,
        target: nextWorkspace.nodes[nextEdge.target]?.label ?? nextEdge.target,
        relationship: nextEdge.relationship,
      });
    }
  }

  for (const [id, prevEdge] of Object.entries(workspace.edges)) {
    if (!nextWorkspace.edges[id]) {
      removedEdges.push({
        id,
        source: workspace.nodes[prevEdge.source]?.label ?? prevEdge.source,
        target: workspace.nodes[prevEdge.target]?.label ?? prevEdge.target,
        relationship: prevEdge.relationship,
      });
    }
  }

  const lines: string[] = [
    `### Visual Architecture Proposal: ${title ?? "Proposed Changes"}`,
    "",
  ];

  if (addedNodes.length > 0) {
    lines.push(`**Added Entities (+${addedNodes.length})**:`);
    for (const n of addedNodes) {
      lines.push(`- \`+ [${n.nodeType}] ${n.label}\``);
    }
    lines.push("");
  }

  if (removedNodes.length > 0) {
    lines.push(`**Removed Entities (-${removedNodes.length})**:`);
    for (const n of removedNodes) {
      lines.push(`- \`- ${n.label}\``);
    }
    lines.push("");
  }

  if (modifiedNodes.length > 0) {
    lines.push(`**Modified Entities (~${modifiedNodes.length})**:`);
    for (const m of modifiedNodes) {
      lines.push(`- **${m.label}**: ${m.changes.join(", ")}`);
    }
    lines.push("");
  }

  if (addedEdges.length > 0) {
    lines.push(`**New Connections (+${addedEdges.length})**:`);
    for (const e of addedEdges) {
      lines.push(`- \`+ ${e.source} --[${e.relationship}]--> ${e.target}\``);
    }
    lines.push("");
  }

  if (removedEdges.length > 0) {
    lines.push(`**Removed Connections (-${removedEdges.length})**:`);
    for (const e of removedEdges) {
      lines.push(`- \`- ${e.source} --[${e.relationship}]--> ${e.target}\``);
    }
    lines.push("");
  }

  return {
    valid: true,
    addedNodes,
    removedNodes,
    modifiedNodes,
    addedEdges,
    removedEdges,
    markdown: lines.join("\n"),
  };
}
