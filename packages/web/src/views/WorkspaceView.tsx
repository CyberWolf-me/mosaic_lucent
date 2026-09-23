import { useState, useEffect, useMemo } from "react";
import { useWorkspace, type View } from "../workspace.js";
import { listProjects, type ProjectMeta } from "../persistence.js";
import { listBoards, type BoardSummary } from "../boards.js";
import { loadOrgs, fetchOrg, type OrgSummary, type OrgMember } from "../orgs.js";
import { getSessionUser } from "../session.js";
import { listMeetings, type MeetingTranscript } from "../meetings.js";
import { Ico } from "../ui/icons.js";
import {
  AtelierAppShell,
  SectionHeader,
} from "../ui/atelierAtoms.js";

type BoardFilter = "all" | "local" | "cloud" | "flowchart" | "architecture" | "mindmap" | "wireframe";

export function WorkspaceView({ onOpenSettings }: { onOpenSettings: (section?: string) => void }) {
  const { setView, openProject, openBoard, newProject, boardId } = useWorkspace();
  const [selectedFilter, setSelectedFilter] = useState<BoardFilter>("all");
  const [activeTab, setActiveTab] = useState<"boards" | "meetings" | "people">("boards");
  const [localProjects, setLocalProjects] = useState<ProjectMeta[]>([]);
  const [cloudBoards, setCloudBoards] = useState<BoardSummary[]>([]);
  const [currentOrg, setCurrentOrg] = useState<OrgSummary | null>(null);
  const [members, setMembers] = useState<OrgMember[]>([]);
  const [meetings, setMeetings] = useState<MeetingTranscript[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const user = getSessionUser();

  useEffect(() => {
    try {
      setLocalProjects(listProjects());
    } catch {
      /* ignore */
    }

    let cancelled = false;
    void (async () => {
      try {
        const { current } = await loadOrgs();
        if (cancelled) return;
        setCurrentOrg(current);
        if (current) {
          const [boards, detail] = await Promise.all([
            listBoards(current.id),
            fetchOrg(current.id),
          ]);
          if (!cancelled) {
            setCloudBoards(boards);
            if (detail?.members) {
              setMembers(detail.members);
            }
          }
        }
      } catch {
        /* ignore */
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

  // Combined boards list with filtering
  const allBoards = useMemo(() => {
    const localItems = localProjects.map((p) => ({
      id: p.id,
      name: p.name,
      isLocal: true,
      updatedAt: p.updatedAt,
      kind: "Interactive canvas",
    }));
    const cloudItems = cloudBoards.map((b) => ({
      id: b.id,
      name: b.name,
      isLocal: false,
      updatedAt: b.updatedAt ?? Date.now(),
      kind: `${b.nodes ?? 0} nodes`,
    }));
    return [...localItems, ...cloudItems];
  }, [localProjects, cloudBoards]);

  const filteredBoards = useMemo(() => {
    let list = allBoards;
    if (selectedFilter === "local") list = list.filter((b) => b.isLocal);
    else if (selectedFilter === "cloud") list = list.filter((b) => !b.isLocal);

    const q = searchQuery.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (b) => b.name.toLowerCase().includes(q) || b.kind.toLowerCase().includes(q)
      );
    }
    return list;
  }, [allBoards, selectedFilter, searchQuery]);

  // Display people: real org members or fallback to current user
  const displayMembers = useMemo(() => {
    if (members.length > 0) return members;
    if (user) {
      return [
        {
          userId: user.id,
          name: user.name || "Alex Kim",
          email: user.email,
          role: "owner" as const,
        },
      ];
    }
    return [
      {
        userId: "local-user",
        name: "Current User",
        email: "local@lucent.workspace",
        role: "owner" as const,
      },
    ];
  }, [members, user]);

  const filteredMeetings = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return meetings;
    return meetings.filter(
      (m) =>
        (m.mode && m.mode.toLowerCase().includes(q)) ||
        m.turns.some((t) => t.text.toLowerCase().includes(q) || t.speaker.toLowerCase().includes(q))
    );
  }, [meetings, searchQuery]);

  const filteredMembers = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return displayMembers;
    return displayMembers.filter(
      (m) =>
        m.name.toLowerCase().includes(q) ||
        m.email.toLowerCase().includes(q) ||
        m.role.toLowerCase().includes(q)
    );
  }, [displayMembers, searchQuery]);

  const orgName = currentOrg?.name || "Workspace";

  return (
    <AtelierAppShell
      activeArea="workspace"
      crumbs={[
        { label: orgName, view: "workspace" as View },
        { label: "Workspace Browser", current: true },
      ]}
      actions={
        <>
          <button
            type="button"
            className="btn-atelier ghost"
            style={{ height: 32 }}
            onClick={() => onOpenSettings("workspace")}
          >
            <Ico.Settings /> Settings
          </button>
          <button
            type="button"
            className="btn-atelier primary"
            style={{ height: 32 }}
            onClick={() => {
              newProject();
              setView("canvas");
            }}
          >
            <Ico.Plus /> New Board
          </button>
        </>
      }
    >
      <div style={{ display: "flex", height: "100%" }}>
        {/* Workspace Organization & Filter Tree */}
        <aside
          style={{
            width: 250,
            flexShrink: 0,
            borderRight: "1px solid oklch(from var(--paper-4) l c h / 0.5)",
            padding: "24px 12px",
            overflowY: "auto",
            background: "oklch(from var(--paper-0) l c h / 0.5)",
          }}
        >
          <div className="mono-caps" style={{ padding: "0 10px", marginBottom: 8 }}>
            Organization
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "8px 10px",
              borderRadius: 8,
              fontWeight: 600,
              fontSize: 13,
              color: "var(--ink-0)",
              background: "var(--paper-1)",
              marginBottom: 16,
            }}
          >
            <Ico.Folder style={{ width: 14, height: 14, color: "var(--bloom-2)" }} />
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {orgName}
            </span>
          </div>

          <div className="mono-caps" style={{ padding: "8px 10px 6px" }}>
            Board Views
          </div>
          {[
            { id: "all", label: "All Boards", count: allBoards.length },
            { id: "local", label: "Local Boards", count: localProjects.length },
            { id: "cloud", label: "Cloud Boards", count: cloudBoards.length },
          ].map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => {
                setSelectedFilter(item.id as BoardFilter);
                setActiveTab("boards");
              }}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                width: "100%",
                padding: "7px 10px",
                borderRadius: 8,
                fontSize: 13,
                color:
                  activeTab === "boards" && selectedFilter === item.id
                    ? "var(--paper-0)"
                    : "var(--ink-1)",
                background:
                  activeTab === "boards" && selectedFilter === item.id
                    ? "var(--ink-0)"
                    : "transparent",
                fontWeight: activeTab === "boards" && selectedFilter === item.id ? 500 : 400,
                textAlign: "left",
                cursor: "pointer",
                border: 0,
                transition: "all 0.1s var(--e-out)",
                marginBottom: 2,
              }}
            >
              <Ico.Layers style={{ width: 12, height: 12 }} />
              <span
                style={{
                  flex: 1,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {item.label}
              </span>
              <span
                className="mono"
                style={{
                  fontSize: 10,
                  opacity: 0.7,
                }}
              >
                {item.count}
              </span>
            </button>
          ))}

          <div className="mono-caps" style={{ padding: "16px 10px 6px" }}>
            Workspace Areas
          </div>
          {[
            { id: "meetings", label: "Meeting Docs", count: meetings.length, icon: <Ico.Present style={{ width: 12, height: 12 }} /> },
            { id: "people", label: "Team Members", count: displayMembers.length, icon: <Ico.User style={{ width: 12, height: 12 }} /> },
          ].map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setActiveTab(item.id as "meetings" | "people")}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                width: "100%",
                padding: "7px 10px",
                borderRadius: 8,
                fontSize: 13,
                color: activeTab === item.id ? "var(--paper-0)" : "var(--ink-1)",
                background: activeTab === item.id ? "var(--ink-0)" : "transparent",
                fontWeight: activeTab === item.id ? 500 : 400,
                textAlign: "left",
                cursor: "pointer",
                border: 0,
                marginBottom: 2,
              }}
            >
              {item.icon}
              <span style={{ flex: 1 }}>{item.label}</span>
              <span className="mono" style={{ fontSize: 10, opacity: 0.7 }}>
                {item.count}
              </span>
            </button>
          ))}
        </aside>

        {/* Main Workspace Explorer Area */}
        <div style={{ flex: 1, overflowY: "auto", padding: "32px 40px 60px" }}>
          <SectionHeader
            eyebrow={`${orgName} / Workspace`}
            title={
              activeTab === "boards"
                ? `${selectedFilter === "all" ? "All" : selectedFilter === "local" ? "Local" : "Cloud"} Boards`
                : activeTab === "meetings"
                ? "Meeting Transcripts & Docs"
                : "Team Members"
            }
            meta={
              activeTab === "boards"
                ? `${filteredBoards.length} of ${allBoards.length} board${allBoards.length === 1 ? "" : "s"} available`
                : activeTab === "meetings"
                ? `${filteredMeetings.length} of ${meetings.length} recorded session${meetings.length === 1 ? "" : "s"}`
                : `${filteredMembers.length} of ${displayMembers.length} active member${displayMembers.length === 1 ? "" : "s"}`
            }
          />

          {/* Sub-Tabs */}
          <div
            style={{
              display: "flex",
              gap: 20,
              borderBottom: "1px solid oklch(from var(--paper-4) l c h / 0.5)",
              marginBottom: 18,
            }}
          >
            {[
              { id: "boards", label: "Boards", count: allBoards.length },
              { id: "meetings", label: "Meetings", count: meetings.length },
              { id: "people", label: "People", count: displayMembers.length },
            ].map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id as "boards" | "meetings" | "people")}
                style={{
                  padding: "8px 0 12px",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  fontSize: 13.5,
                  fontWeight: 500,
                  color: activeTab === tab.id ? "var(--ink-0)" : "var(--ink-2)",
                  borderBottom: `2px solid ${
                    activeTab === tab.id ? "var(--ink-0)" : "transparent"
                  }`,
                  marginBottom: -1,
                  cursor: "pointer",
                  borderTop: 0,
                  borderLeft: 0,
                  borderRight: 0,
                  background: "none",
                }}
              >
                {tab.label}
                <span
                  className="mono"
                  style={{
                    fontSize: 10.5,
                    padding: "1px 6px",
                    borderRadius: 4,
                    background: "oklch(from var(--paper-3) l c h / 0.9)",
                    color: "var(--ink-2)",
                  }}
                >
                  {tab.count}
                </span>
              </button>
            ))}
          </div>

          {/* Real-time Search & Filter Bar */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              marginBottom: 20,
              background: "var(--paper-0)",
              border: "1px solid oklch(from var(--paper-4) l c h / 0.6)",
              borderRadius: 12,
              padding: "6px 14px",
              boxShadow: "var(--shadow-1)",
            }}
          >
            <Ico.Search style={{ width: 15, height: 15, color: "var(--ink-3)", flexShrink: 0 }} />
            <input
              type="text"
              placeholder={
                activeTab === "boards"
                  ? "Search boards by title or kind…"
                  : activeTab === "meetings"
                  ? "Search transcripts…"
                  : "Search teammates…"
              }
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              aria-label="Filter workspace items"
              style={{
                flex: 1,
                border: 0,
                background: "none",
                fontSize: 13,
                color: "var(--ink-0)",
                outline: "none",
                fontFamily: "inherit",
              }}
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery("")}
                aria-label="Clear search"
                style={{
                  border: 0,
                  background: "none",
                  cursor: "pointer",
                  color: "var(--ink-3)",
                  padding: 2,
                  display: "grid",
                  placeItems: "center",
                }}
              >
                <Ico.X style={{ width: 14, height: 14 }} />
              </button>
            )}
            <span
              className="mono"
              style={{
                fontSize: 11,
                color: "var(--ink-3)",
                background: "var(--paper-1)",
                padding: "2px 8px",
                borderRadius: 6,
                flexShrink: 0,
              }}
            >
              {activeTab === "boards"
                ? `${filteredBoards.length} shown`
                : activeTab === "meetings"
                ? `${filteredMeetings.length} shown`
                : `${filteredMembers.length} shown`}
            </span>
          </div>

          {/* Tab Content: Boards */}
          {activeTab === "boards" && (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
                gap: 16,
              }}
            >
              {filteredBoards.length > 0 ? (
                filteredBoards.map((b) => (
                  <div
                    key={b.id}
                    onClick={() => {
                      if (b.isLocal) {
                        openProject(b.id);
                      } else {
                        openBoard(b.id);
                      }
                    }}
                    style={{
                      borderRadius: 14,
                      background: "var(--paper-0)",
                      border: "1px solid oklch(from var(--paper-4) l c h / 0.6)",
                      borderLeft: `4px solid ${b.isLocal ? "var(--bloom-2)" : "var(--moss)"}`,
                      padding: 16,
                      boxShadow: "var(--shadow-1)",
                      cursor: "pointer",
                      transition: "all 0.15s var(--e-out)",
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.transform = "translateY(-2px)";
                      e.currentTarget.style.boxShadow = "var(--shadow-2)";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.transform = "translateY(0)";
                      e.currentTarget.style.boxShadow = "var(--shadow-1)";
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        marginBottom: 8,
                      }}
                    >
                      <span
                        className="mono-caps"
                        style={{ color: b.isLocal ? "var(--bloom-2)" : "var(--moss)" }}
                      >
                        {b.isLocal ? "LOCAL" : "CLOUD"}
                      </span>
                      <div style={{ flex: 1 }} />
                      <span className="mono" style={{ fontSize: 10, color: "var(--ink-3)" }}>
                        {new Date(b.updatedAt).toLocaleDateString()}
                      </span>
                    </div>
                    <div
                      style={{
                        fontSize: 15,
                        fontWeight: 600,
                        color: "var(--ink-0)",
                        marginBottom: 8,
                        letterSpacing: "-0.01em",
                      }}
                    >
                      {b.name}
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
                      <Ico.Layers style={{ width: 12, height: 12 }} />
                      <span>{b.kind}</span>
                    </div>
                  </div>
                ))
              ) : (
                <div
                  style={{
                    gridColumn: "1 / -1",
                    padding: "48px 32px",
                    textAlign: "center",
                    borderRadius: 14,
                    background: "var(--paper-0)",
                    border: "1px dashed oklch(from var(--paper-4) l c h / 0.8)",
                  }}
                >
                  <div
                    style={{
                      width: 44,
                      height: 44,
                      borderRadius: 12,
                      background: "var(--bloom-wash)",
                      color: "var(--bloom-2)",
                      display: "grid",
                      placeItems: "center",
                      margin: "0 auto 16px",
                    }}
                  >
                    <Ico.Layers style={{ width: 20, height: 20 }} />
                  </div>
                  <h3
                    style={{
                      fontSize: 16,
                      fontWeight: 600,
                      color: "var(--ink-0)",
                      marginBottom: 6,
                    }}
                  >
                    {searchQuery ? `No boards matching "${searchQuery}"` : "No boards found"}
                  </h3>
                  <p
                    style={{
                      fontSize: 13,
                      color: "var(--ink-2)",
                      maxWidth: 400,
                      margin: "0 auto 20px",
                    }}
                  >
                    {searchQuery
                      ? "Try searching for a different keyword or clear the search filter."
                      : selectedFilter === "all"
                      ? "Create your first board to start drawing diagrams, mapping architecture, and brainstorming."
                      : `No ${selectedFilter} boards found in this workspace.`}
                  </p>
                  {searchQuery ? (
                    <button
                      type="button"
                      className="btn-atelier ghost"
                      onClick={() => setSearchQuery("")}
                    >
                      Clear Search
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn-atelier primary"
                      onClick={() => {
                        newProject();
                        setView("canvas");
                      }}
                    >
                      <Ico.Plus /> Create Board
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Tab Content: Meetings */}
          {activeTab === "meetings" && (
            <div style={{ display: "grid", gap: 12 }}>
              {filteredMeetings.length > 0 ? (
                filteredMeetings.map((m) => (
                  <div
                    key={m.id}
                    onClick={() => setView("meeting")}
                    style={{
                      padding: "16px 20px",
                      borderRadius: 12,
                      background: "var(--paper-0)",
                      border: "1px solid oklch(from var(--paper-4) l c h / 0.6)",
                      display: "flex",
                      alignItems: "center",
                      gap: 16,
                      cursor: "pointer",
                      boxShadow: "var(--shadow-1)",
                    }}
                  >
                    <div
                      style={{
                        width: 40,
                        height: 40,
                        borderRadius: 10,
                        background: "var(--bloom-wash)",
                        color: "var(--bloom-2)",
                        display: "grid",
                        placeItems: "center",
                      }}
                    >
                      <Ico.Present />
                    </div>
                    <div style={{ flex: 1 }}>
                      <div
                        style={{
                          fontSize: 15,
                          fontWeight: 600,
                          color: "var(--ink-0)",
                          marginBottom: 4,
                        }}
                      >
                        {m.mode ? `${m.mode} Meeting` : `Meeting Session · ${new Date(m.startedAt).toLocaleDateString()}`}
                      </div>
                      <div className="mono" style={{ fontSize: 11, color: "var(--ink-2)" }}>
                        {new Date(m.startedAt).toLocaleString()} · {m.turns.length} utterances
                      </div>
                    </div>
                    <button
                      type="button"
                      className="btn-atelier ghost"
                      style={{ height: 30, fontSize: 12 }}
                    >
                      Open Document
                    </button>
                  </div>
                ))
              ) : (
                <div
                  style={{
                    padding: "48px 32px",
                    textAlign: "center",
                    borderRadius: 14,
                    background: "var(--paper-0)",
                    border: "1px dashed oklch(from var(--paper-4) l c h / 0.8)",
                  }}
                >
                  <div
                    style={{
                      width: 44,
                      height: 44,
                      borderRadius: 12,
                      background: "var(--bloom-wash)",
                      color: "var(--bloom-2)",
                      display: "grid",
                      placeItems: "center",
                      margin: "0 auto 16px",
                    }}
                  >
                    <Ico.Present style={{ width: 20, height: 20 }} />
                  </div>
                  <h3
                    style={{
                      fontSize: 16,
                      fontWeight: 600,
                      color: "var(--ink-0)",
                      marginBottom: 6,
                    }}
                  >
                    No meeting documents yet
                  </h3>
                  <p
                    style={{
                      fontSize: 13,
                      color: "var(--ink-2)",
                      maxWidth: 420,
                      margin: "0 auto 20px",
                    }}
                  >
                    Launch a meeting on any canvas to transcribe live speech, extract decisions, and
                    turn discussions into structured diagrams.
                  </p>
                  <button
                    type="button"
                    className="btn-atelier primary"
                    onClick={() => setView("meeting")}
                  >
                    <Ico.Present /> Start Meeting
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Tab Content: People */}
          {activeTab === "people" && (
            <div style={{ display: "grid", gap: 10 }}>
              {filteredMembers.length > 0 ? (
                filteredMembers.map((person) => {
                  const initials = (person.name || person.email || "U")
                    .split(" ")
                    .map((s) => s[0])
                    .join("")
                    .slice(0, 2)
                    .toUpperCase();
                  return (
                    <div
                      key={person.userId || person.email}
                      style={{
                        padding: "14px 18px",
                        borderRadius: 12,
                        background: "var(--paper-0)",
                        border: "1px solid oklch(from var(--paper-4) l c h / 0.5)",
                        display: "flex",
                        alignItems: "center",
                        gap: 14,
                      }}
                    >
                      <div
                        style={{
                          width: 36,
                          height: 36,
                          borderRadius: 999,
                          background: "var(--bloom-2)",
                          color: "white",
                          display: "grid",
                          placeItems: "center",
                          fontFamily: "var(--font-mono)",
                          fontSize: 12,
                          fontWeight: 700,
                        }}
                      >
                        {initials}
                      </div>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 14, fontWeight: 600, color: "var(--ink-0)" }}>
                          {person.name || person.email}
                        </div>
                        <div className="mono" style={{ fontSize: 11, color: "var(--ink-3)" }}>
                          {person.email}
                        </div>
                      </div>
                      <span
                        className="mono-caps"
                        style={{
                          padding: "3px 8px",
                          borderRadius: 6,
                          background: "var(--paper-2)",
                          color: "var(--ink-1)",
                          fontSize: 10,
                        }}
                      >
                        {person.role}
                      </span>
                    </div>
                  );
                })
              ) : (
                <div
                  style={{
                    padding: "48px 24px",
                    textAlign: "center",
                    background: "var(--paper-0)",
                    border: "1px dashed oklch(from var(--paper-4) l c h / 0.8)",
                    borderRadius: 14,
                  }}
                >
                  <Ico.Search style={{ width: 28, height: 28, color: "var(--ink-3)", opacity: 0.5, marginBottom: 8 }} />
                  <div style={{ fontSize: 14, fontWeight: 500, color: "var(--ink-1)", marginBottom: 4 }}>
                    No teammates matching &ldquo;{searchQuery}&rdquo;
                  </div>
                  <button
                    type="button"
                    className="btn-atelier ghost"
                    style={{ height: 28, fontSize: 11, marginTop: 8 }}
                    onClick={() => setSearchQuery("")}
                  >
                    Clear Search
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </AtelierAppShell>
  );
}
