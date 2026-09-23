import { useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import type { Workspace } from "@lucent/core";
import { Ico } from "../ui/icons.js";
import { DiagramLayer } from "../ui/DiagramLayer.js";
import { useWorkspace } from "../workspace.js";
import { useToast } from "../ui/Toast.js";
import { fetchBoardHistory, type BoardHistory, type BoardHistoryItem } from "../boards.js";
import { listMeetings, type MeetingTranscript } from "../meetings.js";
import {
  classifiedTurns,
  chronologyByDay,
  depthBanner,
  mergeChronology,
  type ChronologyRow,
} from "../historyTimeline.js";
import {
  Button,
  Card,
  EmptyState,
  FilterChips,
  KindBadge,
  Page,
  PageHeader,
  ProvenanceChip,
} from "../ui/kit.js";
import { KIND_TINT } from "../statementUi.js";

/** Who a row belongs to, for the filter: the revision's actor, or a meeting. */
type ActorFilter = "all" | "ai" | "user" | "system" | "meetings";

function rowCategory(row: ChronologyRow): Exclude<ActorFilter, "all"> {
  return row.kind === "meeting" ? "meetings" : row.item.actor.type;
}

function clock(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Version history. Two sources, one surface (Stage C1):
 *
 * - A SHARED board (boardId set) renders the server's revision timeline —
 *   the op log's authoritative, windowed record (who, when, what, and the
 *   proposal link), grouped by day and merged with the board's meetings and
 *   statement events (Stage C3), with the honest depth banner when the
 *   plan's window truncates. This is the timeline Ask cites.
 * - A LOCAL board (no boardId) keeps the client timeline: the versions of
 *   this session, a preview of each, undo/redo, and restore — there is no
 *   server log to read.
 */
export function HistoryView({ onOpenSettings }: { onOpenSettings: (section?: string) => void }) {
  const {
    history,
    undo,
    redo,
    canUndo,
    canRedo,
    restoreVersion,
    setView,
    boardId,
    onCitation,
    workspace,
    projectName,
  } = useWorkspace();
  const { notify } = useToast();

  // --- Server mode -----------------------------------------------------------
  const [server, setServer] = useState<BoardHistory | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  // Bumped by "Try again" after a failed load.
  const [loadAttempt, setLoadAttempt] = useState(0);
  // The board's meetings, for the merged chronology (Stage C3): revisions,
  // meeting markers, and statement events as one timeline.
  const [meetings, setMeetings] = useState<MeetingTranscript[]>([]);
  useEffect(() => {
    if (!boardId) return;
    let cancelled = false;
    // A board switch must not show the previous board's timeline while the
    // new one loads.
    setServer(null);
    setServerError(null);
    void fetchBoardHistory(boardId)
      .then((res) => {
        if (cancelled) return;
        if (!res) {
          setServerError("The board's history could not be loaded.");
          return;
        }
        setServer(res);
      })
      .catch(() => {
        if (!cancelled) setServerError("The board's history could not be loaded.");
      });
    void listMeetings(boardId)
      .then((rows) => {
        if (!cancelled) setMeetings(rows ?? []);
      })
      .catch(() => {
        if (!cancelled) setMeetings([]);
      });
    return () => {
      cancelled = true;
    };
  }, [boardId, loadAttempt]);

  // The merged project chronology (Stage C3): day-grouped rows across the
  // three streams. When no meetings and no statement events exist, this
  // degrades to exactly the revision list C1 shipped.
  const chronoDays = useMemo(
    () => chronologyByDay(mergeChronology(server?.items ?? [], meetings)),
    [server, meetings],
  );
  const banner = server ? depthBanner(server) : null;

  // Filter by who acted. The counts are REVISIONS (plus meetings), not rows —
  // a statement-carrying revision renders as two rows but is one change.
  const [actorFilter, setActorFilter] = useState<ActorFilter>("all");
  const actorCounts = useMemo(() => {
    const counts: Record<Exclude<ActorFilter, "all">, number> = {
      ai: 0,
      user: 0,
      system: 0,
      meetings: meetings.length,
    };
    for (const item of server?.items ?? []) counts[item.actor.type] += 1;
    return counts;
  }, [server, meetings]);
  const visibleDays = useMemo(
    () =>
      actorFilter === "all"
        ? chronoDays
        : chronoDays
            .map((day) => ({
              ...day,
              rows: day.rows.filter((r) => rowCategory(r) === actorFilter),
            }))
            .filter((day) => day.rows.length > 0),
    [chronoDays, actorFilter],
  );

  // ?rev=<seq>: a citation (or the row itself) deep-links a revision; scroll
  // to it and flash it. Consumed on read so a reload doesn't re-flash.
  const revRef = useRef<HTMLLIElement | null>(null);
  const [flashSeq, setFlashSeq] = useState<number | null>(null);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const rev = params.get("rev");
    if (!rev) return;
    params.delete("rev");
    window.history.replaceState(null, "", `?${params.toString()}`);
    const seq = Number(rev);
    if (Number.isInteger(seq)) setFlashSeq(seq);
  }, []);
  useEffect(() => {
    if (flashSeq !== null && server) {
      revRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
      const timer = setTimeout(() => setFlashSeq(null), 1600);
      return () => clearTimeout(timer);
    }
  }, [flashSeq, server]);

  // --- Client mode -------------------------------------------------------------
  const entries = history.timeline();
  const [selected, setSelected] = useState(entries.length - 1);
  // Clamp: an undo while this view is open shortens the timeline, and a
  // stale index past the end would make Restore a silent no-op.
  const selectedIndex = Math.min(Math.max(selected, 0), entries.length - 1);
  const current = entries[selectedIndex];

  const restore = () => {
    restoreVersion(selectedIndex);
    setView("canvas");
  };

  // The server timeline's "show on board" jump: the first touched id is the
  // node the batch was most clearly about (the route caps the list at 10).
  const showOnBoard = (touched: string[]) => {
    const first = touched.find((id) => id.length > 0);
    if (!first) {
      notify("This revision touched no board objects.");
      return;
    }
    onCitation({ kind: "node", id: first });
  };

  const crumbs = [
    { label: "Boards", view: "dashboard" as const },
    { label: projectName || "Untitled board", view: "canvas" as const },
    { label: "History", current: true },
  ];
  const eyebrow = `History · ${projectName || "Untitled board"}`;
  const title = (
    <>
      Everything that happened, <em>in order</em>
    </>
  );

  // --------------------------------------------------------------------- render
  if (boardId) {
    const revisions = server?.items.length ?? 0;
    const statementEvents = server?.items.filter((i) => i.statementEvent).length ?? 0;
    const lede = !server
      ? undefined
      : revisions === 0 && meetings.length === 0
        ? "Nothing recorded on this board yet."
        : [
            `${plural(revisions, "revision")}${server.hasMore ? ` (the latest ${server.limit})` : ""}`,
            ...(meetings.length > 0 ? [plural(meetings.length, "meeting")] : []),
            ...(statementEvents > 0 ? [plural(statementEvents, "statement event")] : []),
          ].join(" · ");
    const filterItems = (
      [
        { id: "user", label: "People" },
        { id: "ai", label: "Approved AI changes" },
        { id: "system", label: "System" },
        { id: "meetings", label: "Meetings" },
      ] as Array<{ id: Exclude<ActorFilter, "all">; label: string }>
    )
      .filter((it) => actorCounts[it.id] > 0 || it.id === actorFilter)
      .map((it) => ({ ...it, count: actorCounts[it.id] }));

    return (
      <Page crumbs={crumbs} onOpenSettings={onOpenSettings} width="narrow">
        <PageHeader eyebrow={eyebrow} title={title} lede={lede} />

        {serverError ? (
          <EmptyState
            glyph={<Ico.History />}
            title={serverError}
            body="Check that the Lucent server is running, then try again."
            action={
              <Button variant="ghost" size="sm" onClick={() => setLoadAttempt((n) => n + 1)}>
                Try again
              </Button>
            }
          />
        ) : !server ? (
          <p className="hist-loading" role="status">
            Loading the board's history…
          </p>
        ) : server.items.length === 0 && meetings.length === 0 ? (
          <EmptyState
            glyph={<Ico.History />}
            title="No history yet"
            body="Every change to a shared board becomes a revision — who made it, when, and what it touched. Make a change and it will show up here."
            action={
              <Button variant="primary" size="sm" onClick={() => setView("canvas")}>
                Back to the canvas
              </Button>
            }
          />
        ) : (
          <>
            {banner && (
              <div className="hist-banner" role="note">
                <span className="mono-caps">History window</span>
                {banner}
              </div>
            )}

            {filterItems.length > 1 && (
              <div className="hist-filters">
                <FilterChips<ActorFilter>
                  label="Filter the timeline by who acted"
                  value={actorFilter}
                  onChange={setActorFilter}
                  items={[
                    {
                      id: "all",
                      label: "All",
                      count: revisions + meetings.length,
                    },
                    ...filterItems,
                  ]}
                />
                {(actorFilter === "ai" || actorFilter === "user") && (
                  <p className="hist-filter-note">
                    {actorFilter === "ai"
                      ? "Lucent's proposals that a person reviewed and approved. AI changes applied straight to the board are recorded under the person who asked for them."
                      : "Changes made by people — including AI changes applied without review, which are recorded under the person who asked for them."}
                  </p>
                )}
              </div>
            )}

            {visibleDays.length === 0 ? (
              <EmptyState compact title="Nothing in this filter" />
            ) : (
              <ol className="hist-timeline">
                {visibleDays.map((day) => (
                  <li key={day.key} className="hist-day">
                    <h2 className="hist-day-label">{day.label}</h2>
                    <ol className="hist-rows">
                      {day.rows.map((row, i) => (
                        <ServerRow
                          key={
                            row.kind === "meeting"
                              ? `m-${row.meeting.id}`
                              : `${row.kind === "statement" ? "s" : "r"}-${row.item.seq}-${i}`
                          }
                          row={row}
                          workspace={workspace}
                          flash={row.kind === "revision" && row.item.seq === flashSeq}
                          flashRef={revRef}
                          onNode={(id) => onCitation({ kind: "node", id })}
                          onMeeting={(id, turnRange) =>
                            onCitation({
                              kind: "meeting",
                              id,
                              ...(turnRange ? { turnRange } : {}),
                            })
                          }
                          onShowOnBoard={showOnBoard}
                        />
                      ))}
                    </ol>
                  </li>
                ))}
              </ol>
            )}
            <p className="hist-foot">
              Ask Lucent (“Ask” in the composer) answers questions about this same history, with
              citations back to it.
            </p>
          </>
        )}
      </Page>
    );
  }

  // Local board: the versions of this session.
  const changes = entries.length - 1;
  const undoRedo = (
    <>
      <Button variant="ghost" size="sm" onClick={undo} disabled={!canUndo} aria-label="Undo">
        <Ico.Undo /> Undo
      </Button>
      <Button variant="ghost" size="sm" onClick={redo} disabled={!canRedo} aria-label="Redo">
        <Ico.Redo /> Redo
      </Button>
    </>
  );
  return (
    <Page crumbs={crumbs} onOpenSettings={onOpenSettings} width="default">
      <PageHeader
        eyebrow={eyebrow}
        title={title}
        lede={
          changes > 0
            ? `${plural(changes, "change")} since this board was opened. A local board keeps its versions for this session — share it for a permanent, server-side record.`
            : "A local board keeps its versions for this session — share it for a permanent, server-side record."
        }
        actions={undoRedo}
      />

      {changes === 0 ? (
        <EmptyState
          glyph={<Ico.History />}
          title="No changes yet"
          body="Every AI change and manual edit becomes a version you can inspect and restore. Make a change on the canvas and it will show up here."
          action={
            <Button variant="primary" size="sm" onClick={() => setView("canvas")}>
              Back to the canvas
            </Button>
          }
        />
      ) : (
        <div className="hist-local">
          <ol className="hist-versions" aria-label="Versions, newest first">
            {entries
              .map((e, i) => ({ e, i }))
              .reverse()
              .map(({ e, i }) => {
                const isSel = i === selectedIndex;
                const isNow = i === entries.length - 1;
                return (
                  <li key={i} className={`hist-version ${isSel ? "is-selected" : ""}`}>
                    <span className={`hist-dot ${isNow ? "is-now" : ""}`} aria-hidden />
                    <button
                      type="button"
                      className="hist-version-btn"
                      aria-pressed={isSel}
                      onClick={() => setSelected(i)}
                    >
                      <span className="hist-version-head">
                        <span className="mono-caps">
                          {i === 0 ? "Starting point" : `Version ${i + 1}`}
                        </span>
                        {isNow && <span className="hist-now">Now</span>}
                      </span>
                      <span className="hist-version-label">
                        {i === 0 ? "The board as it was when this session began" : e.label}
                      </span>
                      <span className="hist-version-meta">
                        {plural(Object.keys(e.workspace.nodes).length, "node")} ·{" "}
                        {plural(Object.keys(e.workspace.edges).length, "edge")}
                      </span>
                    </button>
                  </li>
                );
              })}
          </ol>

          <Card className="hist-preview">
            <div className="hist-preview-head">
              <div className="hist-preview-title">
                <span className="mono-caps">
                  {selectedIndex === 0 ? "Starting point" : `Version ${selectedIndex + 1}`} of{" "}
                  {entries.length}
                </span>
                <span className="hist-preview-label">
                  {selectedIndex === 0
                    ? "The board as it was when this session began"
                    : (current?.label ?? "—")}
                </span>
              </div>
              <Button
                variant="primary"
                size="sm"
                onClick={restore}
                disabled={selectedIndex === entries.length - 1}
                title={
                  selectedIndex === entries.length - 1
                    ? "This is the current version"
                    : "Restore this version — the restore is itself a change you can undo"
                }
              >
                Restore this version
              </Button>
            </div>
            {current && <VersionPreview workspace={current.workspace} />}
          </Card>
        </div>
      )}
    </Page>
  );
}

/** One row of the shared board's chronology: a revision, a statement event, or a meeting. */
function ServerRow({
  row,
  workspace,
  flash,
  flashRef,
  onNode,
  onMeeting,
  onShowOnBoard,
}: {
  row: ChronologyRow;
  workspace: Workspace;
  flash: boolean;
  flashRef: MutableRefObject<HTMLLIElement | null>;
  onNode: (id: string) => void;
  onMeeting: (id: string, turnRange?: [number, number]) => void;
  onShowOnBoard: (touched: string[]) => void;
}) {
  if (row.kind === "meeting") {
    const m = row.meeting;
    return (
      <li className="hist-row">
        <time className="hist-time" dateTime={new Date(row.at).toISOString()}>
          {clock(row.at)}
        </time>
        <span className="hist-dot is-meeting" aria-hidden />
        <Card className="hist-card is-meeting">
          <div className="hist-card-head">
            <button
              type="button"
              className="hist-card-title"
              title={`Open the transcript: ${plural(m.turns.length, "turn")}`}
              onClick={() => onMeeting(m.id)}
            >
              Meeting
            </button>
            <span className="hist-actor">
              {m.endedAt === null ? "no end recorded" : `ended ${clock(m.endedAt)}`}
            </span>
          </div>
          <div className="hist-card-sub">
            {plural(m.turns.length, "turn")} · {classifiedTurns(m)} classified
          </div>
        </Card>
      </li>
    );
  }

  const item = row.item;
  const actorClass = `is-${item.actor.type}`;
  if (row.kind === "statement") {
    const ev = item.statementEvent!;
    const onBoard = workspace.nodes[ev.nodeId];
    // The server reports a status-only UPDATE_STATEMENT with a placeholder
    // kind ("decision" — historyView.ts: "the kind the reader knows from the
    // node"). Kind is identity (ADR 0021), so the node's own kind is the
    // truth; without it a resolved question would read "Decision · Decided".
    const kind = onBoard?.statement?.kind ?? ev.kind;
    return (
      <li className="hist-row" style={{ ["--kind" as string]: KIND_TINT[kind] }}>
        <time className="hist-time" dateTime={new Date(row.at).toISOString()}>
          {clock(row.at)}
        </time>
        <span className="hist-dot is-statement" aria-hidden />
        <Card className="hist-card is-statement">
          <div className="hist-card-head">
            <KindBadge kind={kind} status={ev.status} />
            <span className="hist-actor">{item.actor.name}</span>
          </div>
          {onBoard ? (
            <button
              type="button"
              className="hist-card-title serif"
              title={`Show the ${kind} on the board`}
              onClick={() => onNode(ev.nodeId)}
            >
              {onBoard.label}
            </button>
          ) : (
            <span className="hist-card-title is-gone">No longer on the board</span>
          )}
          {(Boolean(ev.topic) || (ev.supersedes?.length ?? 0) > 0) && (
            <div className="hist-card-sub">
              {(ev.supersedes?.length ?? 0) > 0 ? "Superseded a previous statement" : ""}
              {(ev.supersedes?.length ?? 0) > 0 && ev.topic ? " · " : ""}
              {ev.topic && <span className="hist-topic">{ev.topic}</span>}
            </div>
          )}
        </Card>
      </li>
    );
  }

  return (
    <li className={`hist-row ${flash ? "is-flash" : ""}`} ref={flash ? flashRef : undefined}>
      <time className="hist-time" dateTime={new Date(row.at).toISOString()}>
        {clock(row.at)}
      </time>
      <span className={`hist-dot ${actorClass}`} aria-hidden />
      <Card className={`hist-card ${actorClass}`}>
        <div className="hist-card-head">
          <button
            type="button"
            className="hist-card-title"
            title={
              item.touched.length
                ? `Show on board: ${item.touched.slice(0, 3).join(", ")}`
                : "This revision touched no board objects"
            }
            onClick={() => onShowOnBoard(item.touched)}
          >
            {item.actor.type === "ai" && <Ico.Sparkle className="hist-ai-mark" aria-hidden />}
            <span>{item.label}</span>
          </button>
          <span className="hist-actor">{item.actor.name}</span>
        </div>
        <RevisionDetail item={item} workspace={workspace} onNode={onNode} onMeeting={onMeeting} />
      </Card>
    </li>
  );
}

/** A revision's evidence line: ops, what it touched, who proposed/approved, the meeting. */
function RevisionDetail({
  item,
  workspace,
  onNode,
  onMeeting,
}: {
  item: BoardHistoryItem;
  workspace: Workspace;
  onNode: (id: string) => void;
  onMeeting: (id: string, turnRange?: [number, number]) => void;
}) {
  // Only ids that are still nodes on the board get a named chip; the rest
  // are counted, never guessed at.
  const named = item.touched.filter((id) => workspace.nodes[id]).slice(0, 3);
  const rest = item.touched.length - named.length;
  return (
    <>
      <div className="hist-card-sub">
        <span className="mono">{plural(item.opCount, "op")}</span>
        {named.map((id) => (
          <button key={id} type="button" className="hist-touched" onClick={() => onNode(id)}>
            {workspace.nodes[id]!.label}
          </button>
        ))}
        {rest > 0 && (
          <span className="hist-more">
            {named.length > 0 ? `+${rest} more` : plural(rest, "object")}
          </span>
        )}
        {item.proposal?.meetingId && (
          <ProvenanceChip
            icon={<Ico.Present aria-hidden />}
            label="From a meeting"
            title="Open the meeting this proposal came from"
            onClick={() => onMeeting(item.proposal!.meetingId!, item.proposal!.turnRange)}
          />
        )}
      </div>
      {item.actor.type === "ai" && (item.actor.initiatedBy || item.actor.approvedBy) && (
        <div className="hist-approval">
          {item.actor.initiatedBy && <>Requested by {item.actor.initiatedBy}</>}
          {item.actor.initiatedBy && item.actor.approvedBy && " · "}
          {item.actor.approvedBy && (
            <>
              approved by <strong>{item.actor.approvedBy}</strong>
            </>
          )}
        </div>
      )}
      {item.proposal?.quote && (
        <blockquote className="hist-quote">“{item.proposal.quote}”</blockquote>
      )}
    </>
  );
}

/** A read-only, fit-to-box rendering of one version of the board. */
function VersionPreview({ workspace }: { workspace: Workspace }) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = boxRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((obs) => {
      const r = obs[0]?.contentRect;
      if (r) setBox({ w: r.width, h: r.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const bounds = useMemo(() => {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const n of Object.values(workspace.nodes)) {
      if (!n.position) continue;
      minX = Math.min(minX, n.position.x);
      minY = Math.min(minY, n.position.y);
      maxX = Math.max(maxX, n.position.x + (n.size?.width ?? 150));
      maxY = Math.max(maxY, n.position.y + (n.size?.height ?? 60));
    }
    return Number.isFinite(minX) ? { x: minX, y: minY, w: maxX - minX, h: maxY - minY } : null;
  }, [workspace]);
  const pad = 28;
  const scale =
    bounds && box.w > 0
      ? Math.min(
          1,
          (box.w - pad * 2) / Math.max(bounds.w, 1),
          (box.h - pad * 2) / Math.max(bounds.h, 1),
        )
      : 0;
  return (
    <div ref={boxRef} className="hist-preview-box">
      {!bounds ? (
        <p className="hist-preview-empty">This version has no nodes on the board.</p>
      ) : (
        scale > 0 && (
          <div
            className="hist-preview-stage"
            style={{
              width: bounds.x + bounds.w + pad,
              height: bounds.y + bounds.h + pad,
              transform: `translate(${(box.w - bounds.w * scale) / 2 - bounds.x * scale}px, ${
                (box.h - bounds.h * scale) / 2 - bounds.y * scale
              }px) scale(${scale})`,
            }}
          >
            <DiagramLayer workspace={workspace} showEdgeLabels={false} />
          </div>
        )
      )}
    </div>
  );
}
