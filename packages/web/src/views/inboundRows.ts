import type { InboundChangeView } from "../boards.js";

/**
 * The inbound-row decisions (Stage D7), pure so they can be tested without
 * a DOM (the IntelligencePanel decisions precedent). The UI renders what
 * these decide; these encode the two rules the stage is built on:
 *
 * - THE NEVER-GUESSES RULE: a row with no translation (mappedValue null)
 *   is dismiss-only — Accept would require Lucent to guess a status to
 *   write, so the button must not exist.
 * - THE RESOLVED JOIN: a pending row whose board value already equals
 *   the mapped value has nothing to decide; Accept (offered, as a no-op
 *   mark so the queue can be cleared) says "keep it" honestly.
 */

export function inboundRowIsWarning(row: InboundChangeView): boolean {
  return row.status === "pending" && row.mappedValue === null;
}

export function inboundRowActions(row: InboundChangeView): {
  /** Accept offered at all (never for a warning row). */
  canAccept: boolean;
  /** Dismiss always offered for a pending row. */
  canDismiss: boolean;
} {
  if (row.status !== "pending") return { canAccept: false, canDismiss: false };
  return { canAccept: row.mappedValue !== null, canDismiss: true };
}

/** The pending count the Sync button badge renders. */
export function pendingInboundCount(rows: readonly InboundChangeView[]): number {
  return rows.filter((r) => r.status === "pending").length;
}

/** The row's one-line drift sentence: "Linear says Done — the board says todo". */
export function inboundRowSentence(row: InboundChangeView): string | null {
  if (row.status !== "pending") return null;
  if (row.mappedValue === null) return null; // the warning sentence is separate
  return `${row.externalValue} → ${row.mappedValue} · ${row.boardValue ?? "—"}`;
}
