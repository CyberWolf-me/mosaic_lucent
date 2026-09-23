import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { IssueStatusCategory, Node, Operation } from "@lucent/core";
import {
  actionNodes,
  BOARD_COLUMNS,
  boardColumns,
  decisionsBehindAction,
  derivedExecution,
  pointsByCategory,
} from "@lucent/core";
import { TopBar, LeftRail, StatusBadge } from "../ui/Chrome.js";
import { AIPill } from "../ui/AIPill.js";
import { useToast } from "../ui/Toast.js";
import { fetchIntegrationLinks, type IntegrationLink } from "../boards.js";
import { Ico } from "../ui/icons.js";
import { useWorkspace } from "../workspace.js";

interface ActiveDrag {
  id: string;
  originCategory: IssueStatusCategory;
  dx: number;
  dy: number;
}

/**
 * Kanban board (Jira-style). Every node carrying issue fields is a card, sorted
 * into a To Do / In Progress / Done column by its status category. Dragging a
 * card to another column emits UPDATE_ISSUE, so the board is just another view
 * over the same semantic model — no separate task store.
 */
export function BoardView({ onOpenSettings }: { onOpenSettings: (section?: string) => void }) {
  const { workspace, chat, send, setView, applyManual, boardId , projectName } = useWorkspace();
  const [message, setMessage] = useState("");
  const [activeDrag, setActiveDrag] = useState<ActiveDrag | null>(null);
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
  // Stage E1: the decision labels behind each action — one map lookup per
  // card render, pure over the workspace's drives edges.
  const decisionsByNode = useMemo(() => {
    const out = new Map<string, string[]>();
    for (const action of actionNodes(workspace)) {
      const labels = decisionsBehindAction(workspace, action.id).map((d) => d.label);
      if (labels.length > 0) out.set(action.id, labels);
    }
    return out;
  }, [workspace]);
  // Stage D6: the external links (the ↗ chips on cards).
  const [links, setLinks] = useState<IntegrationLink[]>([]);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const boardLinks = boardId ? await fetchIntegrationLinks(boardId) : [];
      if (!cancelled) setLinks(boardLinks);
    })();
    return () => {
      cancelled = true;
    };
  }, [boardId]);
  const linksByNode = useMemo(() => {
    const map = new Map<string, IntegrationLink>();
    for (const link of links) map.set(link.nodeId, link);
    return map;
  }, [links]);

  const moveTo = useCallback(
    (id: string, category: IssueStatusCategory) => {
      const node = workspace.nodes[id];
      if (!node?.issue || node.issue.statusCategory === category) return;
      // Keep a human-readable status too, defaulting to the column's own label.
      const label = BOARD_COLUMNS.find((c) => c.category === category)!.label;
      const ops: Operation[] = [{ op: "UPDATE_ISSUE", id, status: label, statusCategory: category }];
      applyManual(ops, `Move "${node.label}" to ${label}`);
    },
    [applyManual, workspace.nodes],
  );

  const handleDragMove = useCallback(
    (
      id: string,
      originCategory: IssueStatusCategory,
      dx: number,
      dy: number,
      clientX: number,
      clientY: number,
    ) => {
      setActiveDrag({ id, originCategory, dx, dy });
      if (typeof document !== "undefined" && typeof document.elementsFromPoint === "function") {
        const elements = document.elementsFromPoint(clientX, clientY);
        let found: IssueStatusCategory | null = null;
        for (const el of elements) {
          const cat = el.getAttribute("data-column-category") as IssueStatusCategory | null;
          if (cat) {
            found = cat;
            break;
          }
        }
        setOverCol(found);
      }
    },
    [],
  );

  const handleDragEnd = useCallback(
    (id: string, targetCategory: IssueStatusCategory | null) => {
      if (targetCategory) {
        moveTo(id, targetCategory);
      }
      setActiveDrag(null);
      setOverCol(null);
    },
    [moveTo],
  );

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
          { label: "Boards", view: "dashboard" },
          { label: projectName || "Untitled board", view: "canvas" },
          { label: "Kanban", current: true },
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
                data-column-category={col.category}
                className={`board-column ${overCol === col.category ? "over" : ""}`}
                role="listitem"
                aria-label={`${col.label}, ${cards.length} item${cards.length === 1 ? "" : "s"}`}
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
                      decisions={decisionsByNode.get(n.id)}
                      link={linksByNode.get(n.id)}
                      isDragging={activeDrag?.id === n.id}
                      dragOffset={
                        activeDrag?.id === n.id
                          ? { dx: activeDrag.dx, dy: activeDrag.dy }
                          : undefined
                      }
                      onDragMove={(dx, dy, cx, cy) =>
                        handleDragMove(n.id, col.category, dx, dy, cx, cy)
                      }
                      onDragEnd={(targetCat) => handleDragEnd(n.id, targetCat)}
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
  decisions,
  link,
  isDragging,
  dragOffset,
  onDragMove,
  onDragEnd,
  onNudge,
}: {
  node: Node;
  /** Stage D3: computed project truth for this node (undefined = no derived state). */
  derived?: { blockedBy: string[]; atRiskBy: string[] };
  /** Stage E1: the decision labels behind this action (empty = no drives edges). */
  decisions?: string[];
  /** Stage D6: the board's external link for this card (the ↗ chip). */
  link?: { externalId: string; url?: string; syncedAt: number };
  isDragging: boolean;
  dragOffset?: { dx: number; dy: number };
  onDragMove: (dx: number, dy: number, clientX: number, clientY: number) => void;
  onDragEnd: (targetCategory: IssueStatusCategory | null) => void;
  onNudge: (dir: -1 | 1) => void;
}) {
  const { notify } = useToast();
  const issue = node.issue!;
  const pointerStartRef = useRef<{ x: number; y: number; pointerId: number } | null>(null);
  const isMovingRef = useRef(false);

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement | null;
    if (target && (target.closest("a") || target.closest("button") || target.closest("input"))) {
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    pointerStartRef.current = { x: e.clientX, y: e.clientY, pointerId: e.pointerId };
    isMovingRef.current = false;
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!pointerStartRef.current || pointerStartRef.current.pointerId !== e.pointerId) return;
    const dx = e.clientX - pointerStartRef.current.x;
    const dy = e.clientY - pointerStartRef.current.y;
    if (!isMovingRef.current) {
      if (Math.hypot(dx, dy) < 4) return;
      isMovingRef.current = true;
    }
    onDragMove(dx, dy, e.clientX, e.clientY);
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!pointerStartRef.current || pointerStartRef.current.pointerId !== e.pointerId) return;
    try {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
    } catch {
      // ignore
    }
    const wasMoving = isMovingRef.current;
    pointerStartRef.current = null;
    isMovingRef.current = false;

    if (wasMoving) {
      let finalCategory: IssueStatusCategory | null = null;
      if (typeof document !== "undefined" && typeof document.elementsFromPoint === "function") {
        const elements = document.elementsFromPoint(e.clientX, e.clientY);
        for (const el of elements) {
          const cat = el.getAttribute("data-column-category") as IssueStatusCategory | null;
          if (cat) {
            finalCategory = cat;
            break;
          }
        }
      }
      onDragEnd(finalCategory);
    }
  };

  const handlePointerCancel = (e: React.PointerEvent<HTMLDivElement>) => {
    try {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
    } catch {
      // ignore
    }
    pointerStartRef.current = null;
    isMovingRef.current = false;
    onDragEnd(null);
  };

  // A full sentence for AT: label, type, status, who it's assigned to,
  // (Stage D1) the deadline, and (Stage D3) derived blockers/risks, and
  // (Stage E1) the decisions that caused the work.
  const cardLabel =
    `${node.label} — ${issue.type}, ${issue.status}` +
    (issue.assignee ? `, assigned to ${issue.assignee}` : "") +
    (issue.dueDate ? `, due ${issue.dueDate}` : "") +
    (derived && derived.blockedBy.length > 0
      ? `, blocked by ${derived.blockedBy.join(", ")}`
      : "") +
    (derived && derived.atRiskBy.length > 0
      ? `, at risk from ${derived.atRiskBy.join(", ")}`
      : "") +
    (decisions && decisions.length > 0 ? `, driven by ${decisions.join(", ")}` : "") +
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
      className={`issue-card ${isDragging ? "dragging" : ""}`}
      tabIndex={0}
      role="button"
      aria-label={cardLabel}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      style={
        isDragging && dragOffset
          ? {
              transform: `translate3d(${dragOffset.dx}px, ${dragOffset.dy}px, 0) rotate(1.5deg) scale(1.02)`,
              boxShadow: "var(--elev-3)",
              zIndex: 100,
              cursor: "grabbing",
              opacity: 0.96,
              transition: "none",
            }
          : undefined
      }
      onKeyDown={(e) => {
        // Enter/Space on a card is a no-op by design: the card is already
        // focused, and moving it is the arrow-key path below.
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          notify("Use ← → to move between columns");
        } else if (e.key === "ArrowRight" || e.key === "]") {
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
      {/* Stage E1: the decisions chip — the causal story behind the card.
          Quiet like the derived badges: informs, never refiling. */}
      {decisions && decisions.length > 0 && (
        <div
          className="mono"
          style={{ fontSize: 9.5, marginTop: 2, color: "var(--ink-3)" }}
          title={`Decisions behind this work: ${decisions.join(", ")}`}
        >
          ◆ decision{decisions.length === 1 ? "" : "s"} {decisions.length}
        </div>
      )}
      {link && (
        <a
          href={link.url ?? "#"}
          target="_blank"
          rel="noreferrer"
          className="mono"
          title={`synced ${new Date(link.syncedAt).toISOString().slice(0, 10)}`}
          style={{ fontSize: 9.5, marginTop: 2, color: "var(--amber-2)", textDecoration: "none" }}
        >
          ↗ {link.externalId}
        </a>
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
          <span
            className="issue-assignee"
            title={issue.assignee}
            role="img"
            aria-label={issue.assignee}
          >
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
