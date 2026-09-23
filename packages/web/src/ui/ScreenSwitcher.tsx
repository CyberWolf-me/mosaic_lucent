import React from "react";

export interface ScreenDef {
  id: number;
  key: string;
  label: string;
  group: "REF" | "GLOBAL" | "BOARD" | "MEETING" | "INTEL" | "EXEC" | "X-CUT" | "LENS";
}

export const SCREENS: ScreenDef[] = [
  // -- Reference / meta --
  { id: 0,  key: "system",        label: "Design system",            group: "REF" },
  { id: 25, key: "ia",            label: "Information architecture", group: "REF" },

  // -- Global / product --
  { id: 11, key: "home",          label: "Home",                     group: "GLOBAL" },
  { id: 12, key: "workspace",     label: "Workspace",                group: "GLOBAL" },

  // -- Board (the canvas) --
  { id: 1,  key: "empty",         label: "Board · empty",            group: "BOARD" },
  { id: 2,  key: "generating",    label: "Board · AI drafting",       group: "BOARD" },
  { id: 3,  key: "main",          label: "Board · active",           group: "BOARD" },
  { id: 4,  key: "proposing",     label: "Board · proposing",        group: "BOARD" },

  // -- Meeting --
  { id: 13, key: "meeting_board", label: "Meeting · on board",       group: "MEETING" },
  { id: 5,  key: "voice",         label: "Voice",                     group: "MEETING" },
  { id: 8,  key: "meeting",       label: "Meeting · doc",             group: "MEETING" },

  // -- Intelligence --
  { id: 14, key: "decisions",     label: "Decisions",                group: "INTEL" },
  { id: 15, key: "actions",       label: "Actions",                  group: "INTEL" },
  { id: 16, key: "knowledge",     label: "Knowledge · Ask",          group: "INTEL" },

  // -- Execution --
  { id: 18, key: "projects",      label: "Projects",                 group: "EXEC" },
  { id: 19, key: "task",          label: "Task detail",              group: "EXEC" },

  // -- History / cross-cutting --
  { id: 7,  key: "history",       label: "History",                  group: "GLOBAL" },
  { id: 20, key: "ask",           label: "Ask",                      group: "X-CUT" },
  { id: 21, key: "notif",         label: "Notifications",            group: "X-CUT" },
  { id: 22, key: "review",        label: "Review queue",             group: "X-CUT" },
  { id: 23, key: "integrations",  label: "Integrations",             group: "X-CUT" },
  { id: 24, key: "admin",         label: "Admin",                    group: "X-CUT" },

  // -- Diagram lenses --
  { id: 9,  key: "wireframe",     label: "Wireframe",                group: "LENS" },
  { id: 10, key: "sequence",      label: "Sequence",                 group: "LENS" },
  { id: 6,  key: "dashboard",     label: "Dashboard (legacy)",       group: "LENS" },
];

export const SCREEN_BY_ID = Object.fromEntries(SCREENS.map((s) => [s.id, s]));
export const SCREEN_BY_KEY: Record<string, ScreenDef | undefined> = Object.fromEntries(
  SCREENS.map((s) => [s.key, s]),
);
if (SCREEN_BY_ID[3]) {
  SCREEN_BY_KEY["main"] = SCREEN_BY_ID[3];
  SCREEN_BY_KEY["canvas"] = SCREEN_BY_ID[3];
  SCREEN_BY_KEY["board"] = SCREEN_BY_ID[3];
}
if (SCREEN_BY_ID[14]) {
  SCREEN_BY_KEY["decisions"] = SCREEN_BY_ID[14];
  SCREEN_BY_KEY["intel"] = SCREEN_BY_ID[14];
  SCREEN_BY_KEY["intelligence"] = SCREEN_BY_ID[14];
}
if (SCREEN_BY_ID[16]) {
  SCREEN_BY_KEY["knowledge"] = SCREEN_BY_ID[16];
}
if (SCREEN_BY_ID[18]) {
  SCREEN_BY_KEY["projects"] = SCREEN_BY_ID[18];
  SCREEN_BY_KEY["exec"] = SCREEN_BY_ID[18];
  SCREEN_BY_KEY["execution"] = SCREEN_BY_ID[18];
}
if (SCREEN_BY_ID[13]) {
  SCREEN_BY_KEY["meeting_board"] = SCREEN_BY_ID[13];
}
if (SCREEN_BY_ID[8]) {
  SCREEN_BY_KEY["meeting"] = SCREEN_BY_ID[8];
}

export const GROUPS: Record<ScreenDef["group"], { label: string; color: string }> = {
  REF:     { label: "Reference",        color: "var(--ink-1)" },
  GLOBAL:  { label: "Global",           color: "oklch(0.55 0.14 148)" },
  BOARD:   { label: "Board · canvas",   color: "var(--bloom-2)" },
  MEETING: { label: "Meeting",          color: "var(--madder)" },
  INTEL:   { label: "Intelligence",     color: "oklch(0.55 0.16 300)" },
  EXEC:    { label: "Execution",        color: "oklch(0.55 0.14 200)" },
  "X-CUT": { label: "Cross-cutting",    color: "var(--saffron)" },
  LENS:    { label: "Diagram lenses",   color: "oklch(0.55 0.14 42)" },
};

export function ScreenSwitcher({
  currentKey,
  open,
  setOpen,
  onGo,
}: {
  currentKey: string;
  open: boolean;
  setOpen: (o: boolean | ((prev: boolean) => boolean)) => void;
  onGo: (key: string, id: number) => void;
}) {
  const fallback: ScreenDef = SCREENS[2]!;
  const current: ScreenDef = (currentKey ? SCREEN_BY_KEY[currentKey] : undefined) || SCREEN_BY_ID[11] || fallback;
  const groupMeta = GROUPS[current.group] || GROUPS.GLOBAL;

  const grouped: Record<string, ScreenDef[]> = {};
  SCREENS.forEach((s) => {
    (grouped[s.group] ||= []).push(s);
  });

  return (
    <>
      {/* Floating Pill Trigger at Bottom-Left */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{
          position: "fixed",
          bottom: 12,
          left: 80,
          zIndex: 100,
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "6px 12px 6px 8px",
          background: "oklch(from var(--paper-0) l c h / 0.94)",
          border: "1px solid oklch(from var(--paper-4) l c h / 0.6)",
          borderRadius: 999,
          boxShadow: "var(--shadow-2)",
          backdropFilter: "blur(20px)",
          WebkitBackdropFilter: "blur(20px)",
          fontFamily: "var(--font-mono)",
          fontSize: 11,
          color: "var(--ink-0)",
          maxWidth: 320,
          cursor: "pointer",
        }}
        title="Jump to screen · ⌘J"
      >
        <span
          style={{
            display: "inline-grid",
            placeItems: "center",
            width: 22,
            height: 22,
            borderRadius: 999,
            background: groupMeta.color,
            color: "white",
            fontSize: 10,
            fontWeight: 700,
          }}
        >
          {current.id === 0 || current.id === 25 ? (current.id === 25 ? "★" : "◎") : current.id}
        </span>
        <span style={{ letterSpacing: "0.05em", color: "var(--ink-3)" }}>{groupMeta.label}</span>
        <span style={{ color: "var(--ink-3)" }}>·</span>
        <span
          style={{
            fontFamily: "var(--font-sans)",
            fontWeight: 500,
            letterSpacing: "-0.005em",
            maxWidth: 160,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {current.label}
        </span>
        <span style={{ color: "var(--ink-3)", marginLeft: 4 }}>⌘J</span>
      </button>

      {/* Expanded Modal Grid */}
      {open && (
        <>
          <div
            onClick={() => setOpen(false)}
            style={{
              position: "fixed",
              inset: 0,
              zIndex: 200,
              background: "oklch(0.2 0.02 60 / 0.35)",
              backdropFilter: "blur(8px)",
              WebkitBackdropFilter: "blur(8px)",
            }}
          />
          <div
            style={{
              position: "fixed",
              zIndex: 201,
              top: "50%",
              left: "50%",
              transform: "translate(-50%, -50%)",
              width: 780,
              maxWidth: "calc(100vw - 40px)",
              maxHeight: "calc(100vh - 80px)",
              background: "oklch(from var(--paper-0) l c h / 0.98)",
              border: "1px solid oklch(from var(--paper-4) l c h / 0.7)",
              borderRadius: 18,
              boxShadow: "var(--shadow-3)",
              overflow: "hidden",
              display: "flex",
              flexDirection: "column",
            }}
          >
            <div
              style={{
                padding: "18px 24px 14px",
                borderBottom: "1px solid oklch(from var(--paper-4) l c h / 0.5)",
                display: "flex",
                alignItems: "baseline",
                gap: 12,
              }}
            >
              <div
                style={{
                  fontFamily: "var(--font-serif)",
                  fontSize: 22,
                  fontWeight: 500,
                  letterSpacing: "-0.015em",
                  color: "var(--ink-0)",
                }}
              >
                Jump to screen
              </div>
              <span className="mono" style={{ fontSize: 10.5, color: "var(--ink-3)" }}>
                {SCREENS.length} screens · grouped by product area
              </span>
              <div style={{ flex: 1 }} />
              <span
                className="mono"
                style={{
                  fontSize: 10,
                  padding: "3px 8px",
                  background: "var(--paper-2)",
                  borderRadius: 5,
                  color: "var(--ink-2)",
                }}
              >
                Esc
              </span>
            </div>
            <div style={{ padding: 20, overflow: "auto" }}>
              {Object.entries(grouped).map(([g, list]) => {
                const grp = GROUPS[g as keyof typeof GROUPS] || { label: g, color: "var(--ink-1)" };
                return (
                  <div key={g} style={{ marginBottom: 22 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                      <span style={{ width: 8, height: 8, borderRadius: 2, background: grp.color }} />
                      <span className="mono-caps" style={{ letterSpacing: "0.08em" }}>
                        {grp.label}
                      </span>
                      <span className="mono" style={{ fontSize: 10, color: "var(--ink-3)" }}>
                        · {list.length}
                      </span>
                    </div>
                    <div
                      style={{
                        display: "grid",
                        gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
                        gap: 6,
                      }}
                    >
                      {list.map((s) => (
                        <button
                          key={s.id}
                          type="button"
                          onClick={() => {
                            onGo(s.key, s.id);
                            setOpen(false);
                          }}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 10,
                            padding: "9px 12px",
                            borderRadius: 8,
                            background: s.id === current.id ? "var(--paper-2)" : "transparent",
                            border: `1px solid ${s.id === current.id ? "var(--ink-3)" : "transparent"}`,
                            textAlign: "left",
                            cursor: "pointer",
                            transition: "all 0.1s",
                          }}
                          onMouseEnter={(e) =>
                            s.id !== current.id && (e.currentTarget.style.background = "var(--paper-2)")
                          }
                          onMouseLeave={(e) =>
                            s.id !== current.id && (e.currentTarget.style.background = "transparent")
                          }
                        >
                          <span
                            className="mono"
                            style={{
                              width: 24,
                              textAlign: "right",
                              fontSize: 10,
                              color: "var(--ink-3)",
                              letterSpacing: "0.02em",
                            }}
                          >
                            {String(s.id).padStart(2, "0")}
                          </span>
                          <span
                            style={{
                              fontSize: 12.5,
                              color: "var(--ink-0)",
                              fontWeight: s.id === current.id ? 500 : 400,
                            }}
                          >
                            {s.label}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}
    </>
  );
}
