import { useEffect, useMemo, useState } from "react";
import {
  actionsFromDecision,
  decisionsBehindAction,
  derivedExecution,
  isOverdueUnfinished,
  type Node,
  type Operation,
  type ProvenanceFields,
  type StatementFields,
  type Workspace,
} from "@lucent/core";
import {
  KIND_LABEL,
  STATEMENT_KINDS,
  STATEMENT_STATUSES,
  statementEditOps,
  statusLabel,
  topicDuplicateHint,
  topicSuggestions,
} from "../statementUi.js";
import { styleForType } from "../scene.js";
import { formatDue } from "../ui/atoms.js";
import { Avatar, Button, KindBadge } from "../ui/kit.js";
import { StatementGlyph } from "../ui/StatementGlyph.js";
import { Ico } from "../ui/icons.js";
import { autoIconFor } from "../icons/auto.js";
import { NodeIcon } from "../icons/Icon.js";
import { IconPicker } from "../icons/IconPicker.js";
import { useIcon } from "../icons/registry.js";
import { detailsEditOps, detailsPlaceholder, formatDetailsText } from "../nodeDetails.js";

/**
 * The node inspector: what a node IS on this board, not how it looks.
 *
 * The semantic canvas is the product's differentiator (docs/01), and this is
 * where it becomes visible for one object: its kind and lifecycle, the words
 * that produced it (meeting turns, a conversation request, or the statements
 * a plan came from), what it connects to — in sentences, with the edges'
 * verbs — which decisions it came from or which actions it drives, and the
 * statement editor. Every row is real board state; a section with nothing to
 * say is omitted, except provenance, which says so honestly.
 */
export function NodeInspector({
  nodeId,
  workspace,
  canEdit,
  onApply,
  onSelectNode,
  onOpenMeeting,
  onExplain,
  onExpand,
  onComment,
  onClose,
}: {
  nodeId: string;
  workspace: Workspace;
  canEdit: boolean;
  /** Commit through the same validator the AI path uses. */
  onApply: (ops: Operation[], label: string) => boolean;
  onSelectNode: (id: string) => void;
  /** Open the meeting behind a provenance stamp (null: the meeting view). */
  onOpenMeeting: (meetingId: string | null, turnRange?: [number, number]) => void;
  onExplain: (label: string) => void;
  onExpand: (label: string) => void;
  onComment: () => void;
  onClose: () => void;
}) {
  const node = workspace.nodes[nodeId];

  // Escape closes the inspector (and leaves the selection to the canvas).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (
        e.key === "Escape" &&
        t?.tagName !== "INPUT" &&
        t?.tagName !== "SELECT" &&
        t?.tagName !== "TEXTAREA"
      )
        onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!node) return null;
  const st = node.statement;
  const region = node.groupId ? workspace.groups[node.groupId]?.label : undefined;
  const typeMeta = styleForType(node.nodeType).meta;

  return (
    <aside className="node-inspector" aria-label={`Details: ${node.label}`}>
      <header className="ni-head">
        <div className="ni-eyebrow">
          {st ? (
            <KindBadge kind={st.kind} status={st.status} />
          ) : (
            <>
              <NodeIcon icon={node.icon} fallback={autoIconFor(node.label, node.nodeType)} size={13} />
              <span>{typeMeta}</span>
            </>
          )}
          {region && <span className="ni-region">· {region}</span>}
        </div>
        <h2 className={`ni-title ${st?.kind === "decision" && st.status === "resolved" ? "serif" : ""}`}>
          {node.label}
        </h2>
        <button className="ni-close" onClick={onClose} aria-label="Close details" title="Close · Esc">
          <Ico.X />
        </button>
      </header>

      <div className="ni-body">
        <Provenance
          node={node}
          workspace={workspace}
          onSelectNode={onSelectNode}
          onOpenMeeting={onOpenMeeting}
        />
        <Work node={node} workspace={workspace} onSelectNode={onSelectNode} />
        {canEdit ? (
          <DetailsSection node={node} onApply={onApply} />
        ) : (
          node.details && <DetailsReadOnly node={node} />
        )}
        <Connections node={node} workspace={workspace} onSelectNode={onSelectNode} />
        {/* A statement card shows its statement glyph, not an icon. */}
        {canEdit && !st && <IconSection node={node} onApply={onApply} />}
        {canEdit && <StatementSection node={node} workspace={workspace} onApply={onApply} />}
      </div>

      <footer className="ni-foot">
        <Button size="sm" variant="ghost" onClick={() => onExplain(node.label)}>
          <Ico.Sparkle /> Explain
        </Button>
        {canEdit && (
          <Button size="sm" variant="ghost" onClick={() => onExpand(node.label)}>
            <Ico.Plus /> Expand
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={onComment}>
          <Ico.Comment /> Comment
        </Button>
      </footer>
    </aside>
  );
}

/* ------------------------------------------------------------------ */

function iconName(ref: string): string {
  return ref.slice(ref.indexOf(":") + 1).replace(/-/g, " ");
}

/**
 * The node's icon (docs/26 §6.2): the one it shows, where that came from,
 * and a picker over the registry — Iconoir concepts and Simple Icons brand
 * marks. Choosing is a SET_NODE_ICON, so it is validated, shared and undoable
 * like any edit; "Automatic" clears it back to the label's own icon.
 */
function IconSection({
  node,
  onApply,
}: {
  node: Node;
  onApply: (ops: Operation[], label: string) => boolean;
}) {
  const auto = autoIconFor(node.label, node.nodeType);
  const chosen = useIcon(node.icon);
  const [open, setOpen] = useState(false);
  const choose = (ref: string | null) => {
    onApply([{ op: "SET_NODE_ICON", id: node.id, icon: ref }], ref ? "Set icon" : "Automatic icon");
    setOpen(false);
  };

  const source = node.icon
    ? chosen === null
      ? "Chosen · not in this version of the library — showing the automatic one"
      : "Chosen"
    : auto
      ? "Automatic · from the label"
      : "None · the label names nothing Lucent recognises";
  const shown = chosen?.title ?? (node.icon ? iconName(node.icon) : auto ? iconName(auto) : null);

  return (
    <section className="ni-section">
      <div className="ni-label">Icon</div>
      <div className="ni-icon-row">
        <span className="ni-icon-current" aria-hidden>
          <NodeIcon icon={node.icon} fallback={auto} size={18} />
        </span>
        <span className="ni-icon-what">
          {shown && <span className="ni-icon-name">{shown}</span>}
          <span className="ni-icon-source">{source}</span>
        </span>
        <span className="ni-icon-buttons">
          {node.icon && (
            <Button size="sm" variant="ghost" onClick={() => choose(null)}>
              Automatic
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
            {open ? "Close" : "Change"}
          </Button>
        </span>
      </div>
      {chosen?.set === "simple" && (
        <p className="ni-icon-note">
          {chosen.title} is a trademark of its owner, shown to identify it
          {chosen.guidelines ? (
            <>
              {" "}
              ·{" "}
              <a href={chosen.guidelines} target="_blank" rel="noreferrer noopener">
                logo guidelines
              </a>
            </>
          ) : null}
        </p>
      )}
      {open && (
        <IconPicker
          selected={node.icon}
          lead={auto}
          onChoose={choose}
          onClose={() => setOpen(false)}
        />
      )}
    </section>
  );
}

/**
 * The node's details (V4 compartments: a class's attributes and operations,
 * an entity's columns, a C4 element's technology) as one plain-text editor:
 * `## Title` starts a section, every other line is an item. Leaving the field
 * commits one SET_NODE_DETAILS through the same validator the AI's ops run
 * through — so it is shared and undoable like any edit — and clearing the
 * text clears the details. Parsing lives in nodeDetails.ts.
 */
function DetailsSection({
  node,
  onApply,
}: {
  node: Node;
  onApply: (ops: Operation[], label: string) => boolean;
}) {
  const current = formatDetailsText(node.details);
  const [draft, setDraft] = useState(current);
  const [refused, setRefused] = useState(false);

  // A different node, or its details changed under us (a peer, an undo, the
  // AI): the field shows what the board now says.
  useEffect(() => {
    setDraft(current);
    setRefused(false);
  }, [node.id, current]);

  const commit = () => {
    const ops = detailsEditOps(node.id, node.details, draft);
    if (ops.length === 0) return;
    const op = ops[0];
    const clearing = op?.op === "SET_NODE_DETAILS" && op.details === null;
    setRefused(!onApply(ops, clearing ? "Clear details" : "Edit details"));
  };

  const lines = draft.split("\n").length;
  return (
    <section className="ni-section" onMouseDown={(e) => e.stopPropagation()}>
      <label className="ni-label" htmlFor={`ni-details-${node.id}`}>
        Details
      </label>
      <textarea
        id={`ni-details-${node.id}`}
        className="ni-details-input"
        value={draft}
        rows={Math.min(14, Math.max(3, lines + 1))}
        spellCheck={false}
        placeholder={detailsPlaceholder(node.nodeType)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          // Escape abandons the draft — the field goes back to the board's
          // text, so the blur that follows commits nothing. Nothing typed
          // here is a canvas shortcut.
          if (e.key === "Escape") setDraft(current);
          e.stopPropagation();
        }}
      />
      <p className="ni-details-hint">
        <span className="mono">## Title</span> starts a section · one item per line
      </p>
      {refused && (
        <p className="ni-refused" role="alert">
          Lucent refused that edit — the node may have been removed.
        </p>
      )}
    </section>
  );
}

/** Details for a viewer who can't edit: the compartments, as the card shows them. */
function DetailsReadOnly({ node }: { node: Node }) {
  return (
    <section className="ni-section">
      <div className="ni-label">Details</div>
      {node.details!.sections.map((s, i) => (
        <div key={i} className="ni-details-section">
          {s.title && <div className="ni-sub">{s.title}</div>}
          <ul className="ni-details-list">
            {s.items.map((item, j) => (
              <li key={j}>{item}</li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

function evidenceOf(node: Node): ProvenanceFields | undefined {
  // The op-level field first (ADR 0022), then the statement's own evidence,
  // then the pre-C2 metadata stamp so older boards keep answering.
  if (node.provenance) return node.provenance;
  if (node.statement?.provenance) return node.statement.provenance;
  const legacy = node.metadata?.meeting as Record<string, unknown> | undefined;
  if (legacy && typeof legacy.meetingId === "string") {
    return {
      meetingId: legacy.meetingId,
      turnRange: legacy.turnRange as [number, number] | undefined,
      quote: typeof legacy.quote === "string" ? legacy.quote : undefined,
    };
  }
  return undefined;
}

function when(at: number): string {
  const d = new Date(at);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    : d.toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function Provenance({
  node,
  workspace,
  onSelectNode,
  onOpenMeeting,
}: {
  node: Node;
  workspace: Workspace;
  onSelectNode: (id: string) => void;
  onOpenMeeting: (meetingId: string | null, turnRange?: [number, number]) => void;
}) {
  const ev = evidenceOf(node);
  const [copied, setCopied] = useState(false);

  if (!ev) {
    return (
      <section className="ni-section">
        <div className="ni-label">Why this is here</div>
        <p className="ni-none">
          No recorded source — added by hand, or made before Lucent recorded where things come
          from.
        </p>
      </section>
    );
  }

  const sources = (ev.createdFrom ?? [])
    .map((id) => workspace.nodes[id])
    .filter((n): n is Node => Boolean(n));
  const meetingId = ev.meetingId;
  const live = meetingId === "live-session";

  return (
    <section className="ni-section">
      <div className="ni-label">Why this is here</div>
      <div className="ni-origin">
        <span className="ni-origin-mark" aria-hidden>
          ✦
        </span>
        {meetingId ? (
          <span>
            Lucent · from a meeting
            {ev.turnRange ? `, turns ${ev.turnRange[0] + 1}–${ev.turnRange[1] + 1}` : ""}
          </span>
        ) : ev.conversation ? (
          <span>
            Lucent · from {ev.conversation.by ? `${ev.conversation.by.split(" ")[0]}'s` : "a"}{" "}
            request · {when(ev.conversation.at)}
          </span>
        ) : (
          <span>Lucent · planned from {sources.length === 1 ? "a statement" : "statements"}</span>
        )}
      </div>
      {ev.quote && <blockquote className="ni-quote">“{ev.quote}”</blockquote>}
      {ev.turnKinds && ev.turnKinds.length > 0 && (
        <div className="ni-turnkinds">
          {ev.turnKinds.map((k, i) => (
            <span key={`${k}-${i}`}>{k}</span>
          ))}
        </div>
      )}
      {sources.length > 0 && (
        <ul className="ni-list">
          {sources.map((s) => (
            <li key={s.id}>
              <button className="ni-link" onClick={() => onSelectNode(s.id)}>
                {s.statement && <StatementGlyph kind={s.statement.kind} size={11} />}
                <span>{s.label}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="ni-actions">
        {meetingId && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onOpenMeeting(live ? null : meetingId, live ? undefined : ev.turnRange)}
            title={live ? "Captured live — open the meeting view" : "Open the transcript at these turns"}
          >
            <Ico.Present /> {live ? "Open meeting" : "View transcript"}
          </Button>
        )}
        {ev.quote && (
          <Button
            size="sm"
            variant="quiet"
            onClick={() => {
              void navigator.clipboard
                .writeText(ev.quote ?? "")
                .then(() => setCopied(true))
                .catch(() => setCopied(false));
            }}
          >
            {copied ? "Copied" : "Copy quote"}
          </Button>
        )}
      </div>
    </section>
  );
}

function Work({
  node,
  workspace,
  onSelectNode,
}: {
  node: Node;
  workspace: Workspace;
  onSelectNode: (id: string) => void;
}) {
  const st = node.statement;
  const issue = node.issue;
  // The execution projection is recomputed per board state, not per render.
  const derived = useMemo(() => derivedExecution(workspace, Date.now()), [workspace]);
  const now = Date.now();
  if (!st) return null;

  const drives = st.kind === "decision" ? actionsFromDecision(workspace, node.id) : [];
  const behind = st.kind === "action" ? decisionsBehindAction(workspace, node.id) : [];
  const d = derived.get(node.id);
  const overdue = issue ? isOverdueUnfinished(issue.dueDate, issue.status, now) : false;
  const supersedes = (st.supersedes ?? [])
    .map((id) => workspace.nodes[id])
    .filter((n): n is Node => Boolean(n));
  const supersededBy = Object.values(workspace.nodes).filter((n) =>
    n.statement?.supersedes?.includes(node.id),
  );

  if (
    !issue &&
    drives.length === 0 &&
    behind.length === 0 &&
    supersedes.length === 0 &&
    supersededBy.length === 0 &&
    !st.topic
  ) {
    return null;
  }

  const link = (n: Node) => (
    <li key={n.id}>
      <button className="ni-link" onClick={() => onSelectNode(n.id)}>
        {n.statement && <StatementGlyph kind={n.statement.kind} size={11} />}
        <span className={n.statement && n.statement.status !== "open" && n.statement.status !== "resolved" ? "struck" : ""}>
          {n.label}
        </span>
        {n.statement && (
          <span className="ni-link-meta">{statusLabel(n.statement.kind, n.statement.status)}</span>
        )}
      </button>
    </li>
  );

  return (
    <section className="ni-section">
      <div className="ni-label">{st.kind === "action" ? "The work" : KIND_LABEL[st.kind].one}</div>
      {issue && (
        <dl className="ni-facts">
          {issue.assignee && (
            <>
              <dt>Owner</dt>
              <dd className="ni-owner">
                <Avatar name={issue.assignee} size={18} /> {issue.assignee}
              </dd>
            </>
          )}
          {issue.dueDate && (
            <>
              <dt>Due</dt>
              <dd className={overdue ? "ni-overdue" : ""}>
                {formatDue(issue.dueDate)}
                {overdue ? " · overdue" : ""}
              </dd>
            </>
          )}
          <dt>Status</dt>
          <dd>{issue.status.replace(/_/g, " ")}</dd>
          {d && d.blockedBy.length > 0 && (
            <>
              <dt>Blocked by</dt>
              <dd className="ni-overdue">
                {d.blockedBy.map((id) => workspace.nodes[id]?.label ?? id).join(", ")}
              </dd>
            </>
          )}
        </dl>
      )}
      {st.topic && (
        <div className="ni-topic">
          Topic <span className="mono">{st.topic}</span>
        </div>
      )}
      {behind.length > 0 && (
        <>
          <div className="ni-sub">Decided by</div>
          <ul className="ni-list">{behind.map(link)}</ul>
        </>
      )}
      {drives.length > 0 && (
        <>
          <div className="ni-sub">Drives</div>
          <ul className="ni-list">{drives.map(link)}</ul>
        </>
      )}
      {supersedes.length > 0 && (
        <>
          <div className="ni-sub">Supersedes</div>
          <ul className="ni-list">{supersedes.map(link)}</ul>
        </>
      )}
      {supersededBy.length > 0 && (
        <>
          <div className="ni-sub">Superseded by</div>
          <ul className="ni-list">{supersededBy.map(link)}</ul>
        </>
      )}
    </section>
  );
}

/** "mitigated_by" → "mitigated by": relationship keys read as words. */
function verbOf(relationship: string): string {
  return relationship.replace(/[_-]+/g, " ").trim() || "relates to";
}

function Connections({
  node,
  workspace,
  onSelectNode,
}: {
  node: Node;
  workspace: Workspace;
  onSelectNode: (id: string) => void;
}) {
  const edges = Object.values(workspace.edges);
  const outgoing = edges.filter((e) => e.source === node.id && workspace.nodes[e.target]);
  const incoming = edges.filter((e) => e.target === node.id && workspace.nodes[e.source]);
  if (outgoing.length + incoming.length === 0) {
    return (
      <section className="ni-section">
        <div className="ni-label">Connections</div>
        <p className="ni-none">Not connected to anything yet.</p>
      </section>
    );
  }
  // Sentences, not a list of ids. Outgoing: "unblocks → Driver picks up
  // order" (this node is the subject). Incoming: "Driver supply at peak hours
  // · mitigated by → this" — the other node is the subject, so it leads.
  const row = (other: Node, verb: string, dir: "out" | "in", id: string) => (
    <li key={id}>
      <button className="ni-link ni-edge" onClick={() => onSelectNode(other.id)}>
        {dir === "in" && <span className="ni-edge-other">{other.label}</span>}
        <span className="ni-verb">{dir === "out" ? `${verb} →` : `${verb} → this`}</span>
        {dir === "out" && <span className="ni-edge-other">{other.label}</span>}
      </button>
    </li>
  );
  return (
    <section className="ni-section">
      <div className="ni-label">
        Connections <span className="ni-count">{outgoing.length + incoming.length}</span>
      </div>
      <ul className="ni-list">
        {outgoing.map((e) => row(workspace.nodes[e.target]!, verbOf(e.relationship), "out", e.id))}
        {incoming.map((e) => row(workspace.nodes[e.source]!, verbOf(e.relationship), "in", e.id))}
      </ul>
    </section>
  );
}

/**
 * The statement editor (Stage C2), inline. Kind, status, topic and
 * supersedes commit through statementEditOps → onApply → the validator the
 * model's ops run through, so a manual edit is refused exactly like a bad
 * model op (cycles, superseding a non-statement). The topic field keeps the
 * C5 challenge: a variant of an existing topic is flagged with evidence and
 * the human decides — nothing is rewritten silently.
 */
function StatementSection({
  node,
  workspace,
  onApply,
}: {
  node: Node;
  workspace: Workspace;
  onApply: (ops: Operation[], label: string) => boolean;
}) {
  const prior = node.statement;
  const [editing, setEditing] = useState(false);
  const [kind, setKind] = useState<StatementFields["kind"]>(prior?.kind ?? "decision");
  const [status, setStatus] = useState<StatementFields["status"]>(prior?.status ?? "open");
  const [topic, setTopic] = useState(prior?.topic ?? "");
  const [supersedes, setSupersedes] = useState<ReadonlySet<string>>(
    new Set(prior?.supersedes ?? []),
  );
  const [dismissedHint, setDismissedHint] = useState<string | null>(null);
  const [refused, setRefused] = useState(false);

  // A different node, or the statement changed under us (a peer, an undo):
  // reset the draft to what the board now says.
  useEffect(() => {
    setKind(prior?.kind ?? "decision");
    setStatus(prior?.status ?? "open");
    setTopic(prior?.topic ?? "");
    setSupersedes(new Set(prior?.supersedes ?? []));
    setRefused(false);
  }, [node.id, prior?.kind, prior?.status, prior?.topic, prior?.supersedes]);

  const candidates = useMemo(
    () => Object.values(workspace.nodes).filter((n) => n.statement && n.id !== node.id),
    [workspace.nodes, node.id],
  );
  const hint =
    dismissedHint !== null && dismissedHint === topic.trim()
      ? undefined
      : topicDuplicateHint(topic, workspace);

  if (!editing) {
    return (
      <section className="ni-section">
        <div className="ni-label">Statement</div>
        <p className="ni-none">
          {prior
            ? "Change what this is, where it stands, or what it replaces."
            : "Mark this as a decision, question, risk, action, requirement or proposal — so Lucent tracks it."}
        </p>
        <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
          {prior ? "Edit statement" : "Make it a statement"}
        </Button>
      </section>
    );
  }

  const commit = () => {
    const ops = statementEditOps(node.id, prior, {
      kind,
      status,
      topic: topic.trim().length > 0 ? topic.trim() : undefined,
      supersedes: [...supersedes],
    });
    if (!onApply(ops, prior ? `Update ${prior.kind} statement` : "Set statement")) {
      setRefused(true);
      return;
    }
    setEditing(false);
  };

  return (
    <section className="ni-section ni-editor" onMouseDown={(e) => e.stopPropagation()}>
      <div className="ni-label">Statement</div>
      <div className="ni-kinds" role="radiogroup" aria-label="Kind">
        {STATEMENT_KINDS.map((k) => (
          <button
            key={k}
            role="radio"
            aria-checked={kind === k}
            className={`ni-kind ${kind === k ? "on" : ""}`}
            style={{ ["--kind" as string]: `var(--kind-${k})` }}
            onClick={() => setKind(k)}
          >
            <StatementGlyph kind={k} size={11} tinted={kind !== k} />
            {KIND_LABEL[k].one}
          </button>
        ))}
      </div>
      <label className="ni-field">
        <span>Status</span>
        <select value={status} onChange={(e) => setStatus(e.target.value as StatementFields["status"])}>
          {STATEMENT_STATUSES.map((s) => (
            <option key={s} value={s}>
              {statusLabel(kind, s)}
            </option>
          ))}
        </select>
      </label>
      <label className="ni-field">
        <span>Topic</span>
        <input
          value={topic}
          placeholder="e.g. pricing"
          onChange={(e) => setTopic(e.target.value)}
          list={`ni-topics-${node.id}`}
        />
        <datalist id={`ni-topics-${node.id}`}>
          {topicSuggestions(workspace).map((t) => (
            <option key={t} value={t} />
          ))}
        </datalist>
      </label>
      {hint && (
        <div className="ni-hint">
          <div>
            “{topic.trim()}” may be the existing topic “{hint.existing}” ({hint.statements}{" "}
            {hint.statements === 1 ? "statement" : "statements"} use it).
          </div>
          <div className="ni-actions">
            <Button size="sm" variant="ghost" onClick={() => setTopic(hint.existing)}>
              Use “{hint.existing}”
            </Button>
            <Button size="sm" variant="quiet" onClick={() => setDismissedHint(topic.trim())}>
              Keep mine
            </Button>
          </div>
        </div>
      )}
      {candidates.length > 0 && (
        <label className="ni-field">
          <span>Supersedes</span>
          <select
            multiple
            value={[...supersedes]}
            size={Math.min(4, Math.max(2, candidates.length))}
            onChange={(e) =>
              setSupersedes(new Set([...e.target.selectedOptions].map((o) => o.value)))
            }
          >
            {candidates.map((n) => (
              <option key={n.id} value={n.id}>
                {n.label.slice(0, 40)} ({KIND_LABEL[n.statement!.kind].one.toLowerCase()})
              </option>
            ))}
          </select>
        </label>
      )}
      {refused && (
        <p className="ni-refused" role="alert">
          Lucent refused that edit — it would create a cycle or supersede something that is not a
          statement.
        </p>
      )}
      <div className="ni-actions">
        <Button size="sm" variant="primary" onClick={commit}>
          {prior ? "Save statement" : "Set statement"}
        </Button>
        <Button size="sm" variant="quiet" onClick={() => setEditing(false)}>
          Cancel
        </Button>
      </div>
    </section>
  );
}
