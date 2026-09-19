import { useEffect, useMemo, useRef, useState } from "react";
import { Ico } from "../ui/icons.js";
import { ProfileMenu } from "../ui/ProfileMenu.js";
import { NotificationTray } from "../ui/NotificationTray.js";
import { useWorkspace } from "../workspace.js";
import { listProjects, loadProject, type ProjectMeta } from "../persistence.js";
import { MiniPreview, type MiniKind } from "./MiniPreview.js";
import { createWorkspace, applyOperations, type DiagramKind } from "@lucent/core";
import { csvToStickyOps } from "../board/serialize.js";
import {
  classifyImport,
  documentToOps,
  pdfIsCompressed,
  pdfToOps,
  svgToOps,
} from "../board/importers.js";
import { useToast } from "../ui/Toast.js";
import { getSessionUser, hasSession } from "../session.js";
import { loadOrgs, type OrgSummary } from "../orgs.js";
import { listBoards, type BoardSummary } from "../boards.js";
import { TEMPLATES } from "../templates.js";

/** Project dashboard, ported from reference/screen_dashboard.jsx and wired to
 * real localStorage projects plus cloud boards and sample templates. */

interface DisplayProject extends ProjectMeta {
  kind: string;
  mini: MiniKind;
  nodes: number;
  accent?: boolean;
  isCloud?: boolean;
  isShared?: boolean;
  isTemplate?: boolean;
  templateId?: string;
}

const DIAGRAM_TO_KIND: Record<DiagramKind, { kind: string; mini: MiniKind }> = {
  flowchart: { kind: "Flows", mini: "flow" },
  architecture: { kind: "Architecture", mini: "arch" },
  mindmap: { kind: "Mind maps", mini: "mind" },
  journey: { kind: "User journeys", mini: "journey" },
  decisiontree: { kind: "Decision trees", mini: "flow" },
  process: { kind: "Process maps", mini: "flow" },
  orgchart: { kind: "Org charts", mini: "mind" },
  bpmn: { kind: "BPMN processes", mini: "flow" },
};

export function DashboardView({ onOpenSettings }: { onOpenSettings: (section?: string) => void }) {
  const { newProject, openProject, openBoard, importWorkspace, setView } = useWorkspace();
  const { notify } = useToast();
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const [currentOrg, setCurrentOrg] = useState<OrgSummary | null>(null);
  const [cloudBoards, setCloudBoards] = useState<BoardSummary[]>([]);
  const [sharedBoards, setSharedBoards] = useState<BoardSummary[]>([]);

  useEffect(() => {
    let cancelled = false;
    if (!hasSession()) return;
    void (async () => {
      try {
        const { current } = await loadOrgs();
        if (cancelled) return;
        setCurrentOrg(current);
        if (current) {
          const [orgBoards, shared] = await Promise.all([
            listBoards(current.id),
            listBoards(current.id, "shared"),
          ]);
          if (!cancelled) {
            setCloudBoards(orgBoards);
            const orgBoardIds = new Set(orgBoards.map((b) => b.id));
            setSharedBoards(shared.filter((b) => !orgBoardIds.has(b.id)));
          }
        }
      } catch {
        /* offline or backend unavailable: local projects remain accessible */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const onImportFile = (file: File) => {
    const reader = new FileReader();
    const name = file.name.replace(/\.[^.]+$/, "") || "Imported board";
    const kind = classifyImport(file.name, file.type);

    reader.onload = () => {
      const content = String(reader.result);

      if (kind === "json") {
        try {
          const data = JSON.parse(content);
          // Accept either a raw workspace or a saved project { workspace }.
          const ws = data.workspace ?? data;
          if (ws && typeof ws === "object" && ws.nodes) {
            importWorkspace(ws, name);
            return;
          }
          notify("That JSON doesn't look like a Lucent board.");
        } catch {
          notify("Couldn't read that JSON file.");
        }
        return;
      }

      // Everything else becomes board objects in a fresh workspace.
      const ops =
        kind === "csv"
          ? csvToStickyOps(content)
          : kind === "svg"
            ? svgToOps(content)
            : kind === "pdf"
              ? pdfToOps(content)
              : kind === "document"
                ? documentToOps(content)
                : [];

      if (ops.length === 0) {
        // Say which case failed rather than importing an empty board silently.
        if (kind === "pdf") {
          notify(
            pdfIsCompressed(content)
              ? "That PDF's text is compressed, so it can't be read. Try exporting it as text."
              : "No readable text found in that PDF — it may be a scan.",
          );
        } else if (kind === "image") {
          notify("Drop an image straight onto the canvas to place it.");
        } else if (kind === "unknown") {
          notify("Unsupported file type. Try JSON, CSV, SVG, PDF, Markdown, or text.");
        } else {
          notify("Nothing importable found in that file.");
        }
        return;
      }

      importWorkspace(applyOperations(createWorkspace({ name }), ops), name);
      notify(`Imported ${ops.length} object${ops.length > 1 ? "s" : ""} from ${file.name}.`);
    };

    reader.onerror = () => notify("Couldn't read that file.");
    // PDFs are parsed as text: the content streams we read are ASCII.
    reader.readAsText(file);
  };

  const localSaved: DisplayProject[] = useMemo(() => {
    return listProjects().map((p) => {
      const data = loadProject(p.id);
      const ws = data?.workspace;
      const mapped = ws
        ? DIAGRAM_TO_KIND[ws.diagramKind]
        : { kind: "Workspace", mini: "arch" as MiniKind };
      return {
        ...p,
        kind: mapped.kind,
        mini: mapped.mini,
        nodes: ws ? Object.keys(ws.nodes).length : 0,
        isCloud: false,
      };
    });
  }, []);

  const allCloudProjects: DisplayProject[] = useMemo(() => {
    const combined: BoardSummary[] = [...cloudBoards, ...sharedBoards];
    const seen = new Set<string>();
    const list: DisplayProject[] = [];
    for (const b of combined) {
      if (seen.has(b.id)) continue;
      seen.add(b.id);
      const isShared = sharedBoards.some((sb) => sb.id === b.id);
      list.push({
        id: b.id,
        name: b.name,
        updatedAt: b.updatedAt,
        kind: "Workspace",
        mini: "arch",
        nodes: b.nodes ?? 0,
        isCloud: true,
        isShared,
      });
    }
    return list;
  }, [cloudBoards, sharedBoards]);

  const projects: DisplayProject[] = useMemo(() => {
    const cloudIds = new Set(allCloudProjects.map((p) => p.id));
    const localOnly = localSaved.filter((p) => !cloudIds.has(p.id));
    return [...allCloudProjects, ...localOnly].sort((a, b) => b.updatedAt - a.updatedAt);
  }, [allCloudProjects, localSaved]);

  const templateProjects: DisplayProject[] = useMemo(() => {
    return TEMPLATES.map((t) => ({
      id: `tpl_${t.id}`,
      name: t.name,
      updatedAt: Date.now(),
      kind: t.kind,
      mini: (t.id === "mindmap-seed" ? "mind" : t.id === "swot" ? "arch" : "flow") as MiniKind,
      nodes: 0,
      accent: true,
      isTemplate: true,
      templateId: t.id,
    }));
  }, []);

  const filtered = useMemo(() => {
    let list = projects;
    if (filter === "recents") list = list.slice(0, 6);
    else if (filter === "shared") list = projects.filter((p) => p.isShared);
    else if (filter === "templates") list = templateProjects;
    else if (!["all", "recents", "shared", "templates"].includes(filter)) {
      list = projects.filter((p) => p.kind === filter);
    }
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(
        (p) => p.name.toLowerCase().includes(q) || p.kind.toLowerCase().includes(q),
      );
    }
    return list;
  }, [filter, search, projects, templateProjects]);

  const sidebarTop = [
    { id: "all", label: "All projects", count: projects.length, icon: <Ico.Grid /> },
    { id: "recents", label: "Recents", count: Math.min(projects.length, 6), icon: <Ico.History /> },
    { id: "shared", label: "Shared", count: sharedBoards.length, icon: <Ico.Share /> },
    { id: "templates", label: "Templates", count: TEMPLATES.length, icon: <Ico.Book /> },
  ];
  const byArtifact = [
    { id: "Architecture", label: "Architecture", icon: <Ico.Layers /> },
    { id: "User journeys", label: "User journeys", icon: <Ico.Journey /> },
    { id: "Flows", label: "Flows", icon: <Ico.Flow /> },
    { id: "Wireframes", label: "Wireframes", icon: <Ico.Grid /> },
    { id: "Mind maps", label: "Mind maps", icon: <Ico.Mind /> },
    { id: "Sequence", label: "Sequence", icon: <Ico.Flow /> },
  ];

  const open = async (p: DisplayProject) => {
    if (p.isTemplate && p.templateId) {
      const template = TEMPLATES.find((t) => t.id === p.templateId);
      if (template) {
        const ops = template.build();
        const ws = applyOperations(createWorkspace({ name: template.name }), ops);
        importWorkspace(ws, template.name);
      }
      return;
    }
    if (p.isCloud) {
      const ok = await openBoard(p.id);
      if (!ok) {
        openProject(p.id);
      }
    } else {
      openProject(p.id);
    }
  };

  const user = getSessionUser();
  const firstName = user?.name ? user.name.trim().split(/\s+/)[0] : "there";
  const hour = new Date().getHours();
  const timeGreeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "var(--canvas-1)",
        color: "var(--ink-0)",
        overflow: "hidden",
      }}
    >
      <div
        className="top-bar"
        style={{ borderBottom: "1px solid var(--stroke-1)", background: "var(--canvas-1)" }}
      >
        <button
          className="brand"
          onClick={() => setView("dashboard")}
          title="Home"
          aria-label="Lucent home"
          style={{ background: "none", border: 0, padding: 0, cursor: "pointer" }}
        >
          <div className="logo" />
          <span>Lucent</span>
        </button>
        <span className="crumb-sep">/</span>
        <span className="crumb current">{currentOrg?.name ?? "Personal"}</span>
        <div className="spacer" />
        <div className="actions">
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "5px 12px 5px 10px",
              background: "var(--canvas-2)",
              border: "1px solid var(--stroke-1)",
              borderRadius: 999,
              width: 240,
            }}
          >
            <Ico.Search style={{ color: "var(--ink-3)" }} />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search projects…"
              style={{ flex: 1, fontSize: 12, color: "var(--ink-0)" }}
            />
          </div>
          <input
            ref={fileRef}
            type="file"
            accept=".json,.csv,.tsv,.svg,.pdf,.md,.markdown,.txt,application/json,text/csv,image/svg+xml,application/pdf,text/plain,text/markdown"
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onImportFile(f);
              e.currentTarget.value = "";
            }}
          />
          <button className="icon-btn" onClick={() => fileRef.current?.click()}>
            <Ico.Attach /> Import
          </button>
          <button className="icon-btn primary" onClick={newProject}>
            <Ico.Plus /> New workspace
          </button>
          {/* This view draws its own header instead of going through Chrome, so
              the tray Chrome mounts for every other surface has to be mounted
              again here -- otherwise notifications vanish on the one screen a
              user lands on after following a link from an email. */}
          <NotificationTray />
          <ProfileMenu onOpenSettings={onOpenSettings} />
        </div>
      </div>

      <div
        style={{
          position: "absolute",
          top: 52,
          left: 0,
          right: 0,
          bottom: 0,
          display: "grid",
          gridTemplateColumns: "240px 1fr",
          overflow: "hidden",
        }}
      >
        <aside
          style={{
            borderRight: "1px solid var(--stroke-1)",
            padding: "18px 12px",
            background: "var(--canvas-0)",
            overflowY: "auto",
          }}
        >
          {sidebarTop.map((it) => (
            <SidebarItem
              key={it.id}
              icon={it.icon}
              label={it.label}
              count={it.count}
              active={filter === it.id}
              onClick={() => setFilter(it.id)}
            />
          ))}
          <div style={{ height: 20 }} />
          <div
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 10,
              letterSpacing: "0.1em",
              textTransform: "uppercase",
              color: "var(--ink-3)",
              padding: "6px 10px",
            }}
          >
            By artifact
          </div>
          {byArtifact.map((it) => (
            <SidebarItem
              key={it.id}
              icon={it.icon}
              label={it.label}
              active={filter === it.id}
              onClick={() => setFilter(it.id)}
              small
            />
          ))}
        </aside>

        <main
          style={{ overflowY: "auto", padding: "32px 40px 60px", background: "var(--canvas-1)" }}
        >
          <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 6 }}>
            <h1
              style={{
                fontSize: 30,
                fontVariationSettings: "'wght' 450",
                letterSpacing: "-0.025em",
                color: "var(--ink-0)",
              }}
            >
              {timeGreeting}, {firstName}
            </h1>
            <span className="mono" style={{ fontSize: 11, color: "var(--ink-3)" }}>
              {projects.length} workspaces
            </span>
          </div>
          <p style={{ fontSize: 14, color: "var(--ink-2)", maxWidth: 520 }}>
            Pick up where you left off, or describe something new and let Lucent build it with you.
          </p>

          <div
            style={{
              marginTop: 22,
              padding: 18,
              border: "1px solid var(--stroke-1)",
              borderRadius: "var(--r-lg)",
              background: "linear-gradient(180deg, var(--canvas-2), var(--canvas-1))",
              display: "flex",
              alignItems: "center",
              gap: 16,
            }}
          >
            <div
              style={{
                width: 40,
                height: 40,
                borderRadius: "var(--r-md)",
                background: "linear-gradient(135deg, var(--amber-2), var(--amber-3))",
                color: "var(--canvas-0)",
                display: "grid",
                placeItems: "center",
                boxShadow: "0 0 24px -6px var(--amber-glow)",
              }}
            >
              <Ico.Sparkle />
            </div>
            <div style={{ flex: 1 }}>
              <div
                style={{ fontSize: 14, fontVariationSettings: "'wght' 520", color: "var(--ink-0)" }}
              >
                Start a workspace by describing your idea
              </div>
              <div style={{ fontSize: 12.5, color: "var(--ink-2)", marginTop: 2 }}>
                Type or speak — architecture, flow, wireframe, journey, or something new.
              </div>
            </div>
            <button
              onClick={newProject}
              className="icon-btn primary"
              style={{ padding: "9px 16px", gap: 6 }}
            >
              New workspace <Ico.Arrow />
            </button>
          </div>

          <div
            style={{
              marginTop: 32,
              marginBottom: 12,
              display: "flex",
              alignItems: "baseline",
              gap: 12,
            }}
          >
            <h2
              style={{ fontSize: 15, fontVariationSettings: "'wght' 520", color: "var(--ink-0)" }}
            >
              Recent workspaces
            </h2>
            <span
              className="mono"
              style={{
                fontSize: 10.5,
                color: "var(--ink-3)",
                letterSpacing: "0.05em",
                textTransform: "uppercase",
              }}
            >
              {filtered.length} projects
            </span>
          </div>

          {filtered.length === 0 ? (
            <div
              style={{
                padding: "60px 40px",
                textAlign: "center",
                border: "1px dashed var(--stroke-1)",
                borderRadius: 12,
                background: "var(--canvas-0)",
              }}
            >
              <div
                style={{
                  fontSize: 15,
                  color: "var(--ink-0)",
                  fontVariationSettings: "'wght' 500",
                  marginBottom: 6,
                }}
              >
                Nothing here yet
              </div>
              <div style={{ fontSize: 13, color: "var(--ink-2)", marginBottom: 18 }}>
                Describe something new and Lucent will build it.
              </div>
              <button className="icon-btn primary" onClick={newProject}>
                <Ico.Plus /> New workspace
              </button>
            </div>
          ) : (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
                gap: 14,
              }}
            >
              {filtered.map((p) => (
                <ProjectCard key={p.id} project={p} onOpen={() => open(p)} />
              ))}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

function SidebarItem({
  icon,
  label,
  count,
  active,
  onClick,
  small,
}: {
  icon: React.ReactNode;
  label: string;
  count?: number | null;
  active: boolean;
  onClick: () => void;
  small?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        width: "100%",
        padding: small ? "7px 10px" : "8px 10px",
        borderRadius: 6,
        fontSize: small ? 12.5 : 13,
        color: active ? "var(--ink-0)" : "var(--ink-1)",
        background: active ? "var(--canvas-3)" : "transparent",
        fontVariationSettings: active ? "'wght' 520" : "'wght' 450",
        marginBottom: small ? 1 : 2,
        position: "relative",
      }}
    >
      {active && (
        <span
          style={{
            position: "absolute",
            left: -12,
            top: 8,
            bottom: 8,
            width: 2,
            background: "var(--amber-2)",
            borderRadius: "0 2px 2px 0",
            boxShadow: "0 0 6px var(--amber-glow)",
          }}
        />
      )}
      {icon}
      <span style={{ flex: 1, textAlign: "left" }}>{label}</span>
      {count != null && (
        <span className="mono" style={{ fontSize: small ? 10 : 10.5, color: "var(--ink-3)" }}>
          {count}
        </span>
      )}
    </button>
  );
}

function ProjectCard({ project, onOpen }: { project: DisplayProject; onOpen: () => void }) {
  return (
    <div
      onClick={onOpen}
      style={{
        background: "var(--canvas-0)",
        border: "1px solid var(--stroke-1)",
        borderRadius: 12,
        overflow: "hidden",
        cursor: "pointer",
        transition: "all 0.15s var(--e-out)",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = "var(--stroke-3)";
        e.currentTarget.style.transform = "translateY(-1px)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = "var(--stroke-1)";
        e.currentTarget.style.transform = "translateY(0)";
      }}
    >
      <div
        style={{
          height: 110,
          background: project.accent
            ? "linear-gradient(180deg, var(--amber-glow-soft), var(--canvas-1))"
            : "linear-gradient(180deg, var(--canvas-1), var(--canvas-0))",
          padding: 14,
          borderBottom: "1px solid var(--stroke-1)",
        }}
      >
        <MiniPreview kind={project.mini} accent={project.accent} />
      </div>
      <div style={{ padding: "12px 14px 14px" }}>
        <div
          style={{
            fontSize: 13.5,
            color: "var(--ink-0)",
            fontVariationSettings: "'wght' 520",
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <span
            style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}
          >
            {project.name}
          </span>
          {project.isCloud && (
            <span
              title={project.isShared ? "Shared with you" : "Cloud board"}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 3,
                fontSize: 10,
                color: "var(--ink-3)",
                background: "var(--canvas-2)",
                padding: "2px 6px",
                borderRadius: 4,
                border: "1px solid var(--stroke-1)",
              }}
            >
              {project.isShared ? (
                <Ico.Share width={10} height={10} />
              ) : (
                <Ico.Layers width={10} height={10} />
              )}
              <span>{project.isShared ? "Shared" : "Cloud"}</span>
            </span>
          )}
          {project.accent && (
            <span
              style={{
                width: 5,
                height: 5,
                borderRadius: 999,
                background: "var(--amber-2)",
                boxShadow: "0 0 6px var(--amber-glow)",
              }}
            />
          )}
        </div>
        <div
          className="mono"
          style={{
            marginTop: 6,
            fontSize: 11,
            color: "var(--ink-3)",
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <span>{project.kind}</span>
          <span>·</span>
          <span>{project.nodes} nodes</span>
        </div>
      </div>
    </div>
  );
}
