import type { IntegrationPreview } from "../boards.js";

/**
 * The AI-origin preview's decisions (Stage D9), pure so they can be tested
 * without a DOM (the inboundRows precedent). They encode the review's
 * ordering and doctrine:
 *
 * - THE CONCRETE SELECTION COMES FIRST: the ratio line renders before the
 *   rows; the rationale renders AFTER them — the user sees what changed
 *   before they read why.
 * - THE RATIONALE IS A RECOMMENDATION, never board truth (C2/C5): the
 *   label says so, and the quote marks are part of the contract.
 * - THE DROP WARNINGS ARE SEPARATE from the D8 capability warnings: those
 *   ride the items (the provider's fidelity); these ride the preview (the
 *   model's unknown ids, made visible).
 */

/** True when the preview is AI-drafted (the narrowing agent's origin). */
export function isAiPreview(preview: IntegrationPreview | null): boolean {
  return preview?.action.origin === "ai";
}

/** The ratio line's presence + text inputs (4 of 10). */
export function aiSelectionRatio(
  preview: IntegrationPreview | null,
): { selected: number; total: number } | null {
  if (!isAiPreview(preview)) return null;
  const selected = preview!.preview.selectedCount;
  const total = preview!.preview.totalCandidates;
  if (selected === undefined || total === undefined) return null;
  return { selected, total };
}

/** The rationale block: the explanation + the request that produced it. */
export function aiRationale(
  preview: IntegrationPreview | null,
): { explanation: string; request?: string } | null {
  if (!isAiPreview(preview)) return null;
  const explanation = preview!.preview.explanation;
  if (!explanation) return null;
  const request = preview!.action.provenance?.request;
  return { explanation, ...(request ? { request } : {}) };
}

/** The drop warnings (the model's unknown ids) — present when non-empty. */
export function aiDropWarnings(preview: IntegrationPreview | null): string[] {
  return preview?.preview.warnings ?? [];
}
