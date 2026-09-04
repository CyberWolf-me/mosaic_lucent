import type { StatementFields, Workspace } from "@lucent/core";
import type { Operation } from "@lucent/core";
import { canonicalizeTopic, existingTopics, topicsAreVariants } from "@lucent/core";

/**
 * Statement presentation helpers (Stage C2). Pure, node-tested — the web
 * suite runs without a DOM, so everything the chip and the HUD editor decide
 * lives here and the components only lay it out.
 */

/** The six kinds, uppercase for the chip. */
export const STATEMENT_KINDS = [
  "decision",
  "proposal",
  "question",
  "action",
  "requirement",
  "risk",
] as const;

export const STATEMENT_STATUSES = ["open", "resolved", "rejected", "superseded"] as const;

/** The amber family the ✦ provenance affordances established. */
export const KIND_TINT: Record<StatementFields["kind"], string> = {
  decision: "var(--amber-2)",
  proposal: "var(--ink-2)",
  question: "var(--sig-violet)",
  action: "var(--sig-green)",
  requirement: "var(--ink-1)",
  risk: "var(--sig-red)",
};

/**
 * The chip text: kind + status. Resolved/superseded/rejected render dimmed by
 * the caller (via `statementChipDim`); the text itself stays plain so a
 * screen reader reads one token, e.g. "decision · resolved".
 */
export function statementChipText(statement: StatementFields): string {
  return `${statement.kind} · ${statement.status}`;
}

/** A closed lifecycle reads settled — the chip should not shout. */
export function statementChipDim(statement: StatementFields): boolean {
  return statement.status !== "open";
}

/**
 * Build the ops a HUD edit commits. Always through the same validated op the
 * model emits (applyManual → validateOperations), so a bad manual edit is
 * rejected exactly like a bad model op — the review's guardrail for the
 * supersedes field.
 *
 * - No prior statement → SET_STATEMENT (kind required; status defaults open —
 *   a hand-made decision the user didn't mark resolved is honest as open).
 * - Prior statement, same kind → UPDATE_STATEMENT patch (kind is identity).
 * - Prior statement, different kind → SET_STATEMENT replacement (a kind
 *   change is a new statement, visible as its own revision).
 */
export function statementEditOps(
  nodeId: string,
  prior: StatementFields | undefined,
  draft: {
    kind: StatementFields["kind"];
    status: StatementFields["status"];
    topic?: string;
    supersedes?: string[];
  },
): Operation[] {
  if (!prior) {
    return [
      {
        op: "SET_STATEMENT",
        id: nodeId,
        statement: {
          kind: draft.kind,
          status: draft.status,
          ...(draft.topic ? { topic: draft.topic } : {}),
          ...(draft.supersedes?.length ? { supersedes: draft.supersedes } : {}),
        },
      },
    ];
  }
  if (prior.kind === draft.kind) {
    return [
      {
        op: "UPDATE_STATEMENT",
        id: nodeId,
        status: draft.status,
        ...(draft.topic !== undefined
          ? { topic: draft.topic.length > 0 ? draft.topic : null }
          : {}),
        ...(draft.supersedes !== undefined ? { supersedes: draft.supersedes } : {}),
      },
    ];
  }
  return [
    {
      op: "SET_STATEMENT",
      id: nodeId,
      statement: {
        kind: draft.kind,
        status: draft.status,
        // A kind change is a new statement that replaces the old one; the
        // old statement's node keeps its node, so supersedes stays what the
        // draft says rather than auto-linking to itself.
        ...(draft.topic !== undefined && draft.topic.length > 0 ? { topic: draft.topic } : {}),
        ...(draft.supersedes?.length ? { supersedes: draft.supersedes } : {}),
      },
    },
  ];
}

/* -------------------------------------------------------------------------- */
/* Topic suggestions + the duplicate recommendation (Stage C5, ADR 0025)      */
/* -------------------------------------------------------------------------- */

/**
 * The HUD's topic suggestions: the board's existing AUTHORED keys, as the
 * board holds them (never canonicalized — the user should adopt what the
 * board actually says). Offered via datalist, never forced.
 */
export function topicSuggestions(workspace: Workspace): string[] {
  return existingTopics(workspace);
}

/**
 * The rule-3 recommendation at authoring time: does the topic the human is
 * typing look like a duplicate of an existing authored key? Deterministic
 * and evidence-first — the same variant logic the fold uses, applied to
 * IN-PROGRESS human input, where the fold itself is forbidden (rule 2).
 *
 * Returns the evidence-bearing hint when exactly ONE existing key
 * variant-matches the typed value, undefined otherwise: the ambiguity guard
 * applies to recommendations too (a typed value matching two keys is not a
 * duplicate of either), and a value that IS an existing key needs no hint.
 */
export function topicDuplicateHint(
  typed: string,
  workspace: Workspace,
): { existing: string; statements: number } | undefined {
  const value = typed.trim();
  if (!value) return undefined;
  // The typed value AS an existing key is not a duplicate — it IS the key.
  if (existingTopics(workspace).includes(value)) return undefined;
  const matches = existingTopics(workspace)
    .map((topic) => {
      const nodes = Object.values(workspace.nodes).filter(
        (n) => n.statement?.topic === topic,
      );
      return { topic, statements: nodes.length };
    })
    .filter(({ topic }) =>
      topicsAreVariants(canonicalizeTopic(topic), canonicalizeTopic(value)),
    );
  if (matches.length !== 1) return undefined;
  return { existing: matches[0]!.topic, statements: matches[0]!.statements };
}
