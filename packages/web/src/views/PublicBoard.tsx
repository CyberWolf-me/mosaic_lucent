import { useEffect, useState } from "react";
import { parseWorkspaceOrDefault } from "@lucent/core";
import { buildBoardSvg } from "../board/geometry.js";

/**
 * The anonymous, read-only public board view (docs/26). No account, no session,
 * no editing: it fetches the sanitized snapshot the server serves for a public
 * token and renders it as the same static SVG the export uses. A "Made with
 * Lucent" link turns every shared board into a way in — the growth loop.
 */
type State = { kind: "loading" } | { kind: "gone" } | { kind: "ready"; name: string; svg: string };

export function PublicBoard({ token }: { token: string }) {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    let live = true;
    // A plain fetch — no credentials, no CSRF: this is a public read.
    fetch(`/api/public/boards/${encodeURIComponent(token)}`, { credentials: "omit" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((body: { name?: string; workspace?: unknown }) => {
        if (!live) return;
        const ws = parseWorkspaceOrDefault(body.workspace, "public board");
        setState({ kind: "ready", name: body.name || "Untitled board", svg: buildBoardSvg(ws) });
      })
      .catch(() => live && setState({ kind: "gone" }));
    return () => {
      live = false;
    };
  }, [token]);

  return (
    <div
      style={{
        minHeight: "100%",
        display: "flex",
        flexDirection: "column",
        background: "var(--paper-0, #f6f7f9)",
        color: "var(--ink-0, #14161c)",
        fontFamily: "var(--font-sans, system-ui, sans-serif)",
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "12px clamp(16px, 5vw, 32px)",
          borderBottom: "1px solid var(--stroke-2, #e3e6ec)",
        }}
      >
        <span style={{ fontWeight: 700, letterSpacing: "-0.01em" }}>Lucent</span>
        <span
          style={{
            color: "var(--ink-3, #878d9b)",
            fontSize: 14,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {state.kind === "ready" ? state.name : "Shared board"}
        </span>
        <span style={{ flex: 1 }} />
        <a
          href="/signup"
          style={{
            fontSize: 13,
            fontWeight: 600,
            textDecoration: "none",
            color: "var(--paper-0, #fff)",
            background: "var(--bloom-2, #4b45c6)",
            padding: "7px 13px",
            borderRadius: 999,
            whiteSpace: "nowrap",
          }}
        >
          Made with Lucent →
        </a>
      </header>
      <main style={{ flex: 1, minWidth: 0, padding: "clamp(12px, 3vw, 28px)" }}>
        {state.kind === "loading" && (
          <p style={{ color: "var(--ink-3, #878d9b)" }}>Loading the board…</p>
        )}
        {state.kind === "gone" && (
          <div style={{ maxWidth: "44ch" }}>
            <h1 style={{ fontSize: 20, marginBottom: 8 }}>This board isn't public.</h1>
            <p style={{ color: "var(--ink-2, #565c68)", lineHeight: 1.6 }}>
              The link may have been turned off, or the board was deleted. Ask whoever shared it for
              a fresh link.
            </p>
          </div>
        )}
        {state.kind === "ready" && (
          <div
            role="img"
            aria-label={`Board: ${state.name}`}
            style={{
              overflow: "auto",
              border: "1px solid var(--stroke-2, #e3e6ec)",
              borderRadius: 12,
              maxWidth: "100%",
            }}
            dangerouslySetInnerHTML={{ __html: state.svg }}
          />
        )}
      </main>
    </div>
  );
}
