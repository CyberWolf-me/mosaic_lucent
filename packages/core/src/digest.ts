import type { Workspace } from "./model.js";
import { statementRows } from "./statementIndex.js";
import { boardToMermaid } from "./mermaid.js";

/**
 * Options controlling which sections appear in the generated Markdown board digest.
 */
export interface DigestOptions {
  includeMermaid?: boolean;
  includeMetrics?: boolean;
  includeDecisions?: boolean;
  includeActions?: boolean;
  includeRisksAndQuestions?: boolean;
}

/**
 * Generates an executive Markdown digest of a Lucent workspace.
 * Includes governance metrics, decisions register, assigned actions, open risks/questions,
 * and an inline Mermaid code block suitable for pasting into Notion, GitHub, Linear, or Slack.
 */
export function generateBoardDigest(
  workspace: Workspace,
  boardTitle = "Board Digest",
  options: DigestOptions = {},
): string {
  const {
    includeMermaid = true,
    includeMetrics = true,
    includeDecisions = true,
    includeActions = true,
    includeRisksAndQuestions = true,
  } = options;

  const lines: string[] = [];
  const title = boardTitle.trim() || "Untitled Board";
  lines.push(`# ${title}`);
  lines.push("");
  lines.push(
    `> **Type:** ${workspace.diagramKind} · **Objects:** ${Object.keys(workspace.nodes).length} nodes, ${Object.keys(workspace.edges).length} connectors`,
  );
  lines.push("");

  const rows = statementRows(workspace);
  const decisions = rows.filter((r) => r.kind === "decision");
  const actions = rows.filter((r) => r.kind === "action");
  const risks = rows.filter((r) => r.kind === "risk");
  const questions = rows.filter((r) => r.kind === "question");

  if (includeMetrics) {
    const resolvedDecisions = decisions.filter((d) => d.status === "resolved").length;
    const openDecisions = decisions.filter((d) => d.status === "open").length;
    const openRisks = risks.filter((r) => r.status === "open").length;
    const openQuestions = questions.filter((q) => q.status === "open").length;
    const blockedActions = actions.filter(
      (a) => a.executionStatus === "blocked" || (a.blockedBy && a.blockedBy.length > 0),
    ).length;

    lines.push("## Governance & Health Summary");
    lines.push("");
    lines.push("| Metric | Count | Status |");
    lines.push("| :--- | :--- | :--- |");
    lines.push(
      `| **Decisions** | ${decisions.length} | ${resolvedDecisions} Decided, ${openDecisions} Open |`,
    );
    lines.push(
      `| **Action Items** | ${actions.length} | ${blockedActions > 0 ? `⚠️ ${blockedActions} Blocked` : "On track"} |`,
    );
    lines.push(`| **Open Risks** | ${openRisks} | ${openRisks > 0 ? "Needs Review" : "Clear"} |`);
    lines.push(
      `| **Open Questions** | ${openQuestions} | ${openQuestions > 0 ? "Pending Resolution" : "Resolved"} |`,
    );
    lines.push("");
  }

  if (includeDecisions && decisions.length > 0) {
    lines.push("## Decisions Register");
    lines.push("");
    lines.push("| Decision | Topic | Status | Supersedes |");
    lines.push("| :--- | :--- | :--- | :--- |");
    for (const d of decisions) {
      const topic = d.topic ? `\`${d.topic}\`` : "—";
      const status =
        d.status === "resolved"
          ? "✅ Decided"
          : d.status === "rejected"
            ? "❌ Rejected"
            : "🟡 Open";
      const supersedes = d.supersedes && d.supersedes.length > 0 ? d.supersedes.join(", ") : "—";
      lines.push(`| ${d.label.replace(/\|/g, "\\|")} | ${topic} | ${status} | ${supersedes} |`);
    }
    lines.push("");
  }

  if (includeActions && actions.length > 0) {
    lines.push("## Action Backlog");
    lines.push("");
    lines.push("| Action | Assignee | Due Date | Status | Blocked By |");
    lines.push("| :--- | :--- | :--- | :--- | :--- |");
    for (const a of actions) {
      const assignee = a.assignee ? `**@${a.assignee}**` : "*Unassigned*";
      const due = a.dueDate ? a.dueDate : "—";
      const status = a.executionStatus ? a.executionStatus : a.status;
      const blocked = a.blockedBy && a.blockedBy.length > 0 ? `⚠️ ${a.blockedBy.join(", ")}` : "—";
      lines.push(
        `| ${a.label.replace(/\|/g, "\\|")} | ${assignee} | ${due} | ${status} | ${blocked} |`,
      );
    }
    lines.push("");
  }

  if (includeRisksAndQuestions && (risks.length > 0 || questions.length > 0)) {
    lines.push("## Risks & Questions");
    lines.push("");
    if (risks.length > 0) {
      lines.push("### Identified Risks");
      for (const r of risks) {
        const mark = r.status === "open" ? "⚠️" : "✔️";
        lines.push(
          `- ${mark} **[${r.status.toUpperCase()}]** ${r.label}${r.topic ? ` (Topic: \`${r.topic}\`)` : ""}`,
        );
      }
      lines.push("");
    }
    if (questions.length > 0) {
      lines.push("### Open Questions");
      for (const q of questions) {
        const mark = q.status === "open" ? "❓" : "✔️";
        lines.push(
          `- ${mark} **[${q.status.toUpperCase()}]** ${q.label}${q.topic ? ` (Topic: \`${q.topic}\`)` : ""}`,
        );
      }
      lines.push("");
    }
  }

  if (includeMermaid) {
    lines.push("## Architecture & Flow");
    lines.push("");
    lines.push("```mermaid");
    lines.push(boardToMermaid(workspace).trim());
    lines.push("```");
    lines.push("");
  }

  return lines.join("\n");
}
