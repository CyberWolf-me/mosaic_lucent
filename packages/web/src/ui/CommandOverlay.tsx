import { useEffect, useMemo, useRef, useState } from "react";
import { Ico } from "./icons.js";
import { useWorkspace } from "../workspace.js";
import type { WorkspaceState } from "../workspace.js";
import type { Workspace } from "@lucent/core";
import { searchBoard, type BoardSearchHit, type BoardSearchResponse } from "../boards.js";
import { resolveLocale, t } from "@lucent/i18n";
import {
  buildResults,
  groupSearchHits,
  moveIndex,
  searchHitHint,
  searchHitTarget,
  searchHitTitle,
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
 *
 * Stage C4: on a shared board the board family becomes SERVER search — the
 * same retriever Ask uses, over the same entitlement window — debounced at
 * 250 ms with a fresh AbortController per keystroke so a slow network cannot
 * answer an old query. Results navigate through onCitation (the citation
 * contract: ?reveal / ?meeting+?turn / ?rev), and the Ask bridge hands the
 * query to ask() when the user wants understanding rather than navigation.
 * Local boards keep the local scan; there is nothing server-side to search.
 */
const SEARCH_DEBOUNCE_MS = 250;
const SEARCH_MIN_QUERY = 2;

export function CommandOverlay({
  onClose,
  onOpenSettings,
}: {
  onClose: () => void;
  onOpenSettings?: (section?: string) => void;
}) {
  const {
    setView,
    send,
    workspace,
    undo,
    redo,
    newProject,
    boardId,
    ask,
    setPillMode,
    onCitation,
  } = useWorkspace() as unknown as {
    setView: WorkspaceState["setView"];
    send: WorkspaceState["send"];
    workspace: Workspace;
    undo: () => void;
    redo: () => void;
    newProject: () => void;
    boardId: string | null;
    ask: WorkspaceState["ask"];
    setPillMode: WorkspaceState["setPillMode"];
    onCitation: WorkspaceState["onCitation"];
  };
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  /** Server search results for the current query (null: nothing fetched yet). */
  const [search, setSearch] = useState<BoardSearchResponse | null>(null);
  /** True after a server search failure/offline — surfaced inline, not silent. */
  const [searchError, setSearchError] = useState(false);
  /** The ask-bridge composer: the input becomes the question field. */
  const [askMode, setAskMode] = useState(false);
  const [askText, setAskText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const locale = useMemo(() => resolveLocale(navigator.language), []);
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
        id: "v-intelligence",
        label: "Open intelligence",
        hint: "Decisions · Actions · Risks",
        group: "view",
        run: { kind: "view", view: "intelligence" },
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

  // Local scan for local boards: nodes by label/type and shapes by text. On a
  // shared board the server results (below) replace this family — the server
  // corpus covers everything the local scan sees plus the transcript and the
  // revision log, all windowed by entitlement.
  const useLocalScan = !boardId;
  const boardHits = useMemo<PaletteBoardHit[]>(() => {
    if (!useLocalScan) return [];
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
  }, [q, useLocalScan, workspace.nodes, workspace.shapes]);

  // Server search (shared boards): debounced, aborted per keystroke, and
  // guarded so a stale response can never render (seq check via closure —
  // the last request wins, earlier ones resolve to nothing).
  const searchQuery = useLocalScan ? "" : q.trim();
  useEffect(() => {
    if (!searchQuery || searchQuery.length < SEARCH_MIN_QUERY) {
      setSearch(null);
      setSearchError(false);
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void searchBoard(boardId!, searchQuery, controller.signal)
        .then((res) => {
          if (!cancelled && res && res.query === searchQuery) {
            setSearch(res);
            setSearchError(false);
          }
        })
        .catch(() => {
          // Offline or aborted: surface it inline — the palette still shows
          // local results, but the user must know server search failed.
          if (!cancelled) setSearchError(true);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [boardId, searchQuery]);

  const serverHits = useMemo(
    () => (search && !useLocalScan ? search.results : []),
    [search, useLocalScan],
  );
  const grouped = useMemo(() => groupSearchHits(serverHits), [serverHits]);

  // The full result list the cursor walks: actions, views, then either the
  // local board scan or the server's three groups.
  const results = useMemo(
    () => ({
      ...buildResults(items, boardHits, q),
      search: grouped,
      total: buildResults(items, boardHits, q).total + (useLocalScan ? 0 : grouped.total),
    }),
    [items, boardHits, q, grouped, useLocalScan],
  );
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

  // Navigate a server hit through the citation contract — the same handler
  // and the same URL params the AI pill's citations use, so the target view's
  // flash/highlight behavior comes for free.
  const runSearchHit = (hit: BoardSearchHit): void => {
    const target = searchHitTarget(hit);
    if (target) onCitation(target);
    onClose();
  };

  // The Ask bridge: switch the palette into question mode. Enter submits
  // through ask() — which routes the question through the same retrieval
  // evidence the search results came from — with the pill set to Ask so the
  // reply is visibly an answer, not a build request.
  const submitAsk = (): void => {
    const question = askText.trim() || q.trim();
    if (!question) return;
    setPillMode("ask");
    void ask(question);
    onClose();
  };

  // One cursor across the whole list: entries [0, items) are actions+views,
  // the tail is board hits (local) or the server groups, and past the end is
  // the free-text fallback.
  const runAt = (index: number): void => {
    const itemCount = results.actions.length + results.views.length;
    if (index < itemCount) {
      const it = results.actions[index] ?? results.views[index - results.actions.length];
      if (it) {
        runAction(it.run);
        return;
      }
    }
    if (useLocalScan) {
      const hit = results.board[index - itemCount];
      if (hit) {
        setView("canvas");
        onClose();
        return;
      }
    } else {
      const server = [...grouped.nodes, ...grouped.turns, ...grouped.revisions];
      const hit = server[index - itemCount];
      if (hit) {
        runSearchHit(hit);
        return;
      }
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

  // A server hit row. Matched tokens ride the hint so a result explains
  // itself ("Matching: pricing, 20" — the lexical contract), never a score.
  const searchRow = (hit: BoardSearchHit, index: number): React.ReactNode => (
    <button
      key={`${hit.kind}-${hit.id}${hit.turnIndex ?? ""}`}
      onClick={() => runSearchHit(hit)}
      onMouseEnter={() => setActive(index)}
      style={entryStyle(index === active)}
    >
      {iconBox(
        hit.kind === "node" ? (
          <Ico.Grid />
        ) : hit.kind === "turn" ? (
          <Ico.Journey />
        ) : (
          <Ico.History />
        ),
      )}
      {labelBlock(
        searchHitTitle(hit),
        `${searchHitHint(hit)} · ${t("palette.matched", locale, { q: hit.matched.join(", ") })}`,
      )}
    </button>
  );

  const searchOffset = results.actions.length + results.views.length;
  const visibleTotal = results.total;

  return (
    <>
      <div
        onClick={onClose}
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 300,
          background: "oklch(0.10 0.005 252 / 0.65)",
          backdropFilter: "blur(6px)",
          WebkitBackdropFilter: "blur(6px)",
          animation: "scrim-in 0.18s ease-out backwards",
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
          WebkitBackdropFilter: "blur(24px)",
          animation: "dialog-in 0.2s var(--e-out) backwards",
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
          {askMode ? (
            <input
              ref={inputRef}
              value={askText}
              onChange={(e) => setAskText(e.target.value)}
              aria-label={t("palette.ask.placeholder", locale)}
              placeholder={t("palette.ask.placeholder", locale)}
              style={{ flex: 1, fontSize: 14, color: "var(--ink-0)" }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  submitAsk();
                } else if (e.key === "Escape") {
                  // Escape returns to search, not out of the palette: the
                  // user asked for the bridge, not for the door.
                  e.preventDefault();
                  setAskMode(false);
                }
              }}
            />
          ) : (
            <input
              ref={inputRef}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              aria-label={t("palette.hint.placeholder", locale)}
              placeholder={t("palette.hint.placeholder", locale)}
              style={{ flex: 1, fontSize: 14, color: "var(--ink-0)" }}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setActive((i) => moveIndex(i, 1, visibleTotal));
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setActive((i) => moveIndex(i, -1, visibleTotal));
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
          )}
          <span className="kbd">Esc</span>
        </div>
        <div style={{ maxHeight: 380, overflowY: "auto", padding: 6 }}>
          {!askMode && results.total === 0 && !q.trim() && (
            <div
              className="mono"
              style={{ padding: 24, textAlign: "center", fontSize: 12.5, color: "var(--ink-3)" }}
            >
              {t("palette.empty.none", locale)}
            </div>
          )}
          {!askMode && results.total === 0 && q.trim() && (
            <div
              className="mono"
              style={{ padding: 24, textAlign: "center", fontSize: 12.5, color: "var(--ink-3)" }}
            >
              {t("palette.empty.ask", locale, { q })}
            </div>
          )}
          {askMode ? (
            <div
              className="mono"
              style={{ padding: 24, textAlign: "center", fontSize: 12.5, color: "var(--ink-3)" }}
            >
              {t("palette.ask.hint", locale)}
            </div>
          ) : (
            <>
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
              {results.views.length > 0 && header(t("palette.group.views", locale))}
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
              {useLocalScan
                ? results.board.length > 0 && header(t("palette.group.board", locale))
                : null}
              {useLocalScan &&
                results.board.map((hit, i) => {
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
              {!useLocalScan &&
                grouped.nodes.length > 0 &&
                header(t("palette.group.nodes", locale))}
              {!useLocalScan && grouped.nodes.map((hit, i) => searchRow(hit, searchOffset + i))}
              {!useLocalScan &&
                grouped.turns.length > 0 &&
                header(t("palette.group.transcript", locale))}
              {!useLocalScan &&
                grouped.turns.map((hit, i) =>
                  searchRow(hit, searchOffset + grouped.nodes.length + i),
                )}
              {!useLocalScan &&
                grouped.revisions.length > 0 &&
                header(t("palette.group.revisions", locale))}
              {!useLocalScan &&
                grouped.revisions.map((hit, i) =>
                  searchRow(hit, searchOffset + grouped.nodes.length + grouped.turns.length + i),
                )}
              {!useLocalScan && searchError && (
                <div
                  className="mono"
                  role="status"
                  style={{ padding: "10px 12px", fontSize: 10.5, color: "var(--ink-3)" }}
                >
                  Search unavailable offline — showing local results.
                </div>
              )}
              {!useLocalScan && search?.windowTruncated && (
                <div
                  className="mono"
                  style={{ padding: "10px 12px", fontSize: 10.5, color: "var(--ink-3)" }}
                >
                  {t("palette.window.truncated", locale, {
                    depth: String(search.historyDepth ?? "—"),
                  })}
                </div>
              )}
            </>
          )}
        </div>
        {/* The Ask bridge: one persistent row, so "find" can become
            "understand" without retyping. */}
        {!askMode && (
          <button
            onClick={() => {
              setAskText(q);
              setAskMode(true);
            }}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              width: "100%",
              padding: "10px 18px",
              borderTop: "1px solid var(--stroke-1)",
              background: "transparent",
              textAlign: "left",
              color: "var(--ink-2)",
              fontSize: 12.5,
            }}
          >
            <Ico.Journey />
            {t("palette.ask.bridge", locale)}
          </button>
        )}
      </div>
    </>
  );
}
