import { useEffect, useMemo, useRef, useState } from "react";
import { Ico } from "../ui/icons.js";
import { TopBar, LeftRail } from "../ui/Chrome.js";
import { DiagramLayer } from "../ui/DiagramLayer.js";
import { useWorkspace } from "../workspace.js";
import { useToast } from "../ui/Toast.js";
import { fetchBoardHistory, type BoardHistory } from "../boards.js";
import { listMeetings, type MeetingTranscript } from "../meetings.js";
import {
  classifiedTurns,
  chronologyByDay,
  depthBanner,
  mergeChronology,
} from "../historyTimeline.js";
import { KIND_TINT, statementChipText } from "../statementUi.js";

/**
 * Version history. Two sources, one surface (Stage C1):
 *
 * - A SHARED board (boardId set) renders the server's revision timeline —
 *   the op log's authoritative, windowed record (who, when, what, and the
 *   proposal link), grouped by day, with the honest depth banner when the
 *   plan's window truncates. This is the timeline Ask cites.
 * - A LOCAL board (no boardId) keeps the client timeline exactly as before —
 *   there is no server log to read, and the local History view predates it.
 */
export function HistoryView({ onOpenSettings }: { onOpenSettings: (section?: string) => void }) {
  const { history, undo, redo, canUndo, canRedo, restoreVersion, setView, boardId, onCitation } =
    useWorkspace();
  const { notify } = useToast();

  // --- Server mode -----------------------------------------------------------
  const [server, setServer] = useState<BoardHistory | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  // The board's meetings, for the merged chronology (Stage C3): revisions,
  // meeting markers, and statement events as one timeline.
  const [meetings, setMeetings] = useState<MeetingTranscript[]>([]);
  useEffect(() => {
    if (!boardId) return;
    let cancelled = false;
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
  }, [boardId]);

  // The merged project chronology (Stage C3): day-grouped rows across the
  // three streams. When no meetings and no statement events exist, this
  // degrades to exactly the revision list C1 shipped.
  const chronoDays = useMemo(
    () => chronologyByDay(mergeChronology(server?.items ?? [], meetings)),
    [server, meetings],
  );
  const banner = server ? depthBanner(server) : null;

  // ?rev=<seq>: a citation (or the row itself) deep-links a revision; scroll
  // to it and flash it. Consumed on read so a reload doesn't re-flash.
  const revRef = useRef<HTMLDivElement | null>(null);
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
    if (flashSeq !== null) {
      revRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
      const t = setTimeout(() => setFlashSeq(null), 1600);
      return () => clearTimeout(t);
    }
  }, [flashSeq]);

  // --- Client mode (unchanged) -------------------------------------------------
  const entries = history.timeline();
  const [selected, setSelected] = useState(entries.length - 1);
  const current = entries[Math.min(selected, entries.length - 1)];

  const restore = () => {
    restoreVersion(selected);
    setView("canvas");
  };

  // The server timeline's "show on board" jump: the first touched id is the
  // node the batch was most clearly about (the route caps the list at 10).
  const showOnBoard = (seq: number, touched: string[]) => {
    const first = touched.find((id) => id.length > 0);
    if (!first) {
      notify("This revision touched no board objects.");
      return;
    }
    onCitation({ kind: "node", id: first });
  };

  // --------------------------------------------------------------------- render
  if (boardId) {
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
            { label: "History", current: true },
          ]}
          onOpenSettings={onOpenSettings}
        />
        <LeftRail />

        {serverError ? (
          <div className="view-empty">
            <div className="view-empty-icon">
              <Ico.History />
            </div>
            <h2>{serverError}</h2>
            <p>Check that the Lucent server is running, then reopen this view.</p>
          </div>
        ) : !server || server.items.length === 0 ? (
          <div className="view-empty">
            <div className="view-empty-icon">
              <Ico.History />
            </div>
            <h2>No history yet</h2>
            <p>
              Every change to a shared board becomes a revision — who made it, when, and what it
              touched. Make a change and it will show up here.
            </p>
          </div>
        ) : (
          <div
            style={{
              position: "absolute",
              top: 76,
              bottom: 30,
              left: 76,
              right: 30,
              display: "grid",
              gridTemplateColumns: "minmax(420px, 520px) 1fr",
              gap: 18,
            }}
          >
            <div
              style={{
                background: "oklch(from var(--canvas-2) l c h / 0.75)",
                border: "1px solid var(--stroke-1)",
                borderRadius: 16,
                overflow: "hidden",
                display: "flex",
                flexDirection: "column",
              }}
            >
              <div
                style={{
                  padding: "14px 18px",
                  borderBottom: "1px solid var(--stroke-1)",
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                }}
              >
                <div style={{ fontSize: 13, fontVariationSettings: "'wght' 550" }}>Timeline</div>
                <span className="mono" style={{ fontSize: 10, color: "var(--ink-3)" }}>
                  {server.items.length} revision{server.items.length === 1 ? "" : "s"}
                  {server.hasMore ? ` · latest ${server.limit}` : ""}
                </span>
              </div>
              {banner && (
                <div
                  className="mono"
                  style={{
                    fontSize: 11,
                    color: "var(--amber-1)",
                    background: "oklch(from var(--canvas-2) l c h / 0.6)",
                    borderBottom: "1px solid var(--stroke-1)",
                    padding: "8px 18px",
                  }}
                >
                  {banner}
                </div>
              )}
              <div
                className="panel-body"
                style={{ flex: 1, overflowY: "auto", padding: "10px 8px 20px" }}
              >
                {chronoDays.map((day) => (
                  <div key={day.key} style={{ marginBottom: 10 }}>
                    <div
                      className="mono"
                      style={{
                        fontSize: 10,
                        color: "var(--ink-3)",
                        letterSpacing: "0.06em",
                        textTransform: "uppercase",
                        padding: "6px 12px 4px",
                      }}
                    >
                      {day.label}
                    </div>
                    {day.rows.map((row, i) => {
                      // The merged chronology (Stage C3): three row kinds over
                      // one day-grouped timeline. Statement events and meeting
                      // markers join the revision rows C1 shipped.
                      if (row.kind === "meeting") {
                        return (
                          <div
                            key={`m-${row.meeting.id}`}
                            style={{ display: "flex", gap: 12, position: "relative" }}
                          >
                            <div style={{ width: 24, position: "relative", flexShrink: 0 }}>
                              <div
                                style={{
                                  position: "absolute",
                                  top: 12,
                                  left: 2,
                                  width: 20,
                                  height: 12,
                                  borderRadius: 4,
                                  background: "var(--canvas-2)",
                                  border: "1px solid var(--stroke-2)",
                                }}
                              />
                            </div>
                            <button
                              onClick={() => onCitation({ kind: "meeting", id: row.meeting.id })}
                              title={`Open the transcript: ${row.meeting.turns.length} turns`}
                              style={{
                                flex: 1,
                                textAlign: "left",
                                padding: "8px 12px 8px 0",
                                marginBottom: 4,
                                borderRadius: 8,
                                background: "transparent",
                                border: "1px solid transparent",
                              }}
                            >
                              <div
                                style={{
                                  display: "flex",
                                  alignItems: "baseline",
                                  gap: 8,
                                  marginBottom: 2,
                                }}
                              >
                                <span
                                  className="mono"
                                  style={{ fontSize: 10.5, color: "var(--ink-3)" }}
                                >
                                  {new Date(row.at).toLocaleTimeString([], {
                                    hour: "2-digit",
                                    minute: "2-digit",
                                  })}
                                </span>
                                <span
                                  style={{
                                    fontSize: 13,
                                    color: "var(--ink-0)",
                                    fontVariationSettings: "'wght' 500",
                                    flex: 1,
                                  }}
                                >
                                  Meeting
                                </span>
                                <span
                                  className="mono"
                                  style={{ fontSize: 9.5, color: "var(--ink-3)" }}
                                >
                                  {row.meeting.endedAt === null ? "no end recorded" : "ended"}
                                </span>
                              </div>
                              <div style={{ fontSize: 12, color: "var(--ink-2)" }}>
                                {row.meeting.turns.length} turn
                                {row.meeting.turns.length === 1 ? "" : "s"} ·{" "}
                                {classifiedTurns(row.meeting)} classified
                              </div>
                            </button>
                          </div>
                        );
                      }
                      const item = row.item;
                      const isStatement = row.kind === "statement";
                      const isAi = item.actor.type === "ai";
                      const flash = item.seq === flashSeq;
                      const tint = isStatement
                        ? KIND_TINT[item.statementEvent!.kind]
                        : undefined;
                      return (
                        <div
                          key={`${isStatement ? "s" : "r"}-${item.seq}-${i}`}
                          ref={flash && !isStatement ? revRef : undefined}
                          style={{
                            display: "flex",
                            gap: 12,
                            position: "relative",
                            borderRadius: 8,
                            transition: "background 0.6s",
                            background:
                              flash && !isStatement
                                ? "oklch(0.82 0.15 75 / 0.18)"
                                : "transparent",
                          }}
                        >
                          <div style={{ width: 24, position: "relative", flexShrink: 0 }}>
                            <div
                              style={{
                                position: "absolute",
                                top: 12,
                                left: 6,
                                width: 12,
                                height: 12,
                                borderRadius: 999,
                                background: isStatement
                                  ? tint ?? "var(--canvas-3)"
                                  : isAi
                                    ? "linear-gradient(135deg, var(--amber-2), var(--amber-3))"
                                    : "var(--canvas-3)",
                                border: `1px solid ${
                                  isStatement
                                    ? tint ?? "var(--stroke-2)"
                                    : isAi
                                      ? "oklch(0.82 0.15 75 / 0.5)"
                                      : "var(--stroke-2)"
                                }`,
                                boxShadow: isAi && !isStatement ? "0 0 8px var(--amber-glow)" : "none",
                              }}
                            />
                          </div>
                          <button
                            onClick={() =>
                              isStatement
                                ? onCitation({ kind: "node", id: item.statementEvent!.nodeId })
                                : showOnBoard(item.seq, item.touched)
                            }
                            title={
                              isStatement
                                ? `Show the ${item.statementEvent!.kind} node on the board`
                                : item.touched.length
                                  ? `Show on board: ${item.touched.slice(0, 3).join(", ")}`
                                  : "This revision touched no board objects"
                            }
                            style={{
                              flex: 1,
                              textAlign: "left",
                              padding: "8px 12px 8px 0",
                              marginBottom: 4,
                              borderRadius: 8,
                              background: "transparent",
                              border: "1px solid transparent",
                            }}
                          >
                            <div
                              style={{
                                display: "flex",
                                alignItems: "baseline",
                                gap: 8,
                                marginBottom: 2,
                              }}
                            >
                              <span
                                className="mono"
                                style={{ fontSize: 10.5, color: "var(--ink-3)" }}
                              >
                                {new Date(item.at).toLocaleTimeString([], {
                                  hour: "2-digit",
                                  minute: "2-digit",
                                })}
                              </span>
                              <span
                                style={{
                                  fontSize: 13,
                                  color: isStatement ? tint ?? "var(--ink-0)" : "var(--ink-0)",
                                  fontVariationSettings: "'wght' 500",
                                  flex: 1,
                                }}
                              >
                                {isStatement
                                  ? statementChipText(item.statementEvent!)
                                  : item.label}
                              </span>
                              {isStatement && (
                                <span
                                  className="mono"
                                  style={{ fontSize: 9.5, color: "var(--ink-3)" }}
                                >
                                  statement
                                </span>
                              )}
                              {isAi && !isStatement && (
                                <span
                                  className="mono"
                                  style={{ fontSize: 10, color: "var(--amber-2)" }}
                                >
                                  ✦
                                </span>
                              )}
                            </div>
                            <div style={{ fontSize: 12, color: "var(--ink-2)" }}>
                              {isStatement
                                ? `${item.actor.name}${item.statementEvent!.supersedes?.length ? " · superseded a previous statement" : ""}${item.statementEvent!.topic ? ` · ${item.statementEvent!.topic}` : ""}`
                                : `${item.actor.name} · ${item.opCount} op${
                                    item.opCount === 1 ? "" : "s"
                                  }${item.proposal?.meetingId ? ` · from meeting` : ""}`}
                            </div>
                          </button>
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>

            <div
              style={{
                background: "var(--canvas-0)",
                border: "1px solid var(--stroke-1)",
                borderRadius: 16,
                overflow: "hidden",
                display: "flex",
                flexDirection: "column",
              }}
            >
              <div
                style={{
                  padding: "14px 18px",
                  borderBottom: "1px solid var(--stroke-1)",
                }}
              >
                <div style={{ fontSize: 13, fontVariationSettings: "'wght' 550" }}>
                  Every change, remembered
                </div>
                <div className="mono" style={{ fontSize: 10.5, color: "var(--ink-3)", marginTop: 2 }}>
                  {server.items.length} visible revision
                  {server.items.length === 1 ? "" : "s"}
                  {server.hasMore ? ` of more — your plan shows the latest ${server.limit}` : ""}
                </div>
              </div>
              <div
                style={{
                  flex: 1,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "var(--ink-3)",
                  fontSize: 13,
                  padding: 30,
                  textAlign: "center",
                }}
              >
                Pick a revision on the left to jump to the objects it touched. Ask Lucent
                (&ldquo;Ask&rdquo; in the composer) answers questions about this same history, with
                citations back to it.
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  // Local board: the client timeline, unchanged.
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
          { label: "History", current: true },
        ]}
        onOpenSettings={onOpenSettings}
        actions={
          <>
            <button className="icon-btn" onClick={undo} disabled={!canUndo} aria-label="Undo">
              <Ico.Undo />
            </button>
            <button className="icon-btn" onClick={redo} disabled={!canRedo} aria-label="Redo">
              <Ico.Redo />
            </button>
            <div style={{ width: 6 }} />
            <button className="icon-btn primary" onClick={restore} disabled={entries.length <= 1}>
              Restore version
            </button>
          </>
        }
      />
      <LeftRail />

      {entries.length <= 1 ? (
        <div className="view-empty">
          <div className="view-empty-icon">
            <Ico.History />
          </div>
          <h2>No history yet</h2>
          <p>
            Every AI change and manual edit becomes a version you can inspect and restore. Make a
            change on the canvas and it will show up here.
          </p>
        </div>
      ) : (
        <div
          style={{
            position: "absolute",
            top: 76,
            bottom: 30,
            left: 76,
            right: 30,
            display: "grid",
            gridTemplateColumns: "420px 1fr",
            gap: 18,
          }}
        >
          <div
            style={{
              background: "oklch(from var(--canvas-2) l c h / 0.75)",
              border: "1px solid var(--stroke-1)",
              borderRadius: 16,
              overflow: "hidden",
              display: "flex",
              flexDirection: "column",
            }}
          >
            <div
              style={{
                padding: "14px 18px",
                borderBottom: "1px solid var(--stroke-1)",
                display: "flex",
                alignItems: "center",
                gap: 10,
              }}
            >
              <div style={{ fontSize: 13, fontVariationSettings: "'wght' 550" }}>Timeline</div>
              <span className="mono" style={{ fontSize: 10, color: "var(--ink-3)" }}>
                {entries.length} versions
              </span>
            </div>
            <div
              className="panel-body"
              style={{ flex: 1, overflowY: "auto", padding: "10px 8px 20px" }}
            >
              {entries.map((e, i) => {
                const isSel = i === selected;
                const isAi =
                  e.label !== "initial" && e.label !== "loaded" && !e.label.startsWith("Transform");
                return (
                  <div key={i} style={{ display: "flex", gap: 12, position: "relative" }}>
                    <div style={{ width: 24, position: "relative", flexShrink: 0 }}>
                      {i < entries.length - 1 && (
                        <div
                          style={{
                            position: "absolute",
                            top: 22,
                            bottom: -6,
                            left: 11,
                            width: 1,
                            background: "var(--stroke-1)",
                          }}
                        />
                      )}
                      <div
                        style={{
                          position: "absolute",
                          top: 10,
                          left: 6,
                          width: 12,
                          height: 12,
                          borderRadius: 999,
                          background: isAi
                            ? "linear-gradient(135deg, var(--amber-2), var(--amber-3))"
                            : "var(--canvas-3)",
                          border: `1px solid ${isAi ? "oklch(0.82 0.15 75 / 0.5)" : "var(--stroke-2)"}`,
                          boxShadow: isAi ? "0 0 8px var(--amber-glow)" : "none",
                        }}
                      />
                    </div>
                    <button
                      onClick={() => setSelected(i)}
                      style={{
                        flex: 1,
                        textAlign: "left",
                        padding: "8px 12px",
                        marginBottom: 4,
                        borderRadius: 8,
                        background: isSel ? "var(--canvas-3)" : "transparent",
                        border: `1px solid ${isSel ? "var(--stroke-2)" : "transparent"}`,
                      }}
                    >
                      <div
                        style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 2 }}
                      >
                        <span className="mono" style={{ fontSize: 10.5, color: "var(--ink-3)" }}>
                          {new Date(e.timestamp).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </span>
                        <span
                          style={{
                            fontSize: 13,
                            color: "var(--ink-0)",
                            fontVariationSettings: "'wght' 500",
                            flex: 1,
                          }}
                        >
                          {e.label}
                        </span>
                        {i === entries.length - 1 && (
                          <span
                            className="mono"
                            style={{
                              fontSize: 9,
                              color: "var(--sig-green)",
                              padding: "2px 6px",
                              borderRadius: 3,
                              background: "oklch(0.78 0.11 155 / 0.12)",
                              border: "1px solid oklch(0.78 0.11 155 / 0.25)",
                              letterSpacing: "0.05em",
                              textTransform: "uppercase",
                            }}
                          >
                            Now
                          </span>
                        )}
                      </div>
                      <div style={{ fontSize: 12, color: "var(--ink-2)" }}>
                        {Object.keys(e.workspace.nodes).length} nodes ·{" "}
                        {Object.keys(e.workspace.edges).length} edges
                      </div>
                    </button>
                  </div>
                );
              })}
            </div>
          </div>

          <div
            style={{
              background: "var(--canvas-0)",
              border: "1px solid var(--stroke-1)",
              borderRadius: 16,
              overflow: "hidden",
              display: "flex",
              flexDirection: "column",
            }}
          >
            <div
              style={{
                padding: "14px 18px",
                borderBottom: "1px solid var(--stroke-1)",
                display: "flex",
                alignItems: "center",
                gap: 10,
              }}
            >
              <div>
                <div style={{ fontSize: 13, fontVariationSettings: "'wght' 550" }}>
                  {current?.label ?? "—"}
                </div>
                <div
                  className="mono"
                  style={{ fontSize: 10.5, color: "var(--ink-3)", marginTop: 2 }}
                >
                  Version #{selected + 1}
                </div>
              </div>
              <div style={{ flex: 1 }} />
              <button
                className="icon-btn"
                style={{ height: 28, fontSize: 11.5 }}
                onClick={() => notify("Side-by-side version compare is coming soon.")}
              >
                Compare
              </button>
              <button
                className="icon-btn primary"
                style={{ height: 28, fontSize: 11.5 }}
                onClick={restore}
              >
                Restore
              </button>
            </div>
            <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  transform: "scale(0.6)",
                  transformOrigin: "center",
                }}
              >
                {current && <DiagramLayer workspace={current.workspace} />}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
