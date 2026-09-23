import { useEffect, useState, useMemo } from "react";
import { executionRollup } from "@lucent/core";
import { useWorkspace, type View } from "../workspace.js";
import { getSessionUser } from "../session.js";
import { listProjects, type ProjectMeta } from "../persistence.js";
import { listBoards, type BoardSummary } from "../boards.js";
import { loadOrgs } from "../orgs.js";
import { listMeetings, type MeetingTranscript } from "../meetings.js";
import { intelligenceSections, inboxItems } from "../intelligence.js";
import { Ico } from "../ui/icons.js";
import {
  AtelierAppShell,
  StatCard,
  ProvenanceChip,
  DecisionIcon,
  ActionIcon,
  RiskIcon,
} from "../ui/atelierAtoms.js";

interface UnifiedBoard {
  id: string;
  name: string;
  updatedAt: number;
  isLocal: boolean;
  nodes?: number;
}

export function HomeView({ onOpenSettings }: { onOpenSettings: (section?: string) => void }) {
  const { setView, send, openProject, openBoard, newProject, workspace, boardId } = useWorkspace();
  const [askPrompt, setAskPrompt] = useState("");
  const [projects, setProjects] = useState<ProjectMeta[]>([]);
  const [cloudBoards, setCloudBoards] = useState<BoardSummary[]>([]);
  const [meetings, setMeetings] = useState<MeetingTranscript[]>([]);
  const user = getSessionUser();
  const userName = user?.name ? user.name.split(" ")[0] : user?.email ? user.email.split("@")[0] : "there";

  useEffect(() => {
    try {
      setProjects(listProjects().slice(0, 5));
    } catch {
      /* ignore */
    }

    let cancelled = false;
    void (async () => {
      try {
        const { current } = await loadOrgs();
        if (current && !cancelled) {
          const boards = await listBoards(current.id);
          if (!cancelled) setCloudBoards(boards.slice(0, 5));
        }
      } catch {
        /* offline or guest */
      }

      if (boardId) {
        try {
          const mList = await listMeetings(boardId);
          if (!cancelled && mList) {
            setMeetings(mList);
          }
        } catch {
          /* ignore */
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [boardId]);

  const formattedDate = useMemo(() => {
    const now = new Date();
    const day = now.toLocaleDateString("en-US", { weekday: "long" });
    const month = now.toLocaleDateString("en-US", { month: "short" });
    const date = now.getDate();
    const time = now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    return `${day} · ${month} ${date} · ${time}`;
  }, []);

  // Live workspace intelligence & canvas stats
  const sections = useMemo(() => intelligenceSections(workspace), [workspace]);
  const inbox = useMemo(() => inboxItems(workspace), [workspace]);

  const decisionsCount =
    (sections.find((s) => s.kind === "decision")?.rows.length ?? 0) +
    (sections.find((s) => s.kind === "proposal")?.rows.length ?? 0);
  const actionsCount = sections.find((s) => s.kind === "action")?.rows.length ?? 0;
  const rollup = useMemo(() => executionRollup(workspace, Date.now()), [workspace]);
  const blockedCount = rollup.blocked;
  const pendingDecisions =
    sections.find((s) => s.kind === "decision")?.rows.filter((r) => r.status === "open").length ?? 0;

  const nodesCount = Object.keys(workspace.nodes).length;
  const edgesCount = Object.keys(workspace.edges).length;
  const totalBoards = projects.length + cloudBoards.length;

  const subtitle = useMemo(() => {
    if (totalBoards === 0 && nodesCount === 0) {
      return "Welcome to your workspace. Start by creating a board or describing a diagram to draft.";
    }
    const parts: string[] = [];
    if (totalBoards > 0) parts.push(`${totalBoards} board${totalBoards === 1 ? "" : "s"}`);
    if (decisionsCount > 0) parts.push(`${decisionsCount} decision${decisionsCount === 1 ? "" : "s"}`);
    if (actionsCount > 0) parts.push(`${actionsCount} open action${actionsCount === 1 ? "" : "s"}`);
    if (inbox.length > 0) parts.push(`${inbox.length} item${inbox.length === 1 ? "" : "s"} awaiting review`);
    return parts.length > 0 ? parts.join(" · ") : `${nodesCount} nodes on active canvas`;
  }, [totalBoards, nodesCount, decisionsCount, actionsCount, inbox.length]);

  const handleSubmit = (e?: React.FormEvent) => {
    e?.preventDefault();
    const q = askPrompt.trim();
    if (!q) return;

    // If it asks a question about existing work, go to intelligence ask
    const isQuestion =
      q.endsWith("?") ||
      /^(who|what|where|why|when|how|is|are|does|can|which)\b/i.test(q);

    if (isQuestion) {
      try {
        localStorage.setItem("lucent.v2.askInitial", q);
      } catch {
        /* ignore */
      }
      setView("intelligence");
    } else {
      // Describe / generate a canvas diagram
      setView("canvas");
      void send(q);
    }
  };

  const allBoards = useMemo<UnifiedBoard[]>(() => {
    const local = projects.map((p) => ({
      id: p.id,
      name: p.name,
      updatedAt: p.updatedAt,
      isLocal: true,
    }));
    const cloud = cloudBoards.map((b) => ({
      id: b.id,
      name: b.name,
      updatedAt: b.updatedAt ?? Date.now(),
      isLocal: false,
      nodes: b.nodes,
    }));
    return [...local, ...cloud];
  }, [projects, cloudBoards]);

  const noticeContent = useMemo(() => {
    const risks = sections.find((s) => s.kind === "risk")?.rows ?? [];
    const questions = sections.find((s) => s.kind === "question")?.rows ?? [];
    if (risks.length > 0) {
      return (
        <>
          <div
            style={{
              fontFamily: "var(--font-serif)",
              fontSize: 15,
              lineHeight: 1.55,
              color: "var(--ink-0)",
              marginBottom: 12,
            }}
          >
            Identified <b>{risks.length} architectural risk{risks.length === 1 ? "" : "s"}</b> on the active board, including &ldquo;{risks[0]?.label}&rdquo;. Consider adding mitigations or linking resolving actions.
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
            <ProvenanceChip icon={<RiskIcon />} label={`Risk: ${risks[0]?.label}`} />
          </div>
          <div style={{ display: "flex", gap: 6, marginTop: 14 }}>
            <button
              type="button"
              className="btn-atelier primary"
              style={{ height: 30, fontSize: 12, padding: "0 14px" }}
              onClick={() => setView("intelligence")}
            >
              Review risks
            </button>
          </div>
        </>
      );
    }
    if (questions.length > 0) {
      return (
        <>
          <div
            style={{
              fontFamily: "var(--font-serif)",
              fontSize: 15,
              lineHeight: 1.55,
              color: "var(--ink-0)",
              marginBottom: 12,
            }}
          >
            There {questions.length === 1 ? "is" : "are"} <b>{questions.length} open question{questions.length === 1 ? "" : "s"}</b> awaiting decision, starting with &ldquo;{questions[0]?.label}&rdquo;.
          </div>
          <div style={{ display: "flex", gap: 6, marginTop: 14 }}>
            <button
              type="button"
              className="btn-atelier primary"
              style={{ height: 30, fontSize: 12, padding: "0 14px" }}
              onClick={() => setView("intelligence")}
            >
              Review questions
            </button>
          </div>
        </>
      );
    }
    if (nodesCount > 1 && edgesCount === 0) {
      return (
        <>
          <div
            style={{
              fontFamily: "var(--font-serif)",
              fontSize: 15,
              lineHeight: 1.55,
              color: "var(--ink-0)",
              marginBottom: 12,
            }}
          >
            Your canvas has <b>{nodesCount} disconnected nodes</b>. Use connectors to specify data flow, dependencies, or parent-child hierarchy.
          </div>
          <div style={{ display: "flex", gap: 6, marginTop: 14 }}>
            <button
              type="button"
              className="btn-atelier primary"
              style={{ height: 30, fontSize: 12, padding: "0 14px" }}
              onClick={() => setView("canvas")}
            >
              Open canvas
            </button>
          </div>
        </>
      );
    }
    return (
      <>
        <div
          style={{
            fontFamily: "var(--font-serif)",
            fontSize: 15,
            lineHeight: 1.55,
            color: "var(--ink-0)",
            marginBottom: 12,
          }}
        >
          Lucent is monitoring your workspace. As you create diagrams and run meetings, architectural contradictions, unmitigated risks, and duplicate topics will appear here in real time.
        </div>
        <div style={{ display: "flex", gap: 6, marginTop: 14 }}>
          <button
            type="button"
            className="btn-atelier ghost"
            style={{ height: 30, fontSize: 12 }}
            onClick={() => setView("canvas")}
          >
            Explore canvas
          </button>
        </div>
      </>
    );
  }, [sections, nodesCount, edgesCount, setView]);

  return (
    <AtelierAppShell
      activeArea="home"
      crumbs={[{ label: "Personal", view: "home" as View }, { label: "Home", current: true }]}
    >
      <div style={{ padding: "36px 40px 60px", maxWidth: 1220, margin: "0 auto" }}>
        {/* Header greeting */}
        <div style={{ marginBottom: 28 }}>
          <div className="mono-caps" style={{ marginBottom: 8, color: "var(--ink-3)" }}>
            {formattedDate}
          </div>
          <h1
            style={{
              fontFamily: "var(--font-serif)",
              fontSize: 42,
              letterSpacing: "-0.025em",
              fontWeight: 400,
              color: "var(--ink-0)",
              lineHeight: 1.1,
              margin: 0,
            }}
          >
            Good morning, {userName}.
          </h1>
          <div
            style={{
              marginTop: 8,
              fontFamily: "var(--font-serif)",
              fontStyle: "italic",
              fontSize: 17,
              color: "var(--ink-2)",
            }}
          >
            {subtitle}
          </div>
        </div>

        {/* Unified Ask & Prompt Bar */}
        <form
          onSubmit={handleSubmit}
          style={{
            padding: "12px 18px",
            background: "var(--paper-0)",
            border: "1px solid oklch(from var(--paper-4) l c h / 0.7)",
            borderRadius: 14,
            display: "flex",
            gap: 12,
            alignItems: "center",
            marginBottom: 32,
            boxShadow: "var(--shadow-1)",
          }}
        >
          <div
            style={{
              width: 32,
              height: 32,
              borderRadius: 8,
              background: "var(--bloom-wash)",
              border: "1px solid var(--bloom-wash-2)",
              display: "grid",
              placeItems: "center",
              color: "var(--bloom-2)",
              flexShrink: 0,
            }}
          >
            <Ico.Sparkle />
          </div>
          <input
            value={askPrompt}
            onChange={(e) => setAskPrompt(e.target.value)}
            placeholder="Ask Lucent anything — or describe a new diagram to draft…"
            style={{
              flex: 1,
              fontSize: 15,
              color: "var(--ink-0)",
              fontFamily: "var(--font-serif)",
              background: "none",
              border: 0,
              outline: "none",
            }}
          />
          <span
            className="mono"
            style={{
              fontSize: 10.5,
              color: "var(--ink-3)",
              padding: "4px 8px",
              background: "var(--paper-2)",
              borderRadius: 6,
            }}
          >
            ↵
          </span>
          <button
            type="submit"
            className="btn-atelier ghost"
            style={{ height: 32 }}
            disabled={!askPrompt.trim()}
          >
            Ask
          </button>
          <button
            type="button"
            className="btn-atelier primary"
            style={{ height: 32 }}
            onClick={() => {
              if (askPrompt.trim()) {
                setView("canvas");
                void send(askPrompt.trim());
              } else {
                newProject();
                setView("canvas");
              }
            }}
          >
            <Ico.Plus /> New Board
          </button>
        </form>

        {/* Clickable Stat Cards */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
            gap: 14,
            marginBottom: 32,
          }}
        >
          <StatCard
            label="Decisions"
            value={decisionsCount.toString()}
            delta={pendingDecisions > 0 ? `+${pendingDecisions}` : undefined}
            sub={
              pendingDecisions > 0
                ? `${pendingDecisions} awaiting review`
                : decisionsCount > 0
                ? "Tracked in workspace"
                : "No active decisions"
            }
            onClick={() => setView("intelligence")}
          />
          <StatCard
            label="Open actions"
            value={actionsCount.toString()}
            color="var(--bloom-2)"
            sub={
              blockedCount > 0
                ? `${blockedCount} blocked`
                : actionsCount > 0
                ? "From board tasks"
                : "No open actions"
            }
            onClick={() => setView("execution")}
          />
          <StatCard
            label="Active Canvas"
            value={nodesCount.toString()}
            color="var(--moss)"
            sub={`${edgesCount} connector${edgesCount === 1 ? "" : "s"}`}
            onClick={() => setView("canvas")}
          />
          <StatCard
            label="Total boards"
            value={totalBoards.toString()}
            sub={`${projects.length} local · ${cloudBoards.length} cloud`}
            onClick={() => setView("dashboard")}
          />
        </div>

        {/* Main Two-Column Layout */}
        <div style={{ display: "grid", gridTemplateColumns: "1.3fr 1fr", gap: 28 }}>
          {/* Left Column: Upcoming Meetings + Needs You (Inbox) */}
          <div>
            <div className="mono-caps" style={{ marginBottom: 10 }}>
              Meetings &amp; Transcripts
            </div>
            <div style={{ display: "grid", gap: 10, marginBottom: 32 }}>
              {meetings.length > 0 ? (
                meetings.slice(0, 3).map((m) => (
                  <div
                    key={m.id}
                    onClick={() => setView("meeting")}
                    style={{
                      padding: "14px 16px",
                      borderRadius: 12,
                      background: "var(--paper-0)",
                      border: "1px solid oklch(from var(--paper-4) l c h / 0.5)",
                      display: "flex",
                      alignItems: "center",
                      gap: 16,
                      cursor: "pointer",
                      transition: "all 0.15s var(--e-out)",
                    }}
                  >
                    <div style={{ width: 56, textAlign: "right", fontFamily: "var(--font-mono)" }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: "var(--ink-0)" }}>
                        {new Date(m.startedAt).toLocaleTimeString("en-US", {
                          hour: "numeric",
                          minute: "2-digit",
                        })}
                      </div>
                      <div style={{ fontSize: 10, color: "var(--ink-3)", marginTop: 2 }}>
                        {m.turns.length} turns
                      </div>
                    </div>
                    <div
                      style={{
                        width: 1,
                        height: 32,
                        background: "oklch(from var(--paper-4) l c h / 0.6)",
                      }}
                    />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        style={{
                          fontSize: 14,
                          fontWeight: 600,
                          color: "var(--ink-0)",
                          marginBottom: 3,
                        }}
                      >
                        {m.mode ? `${m.mode} Meeting` : `Meeting Session · ${new Date(m.startedAt).toLocaleDateString()}`}
                      </div>
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 6,
                          fontSize: 11.5,
                          color: "var(--ink-2)",
                        }}
                      >
                        <Ico.Present style={{ width: 11, height: 11 }} />
                        <span>{new Date(m.startedAt).toLocaleDateString()}</span>
                      </div>
                    </div>
                    <button
                      type="button"
                      className="btn-atelier ghost"
                      style={{ height: 28, fontSize: 11 }}
                    >
                      View
                    </button>
                  </div>
                ))
              ) : (
                <div
                  style={{
                    padding: "20px 22px",
                    borderRadius: 12,
                    background: "var(--paper-0)",
                    border: "1px solid oklch(from var(--paper-4) l c h / 0.5)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 16,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                    <div
                      style={{
                        width: 36,
                        height: 36,
                        borderRadius: 10,
                        background: "var(--bloom-wash)",
                        color: "var(--bloom-2)",
                        display: "grid",
                        placeItems: "center",
                        flexShrink: 0,
                      }}
                    >
                      <Ico.Present />
                    </div>
                    <div>
                      <div
                        style={{
                          fontSize: 14,
                          fontWeight: 500,
                          color: "var(--ink-0)",
                          marginBottom: 2,
                        }}
                      >
                        No meetings recorded yet
                      </div>
                      <div style={{ fontSize: 12, color: "var(--ink-2)" }}>
                        Capture speech in real time, extract architecture decisions, and sync action
                        items to the board.
                      </div>
                    </div>
                  </div>
                  <button
                    type="button"
                    className="btn-atelier primary"
                    style={{ height: 32, flexShrink: 0 }}
                    onClick={() => setView("meeting")}
                  >
                    <Ico.Present /> Start Meeting
                  </button>
                </div>
              )}
            </div>

            {/* Inbox */}
            <div className="mono-caps" style={{ marginBottom: 10 }}>
              Inbox · needs you
            </div>
            <div style={{ display: "grid", gap: 8, marginBottom: 28 }}>
              {inbox.length > 0 ? (
                inbox.slice(0, 4).map((item) => (
                  <div
                    key={item.id}
                    onClick={() => setView("intelligence")}
                    style={{
                      padding: "12px 14px",
                      borderRadius: 10,
                      background: "var(--paper-0)",
                      border: "1px solid oklch(from var(--paper-4) l c h / 0.5)",
                      display: "flex",
                      alignItems: "flex-start",
                      gap: 12,
                      cursor: "pointer",
                    }}
                  >
                    <div
                      style={{
                        width: 26,
                        height: 26,
                        borderRadius: 7,
                        background: "var(--bloom-wash)",
                        color: "var(--bloom-2)",
                        display: "grid",
                        placeItems: "center",
                        flexShrink: 0,
                      }}
                    >
                      <Ico.Sparkle />
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        style={{
                          fontSize: 13.5,
                          fontWeight: 500,
                          color: "var(--ink-0)",
                          marginBottom: 2,
                        }}
                      >
                        Merge &ldquo;{item.dup}&rdquo; into &ldquo;{item.existing}&rdquo;?
                      </div>
                      <div style={{ fontSize: 12, color: "var(--ink-2)" }}>
                        {item.dupStatements + item.existingStatements} statements across topics
                      </div>
                    </div>
                    <span className="mono" style={{ fontSize: 10.5, color: "var(--ink-3)" }}>
                      Review →
                    </span>
                  </div>
                ))
              ) : (
                <div
                  style={{
                    padding: "18px 20px",
                    borderRadius: 10,
                    background: "var(--paper-0)",
                    border: "1px solid oklch(from var(--paper-4) l c h / 0.5)",
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                  }}
                >
                  <div
                    style={{
                      width: 26,
                      height: 26,
                      borderRadius: 7,
                      background: "oklch(from var(--moss) l c h / 0.12)",
                      color: "var(--moss)",
                      display: "grid",
                      placeItems: "center",
                      flexShrink: 0,
                    }}
                  >
                    <Ico.Check />
                  </div>
                  <div>
                    <div style={{ fontSize: 13.5, fontWeight: 500, color: "var(--ink-0)" }}>
                      Inbox zero
                    </div>
                    <div style={{ fontSize: 12, color: "var(--ink-2)" }}>
                      All decisions settled. No open proposals, conflicting statements, or
                      blockers.
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Right Column: Pinned Boards & What Lucent Noticed */}
          <div>
            <div className="mono-caps" style={{ marginBottom: 10 }}>
              Pinned &amp; Recent Boards
            </div>
            <div style={{ display: "grid", gap: 8, marginBottom: 28 }}>
              {allBoards.length > 0 ? (
                allBoards.slice(0, 5).map((b) => (
                  <button
                    key={b.id}
                    type="button"
                    onClick={() => {
                      if (b.isLocal) {
                        openProject(b.id);
                      } else {
                        openBoard(b.id);
                      }
                    }}
                    style={{
                      padding: "12px 14px",
                      borderRadius: 10,
                      background: "var(--paper-0)",
                      border: "1px solid oklch(from var(--paper-4) l c h / 0.5)",
                      borderLeft: "4px solid var(--bloom-2)",
                      display: "flex",
                      alignItems: "center",
                      gap: 12,
                      textAlign: "left",
                      cursor: "pointer",
                      width: "100%",
                      transition: "all 0.15s var(--e-out)",
                    }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        style={{
                          fontSize: 13.5,
                          fontWeight: 500,
                          color: "var(--ink-0)",
                          marginBottom: 2,
                        }}
                      >
                        {b.name}
                      </div>
                      <div className="mono" style={{ fontSize: 10.5, color: "var(--ink-3)" }}>
                        {b.isLocal
                          ? `Local · Updated ${new Date(b.updatedAt).toLocaleDateString()}`
                          : `Cloud · ${b.nodes ?? 0} nodes`}
                      </div>
                    </div>
                    <Ico.Arrow style={{ color: "var(--ink-3)" }} />
                  </button>
                ))
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    newProject();
                    setView("canvas");
                  }}
                  style={{
                    padding: "16px 18px",
                    borderRadius: 10,
                    background: "var(--paper-0)",
                    border: "1px dashed oklch(from var(--bloom-2) l c h / 0.4)",
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    textAlign: "left",
                    cursor: "pointer",
                    width: "100%",
                  }}
                >
                  <div
                    style={{
                      width: 32,
                      height: 32,
                      borderRadius: 8,
                      background: "var(--bloom-wash)",
                      color: "var(--bloom-2)",
                      display: "grid",
                      placeItems: "center",
                      flexShrink: 0,
                    }}
                  >
                    <Ico.Plus />
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 600, color: "var(--ink-0)" }}>
                      Create your first board
                    </div>
                    <div style={{ fontSize: 12, color: "var(--ink-2)" }}>
                      Start with a blank canvas or ask Lucent to generate a diagram.
                    </div>
                  </div>
                </button>
              )}
            </div>

            {/* What Lucent Noticed */}
            <div className="mono-caps" style={{ marginBottom: 10, color: "var(--bloom-2)" }}>
              <Ico.Sparkle style={{ display: "inline", verticalAlign: -2, marginRight: 4 }} />
              What Lucent noticed
            </div>
            <div
              style={{
                padding: 18,
                borderRadius: 14,
                background: "oklch(from var(--bloom-1) l c h / 0.05)",
                border: "1px solid var(--bloom-wash-2)",
              }}
            >
              {noticeContent}
            </div>
          </div>
        </div>
      </div>
    </AtelierAppShell>
  );
}
