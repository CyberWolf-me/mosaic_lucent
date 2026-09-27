import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useWorkspace } from "../workspace.js";
import { useToast } from "./Toast.js";
import { Ico } from "./icons.js";
import { Button } from "./kit.js";
import {
  appendThread,
  askWorkspace,
  loadThread,
  type Confidence,
  type Scope,
  type ScopedCitation,
} from "../workspaceAsk.js";

/**
 * Ask a scope — the workspace, a project — and read the answer where you
 * asked (docs/26 J4, ADR 0048): the answer, how well it is supported, and the
 * evidence, each piece one click from where it lives. The conversation is the
 * person's thread on that scope (J7), so a follow-up resolves against what
 * was asked before, here or anywhere else that thread is open.
 */

interface Exchange {
  question: string;
  answer: string;
  confidence?: Confidence;
  citations: ScopedCitation[];
  failed?: boolean;
}

const KEEP_ON_SCREEN = 3;

export function ScopedAsk({
  orgId,
  scope,
  threadKey,
  placeholder,
  ask: incoming,
}: {
  orgId: string;
  scope: Scope;
  /** The thread this conversation lives in (workspaceAsk.threadScope). */
  threadKey: string;
  placeholder: string;
  /** A question handed in from elsewhere (Home's composer); asked once. */
  ask?: string | null;
}) {
  const inputId = useId();
  const { boardId, openBoard, setView } = useWorkspace();
  const { notify } = useToast();
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [exchanges, setExchanges] = useState<Exchange[]>([]);
  const history = useRef<Array<{ role: "user" | "ai"; text: string }>>([]);

  // The thread so far: what was asked here before, for context.
  useEffect(() => {
    let cancelled = false;
    void loadThread(threadKey).then((messages) => {
      if (cancelled || !messages) return;
      history.current = messages.map((m) => ({ role: m.role, text: m.text }));
    });
    return () => {
      cancelled = true;
    };
  }, [threadKey]);

  const run = useCallback(
    async (question: string) => {
      const q = question.trim();
      if (!q || busy) return;
      setBusy(true);
      setDraft("");
      const result = await askWorkspace(orgId, q, scope, history.current.slice(-8));
      setBusy(false);
      if ("error" in result) {
        setExchanges((xs) => [
          ...xs.slice(-(KEEP_ON_SCREEN - 1)),
          { question: q, answer: result.error, citations: [], failed: true },
        ]);
        return;
      }
      setExchanges((xs) => [
        ...xs.slice(-(KEEP_ON_SCREEN - 1)),
        {
          question: q,
          answer: result.answer,
          confidence: result.confidence,
          citations: result.citations,
        },
      ]);
      history.current = [
        ...history.current,
        { role: "user" as const, text: q },
        { role: "ai" as const, text: result.answer },
      ].slice(-16);
      void appendThread(threadKey, [
        { role: "user", text: q, surface: "ask", at: Date.now() },
        {
          role: "ai",
          text: result.answer,
          surface: "ask",
          at: Date.now(),
          citations: result.citations,
        },
      ]);
    },
    [busy, orgId, scope, threadKey],
  );

  // A question handed in (Home's composer) is asked once.
  const lastIncoming = useRef<string | null>(null);
  useEffect(() => {
    if (incoming && incoming !== lastIncoming.current) {
      lastIncoming.current = incoming;
      void run(incoming);
    }
  }, [incoming, run]);

  /** Evidence opens where it lives: a node on its board, a meeting at its turn. */
  const open = async (c: ScopedCitation) => {
    const target = c.boardId ?? boardId;
    if (!target) return;
    const params = new URLSearchParams(window.location.search);
    if (c.kind === "node") params.set("reveal", c.id);
    else if (c.kind === "meeting") {
      params.set("meeting", c.id);
      params.set("board", target);
      if (c.turnRange) params.set("turn", String(c.turnRange[0]));
    }
    window.history.replaceState(null, "", `?${params.toString()}`);
    if (target !== boardId && !(await openBoard(target))) {
      notify("That board isn't available any more — it may have been deleted or unshared.");
      return;
    }
    setView(c.kind === "meeting" ? "meeting" : "canvas");
  };

  const showAll = async (boardOf: string, ids: string[]) => {
    const params = new URLSearchParams(window.location.search);
    params.set("reveal", ids.join(","));
    window.history.replaceState(null, "", `?${params.toString()}`);
    if (boardOf !== boardId && !(await openBoard(boardOf))) return;
    setView("canvas");
  };

  return (
    <div className="scoped-ask">
      <form
        className="scoped-ask-form"
        onSubmit={(e) => {
          e.preventDefault();
          void run(draft);
        }}
      >
        <label className="sr-only" htmlFor={inputId}>
          {placeholder}
        </label>
        <Ico.Sparkle aria-hidden />
        <input
          id={inputId}
          className="scoped-ask-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={placeholder}
          disabled={busy}
        />
        <Button size="sm" variant="primary" type="submit" disabled={busy || !draft.trim()}>
          {busy ? "Asking…" : "Ask"}
        </Button>
      </form>
      {exchanges.length > 0 && (
        <ol className="scoped-ask-answers" aria-live="polite">
          {exchanges.map((x, i) => {
            // Several statements on one board can be shown together.
            const nodesByBoard = new Map<string, string[]>();
            for (const c of x.citations) {
              if (c.kind === "node" && c.boardId) {
                nodesByBoard.set(c.boardId, [...(nodesByBoard.get(c.boardId) ?? []), c.id]);
              }
            }
            return (
              <li key={i} className={`scoped-ask-answer${x.failed ? " failed" : ""}`}>
                <div className="scoped-ask-question">{x.question}</div>
                <p className="scoped-ask-text">{x.answer}</p>
                {x.confidence && (
                  <div className={`answer-confidence is-${x.confidence.level}`}>
                    {x.confidence.level === "none"
                      ? "No evidence — nothing in scope supports this answer."
                      : x.confidence.reason}
                  </div>
                )}
                {x.citations.length > 0 && (
                  <div className="scoped-ask-cites">
                    {[...nodesByBoard].map(([b, ids]) =>
                      ids.length > 1 ? (
                        <button
                          key={`all-${b}`}
                          type="button"
                          className="citation-chip strong"
                          onClick={() => void showAll(b, ids)}
                        >
                          Show all {ids.length} on the board
                        </button>
                      ) : null,
                    )}
                    {x.citations.map((c, j) => (
                      <button
                        key={j}
                        type="button"
                        className="citation-chip"
                        onClick={() => void open(c)}
                        title={c.why ?? c.label}
                      >
                        <span aria-hidden>✦</span> {c.label}
                        {c.boardName ? (
                          <span className="citation-board"> · {c.boardName}</span>
                        ) : null}
                      </button>
                    ))}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
