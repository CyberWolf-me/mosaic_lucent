import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { useWorkspace } from "../workspace.js";
import { useToast } from "../ui/Toast.js";
import { Ico } from "../ui/icons.js";
import { StatementGlyph } from "../ui/StatementGlyph.js";
import { Button, EmptyState, KindBadge, Page, PageHeader, SectionLabel } from "../ui/kit.js";
import { loadOrgs } from "../orgs.js";
import { hasSession } from "../session.js";
import { inboundChangeText } from "./inboundRows.js";
import { decideInboundChange, decideServerProposal } from "../boards.js";
import {
  decideStatements,
  loadReviewQueue,
  type ReviewQueue,
  type ReviewStatement,
  type StatementDecision,
} from "../review.js";

/**
 * The Review center (docs/26 J5, ADR 0047): everything that waits on a
 * person, across the boards they can read — what Lucent suggested from
 * meetings and agents, proposed changes, and what connected tools want to
 * change. Nothing the AI extracted is trusted until someone looks: approving
 * makes it the team's, editing makes it yours, rejecting removes it (undo
 * brings it back), assigning gives it an owner.
 *
 * External actions (pushes to Linear, Jira, GitHub) are reviewed on their
 * board, where the preview and its warnings live — never approved blind.
 */

type Load =
  | { kind: "loading" }
  | { kind: "signed-out" }
  | { kind: "failed" }
  | { kind: "ready"; queue: ReviewQueue };

function meetingLabel(m: NonNullable<ReviewStatement["meeting"]>): string {
  const when = new Date(m.startedAt).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
  return m.title ? `${m.title} · ${when}` : `Meeting · ${when}`;
}

/** Suggestions grouped the way they arrived: by board, then by meeting (or "From agents"). */
function groupsOf(statements: ReviewStatement[]) {
  const groups = new Map<
    string,
    { key: string; boardId: string; title: string; rows: ReviewStatement[] }
  >();
  for (const s of statements) {
    const source = s.meeting ? meetingLabel(s.meeting) : s.provenance ? "A meeting" : "From agents";
    const key = `${s.boardId}:${s.meeting?.id ?? s.provenance?.meetingId ?? "agents"}`;
    const group = groups.get(key) ?? {
      key,
      boardId: s.boardId,
      title: `${s.boardName} — ${source}`,
      rows: [],
    };
    group.rows.push(s);
    groups.set(key, group);
  }
  return [...groups.values()];
}

export function ReviewView({ onOpenSettings }: { onOpenSettings: (section?: string) => void }) {
  const { boardId, openBoard, setView } = useWorkspace();
  const { notify } = useToast();
  const [orgId, setOrgId] = useState<string | null>(null);
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(
    async (id: string | null = orgId) => {
      if (!id) return;
      const queue = await loadReviewQueue(id);
      setLoad(queue ? { kind: "ready", queue } : { kind: "failed" });
    },
    [orgId],
  );

  useEffect(() => {
    if (!hasSession()) {
      setLoad({ kind: "signed-out" });
      return;
    }
    void loadOrgs()
      .then(async ({ current }) => {
        if (!current) return setLoad({ kind: "signed-out" });
        setOrgId(current.id);
        await refresh(current.id);
      })
      .catch(() => setLoad({ kind: "failed" }));
    // Loads once; `refresh` is called again after every decision.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const queue = load.kind === "ready" ? load.queue : null;
  const total = queue
    ? queue.counts.statements + queue.counts.proposals + queue.counts.actions + queue.counts.inbound
    : 0;
  const groups = useMemo(() => (queue ? groupsOf(queue.statements) : []), [queue]);
  const canDecide = (id: string) => queue?.boards[id]?.canDecide === true;

  /** Run a decision, then reload the queue. */
  const act = async (key: string, run: () => Promise<string | null>, done: string) => {
    setBusy(key);
    const error = await run();
    setBusy(null);
    if (error) notify(error, undefined, "error");
    else notify(done);
    await refresh();
  };

  const decide = (board: string, decision: StatementDecision, done: string) =>
    act(
      `${board}:${decision.nodeIds.join(",")}:${decision.action}`,
      () => decideStatements(board, decision),
      done,
    );

  /** Open a board — and, given a node, select and centre it there. */
  const openOn = async (
    target: string,
    nodeId?: string,
    view: "canvas" | "intelligence" = "canvas",
  ) => {
    if (nodeId) {
      const params = new URLSearchParams(window.location.search);
      params.set("reveal", nodeId);
      window.history.replaceState(null, "", `?${params.toString()}`);
    }
    if (target !== boardId && !(await openBoard(target))) {
      notify("That board isn't available any more — it may have been deleted or unshared.");
      return;
    }
    setView(view);
  };

  return (
    <Page
      crumbs={[{ label: "Review", current: true }]}
      boardScoped={false}
      onOpenSettings={onOpenSettings}
      width="narrow"
    >
      <PageHeader
        eyebrow="Review"
        title={
          !queue ? (
            "Review"
          ) : total === 0 ? (
            "Nothing waits on you"
          ) : (
            <>
              {total} {total === 1 ? "thing waits" : "things wait"} <em>on a person</em>
            </>
          )
        }
        lede="What Lucent suggested from meetings and agents, changes it proposed, and what your connected tools want to change. Nothing the AI extracted is trusted until someone looks."
      />

      {load.kind === "loading" && (
        <div className="boards-notif-skeleton" role="status" aria-label="Loading the review queue">
          {[0, 1, 2].map((i) => (
            <div key={i} />
          ))}
        </div>
      )}
      {load.kind === "signed-out" && (
        <EmptyState
          compact
          title="Sign in to review your workspace"
          body="The review queue gathers shared boards, so it needs a signed-in session."
        />
      )}
      {load.kind === "failed" && (
        <div role="alert">
          <EmptyState
            compact
            title="Couldn't load the review queue"
            body="The Lucent server didn't answer, or answered with an error."
            action={
              <Button size="sm" onClick={() => void refresh()}>
                Retry
              </Button>
            }
          />
        </div>
      )}
      {queue && total === 0 && (
        <EmptyState
          glyph={<Ico.Check width={22} height={22} />}
          title="All reviewed"
          body="When Lucent extracts decisions and actions from a meeting, or an agent changes a board, what it suggested waits here for a person."
        />
      )}

      {queue && groups.length > 0 && (
        <section className="boards-notif-group" aria-label="Suggestions">
          <SectionLabel count={queue.counts.statements}>Suggestions</SectionLabel>
          {groups.map((g) => (
            <div key={g.key} className="review-group">
              <div className="review-group-head">
                <span className="mono-caps">{g.title}</span>
                {canDecide(g.boardId) && g.rows.length > 1 && (
                  <Button
                    size="sm"
                    variant="quiet"
                    disabled={busy !== null}
                    onClick={() =>
                      void decide(
                        g.boardId,
                        { action: "approve", nodeIds: g.rows.map((r) => r.id) },
                        `Approved ${g.rows.length} suggestions`,
                      )
                    }
                  >
                    <Ico.Check /> Approve all {g.rows.length}
                  </Button>
                )}
              </div>
              <ul className="boards-notif-list">
                {g.rows.map((row) => (
                  <SuggestionRow
                    key={`${row.boardId}:${row.id}`}
                    row={row}
                    canDecide={canDecide(row.boardId)}
                    busy={busy !== null}
                    onOpen={() => void openOn(row.boardId, row.id)}
                    onDecide={(decision, done) => void decide(row.boardId, decision, done)}
                  />
                ))}
              </ul>
            </div>
          ))}
        </section>
      )}

      {queue && queue.proposals.length > 0 && (
        <section className="boards-notif-group" aria-label="Proposed changes">
          <SectionLabel count={queue.proposals.length}>Proposed changes</SectionLabel>
          <ul className="boards-notif-list">
            {queue.proposals.map((p) => (
              <li key={p.id} className="review-item">
                <div className="boards-notif-row read static">
                  <span className="boards-notif-ico" aria-hidden="true">
                    <Ico.Sparkle />
                  </span>
                  <span className="boards-notif-main">
                    <span className="boards-notif-meta">
                      <span className="mono-caps">{p.boardName}</span>
                      {p.meetingId && <span className="boards-notif-new">From a meeting</span>}
                    </span>
                    <span className="boards-notif-title">
                      {p.meetingId && p.quote ? `“${p.quote}”` : p.request}
                    </span>
                    <span className="boards-notif-body">
                      {p.operations} {p.operations === 1 ? "change" : "changes"}
                      {p.explanation ? ` · ${p.explanation}` : ""}
                    </span>
                  </span>
                </div>
                <div className="review-actions">
                  <Button size="sm" variant="quiet" onClick={() => void openOn(p.boardId)}>
                    Open
                  </Button>
                  {canDecide(p.boardId) && (
                    <>
                      <Button
                        size="sm"
                        disabled={busy !== null}
                        onClick={() =>
                          void act(
                            p.id,
                            async () =>
                              (await decideServerProposal(p.boardId, p.id, "reject"))
                                ? null
                                : "Couldn't reject it — it may have changed.",
                            "Proposal rejected",
                          )
                        }
                      >
                        Reject
                      </Button>
                      <Button
                        size="sm"
                        variant="primary"
                        disabled={busy !== null}
                        onClick={() =>
                          void act(
                            p.id,
                            async () =>
                              (await decideServerProposal(p.boardId, p.id, "approve"))
                                ? null
                                : "Couldn't apply it — the board may have changed.",
                            "Proposal applied",
                          )
                        }
                      >
                        Approve
                      </Button>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {queue && queue.actions.length > 0 && (
        <section className="boards-notif-group" aria-label="External actions">
          <SectionLabel count={queue.actions.length}>Waiting to go out</SectionLabel>
          <ul className="boards-notif-list">
            {queue.actions.map((a) => (
              <li key={a.id}>
                <button
                  type="button"
                  className="boards-notif-row read"
                  onClick={() => void openOn(a.boardId, undefined, "intelligence")}
                  title="Review it on its board, with the preview and any warnings"
                >
                  <span className="boards-notif-ico" aria-hidden="true">
                    <Ico.Share />
                  </span>
                  <span className="boards-notif-main">
                    <span className="boards-notif-meta">
                      <span className="mono-caps">{a.boardName}</span>
                      <span className="boards-notif-new">{a.provider}</span>
                      {a.origin === "ai" && (
                        <span className="boards-notif-new">Drafted by Lucent</span>
                      )}
                    </span>
                    <span className="boards-notif-title">
                      {a.items.length === 1
                        ? a.items[0]!.title
                        : `${a.items.length} items to ${a.provider}`}
                    </span>
                    <span className="boards-notif-body">
                      Review on its board — the preview shows exactly what goes out.
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {queue && queue.inbound.length > 0 && (
        <section className="boards-notif-group" aria-label="External changes">
          <SectionLabel count={queue.inbound.length}>Changes from your tools</SectionLabel>
          <ul className="boards-notif-list">
            {queue.inbound.map((c) => (
              <li key={c.id} className="review-item">
                <div className="boards-notif-row read static">
                  <span className="boards-notif-ico" aria-hidden="true">
                    <Ico.Undo />
                  </span>
                  <span className="boards-notif-main">
                    <span className="boards-notif-meta">
                      <span className="mono-caps">{c.boardName}</span>
                      <span className="boards-notif-new">{c.provider}</span>
                    </span>
                    <span className="boards-notif-title">{c.label}</span>
                    <span className="boards-notif-body">{inboundChangeText(c)}</span>
                  </span>
                </div>
                {canDecide(c.boardId) && (
                  <div className="review-actions">
                    <Button
                      size="sm"
                      disabled={busy !== null}
                      onClick={() =>
                        void act(
                          c.id,
                          async () => {
                            const r = await decideInboundChange(c.boardId, c.id, "dismiss");
                            return r && !r.error ? null : (r?.error ?? "Couldn't dismiss it.");
                          },
                          "Dismissed",
                        )
                      }
                    >
                      Dismiss
                    </Button>
                    {c.mappedValue !== null && (
                      <Button
                        size="sm"
                        variant="primary"
                        disabled={busy !== null}
                        onClick={() =>
                          void act(
                            c.id,
                            async () => {
                              const r = await decideInboundChange(c.boardId, c.id, "accept");
                              return r && !r.error ? null : (r?.error ?? "Couldn't apply it.");
                            },
                            "Applied to the board",
                          )
                        }
                      >
                        Accept
                      </Button>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </Page>
  );
}

function SuggestionRow({
  row,
  canDecide,
  busy,
  onOpen,
  onDecide,
}: {
  row: ReviewStatement;
  canDecide: boolean;
  busy: boolean;
  onOpen: () => void;
  onDecide: (decision: StatementDecision, done: string) => void;
}) {
  const ids = { label: useId(), owner: useId(), due: useId() };
  const [mode, setMode] = useState<"view" | "edit" | "assign">("view");
  const [label, setLabel] = useState(row.label);
  const [owner, setOwner] = useState(row.assignee ?? "");
  const [due, setDue] = useState(row.dueDate ?? "");
  return (
    <li className="review-item">
      <button
        type="button"
        className="boards-notif-row read"
        onClick={onOpen}
        title="Open it on its board"
      >
        <span className="boards-notif-ico" aria-hidden="true">
          <StatementGlyph kind={row.kind} size={14} />
        </span>
        <span className="boards-notif-main">
          <span className="boards-notif-meta">
            <KindBadge kind={row.kind} status={row.status} />
            <span className="trust-chip">Suggested</span>
          </span>
          <span className="boards-notif-title">{row.label}</span>
          {(row.assignee || row.dueDate) && (
            <span className="boards-notif-body">
              {[row.assignee, row.dueDate ? `due ${row.dueDate}` : null]
                .filter(Boolean)
                .join(" · ")}
            </span>
          )}
        </span>
      </button>
      {canDecide && mode === "view" && (
        <div className="review-actions">
          <Button size="sm" variant="quiet" disabled={busy} onClick={() => setMode("edit")}>
            Edit
          </Button>
          <Button size="sm" variant="quiet" disabled={busy} onClick={() => setMode("assign")}>
            Assign
          </Button>
          <Button
            size="sm"
            disabled={busy}
            onClick={() =>
              onDecide({ action: "reject", nodeIds: [row.id] }, "Removed — undo brings it back")
            }
          >
            Reject
          </Button>
          <Button
            size="sm"
            variant="primary"
            disabled={busy}
            onClick={() => onDecide({ action: "approve", nodeIds: [row.id] }, "Approved")}
          >
            Approve
          </Button>
        </div>
      )}
      {canDecide && mode === "edit" && (
        <form
          className="review-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (label.trim())
              onDecide(
                { action: "edit", nodeIds: [row.id], label: label.trim() },
                "Saved in your words",
              );
          }}
        >
          <label className="sr-only" htmlFor={ids.label}>
            What it should say
          </label>
          <input
            id={ids.label}
            className="field-input auth-input"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            autoFocus
          />
          <Button size="sm" variant="quiet" onClick={() => setMode("view")}>
            Cancel
          </Button>
          <Button size="sm" variant="primary" type="submit" disabled={busy || !label.trim()}>
            Save
          </Button>
        </form>
      )}
      {canDecide && mode === "assign" && (
        <form
          className="review-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (owner.trim() || due) {
              onDecide(
                {
                  action: "assign",
                  nodeIds: [row.id],
                  ...(owner.trim() ? { assignee: owner.trim() } : {}),
                  ...(due ? { dueDate: due } : {}),
                },
                owner.trim() ? `Assigned to ${owner.trim()}` : "Due date set",
              );
            }
          }}
        >
          <label className="sr-only" htmlFor={ids.owner}>
            Owner
          </label>
          <input
            id={ids.owner}
            className="field-input auth-input"
            placeholder="Owner"
            value={owner}
            onChange={(e) => setOwner(e.target.value)}
            autoFocus
          />
          <label className="sr-only" htmlFor={ids.due}>
            Due date
          </label>
          <input
            id={ids.due}
            className="field-input auth-input"
            type="date"
            value={due}
            onChange={(e) => setDue(e.target.value)}
          />
          <Button size="sm" variant="quiet" onClick={() => setMode("view")}>
            Cancel
          </Button>
          <Button
            size="sm"
            variant="primary"
            type="submit"
            disabled={busy || (!owner.trim() && !due)}
          >
            Assign
          </Button>
        </form>
      )}
    </li>
  );
}
