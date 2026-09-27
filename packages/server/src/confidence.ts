/**
 * How well an answer is supported (docs/26 rule 2, ADR 0048): computed from
 * the evidence that survived validation — never the model's own estimate.
 *
 * - `none`: nothing cited survived. The answer is shown as "No evidence".
 * - `low`: one source, or a cited statement has since been superseded or
 *   rejected (the answer may rest on something the team moved past).
 * - `medium`: two sources, or several of one kind (three statements that may
 *   all trace to one conversation).
 * - `high`: three or more sources of at least two kinds — a statement and
 *   the meeting it came from, say — with nothing superseded among them.
 *
 * A count, not a probability: "high" says independent evidence agrees, not
 * that the model read it well.
 */

export type ConfidenceLevel = "none" | "low" | "medium" | "high";

export interface Confidence {
  level: ConfidenceLevel;
  /** Distinct pieces of evidence cited. */
  sources: number;
  /** Distinct kinds among them (statement/node, meeting, revision). */
  kinds: number;
  /** Labels of cited statements that were since superseded or rejected. */
  superseded: string[];
  /** One sentence, for the answer's footer. */
  reason: string;
}

export interface CitedEvidence {
  kind: "node" | "meeting" | "revision";
  /** Unique within its kind (qualified with the board for workspace answers). */
  key: string;
  label: string;
  /** For a node carrying a statement: its lifecycle status. */
  statementStatus?: string;
}

export function answerConfidence(evidence: readonly CitedEvidence[]): Confidence {
  const distinct = new Map<string, CitedEvidence>();
  for (const e of evidence) distinct.set(`${e.kind}:${e.key}`, e);
  const items = [...distinct.values()];
  const sources = items.length;
  const kinds = new Set(items.map((e) => e.kind)).size;
  const superseded = items
    .filter((e) => e.statementStatus === "superseded" || e.statementStatus === "rejected")
    .map((e) => e.label);

  if (sources === 0) {
    return {
      level: "none",
      sources,
      kinds,
      superseded,
      reason: "No evidence: nothing in scope supports this answer.",
    };
  }
  if (superseded.length > 0) {
    return {
      level: "low",
      sources,
      kinds,
      superseded,
      reason: `It cites ${superseded.length === 1 ? "a statement" : "statements"} the team has since moved past.`,
    };
  }
  const level: ConfidenceLevel =
    sources >= 3 && kinds >= 2 ? "high" : sources >= 2 ? "medium" : "low";
  const reason =
    level === "high"
      ? `${sources} sources of ${kinds} kinds agree.`
      : level === "medium"
        ? kinds >= 2
          ? `${sources} sources of different kinds.`
          : `${sources} sources, all of one kind.`
        : "One source.";
  return { level, sources, kinds, superseded, reason };
}
