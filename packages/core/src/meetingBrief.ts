import type { Workspace } from "./model.js";

export interface DecisionDelta {
  id: string;
  label: string;
  topic?: string;
}

export interface QuestionDelta {
  id: string;
  label: string;
  topic?: string;
}

export interface NodeDelta {
  id: string;
  label: string;
  nodeType: string;
}

export interface EdgeDelta {
  id: string;
  source: string;
  target: string;
  relationship: string;
}

export interface TaskDelta {
  id: string;
  label: string;
  status: string;
  assignee?: string;
  priority?: string;
}

export interface TaskUpdateDelta {
  id: string;
  label: string;
  fromStatus: string;
  toStatus: string;
}

export interface MeetingDeltaBrief {
  title: string;
  decisions: {
    settled: DecisionDelta[];
    superseded: DecisionDelta[];
  };
  questions: {
    resolved: QuestionDelta[];
    open: QuestionDelta[];
  };
  architecture: {
    addedNodes: NodeDelta[];
    removedNodes: Array<{ id: string; label: string }>;
    newEdges: EdgeDelta[];
  };
  execution: {
    createdTasks: TaskDelta[];
    updatedTasks: TaskUpdateDelta[];
  };
  markdown: string;
}

/**
 * Computes the semantic diff between workspace state at the beginning and end of a meeting session,
 * producing structured data and an executive markdown brief.
 */
export function computeMeetingDeltaBrief(
  before: Workspace,
  after: Workspace,
  meetingTitle: string = "Meeting Session",
): MeetingDeltaBrief {
  const settledDecisions: DecisionDelta[] = [];
  const supersededDecisions: DecisionDelta[] = [];
  const resolvedQuestions: QuestionDelta[] = [];
  const openQuestions: QuestionDelta[] = [];

  const addedNodes: NodeDelta[] = [];
  const removedNodes: Array<{ id: string; label: string }> = [];
  const newEdges: EdgeDelta[] = [];

  const createdTasks: TaskDelta[] = [];
  const updatedTasks: TaskUpdateDelta[] = [];

  // Compare nodes
  for (const [id, afterNode] of Object.entries(after.nodes)) {
    const beforeNode = before.nodes[id];

    if (!beforeNode) {
      addedNodes.push({ id, label: afterNode.label, nodeType: afterNode.nodeType });

      if (afterNode.statement?.kind === "decision" && afterNode.statement.status === "resolved") {
        settledDecisions.push({
          id,
          label: afterNode.label,
          topic: afterNode.statement.topic,
        });
      } else if (afterNode.statement?.kind === "question") {
        openQuestions.push({
          id,
          label: afterNode.label,
          topic: afterNode.statement.topic,
        });
      }

      if (afterNode.issue) {
        createdTasks.push({
          id,
          label: afterNode.label,
          status: afterNode.issue.status,
          assignee: afterNode.issue.assignee,
          priority: afterNode.issue.priority,
        });
      }
    } else {
      // Existing node modifications
      const bs = beforeNode.statement;
      const as = afterNode.statement;

      if (as?.kind === "decision") {
        if (as.status === "resolved" && (!bs || bs.status !== "resolved")) {
          settledDecisions.push({
            id,
            label: afterNode.label,
            topic: as.topic,
          });
        } else if (as.status === "superseded" && (!bs || bs.status !== "superseded")) {
          supersededDecisions.push({
            id,
            label: afterNode.label,
            topic: as.topic,
          });
        }
      }

      if (bs?.kind === "question" && as?.kind === "question") {
        if (as.status === "resolved" && bs.status !== "resolved") {
          resolvedQuestions.push({ id, label: afterNode.label, topic: as.topic });
        } else if (as.status !== "resolved") {
          // remains open
        }
      } else if (!bs && as?.kind === "question" && as.status !== "resolved") {
        openQuestions.push({ id, label: afterNode.label, topic: as.topic });
      }

      // Check task changes
      if (!beforeNode.issue && afterNode.issue) {
        createdTasks.push({
          id,
          label: afterNode.label,
          status: afterNode.issue.status,
          assignee: afterNode.issue.assignee,
          priority: afterNode.issue.priority,
        });
      } else if (beforeNode.issue && afterNode.issue) {
        if (beforeNode.issue.status !== afterNode.issue.status) {
          updatedTasks.push({
            id,
            label: afterNode.label,
            fromStatus: beforeNode.issue.status,
            toStatus: afterNode.issue.status,
          });
        }
      }
    }
  }

  for (const [id, beforeNode] of Object.entries(before.nodes)) {
    if (!after.nodes[id]) {
      removedNodes.push({ id, label: beforeNode.label });
    }
  }

  // Compare edges
  for (const [id, edge] of Object.entries(after.edges)) {
    if (!before.edges[id]) {
      newEdges.push({
        id,
        source: after.nodes[edge.source]?.label ?? edge.source,
        target: after.nodes[edge.target]?.label ?? edge.target,
        relationship: edge.relationship,
      });
    }
  }

  // Generate markdown brief
  const mdParts: string[] = [
    `# Meeting Delta Brief: ${meetingTitle}`,
    `Generated at ${new Date().toISOString().split("T")[0]}`,
    "",
  ];

  if (settledDecisions.length > 0) {
    mdParts.push("## Key Architectural Decisions Settled");
    for (const d of settledDecisions) {
      mdParts.push(`- **${d.label}**${d.topic ? ` _[${d.topic}]_` : ""}`);
    }
    mdParts.push("");
  }

  if (supersededDecisions.length > 0) {
    mdParts.push("## Decisions Superseded / Deprecated");
    for (const d of supersededDecisions) {
      mdParts.push(`- ~~${d.label}~~${d.topic ? ` _[${d.topic}]_` : ""}`);
    }
    mdParts.push("");
  }

  if (createdTasks.length > 0 || updatedTasks.length > 0) {
    mdParts.push("## Action Items & Execution Progress");
    for (const t of createdTasks) {
      const assigneeStr = t.assignee ? ` (@${t.assignee})` : "";
      const prioStr = t.priority ? ` [${t.priority}]` : "";
      mdParts.push(`- [ ] **${t.label}** — *${t.status}*${assigneeStr}${prioStr}`);
    }
    for (const u of updatedTasks) {
      mdParts.push(`- **${u.label}**: Status shifted \`${u.fromStatus}\` → \`${u.toStatus}\``);
    }
    mdParts.push("");
  }

  if (addedNodes.length > 0 || newEdges.length > 0) {
    mdParts.push("## Architecture & Structural Updates");
    if (addedNodes.length > 0) {
      mdParts.push(`- **New Components**: ${addedNodes.map((n) => `\`${n.label}\` (${n.nodeType})`).join(", ")}`);
    }
    if (newEdges.length > 0) {
      mdParts.push(
        `- **New Connections**: ${newEdges.map((e) => `${e.source} --[${e.relationship}]--> ${e.target}`).join(", ")}`,
      );
    }
    mdParts.push("");
  }

  if (openQuestions.length > 0) {
    mdParts.push("## Open Questions Requiring Follow-up");
    for (const q of openQuestions) {
      mdParts.push(`- ? **${q.label}**${q.topic ? ` _[${q.topic}]_` : ""}`);
    }
    mdParts.push("");
  }

  return {
    title: meetingTitle,
    decisions: {
      settled: settledDecisions,
      superseded: supersededDecisions,
    },
    questions: {
      resolved: resolvedQuestions,
      open: openQuestions,
    },
    architecture: {
      addedNodes,
      removedNodes,
      newEdges,
    },
    execution: {
      createdTasks,
      updatedTasks,
    },
    markdown: mdParts.join("\n"),
  };
}
