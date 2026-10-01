import type { Node, Workspace } from "@lucent/core";
import { canonicalizeTopic, statementNodes, topicsAreVariants } from "@lucent/core";

/**
 * The generation-side memory projection — the "workspace remembers" north star
 * on the WRITE path.
 *
 * PROJECTION, NOT A STORE. Under the same doctrine as askContext (ADR 0021
 * "statements live on nodes", ADR 0023 "cross-meeting memory is a projection
 * over canonical state"), this derives disposable context from the board's
 * canonical state and persists NOTHING. The Ask path already renders a digest
 * like this for read-only Q&A; this is its sibling for generation, so a request
 * like "add the login step" resolves "the login flow" against what the project
 * already decided — and supersedes a settled decision instead of re-deciding
 * it.
 *
 * It runs only on the authoritative path (a stored board the caller owns), so
 * it reads durable SERVER state — not the client's summary, which can be
 * partial or stale. Advisory/anonymous generations get no memory and behave
 * exactly as before.
 *
 * First-party rendering of collaborator-authored strings (labels, topics). The
 * prompt harness escapes the whole block again on interpolation (buildUserPrompt
 * → escapeHarnessTags) — the same defence in depth board-context uses.
 */

const MEMORY_LIMITS = {
  /** Statements listed per kind-grouped section (decisions, requirements, …). */
  perSection: 12,
  label: 80,
  topic: 48,
  /** Supersession chains rendered in the evolution section. */
  evolution: 16,
  /** Distinct topic groups rendered in the glossary. */
  topics: 24,
} as const;

/** A statement is "live" unless history: superseded/rejected ones are the past,
 * surfaced in the evolution section, never listed as current truth. */
function isLive(node: Node): boolean {
  const s = node.statement!.status;
  return s !== "superseded" && s !== "rejected";
}

/** One list line: `- label · topic (id)`, each piece clamped. */
function line(node: Node): string {
  const label = node.label.slice(0, MEMORY_LIMITS.label) || "(untitled)";
  const topic = node.statement!.topic
    ? ` · ${node.statement!.topic.slice(0, MEMORY_LIMITS.topic)}`
    : "";
  return `  - ${label}${topic} (${node.id})`;
}

/** A kind-grouped section, or null when nothing of that kind is live. */
function section(header: string, nodes: Node[]): string | null {
  if (nodes.length === 0) return null;
  const shown = nodes.slice(0, MEMORY_LIMITS.perSection);
  const more = nodes.length > shown.length ? `\n  …and ${nodes.length - shown.length} more` : "";
  return `${header}\n${shown.map(line).join("\n")}${more}`;
}

/**
 * Render the project's accumulated memory for a generation prompt, or null when
 * the board carries no statements worth remembering (so the section is omitted
 * entirely and an empty board reads exactly as it does today).
 *
 * Deliberately a SYNTHESIS, not a re-dump of the node list (board-context
 * already carries that): statements grouped by what they are and whether
 * they're settled, the supersession chain, and a topic glossary — the three
 * things that let the model resolve references and avoid re-litigating settled
 * work.
 */
export function buildMemoryDigest(workspace: Workspace, boardName: string): string | null {
  const statements = statementNodes(workspace);
  if (statements.length === 0) return null;

  const liveOfKind = (kind: string): Node[] =>
    statements.filter((n) => n.statement!.kind === kind && isLive(n));
  const openOfKind = (kind: string): Node[] =>
    statements.filter((n) => n.statement!.kind === kind && n.statement!.status === "open");

  const sections: Array<string | null> = [
    // Decisions are born resolved (ADR 0021); a live decision is settled truth.
    section("Settled decisions (build on these — don't re-decide them):", liveOfKind("decision")),
    section("Requirements (constraints this project must satisfy):", liveOfKind("requirement")),
    section("Open questions (unresolved — don't invent answers):", openOfKind("question")),
    section("Open proposals (floated, not yet decided):", openOfKind("proposal")),
    section("Known risks:", liveOfKind("risk")),
    evolutionSection(workspace),
    topicGlossary(statements),
  ];

  const body = sections.filter((s): s is string => s !== null);
  if (body.length === 0) return null;
  return `Project memory for "${boardName}" — what earlier work on this board already established:\n\n${body.join("\n\n")}`;
}

/**
 * The supersession chain: every statement that replaced another, as one line
 * naming what replaced what — so the model updates the live statement rather
 * than adding a duplicate. Derived purely from the current workspace, same as
 * askContext's evolution section (ADR 0023).
 */
function evolutionSection(workspace: Workspace): string | null {
  const chains = statementNodes(workspace)
    .filter((n) => n.statement!.supersedes?.length)
    .slice(0, MEMORY_LIMITS.evolution)
    .map((n) => {
      const replaced = n
        .statement!.supersedes!.map((id) => {
          const target = workspace.nodes[id];
          const label = target ? target.label.slice(0, MEMORY_LIMITS.label) : `unknown ${id}`;
          return `${label} (${id})`;
        })
        .join(", ");
      return `  - ${n.label.slice(0, MEMORY_LIMITS.label)} (${n.id}) replaced: ${replaced}`;
    });
  if (chains.length === 0) return null;
  return `How decisions changed (newer superseding older — update the live one, don't duplicate):\n${chains.join("\n")}`;
}

/**
 * The topic glossary: statements grouped by topic IDENTITY (canonicalizeTopic
 * normalizes morphology, topicsAreVariants merges related keys), so "the login
 * flow" and "auth" resolve to the same group. This is the reference-resolution
 * seam — the model maps a user's informal name to the ids under its topic.
 */
function topicGlossary(statements: Node[]): string | null {
  const groups: Array<{ key: string; authored: Set<string>; ids: string[] }> = [];
  for (const node of statements) {
    const topic = node.statement!.topic;
    if (!topic || !isLive(node)) continue;
    const key = canonicalizeTopic(topic) || topic;
    let group = groups.find((g) => topicsAreVariants(g.key, key));
    if (!group) {
      if (groups.length >= MEMORY_LIMITS.topics) break;
      group = { key, authored: new Set(), ids: [] };
      groups.push(group);
    }
    group.authored.add(topic);
    group.ids.push(node.id);
  }
  if (groups.length === 0) return null;
  const lines = groups.map((g) => {
    const names = [...g.authored].join(", ");
    return `  - ${names}: ${g.ids.join(", ")}`;
  });
  return `Topics (resolve a named part of the project — "the X" — to these ids):\n${lines.join("\n")}`;
}
