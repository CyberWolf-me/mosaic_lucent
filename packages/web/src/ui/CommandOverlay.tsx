import { useEffect, useMemo, useRef, useState } from "react";
import { Ico } from "./icons.js";
import { useWorkspace } from "../workspace.js";
import type { WorkspaceState } from "../workspace.js";
import type { Workspace } from "@lucent/core";
import {
  buildResults,
  moveIndex,
  type PaletteAction,
  type PaletteBoardHit,
  type PaletteItem,
} from "./palette.js";

/**
 * The command palette overlay (M7): ⌘K. Actions first (undo/redo, new
 * workspace, settings, export), then views, then the open board's objects —
 * one cursor across all of them, driven entirely by `palette.ts`'s pure
 * functions. The free-text fallback remains: with no matches, Enter asks
 * Lucent to build what you typed, which is the product's promise anyway.
 */
export function CommandOverlay({
  onClose,
  onOpenSettings,
}: {
  onClose: () => void;
  onOpenSettings?: (section?: string) => void;
}) {
  const { setView, send, workspace, undo, redo, newProject } = useWorkspace() as unknown as {
    setView: WorkspaceState["setView"];
    send: WorkspaceState["send"];
    workspace: Workspace;
    undo: () => void;
    redo: () => void;
    newProject: () => void;
  };
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const items: PaletteItem[] = useMemo(
    () => [
      { id: "undo", label: "Undo", hint: "⌘Z · History", group: "action", run: { kind: "undo" } },
      { id: "redo", label: "Redo", hint: "⌘⇧Z · History", group: "action", run: { kind: "redo" } },
      {
        id: "new",
        label: "New workspace",
        hint: "Board · Start over",
        group: "action",
        run: { kind: "newWorkspace" },
      },
      {
        id: "settings",
        label: "Open settings",
        hint: "Account · Board",
        group: "action",
        run: { kind: "settings" },
      },
      {
        id: "export",
        label: "Export board",
        hint: "PNG · SVG · PDF",
        group: "action",
        run: { kind: "export" },
      },
      {
        id: "v-canvas",
        label: "Open canvas",
        hint: "Semantic diagram",
        group: "view",
        run: { kind: "view", view: "canvas" },
      },
      {
        id: "v-dash",
        label: "Go to dashboard",
        hint: "Personal · Home",
        group: "view",
        run: { kind: "view", view: "dashboard" },
      },
      {
        id: "v-history",
        label: "Open workspace history",
        hint: "Version timeline",
        group: "view",
        run: { kind: "view", view: "history" },
      },
      {
        id: "v-meeting",
        label: "Start meeting mode",
        hint: "Extract from convo",
        group: "view",
        run: { kind: "view", view: "meeting" },
      },
      {
        id: "v-wireframe",
        label: "Open wireframe",
        hint: "Checkout · 1440",
        group: "view",
        run: { kind: "view", view: "wireframe" },
      },
      {
        id: "v-sequence",
        label: "Open sequence",
        hint: "Message flow",
        group: "view",
        run: { kind: "view", view: "sequence" },
      },
    ],
    [],
  );

  // Search the board itself, not just view names: nodes by label/type and manual
  // shapes by their text.
  const boardHits = useMemo<PaletteBoardHit[]>(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return [];
    const hits: PaletteBoardHit[] = [];
    for (const n of Object.values(workspace.nodes)) {
      if (n.label.toLowerCase().includes(needle) || n.nodeType.toLowerCase().includes(needle)) {
        hits.push({ id: n.id, title: n.label, hint: `Node · ${n.nodeType}` });
      }
    }
    for (const s of Object.values(workspace.shapes)) {
      const text = s.text ?? "";
      if (text.toLowerCase().includes(needle) || s.kind.toLowerCase().includes(needle)) {
        hits.push({
          id: s.id,
          title: text || s.kind,
          hint: `${s.kind}${s.hidden ? " · hidden" : ""}`,
        });
      }
    }
    return hits.slice(0, 8);
  }, [q, workspace.nodes, workspace.shapes]);

  const results = useMemo(() => buildResults(items, boardHits, q), [items, boardHits, q]);
  useEffect(() => {
    setActive(0);
  }, [q]);

  const runAction = (a: PaletteAction): void => {
    switch (a.kind) {
      case "undo":
        undo();
        break;
      case "redo":
        redo();
        break;
      case "newWorkspace":
        newProject();
        break;
      case "settings":
        onOpenSettings?.();
        break;
      case "export":
        // The export surface lives on the canvas; opening it with the palette
        // is the 80% case, so route there and let the user pick the format.
        setView("canvas");
        break;
      case "view":
        setView(a.view);
        break;
    }
    onClose();
  };

  // One cursor across the whole list: entries [0, items) are actions+views,
  // the tail is board hits, and past the end is the free-text fallback.
  const runAt = (index: number): void => {
    const itemCount = results.actions.length + results.views.length;
    if (index < itemCount) {
      const it = results.actions[index] ?? results.views[index - results.actions.length];
      if (it) {
        runAction(it.run);
        return;
      }
    }
    const hit = results.board[index - itemCount];
    if (hit) {
      setView("canvas");
      onClose();
      return;
    }
    if (q.trim()) {
      setView("canvas");
      void send(q.trim());
      onClose();
    }
  };

  const entryStyle = (isActive: boolean): React.CSSProperties => ({
    display: "flex",
    alignItems: "center",
    gap: 12,
    width: "100%",
    padding: "10px 12px",
    borderRadius: 8,
    textAlign: "left",
    background: isActive ? "var(--canvas-3)" : "transparent",
    boxShadow: isActive ? "inset 0 0 0 1px var(--stroke-2)" : "none",
  });

  const iconBox = (children: React.ReactNode): React.ReactNode => (
    <div
      style={{
        width: 26,
        height: 26,
        borderRadius: 6,
        background: "var(--canvas-3)",
        display: "grid",
        placeItems: "center",
        color: "var(--ink-1)",
        flexShrink: 0,
      }}
    >
      {children}
    </div>
  );

  const labelBlock = (title: string, hint: string): React.ReactNode => (
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ fontSize: 13, color: "var(--ink-0)", fontVariationSettings: "'wght' 500" }}>
        {title}
      </div>
      <div className="mono" style={{ fontSize: 10.5, color: "var(--ink-3)", marginTop: 1 }}>
        {hint}
      </div>
    </div>
  );

  const header = (text: string): React.ReactNode => (
    <div
      className="mono"
      style={{
        fontSize: 10,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        color: "var(--ink-3)",
        padding: "10px 12px 4px",
      }}
    >
      {text}
    </div>
  );

  return (
    <>
      <div
        onClick={onClose}
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 300,
          background: "oklch(0.10 0.005 60 / 0.55)",
          backdropFilter: "blur(6px)",
        }}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command menu"
        style={{
          position: "fixed",
          top: "18vh",
          left: "50%",
          transform: "translateX(-50%)",
          zIndex: 301,
          width: 560,
          maxWidth: "calc(100vw - 40px)",
          background: "oklch(from var(--canvas-2) l c h / 0.96)",
          border: "1px solid var(--stroke-2)",
          borderRadius: 16,
          boxShadow: "var(--elev-3)",
          overflow: "hidden",
          backdropFilter: "blur(24px)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "14px 18px",
            borderBottom: "1px solid var(--stroke-1)",
          }}
        >
          <Ico.Search style={{ color: "var(--ink-2)" }} />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="Search actions, views, or ask Lucent to build something"
            placeholder="Search actions, views, or ask Lucent to build something…"
            style={{ flex: 1, fontSize: 14, color: "var(--ink-0)" }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((i) => moveIndex(i, 1, results.total));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((i) => moveIndex(i, -1, results.total));
              } else if (e.key === "Enter") {
                e.preventDefault();
                runAt(active);
              } else if (e.key === "Escape") {
                // Esc must close from inside the field: the app-level Escape
                // handler ignores INPUT targets, so handle it here.
                e.preventDefault();
                onClose();
              }
            }}
          />
          <span className="kbd">Esc</span>
        </div>
        <div style={{ maxHeight: 380, overflowY: "auto", padding: 6 }}>
          {results.total === 0 && !q.trim() && (
            <div
              className="mono"
              style={{ padding: 24, textAlign: "center", fontSize: 12.5, color: "var(--ink-3)" }}
            >
              No matches
            </div>
          )}
          {results.total === 0 && q.trim() && (
            <div
              className="mono"
              style={{ padding: 24, textAlign: "center", fontSize: 12.5, color: "var(--ink-3)" }}
            >
              No matches · Press Enter to ask Lucent to build "{q}"
            </div>
          )}
          {results.actions.map((it, i) => (
            <button
              key={it.id}
              onClick={() => runAction(it.run)}
              onMouseEnter={() => setActive(i)}
              style={entryStyle(i === active)}
            >
              {iconBox(<Ico.Layers />)}
              {labelBlock(it.label, it.hint)}
            </button>
          ))}
          {results.views.length > 0 && header("Views")}
          {results.views.map((it, i) => {
            const index = results.actions.length + i;
            return (
              <button
                key={it.id}
                onClick={() => runAction(it.run)}
                onMouseEnter={() => setActive(index)}
                style={entryStyle(index === active)}
              >
                {iconBox(<Ico.Arrow />)}
                {labelBlock(it.label, it.hint)}
              </button>
            );
          })}
          {results.board.length > 0 && header("On this board")}
          {results.board.map((hit, i) => {
            const index = results.actions.length + results.views.length + i;
            return (
              <button
                key={hit.id}
                onClick={() => runAt(index)}
                onMouseEnter={() => setActive(index)}
                style={entryStyle(index === active)}
              >
                {iconBox(<Ico.Grid />)}
                {labelBlock(hit.title, hit.hint)}
              </button>
            );
          })}
        </div>
      </div>
    </>
  );
}
