import { useEffect, useMemo, useRef, useState } from "react";
import { Ico } from "../ui/icons.js";
import { AtelierAppShell } from "../ui/atelierAtoms.js";
import { useWorkspace, type View } from "../workspace.js";
import { useToast } from "../ui/Toast.js";
import { fetchBoardHistory, type BoardHistory } from "../boards.js";
import { listMeetings, type MeetingTranscript } from "../meetings.js";
import {
  chronologyByDay,
  depthBanner,
  mergeChronology,
} from "../historyTimeline.js";
import { statementChipText } from "../statementUi.js";

function BotIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="7" width="16" height="12" rx="2.5" />
      <circle cx="9" cy="13" r="1" fill="currentColor" />
      <circle cx="15" cy="13" r="1" fill="currentColor" />
      <path d="M12 4v3M8 19v2M16 19v2" />
    </svg>
  );
}

interface TimelineDisplayEvent {
  id?: string;
  time: string;
  title: string;
  desc: string;
  bloom: boolean;
  who: string;
  type: "all" | "lucent" | "people" | "system";
  onRestore?: () => void;
  onReveal?: () => void;
}

const DEMO_EVENTS: TimelineDisplayEvent[] = [
  { time: "just now", title: 'You reverted "Legacy Auth" removal', desc: "Restored from commit d2f4a1c", bloom: false, who: "YOU", type: "people" },
  { time: "2m ago", title: "Applied 6 changes from proposal", desc: "Payment Service · Redis Cache · Notification Bus + 3 edits", bloom: true, who: "LUCENT", type: "lucent" },
  { time: "4m ago", title: "Sarah joined the workspace", desc: "Invited via lucent.app/w/e-commerce-x8j2", bloom: false, who: "SARAH", type: "people" },
  { time: "8m ago", title: "Lucent proposed adding payments", desc: 'From voice · "add stripe integration"', bloom: true, who: "LUCENT", type: "lucent" },
  { time: "12m ago", title: 'Renamed "Checkout" → "Order Service"', desc: "Manual edit by Alex", bloom: false, who: "YOU", type: "people" },
  { time: "18m ago", title: "Layout reflowed · ELK mrtree", desc: "Auto-layout after 3 node moves", bloom: false, who: "SYSTEM", type: "system" },
  { time: "24m ago", title: "Lucent generated initial draft", desc: 'From "design an e-commerce platform" · 8 nodes, 6 edges', bloom: true, who: "LUCENT", type: "lucent" },
  { time: "25m ago", title: "Workspace created", desc: "E-commerce platform · from blank", bloom: false, who: "YOU", type: "people" },
];

export function HistoryView({ onOpenSettings }: { onOpenSettings?: (section?: string) => void }) {
  const { history, restoreVersion, setView, boardId, onCitation, projectName } = useWorkspace();
  const { notify } = useToast();
  const [filter, setFilter] = useState<"all" | "lucent" | "people" | "system">("all");

  // --- Server mode -----------------------------------------------------------
  const [server, setServer] = useState<BoardHistory | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
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

  // Merge server revisions & meetings into timeline display items
  const serverEvents = useMemo((): TimelineDisplayEvent[] => {
    if (!server || server.items.length === 0) return [];
    return server.items.map((item) => {
      const isAi = item.actor.type === "ai" || !!item.proposal;
      const isStatement = !!item.statementEvent;
      const label = isStatement ? statementChipText(item.statementEvent!) : item.label;
      const who = isAi ? "LUCENT" : item.actor.name.toUpperCase();
      const type: "all" | "lucent" | "people" | "system" = isAi
        ? "lucent"
        : item.actor.type === "system"
          ? "system"
          : "people";
      const desc = isStatement
        ? `${item.actor.name}${item.statementEvent!.supersedes?.length ? " · superseded a previous statement" : ""}${item.statementEvent!.topic ? ` · ${item.statementEvent!.topic}` : ""}`
        : `${item.actor.name} · ${item.opCount} op${item.opCount === 1 ? "" : "s"}${item.proposal?.meetingId ? " · from meeting" : ""}`;
      const timeStr = formatDelta(Date.now() - item.at);

      return {
        id: String(item.seq),
        time: timeStr,
        title: label,
        desc,
        bloom: isAi,
        who,
        type,
        onReveal: () => {
          const first = item.touched.find((id) => id.length > 0);
          if (first) {
            onCitation({ kind: "node", id: first });
          } else {
            notify("This revision touched no board objects.");
          }
        },
      };
    });
  }, [server, onCitation, notify]);

  // Client mode timeline items
  const clientEntries = history.timeline();
  const clientEvents = useMemo((): TimelineDisplayEvent[] => {
    if (clientEntries.length <= 1) return [];
    return clientEntries
      .slice()
      .reverse()
      .map((entry, revIdx) => {
        const actualIdx = clientEntries.length - 1 - revIdx;
        const isAi =
          entry.label !== "initial" &&
          entry.label !== "loaded" &&
          !entry.label.startsWith("Transform");
        const who = isAi ? "LUCENT" : "YOU";
        const type: "all" | "lucent" | "people" | "system" = isAi ? "lucent" : "people";
        const nodeCount = Object.keys(entry.workspace.nodes).length;
        const edgeCount = Object.keys(entry.workspace.edges).length;
        return {
          id: String(actualIdx),
          time: formatDelta(Date.now() - entry.timestamp),
          title: entry.label,
          desc: `${nodeCount} nodes · ${edgeCount} edges`,
          bloom: isAi,
          who,
          type,
          onRestore: () => {
            restoreVersion(actualIdx);
            setView("canvas" as View);
            notify(`Restored to version: ${entry.label}`);
          },
        };
      });
  }, [clientEntries, restoreVersion, setView, notify]);

  // Combined timeline events (server if available, client if available, fallback to demo)
  const displayEvents: TimelineDisplayEvent[] = useMemo(() => {
    if (serverEvents.length > 0) return serverEvents;
    if (clientEvents.length > 0) return clientEvents;
    return DEMO_EVENTS;
  }, [serverEvents, clientEvents]);

  const filteredEvents = useMemo(() => {
    if (filter === "all") return displayEvents;
    return displayEvents.filter((e) => e.type === filter);
  }, [displayEvents, filter]);

  return (
    <AtelierAppShell
      activeArea="history"
      crumbs={[
        { label: "Personal", onClick: () => setView("workspace" as View) },
        { label: projectName || "E-commerce platform", view: "canvas" as View },
        { label: "History", current: true },
      ]}
      onOpenSettings={onOpenSettings}
    >
      <div style={{ padding: "32px 40px 60px", maxWidth: 960, margin: "0 auto" }}>
        <div className="mono-caps" style={{ marginBottom: 8, color: "var(--ink-3)" }}>
          Fig. 07 · Workspace history
        </div>
        <h1
          style={{
            fontFamily: "var(--font-serif)",
            fontSize: 40,
            letterSpacing: "-0.02em",
            fontWeight: 400,
            color: "var(--ink-0)",
            margin: "0 0 8px",
            lineHeight: 1.15,
          }}
        >
          Everything that happened, in order.
        </h1>
        <div
          style={{
            fontFamily: "var(--font-serif)",
            fontStyle: "italic",
            fontSize: 15,
            color: "var(--ink-2)",
            marginBottom: 32,
          }}
        >
          {displayEvents.length} events today · scroll for older
        </div>

        {serverError && (
          <div
            style={{
              padding: "10px 14px",
              borderRadius: 8,
              background: "oklch(from var(--madder) l c h / 0.1)",
              color: "var(--madder)",
              marginBottom: 20,
              fontSize: 13,
            }}
          >
            {serverError}
          </div>
        )}

        {/* Filter Bar */}
        <div style={{ display: "flex", gap: 8, marginBottom: 26, alignItems: "center" }}>
          <button
            type="button"
            className={`icon-btn ${filter === "all" ? "primary" : ""}`}
            style={{ height: 32, fontSize: 12.5 }}
            onClick={() => setFilter("all")}
          >
            All
          </button>
          <button
            type="button"
            className={`icon-btn ${filter === "lucent" ? "primary" : ""}`}
            style={{ height: 32, fontSize: 12.5 }}
            onClick={() => setFilter("lucent")}
          >
            <Ico.Sparkle /> Lucent
          </button>
          <button
            type="button"
            className={`icon-btn ${filter === "people" ? "primary" : ""}`}
            style={{ height: 32, fontSize: 12.5 }}
            onClick={() => setFilter("people")}
          >
            <Ico.User /> People
          </button>
          <button
            type="button"
            className={`icon-btn ${filter === "system" ? "primary" : ""}`}
            style={{ height: 32, fontSize: 12.5 }}
            onClick={() => setFilter("system")}
          >
            <BotIcon /> System
          </button>
          <div style={{ flex: 1 }} />
          <button
            type="button"
            className="icon-btn"
            style={{ height: 32, fontSize: 12.5 }}
            onClick={() => notify("Exporting JSON audit ledger…")}
          >
            Export ledger
          </button>
        </div>

        {/* Timeline rows */}
        <div style={{ display: "grid", gap: 0 }}>
          {filteredEvents.map((e, i) => (
            <div key={e.id || i} className="tl-row">
              <div className="tl-time">{e.time}</div>
              <div className={`tl-node ${e.bloom ? "bloom" : ""}`}>
                <div className="dot" />
                {i < filteredEvents.length - 1 && <div className="line" />}
              </div>
              <div className="tl-body">
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                  {e.bloom && <Ico.Sparkle style={{ color: "var(--bloom-2)" }} />}
                  <div className="tl-title">{e.title}</div>
                  <div style={{ flex: 1 }} />
                  <span
                    className="mono-caps"
                    style={{
                      fontSize: 10,
                      padding: "2px 6px",
                      borderRadius: 4,
                      background: e.bloom
                        ? "var(--bloom-wash-2)"
                        : "oklch(from var(--paper-2) l c h / 0.8)",
                      color: e.bloom ? "var(--bloom-2)" : "var(--ink-2)",
                    }}
                  >
                    {e.who}
                  </span>
                </div>
                <div className="tl-desc">{e.desc}</div>
                {(e.onRestore || e.onReveal) && (
                  <div
                    style={{
                      display: "flex",
                      gap: 8,
                      marginTop: 10,
                      paddingTop: 8,
                      borderTop: "1px solid oklch(from var(--paper-4) l c h / 0.4)",
                    }}
                  >
                    {e.onRestore && (
                      <button
                        type="button"
                        className="btn-atelier ghost"
                        style={{ height: 26, fontSize: 11.5 }}
                        onClick={e.onRestore}
                      >
                        Restore this version
                      </button>
                    )}
                    {e.onReveal && (
                      <button
                        type="button"
                        className="btn-atelier ghost"
                        style={{ height: 26, fontSize: 11.5 }}
                        onClick={e.onReveal}
                      >
                        Reveal on canvas
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </AtelierAppShell>
  );
}

function formatDelta(deltaMs: number): string {
  if (deltaMs < 60_000) return "just now";
  const mins = Math.floor(deltaMs / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
