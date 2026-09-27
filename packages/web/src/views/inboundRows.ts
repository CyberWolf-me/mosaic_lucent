import type { InboundChangeView } from "../boards.js";
import { providerLabel } from "../integrationsAdmin.js";

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

/**
 * What a change says, in a sentence (docs/26 A5): a status to mark, an owner
 * to give it to, a date to move it to — or that the provider cleared one.
 */
export function inboundChangeText(change: {
  provider: string;
  field?: "status" | "assignee" | "dueDate";
  externalValue: string;
  mappedValue: string | null;
}): string {
  const { externalValue: ext, mappedValue: mapped } = change;
  const provider = providerLabel(change.provider);
  switch (change.field ?? "status") {
    case "assignee":
      return ext ? `${provider} gives it to ${ext}` : `${provider} unassigned it`;
    case "dueDate":
      if (!ext) return `${provider} cleared its due date`;
      return mapped
        ? `${provider} moved its due date to ${mapped}`
        : `${provider} says it's due “${ext}” — not a date Lucent can read`;
    default:
      return mapped
        ? `${provider} says “${ext}” — mark it ${mapped.replace(/_/g, " ")}`
        : `${provider} says “${ext}” — no matching status here`;
  }
}

/** The row's one-line drift sentence: "Linear says Done — the board says todo". */
export function inboundRowSentence(row: InboundChangeView): string | null {
  if (row.status !== "pending") return null;
  if (row.mappedValue === null) return null; // the warning sentence is separate
  return `${row.externalValue} → ${row.mappedValue} · ${row.boardValue ?? "—"}`;
}
