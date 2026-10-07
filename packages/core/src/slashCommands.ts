/**
 * Slash commands catalog and prompt expansion for Lucent visual workspace.
 * Provides curated, contextual architectural actions (e.g. /decompose, /threat-model).
 */

export type SlashCommandCategory = "architecture" | "security" | "refine" | "transform";

export interface SlashCommandDef {
  /** The command token without slash, e.g. "decompose" */
  id: string;
  /** Full command trigger with slash, e.g. "/decompose" */
  command: string;
  /** Human-readable title, e.g. "Decompose Component" */
  title: string;
  /** Description for autocomplete popover */
  description: string;
  /** Example or argument placeholder, e.g. "/decompose [component or service name]" */
  placeholder: string;
  /** Visual category */
  category: SlashCommandCategory;
  /** Icon identifier */
  icon: "layers" | "shield" | "alert-triangle" | "git-commit" | "minimize" | "globe";
}

export const SLASH_COMMANDS: readonly SlashCommandDef[] = [
  {
    id: "decompose",
    command: "/decompose",
    title: "Decompose Component",
    description:
      "Break a high-level service or process into 3–5 granular sub-steps with connectors",
    placeholder: "/decompose [component or service name]",
    category: "architecture",
    icon: "layers",
  },
  {
    id: "threat-model",
    command: "/threat-model",
    title: "Threat Model & Security Audit",
    description: "Identify security risks, single points of failure, and missing auth boundaries",
    placeholder: "/threat-model [focus area or leave blank for full board]",
    category: "security",
    icon: "shield",
  },
  {
    id: "edge-cases",
    command: "/edge-cases",
    title: "Edge Cases & Error Handling",
    description: "Discover failure states, timeouts, and add decision and retry recovery branches",
    placeholder: "/edge-cases [specific flow or scenario]",
    category: "refine",
    icon: "alert-triangle",
  },
  {
    id: "sequence",
    command: "/sequence",
    title: "Convert to Sequence Flow",
    description: "Transform flowchart steps into an actor-to-actor ordered message sequence",
    placeholder: "/sequence [use case or actors]",
    category: "transform",
    icon: "git-commit",
  },
  {
    id: "simplify",
    command: "/simplify",
    title: "Simplify Architecture",
    description: "Consolidate redundant nodes and group components into clean cohesive subsystems",
    placeholder: "/simplify [subsystem or full board]",
    category: "refine",
    icon: "minimize",
  },
  {
    id: "translate",
    command: "/translate",
    title: "Translate Board",
    description: "Translate all labels and notes to a target language preserving diagram topology",
    placeholder: "/translate [target language, e.g. Spanish, German, Japanese]",
    category: "transform",
    icon: "globe",
  },
];

export interface ParsedSlashCommand {
  command: string;
  args: string;
  raw: string;
  definition?: SlashCommandDef;
}

/**
 * Parses a raw user prompt to check if it begins with a slash command.
 */
export function parseSlashCommand(input: string): ParsedSlashCommand | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return null;
  const match = trimmed.match(/^\/([a-zA-Z0-9_-]+)(?:\s+(.*))?$/s);
  if (!match || !match[1]) return null;
  const command = match[1].toLowerCase();
  const args = (match[2] ?? "").trim();
  const definition = SLASH_COMMANDS.find((c) => c.id === command);
  return {
    command,
    args,
    raw: trimmed,
    ...(definition ? { definition } : {}),
  };
}

/**
 * Filters the slash command catalog for autocomplete suggestions matching a search prefix.
 */
export function filterSlashCommands(query: string): SlashCommandDef[] {
  const q = query.replace(/^\//, "").toLowerCase().trim();
  if (!q) return [...SLASH_COMMANDS];

  // Prioritize command ID prefix matches (e.g. /dec -> decompose)
  const idPrefixMatches = SLASH_COMMANDS.filter((cmd) => cmd.id.startsWith(q));
  if (idPrefixMatches.length > 0) return idPrefixMatches;

  return SLASH_COMMANDS.filter(
    (cmd) =>
      cmd.id.includes(q) ||
      cmd.title.toLowerCase().includes(q) ||
      cmd.description.toLowerCase().includes(q) ||
      cmd.category.includes(q),
  );
}

/**
 * Expands a parsed slash command into an unambiguous, domain-specific prompt instruction
 * that reliably steers the LLM's operation generation.
 */
export function expandSlashCommandPrompt(parsed: ParsedSlashCommand): string {
  switch (parsed.command) {
    case "decompose": {
      const target = parsed.args ? `"${parsed.args}"` : "the selected or central component";
      return `[Mode: Component Decomposition]\nDecompose ${target}: break it down into 3 to 5 granular, connected sub-process nodes showing the detailed internal flow and dependencies. Connect them logically with directed relationships.`;
    }
    case "threat-model": {
      const target = parsed.args ? ` with focus on "${parsed.args}"` : "";
      return `[Mode: Threat Model & Security Audit]\nPerform a STRIDE and security architecture review${target}: identify unauthenticated boundaries, missing encryption/mTLS, rate limiting gaps, and single points of failure. Add explicit risk statement nodes and mitigation nodes with flagged connectors.`;
    }
    case "edge-cases": {
      const target = parsed.args ? ` for "${parsed.args}"` : "";
      return `[Mode: Edge Cases & Error Handling]\nDiscover edge cases and error handling${target}: add decision diamonds, validation checks, timeout/failure branches, and retry recovery nodes to make the flow robust against real-world failures.`;
    }
    case "sequence": {
      const target = parsed.args ? ` for "${parsed.args}"` : "";
      return `[Mode: Sequence Diagram Generation]\nTransform this workflow${target} into an actor-to-actor sequence flow: define participating actors/services and chronological message-passing steps with explicit relationship verbs.`;
    }
    case "simplify": {
      const target = parsed.args ? ` regarding "${parsed.args}"` : "";
      return `[Mode: Architecture Simplification]\nSimplify this architecture${target}: consolidate redundant nodes, eliminate unnecessary intermediate hops, and group related components into clean, cohesive subsystems with clear boundaries.`;
    }
    case "translate": {
      const targetLang = parsed.args || "the requested language";
      return `[Mode: Diagram Translation]\nTranslate all diagram node labels, group titles, and text notes to ${targetLang} while strictly preserving all node IDs, edge relationships, and diagram topology.`;
    }
    default:
      return parsed.raw;
  }
}
