import { useMemo, useState } from "react";
import type { IssueStatusCategory, Node, Operation } from "@lucent/core";
import { BOARD_COLUMNS, boardColumns, derivedExecution, pointsByCategory } from "@lucent/core";
import { TopBar, LeftRail, StatusBadge } from "../ui/Chrome.js";
import { AIPill } from "../ui/AIPill.js";
import { Ico } from "../ui/icons.js";
import { useWorkspace } from "../workspace.js";

/**
 * Kanban board (Jira-style). Every node carrying issue fields is a card, sorted
 * into a To Do / In Progress / Done column by its status category. Dragging a
 * card to another column emits UPDATE_ISSUE, so the board is just another view
 * over the same semantic model — no separate task store.
 */
export function BoardView({ onOpenSettings }: { onOpenSettings: (section?: string) => void }) {
  const { workspace, chat, send, setView, applyManual } = useWorkspace();
  const [message, setMessage] = useState("");
  const [dragId, setDragId] = useState<string | null>(null);
  const [overCol, setOverCol] = useState<IssueStatusCategory | null>(null);

  const submit = () => {
    const text = message.trim();
    if (!text) return;
    setMessage("");
    setView("canvas");
    void send(text);
  };

  const columns = boardColumns(workspace);
  const points = pointsByCategory(workspace);
  const total = BOARD_COLUMNS.reduce((sum, c) => sum + columns[c.category].length, 0);
  // Stage D3: the derived execution state, computed once per render — the
  // card badge reads it; column placement stays on the manual statusCategory
  // (derived informs, never silently refiles).
  const derived = useMemo(() => derivedExecution(workspace, Date.now()), [workspace]);

  const moveTo = (id: string, category: IssueStatusCategory) => {
    const node = workspace.nodes[id];
    if (!node?.issue || node.issue.statusCategory === category) return;
    // Keep a human-readable status too, defaulting to the column's own label.
    const label = BOARD_COLUMNS.find((c) => c.category === category)!.label;
    const ops: Operation[] = [{ op: "UPDATE_ISSUE", id, status: label, statusCategory: category }];
    applyManual(ops, `Move "${node.label}" to ${label}`);
  };

  /** Keyboard move: shift a card one column left/right (WCAG 2.1.1). */
  const nudgeCard = (id: string, dir: -1 | 1) => {
    const node = workspace.nodes[id];
    if (!node?.issue) return;
    const idx = BOARD_COLUMNS.findIndex((c) => c.category === node.issue!.statusCategory);
    const next = BOARD_COLUMNS[idx + dir];
    if (next) moveTo(id, next.category);
  };

  return (
    <div style={{ position: "absolute", inset: 0 }}>
      <div style={{ position: "absolute", inset: 0 }}>
        <div className="canvas-grid" />
        <div className="canvas-vignette" />
      </div>
      <TopBar
        crumbs={[
          { label: "Personal" },
          { label: "Workspace", view: "canvas" },
          { label: "Board", current: true },
        ]}
        onOpenSettings={onOpenSettings}
      />
      <LeftRail />

      {total === 0 ? (
        <div className="view-empty">
          <div className="view-empty-icon">
            <Ico.Layers />
          </div>
          <h2>No work items yet</h2>
          <p>
            Cards come from nodes with issue fields. Ask Lucent to "break the checkout epic into
            stories" or "make a sprint backlog", or add issue details to a node, and they'll appear
            here as a Kanban board.
          </p>
        </div>
      ) : (
        <div className="board-columns" role="list" aria-label="Work board">
          {BOARD_COLUMNS.map((col) => {
            const cards = columns[col.category];
            return (
              <div
                key={col.category}
                className={`board-column ${overCol === col.category ? "over" : ""}`}
                role="listitem"
                aria-label={`${col.label}, ${cards.length} item${cards.length === 1 ? "" : "s"}`}
                onDragOver={(e) => {
                  e.preventDefault();
                  setOverCol(col.category);
                }}
                onDragLeave={() => setOverCol((c) => (c === col.category ? null : c))}
                onDrop={() => {
                  if (dragId) moveTo(dragId, col.category);
                  setDragId(null);
                  setOverCol(null);
                }}
              >
                <div className="board-column-head">
                  <h2 className="board-column-title">{col.label}</h2>
                  <span className="mono board-column-count">
                    {cards.length}
                    {points[col.category] > 0 ? ` · ${points[col.category]}pt` : ""}
                  </span>
                </div>
                <div className="board-column-body">
                  {cards.map((n) => (
                    <IssueCard
                      key={n.id}
                      node={n}
                      derived={derived.get(n.id)}
                      dragging={dragId === n.id}
                      onDragStart={() => setDragId(n.id)}
                      onDragEnd={() => {
                        setDragId(null);
                        setOverCol(null);
                      }}
                      onNudge={(dir) => nudgeCard(n.id, dir)}
                    />
                  ))}
                  {cards.length === 0 && <div className="board-column-empty">Nothing here</div>}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <AIPill
        placeholder="Add a story, move a card, assign someone…"
        value={message}
        onChange={setMessage}
        onSubmit={submit}
        history={chat}
      />
      <StatusBadge>
        <Ico.Layers style={{ color: "var(--ink-3)" }} />
        <span>
          {total} work item{total === 1 ? "" : "s"}
        </span>
      </StatusBadge>
    </div>
  );
}

const TYPE_TINT: Record<string, string> = {
  epic: "var(--sig-violet)",
  story: "var(--sig-green)",
  task: "var(--sig-blue)",
  subtask: "var(--ink-2)",
  bug: "var(--sig-red)",
};

const PRIORITY_MARK: Record<string, string> = {
  highest: "↑↑",
  high: "↑",
  medium: "=",
  low: "↓",
  lowest: "↓↓",
};

function IssueCard({
  node,
  derived,
  dragging,
  onDragStart,
  onDragEnd,
  onNudge,
}: {
  node: Node;
  /** Stage D3: computed project truth for this node (undefined = no derived state). */
  derived?: { blockedBy: string[]; atRiskBy: string[] };
  dragging: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onNudge: (dir: -1 | 1) => void;
}) {
  const issue = node.issue!;
  // A full sentence for AT: label, type, status, who it's assigned to,
  // (Stage D1) the deadline, and (Stage D3) derived blockers/risks.
  const cardLabel =
    `${node.label} — ${issue.type}, ${issue.status}` +
    (issue.assignee ? `, assigned to ${issue.assignee}` : "") +
    (issue.dueDate ? `, due ${issue.dueDate}` : "") +
    (derived && derived.blockedBy.length > 0 ? `, blocked by ${derived.blockedBy.join(", ")}` : "") +
    (derived && derived.atRiskBy.length > 0 ? `, at risk from ${derived.atRiskBy.join(", ")}` : "") +
    (issue.storyPoints !== undefined ? `, ${issue.storyPoints} points` : "");
  // The due date is overdue when past today and the work isn't finished —
  // computed here at render, never persisted (ADR 0027).
  const overdue =
    issue.dueDate !== undefined &&
    issue.dueDate < new Date().toISOString().slice(0, 10) &&
    issue.status !== "completed" &&
    issue.status !== "cancelled";
  return (
    <div
      className={`issue-card ${dragging ? "dragging" : ""}`}
      draggable
      tabIndex={0}
      role="button"
      aria-label={cardLabel}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onKeyDown={(e) => {
        // Keyboard equivalent of dragging between columns.
        if (e.key === "ArrowRight" || e.key === "]") {
          e.preventDefault();
          onNudge(1);
        } else if (e.key === "ArrowLeft" || e.key === "[") {
          e.preventDefault();
          onNudge(-1);
        }
      }}
    >
      <div className="issue-card-title">{node.label}</div>
      {issue.dueDate && (
        <div
          className="mono"
          style={{
            fontSize: 9.5,
            marginTop: 2,
            color: overdue ? "var(--sig-red)" : "var(--ink-3)",
          }}
          title={overdue ? `Overdue — due ${issue.dueDate}` : `Due ${issue.dueDate}`}
        >
          {overdue ? "⚠ " : "▢ "}
          {issue.dueDate}
        </div>
      )}
      {/* Stage D3: the derived badge — derived informs, never refiles. The
          card stays in the human's chosen column; the badge names the
          upstream truth. */}
      {derived && derived.blockedBy.length > 0 && (
        <div
          className="mono"
          style={{
            fontSize: 9.5,
            marginTop: 2,
            color: "var(--sig-red)",
          }}
          title={`Blocked by: ${derived.blockedBy.join(", ")}`}
        >
          ⚠ blocked by {derived.blockedBy.length}
        </div>
      )}
      {derived && derived.atRiskBy.length > 0 && (
        <div
          className="mono"
          style={{
            fontSize: 9.5,
            marginTop: 2,
            color: "var(--amber-2)",
          }}
          title={`At risk from: ${derived.atRiskBy.join(", ")}`}
        >
          ⌛ at risk {derived.atRiskBy.length}
        </div>
      )}
      <div className="issue-card-meta">
        <span className="issue-type" style={{ color: TYPE_TINT[issue.type] ?? "var(--ink-2)" }}>
          {issue.type}
        </span>
        {issue.priority && (
          <span className="issue-prio" title={`Priority: ${issue.priority}`}>
            {PRIORITY_MARK[issue.priority] ?? ""}
          </span>
        )}
        {issue.storyPoints !== undefined && (
          <span className="issue-points mono">{issue.storyPoints}</span>
        )}
        <span style={{ flex: 1 }} />
        {issue.assignee && (
          <span className="issue-assignee" title={issue.assignee} aria-hidden="true">
            {initials(issue.assignee)}
          </span>
        )}
      </div>
    </div>
  );
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}
