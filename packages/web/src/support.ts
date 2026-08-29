/**
 * Support diagnostics (G2): "support channel with diagnostic context (no
 * board contents)".
 *
 * The rule this module enforces is the one the plan was explicit about: the
 * report a user attaches to a support request describes the *session*, not
 * the *board*. Node texts, board names, board contents and the user's
 * prompts never enter it — a customer pasting "here's my board" into a
 * support ticket is exactly how sensitive company info leaks, and the
 * product should not be the thing that formats it for them.
 *
 * What the report does carry: the numbers and versions a triage needs
 * (build, provider, sync state, object counts, error counts), because
 * "generation is slow" and "generation is slow with 403 nodes and the
 * socket reconnecting every 20s" are different tickets.
 */

export interface SupportContext {
  /** From the workspace: object counts, never contents. */
  nodes: number;
  edges: number;
  shapes: number;
  comments: number;
  /** Server board id when this project is shared; null for a local-only board. */
  boardId: string | null;
  /** Realtime connection state as the share dialog sees it. */
  syncStatus: string;
  /** This user's role on the shared board; null when solo. */
  syncRole: string | null;
  /** Whether the AI is mid-generation at report time. */
  busy: boolean;
  /** Streamed characters received so far — nonzero during a stalled stream. */
  streamChars: number;
  /** The resolved provider name (MockProvider in offline dev). */
  provider: string;
}

export interface SupportReport {
  /** `lucent/2026-08-29T…` — the one field support greps first. */
  product: string;
  build: string;
  userAgent: string;
  language: string;
  /** Viewport, rounded — a mobile-only bug needs to be recognisable as one. */
  viewport: string;
  timezone: string;
  connection: string;
  context: SupportContext;
  /** Epoch ms — lets support correlate against server logs by time. */
  at: number;
}

/**
 * Assemble the report. `BUILD_ID` is stamped by Vite at build time
 * (`vite.config.ts` define); in dev it is the string "dev", which is itself
 * the correct diagnostic.
 */
export function buildSupportReport(ctx: SupportContext): SupportReport {
  const nav =
    typeof navigator === "undefined"
      ? { userAgent: "unknown", language: "unknown", connection: undefined }
      : {
          userAgent: navigator.userAgent,
          language: navigator.languages?.[0] ?? navigator.language ?? "unknown",
          connection: (navigator as Navigator & { connection?: { effectiveType?: string } })
            .connection?.effectiveType,
        };
  const meta = import.meta as unknown as { env?: { DEV?: boolean; BUILD_ID?: string } };
  return {
    product: "lucent",
    build: meta.env?.DEV ? "dev" : String(meta.env?.BUILD_ID ?? "unknown"),
    userAgent: nav.userAgent,
    language: nav.language,
    viewport:
      typeof window === "undefined"
        ? "unknown"
        : `${Math.round(window.innerWidth)}×${Math.round(window.innerHeight)}`,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? "unknown",
    connection: nav.connection ?? "unknown",
    context: ctx,
    at: Date.now(),
  };
}

/**
 * Render the report as the text a user pastes into a support request. JSON
 * because support tooling parses it, fenced in a code block because humans
 * paste it into chat clients that eat indentation. Key order is insertion
 * order, which is most-readable-first.
 */
export function formatSupportReport(report: SupportReport): string {
  return "```\n" + JSON.stringify(report, null, 2) + "\n```";
}
