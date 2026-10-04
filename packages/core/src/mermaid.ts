import type { DiagramKind, NodeDetails, Workspace } from "./model.js";
import { clampNodeDetails, type Operation } from "./operations.js";

/**
 * Mermaid interop (docs/08 "basic integrations"; docs/27 D2).
 *
 * Mermaid is the lingua franca for diagrams-as-text: GitHub, GitLab, Notion and
 * Obsidian render it inline, and Miro standardised on it for agents. Exporting
 * means a Lucent board can be pasted into a README or a ticket; importing means
 * a diagram already in a repo lands as real semantic nodes — never as a
 * picture.
 *
 * Four flavours, each onto the Lucent kind that means the same thing:
 *
 *   flowchart / graph   → flowchart (top-down) or process (left-right)
 *   stateDiagram(-v2)   → statemachine, with [*] as start/end pseudo-states and
 *                         a state's `X : description` lines as its details
 *   mindmap             → mindmap, the indentation tree as branch edges
 *   classDiagram        → class, members as Attributes/Operations details and
 *                         the UML arrows as inherits/implements/composition/…
 *
 * Pure string <-> operation transforms: testable without a DOM, usable by the
 * web app and the MCP server alike, and landing through the same validated
 * operation contract as everything else. What isn't semantic (styling, click
 * handlers, notes) is skipped and counted, never guessed at.
 */

export type MermaidFlavor = "flowchart" | "state" | "mindmap" | "class";

export interface MermaidGraph {
  flavor: MermaidFlavor;
  /** The Lucent kind this flavour and direction mean. */
  kind: DiagramKind;
  /** From YAML front matter (`title: …`), when the source has one. */
  title?: string;
  direction: "TD" | "LR";
  nodes: Array<{
    id: string;
    label: string;
    nodeType: string;
    groupId?: string;
    /** A state's descriptions, a class's members — already within NODE_DETAILS_LIMITS. */
    details?: NodeDetails;
  }>;
  edges: Array<{ source: string; target: string; relationship: string }>;
  groups: Array<{ id: string; label: string }>;
  /** Recognised lines that carry no meaning Lucent keeps (styles, notes, clicks). */
  skipped: number;
}

export const MERMAID_LIMITS = { nodes: 500, edges: 1000, label: 200 } as const;

const DEFAULT_TITLE: Record<MermaidFlavor, string> = {
  flowchart: "Imported flowchart",
  state: "Imported state machine",
  mindmap: "Imported mind map",
  class: "Imported class diagram",
};

// ---------------------------------------------------------------------------
// Source cleanup
// ---------------------------------------------------------------------------

/**
 * The diagram text itself: a ```mermaid fence unwrapped (people copy from
 * READMEs), front matter lifted off (its title kept), init directives and
 * comments dropped. Line structure is preserved for the indentation-based
 * mind map.
 */
function prepare(text: string): { lines: string[]; title?: string } {
  let body = text.replace(/\r\n?/g, "\n");
  const fence = /```\s*mermaid[^\n]*\n([\s\S]*?)```/i.exec(body);
  if (fence) body = fence[1]!;
  let title: string | undefined;
  const front = /^\s*---\n([\s\S]*?)\n---\s*\n/.exec(body);
  if (front) {
    const t = /^\s*title\s*:\s*(.+)$/m.exec(front[1]!);
    if (t) title = clean(t[1]!.replace(/^["']|["']$/g, ""));
    body = body.slice(front[0].length);
  }
  const lines = body
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .filter((l) => {
      const t = l.trim();
      return t !== "" && !t.startsWith("%%");
    });
  return { lines, ...(title ? { title } : {}) };
}

// Mermaid keywords are lowercase and own their line — so prose that merely
// starts with "Graph" or "Flowchart" is never mistaken for a diagram.
const FLOW_HEADER = /^(?:flowchart|graph)(?:\s+(TD|TB|LR|RL|BT))?\s*(?:;|$)/;

/** Which Mermaid flavour this text is, or null when it isn't one we import. */
export function detectMermaid(text: string): MermaidFlavor | null {
  const first = prepare(text).lines[0]?.trim() ?? "";
  if (FLOW_HEADER.test(first)) return "flowchart";
  if (/^stateDiagram(-v2)?\s*$/.test(first)) return "state";
  if (/^mindmap\s*$/.test(first)) return "mindmap";
  if (/^classDiagram(-v2)?\s*$/.test(first)) return "class";
  return null;
}

/** Label text as a person reads it: entities decoded, markup and breaks flattened. */
function clean(raw: string): string {
  return raw
    .replace(/#quot;/g, '"')
    .replace(/#amp;/g, "&")
    .replace(/#lt;/g, "<")
    .replace(/#gt;/g, ">")
    .replace(/#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/?[a-z][^>]*>/gi, "")
    .replace(/`/g, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MERMAID_LIMITS.label);
}

const unquote = (s: string) => s.trim().replace(/^"([\s\S]*)"$/, "$1");

// ---------------------------------------------------------------------------
// Flowchart
// ---------------------------------------------------------------------------

// Ids: letters, digits, underscores; an inner hyphen only when a word follows
// (so `api-gateway` is one id but `A---B` is a link).
const ID_RE = /^[\p{L}\p{N}_]+(?:-(?=[\p{L}\p{N}_])[\p{L}\p{N}_]+)*/u;

/** Bracket shapes, longest opener first; each maps to the node type it means. */
const SHAPES: Array<{ open: string; close: string[]; type: string }> = [
  { open: "(((", close: [")))"], type: "end" },
  { open: "([", close: ["])"], type: "start" },
  { open: "[[", close: ["]]"], type: "step" },
  { open: "[(", close: [")]"], type: "database" },
  { open: "((", close: ["))"], type: "actor" },
  { open: "{{", close: ["}}"], type: "step" },
  { open: "[/", close: ["/]", "\\]"], type: "data" },
  { open: "[\\", close: ["\\]", "/]"], type: "data" },
  { open: "{", close: ["}"], type: "decision" },
  { open: "[", close: ["]"], type: "step" },
  { open: "(", close: [")"], type: "step" },
  { open: ">", close: ["]"], type: "step" },
];

/** v11 `@{ shape: … }` names onto node types. */
function typeForShapeName(name: string): string {
  const n = name.toLowerCase();
  if (/^(diam|diamond|decision|question)$/.test(n)) return "decision";
  if (/^(cyl|cylinder|db|database|das|lin-cyl|h-cyl)$/.test(n)) return "database";
  if (/^(stadium|pill|terminal|start|sm-circ|small-circle)$/.test(n)) return "start";
  if (/^(stop|dbl-circ|double-circle|fr-circ|framed-circle)$/.test(n)) return "end";
  if (/^(circle|circ)$/.test(n)) return "actor";
  if (/^(lean-r|lean-l|in-out|out-in|lean-right|lean-left)$/.test(n)) return "data";
  return "step";
}

interface Ref {
  id: string;
  label?: string;
  nodeType?: string;
}

class Scanner {
  constructor(
    readonly s: string,
    public i = 0,
  ) {}
  ws(): void {
    while (this.i < this.s.length && /\s/.test(this.s[this.i]!)) this.i++;
  }
  done(): boolean {
    this.ws();
    return this.i >= this.s.length;
  }
  rest(): string {
    return this.s.slice(this.i);
  }
}

function readShape(sc: Scanner): { label: string; nodeType: string } | null {
  const rest = sc.rest();
  // v11: A@{ shape: diam, label: "Ready?" }
  if (rest.startsWith("@{")) {
    const end = rest.indexOf("}");
    if (end < 0) return null;
    const body = rest.slice(2, end);
    sc.i += end + 1;
    const shape = /shape\s*:\s*([\w-]+)/.exec(body)?.[1] ?? "rect";
    const label = /label\s*:\s*("(?:[^"]*)"|[^,}]+)/.exec(body)?.[1];
    return { label: label ? clean(unquote(label)) : "", nodeType: typeForShapeName(shape) };
  }
  const shape = SHAPES.find((s) => rest.startsWith(s.open));
  if (!shape) return null;
  let j = shape.open.length;
  while (j < rest.length && rest[j] === " ") j++;
  let label: string;
  let after: number;
  if (rest[j] === '"') {
    // A quoted label may contain brackets; it ends at its closing quote.
    const q = rest.indexOf('"', j + 1);
    if (q < 0) return null;
    label = rest.slice(j + 1, q);
    after = q + 1;
    while (after < rest.length && rest[after] === " ") after++;
    const close = shape.close.find((c) => rest.startsWith(c, after));
    if (!close) return null;
    after += close.length;
  } else {
    let best = -1;
    let closeLen = 0;
    for (const c of shape.close) {
      const k = rest.indexOf(c, j);
      if (k >= 0 && (best < 0 || k < best)) {
        best = k;
        closeLen = c.length;
      }
    }
    if (best < 0) return null;
    label = rest.slice(j, best);
    after = best + closeLen;
  }
  sc.i += after;
  return { label: clean(label), nodeType: shape.type };
}

function readRef(sc: Scanner): Ref | null {
  sc.ws();
  const m = ID_RE.exec(sc.rest());
  if (!m) return null;
  sc.i += m[0].length;
  const ref: Ref = { id: m[0] };
  const shape = readShape(sc);
  if (shape) {
    if (shape.label) ref.label = shape.label;
    ref.nodeType = shape.nodeType;
  }
  // `:::className` styling rides on the node; it carries no meaning here.
  const cls = /^:::[\w-]+/.exec(sc.rest());
  if (cls) sc.i += cls[0].length;
  return ref;
}

function readGroup(sc: Scanner): Ref[] | null {
  const first = readRef(sc);
  if (!first) return null;
  const refs = [first];
  for (;;) {
    const save = sc.i;
    sc.ws();
    if (sc.s[sc.i] !== "&") {
      sc.i = save;
      break;
    }
    sc.i++;
    const next = readRef(sc);
    if (!next) {
      sc.i = save;
      break;
    }
    refs.push(next);
  }
  return refs;
}

const LINK_PLAIN =
  /^<?(?:-{2,}>|-{3,}|={2,}>|={3,}|-\.+->|-\.+-|-{2,}[ox](?![\p{L}\p{N}_])|={2,}[ox](?![\p{L}\p{N}_])|~{3,})/u;
const LINK_TEXT =
  /^<?(--|==|-\.)\s*("[^"]*"|[^-=.|>][^|]*?)\s*(-{2,}>|-{3,}|={2,}>|={3,}|\.-*->|\.-+)/;

function readLink(sc: Scanner): { label: string } | null {
  sc.ws();
  const rest = sc.rest();
  const plain = LINK_PLAIN.exec(rest);
  if (plain) {
    sc.i += plain[0].length;
    const pipe = /^\s*\|([^|]*)\|/.exec(sc.rest());
    if (pipe) {
      sc.i += pipe[0].length;
      return { label: clean(unquote(pipe[1]!)) };
    }
    return { label: "" };
  }
  const text = LINK_TEXT.exec(rest);
  if (text) {
    sc.i += text[0].length;
    return { label: clean(unquote(text[2]!)) };
  }
  return null;
}

/** Split `a --> b; c --> d` into statements, respecting quoted labels. */
function statements(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    if (ch === ";" && !quoted) {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const FLOW_SKIP = /^(classDef|class|style|linkStyle|click|direction|accTitle|accDescr|title)\b/;

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "_")
      .replace(/^_+|_+$/g, "") || "group"
  );
}

function parseFlowchart(lines: string[]): MermaidGraph {
  const nodes = new Map<
    string,
    { id: string; label: string; nodeType: string; groupId?: string }
  >();
  const edges: MermaidGraph["edges"] = [];
  const groups: MermaidGraph["groups"] = [];
  const stack: string[] = [];
  let direction: "TD" | "LR" = "TD";
  let skipped = 0;

  const declare = (ref: Ref, standalone: boolean) => {
    const group = stack[stack.length - 1];
    const existing = nodes.get(ref.id);
    if (existing) {
      if (ref.label) existing.label = ref.label;
      if (ref.nodeType && existing.nodeType === "step") existing.nodeType = ref.nodeType;
      // Listing a node inside a subgraph moves it there (Mermaid's rule).
      if (standalone && group) existing.groupId = group;
      return;
    }
    nodes.set(ref.id, {
      id: ref.id,
      label: ref.label ?? ref.id,
      nodeType: ref.nodeType ?? "step",
      ...(group ? { groupId: group } : {}),
    });
  };

  for (const [n, raw] of lines.entries()) {
    let line = raw.trim();
    if (n === 0) {
      // The header may carry statements after it: `graph LR; A-->B; B-->C`.
      const header = FLOW_HEADER.exec(line);
      const d = header?.[1];
      direction = d === "LR" || d === "RL" ? "LR" : "TD";
      line = header ? line.slice(header[0].length).trim() : "";
      if (!line) continue;
    }
    const sub = /^subgraph\s+(.+)$/i.exec(line);
    if (sub) {
      const rest = sub[1]!.trim();
      const withLabel = /^([\p{L}\p{N}_-]+)\s*\[(.*)\]$/u.exec(rest);
      let id: string;
      let label: string;
      if (withLabel) {
        id = withLabel[1]!;
        label = clean(unquote(withLabel[2]!)) || id;
      } else if (/^"[^"]*"$/.test(rest)) {
        label = clean(unquote(rest));
        id = slug(label);
      } else if (/^[\p{L}\p{N}_-]+$/u.test(rest)) {
        id = label = rest;
      } else {
        label = clean(rest);
        id = slug(label);
      }
      if (!groups.some((g) => g.id === id)) groups.push({ id, label });
      stack.push(id);
      continue;
    }
    if (/^end$/i.test(line)) {
      stack.pop();
      continue;
    }
    if (FLOW_SKIP.test(line)) {
      skipped++;
      continue;
    }
    for (const stmt of statements(line)) {
      const sc = new Scanner(stmt);
      const first = readGroup(sc);
      if (!first) {
        skipped++;
        continue;
      }
      let left = first;
      let linked = false;
      for (;;) {
        if (sc.done()) break;
        const link = readLink(sc);
        if (!link) break;
        const right = readGroup(sc);
        if (!right) break;
        for (const r of [...left, ...right]) declare(r, false);
        for (const a of left)
          for (const b of right)
            edges.push({ source: a.id, target: b.id, relationship: link.label || "next" });
        linked = true;
        left = right;
      }
      if (!linked) for (const r of first) declare(r, true);
    }
  }
  return {
    flavor: "flowchart",
    kind: direction === "LR" ? "process" : "flowchart",
    direction,
    nodes: [...nodes.values()],
    edges,
    groups,
    skipped,
  };
}

// ---------------------------------------------------------------------------
// State diagram
// ---------------------------------------------------------------------------

const STATE_ID = "[\\p{L}\\p{N}_][\\p{L}\\p{N}_.-]*";
const STATE_REF = `(\\[\\*\\]|${STATE_ID})`;
const TRANSITION = new RegExp(`^${STATE_REF}\\s*-->\\s*${STATE_REF}\\s*(?::\\s*(.*))?$`, "u");
const STATE_ALIAS = new RegExp(`^state\\s+"([^"]*)"\\s+as\\s+(${STATE_ID})\\s*(\\{)?$`, "u");
const STATE_DECL = new RegExp(
  `^state\\s+(${STATE_ID})\\s*(<<\\s*(choice|fork|join)\\s*>>)?\\s*(\\{)?$`,
  "u",
);
const STATE_DESC = new RegExp(`^(${STATE_ID})\\s*:\\s*(.+)$`, "u");

function parseState(lines: string[]): MermaidGraph {
  const nodes = new Map<
    string,
    { id: string; label: string; nodeType: string; groupId?: string; details?: NodeDetails }
  >();
  const edges: MermaidGraph["edges"] = [];
  const composites = new Map<string, { id: string; label: string }>();
  // `Draft : being written` — a state's description lines, in order. Mermaid
  // stacks repeated ones under the name, which is exactly one details section.
  const descriptions = new Map<string, string[]>();
  const stack: string[] = [];
  let direction: "TD" | "LR" = "TD";
  let skipped = 0;
  let inNote = false;

  const scope = () => stack[stack.length - 1];
  const declare = (id: string, label?: string, nodeType?: string) => {
    const existing = nodes.get(id);
    if (existing) {
      if (label) existing.label = label;
      if (nodeType) existing.nodeType = nodeType;
      return;
    }
    const s = scope();
    nodes.set(id, {
      id,
      label: label ?? id,
      nodeType: nodeType ?? "state",
      ...(s ? { groupId: s } : {}),
    });
  };
  // `[*] --> First` then `state First { … }` (the order Mermaid's own docs
  // use): the plain state the transition declared becomes the composite.
  const openComposite = (id: string, label: string) => {
    const early = nodes.get(id);
    if (early && early.nodeType === "state" && early.label === id) nodes.delete(id);
    composites.set(id, { id, label });
    stack.push(id);
  };
  // [*] is the scope's own start (as a source) or end (as a target).
  const pseudo = (ref: string, role: "start" | "end"): string => {
    if (ref !== "[*]") {
      if (!composites.has(ref)) declare(ref);
      return ref;
    }
    const s = scope();
    const id = `${s ? `${s}__` : ""}${role}`;
    declare(id, role === "start" ? "Start" : "End", role);
    return id;
  };

  for (const [n, raw] of lines.entries()) {
    const line = raw.trim();
    if (n === 0) continue;
    if (inNote) {
      if (/^end\s+note$/i.test(line)) inNote = false;
      continue;
    }
    if (/^note\b/i.test(line)) {
      skipped++;
      if (!line.includes(":")) inNote = true;
      continue;
    }
    const dir = /^direction\s+(TD|TB|LR|RL|BT)$/i.exec(line);
    if (dir) {
      if (stack.length === 0) direction = /^(LR|RL)$/i.test(dir[1]!) ? "LR" : "TD";
      continue;
    }
    if (line === "}") {
      stack.pop();
      continue;
    }
    const t = TRANSITION.exec(line);
    if (t) {
      const source = pseudo(t[1]!, "start");
      const target = pseudo(t[2]!, "end");
      edges.push({ source, target, relationship: clean(t[3] ?? "") });
      continue;
    }
    const alias = STATE_ALIAS.exec(line);
    if (alias) {
      const [, label, id, open] = alias;
      if (open) openComposite(id!, clean(label!) || id!);
      else declare(id!, clean(label!) || id!);
      continue;
    }
    const decl = STATE_DECL.exec(line);
    if (decl) {
      const [, id, , stereo, open] = decl;
      if (open) openComposite(id!, id!);
      else if (stereo === "choice") declare(id!, undefined, "decision");
      else if (stereo) declare(id!, stereo === "fork" ? "fork" : "join", "parallel");
      else declare(id!);
      continue;
    }
    const desc = STATE_DESC.exec(line);
    if (desc) {
      // A state's description is its details (V4) — the text Mermaid draws
      // under the state's name, which is where the card draws details. A
      // composite is a group, not a node, so its prose has nowhere to go.
      const id = desc[1]!;
      const text = clean(desc[2]!);
      if (composites.has(id) || !text) {
        skipped++;
        continue;
      }
      declare(id);
      descriptions.set(id, [...(descriptions.get(id) ?? []), text]);
      continue;
    }
    if (/^(--|classDef|class|style|click|accTitle|accDescr)\b/.test(line) || line.includes(":::")) {
      skipped++;
      continue;
    }
    const bare = new RegExp(`^${STATE_ID}$`, "u").exec(line);
    if (bare) declare(bare[0]);
    else skipped++;
  }

  // A transition into a composite state enters at its start; one out of it
  // leaves from its end. Groups can't be edge endpoints in Lucent, so the
  // composite's own pseudo-states stand in — or its first / last member.
  const members = (c: string) => [...nodes.values()].filter((x) => x.groupId === c);
  const resolve = (id: string, as: "source" | "target"): string | null => {
    if (!composites.has(id) || nodes.has(id)) return id;
    const inside = members(id);
    if (inside.length === 0) return null;
    const pick = as === "target" ? `${id}__start` : `${id}__end`;
    if (nodes.has(pick)) return pick;
    return as === "target" ? inside[0]!.id : inside[inside.length - 1]!.id;
  };
  const resolved: MermaidGraph["edges"] = [];
  for (const e of edges) {
    const source = resolve(e.source, "source");
    const target = resolve(e.target, "target");
    if (!source || !target) {
      skipped++;
      continue;
    }
    resolved.push({ source, target, relationship: e.relationship });
  }
  // A composite nothing ended up inside is just a state.
  for (const c of composites.values()) {
    if (members(c.id).length === 0 && !nodes.has(c.id)) {
      nodes.set(c.id, { id: c.id, label: c.label, nodeType: "state" });
    }
  }
  for (const [id, items] of descriptions) {
    const node = nodes.get(id);
    const details = clampNodeDetails([{ items }]);
    if (node && details) node.details = details;
  }
  const groups = [...composites.values()].filter((c) => members(c.id).length > 0);
  return {
    flavor: "state",
    kind: "statemachine",
    direction,
    nodes: [...nodes.values()],
    edges: resolved,
    groups,
    skipped,
  };
}

// ---------------------------------------------------------------------------
// Mind map
// ---------------------------------------------------------------------------

// `id(label)` needs the shape glued to the id: "Tools (dev)" is plain text.
const MIND_SHAPE =
  /^([\p{L}\p{N}_-]*)(\(\(|\)\)|\{\{|\(|\)|\[)([\s\S]*?)(\)\)|\(\(|\}\}|\)|\(|\])$/u;

function parseMindmap(lines: string[]): MermaidGraph {
  const nodes: MermaidGraph["nodes"] = [];
  const edges: MermaidGraph["edges"] = [];
  const stack: Array<{ indent: number; id: string }> = [];
  const used = new Set<string>();
  let skipped = 0;
  let counter = 0;

  for (const [n, raw] of lines.entries()) {
    if (n === 0) continue;
    const indent = raw.replace(/\t/g, "    ").search(/\S/);
    let content = raw.trim();
    if (/^::icon\(/.test(content)) {
      skipped++;
      continue;
    }
    content = content.replace(/:::[\w\s-]+$/, "").trim();
    let id: string | undefined;
    let label = content;
    const shaped = MIND_SHAPE.exec(content);
    if (shaped) {
      id = shaped[1] || undefined;
      label = shaped[3]!;
    }
    label = clean(unquote(label));
    if (!label) continue;
    if (!id || used.has(id)) {
      do id = `m${++counter}`;
      while (used.has(id));
    }
    used.add(id);
    while (stack.length && stack[stack.length - 1]!.indent >= indent) stack.pop();
    const parent = stack[stack.length - 1];
    nodes.push({ id, label, nodeType: "idea" });
    if (parent) edges.push({ source: parent.id, target: id, relationship: "branch" });
    stack.push({ indent, id });
  }
  return { flavor: "mindmap", kind: "mindmap", direction: "TD", nodes, edges, groups: [], skipped };
}

// ---------------------------------------------------------------------------
// Class diagram
// ---------------------------------------------------------------------------

// A class name: a word, or `backticked words`; generics ride as ~T~.
const CLASS_NAME = "(`[^`]+`|[\\p{L}\\p{N}_]+)(?:~([^~]+)~)?";
// The UML arrows: an optional end marker, a solid (--) or dashed (..) line,
// an optional end marker. Markers: <| |> triangle, * diamond, o hollow
// diamond, < > plain head.
const CLASS_ARROW = "((?:<\\||<|\\*|o)?(?:--|\\.\\.)(?:\\|>|>|\\*|o)?)";
const CLASS_RELATION = new RegExp(
  `^${CLASS_NAME}\\s*(?:"[^"]*"\\s*)?${CLASS_ARROW}\\s*(?:"[^"]*"\\s*)?${CLASS_NAME}\\s*(?::\\s*(.*))?$`,
  "u",
);
const CLASS_DECL = new RegExp(
  `^class\\s+${CLASS_NAME}(?:\\s*\\["([^"]*)"\\])?(?::::[\\w-]+)?\\s*(\\{)?\\s*$`,
  "u",
);
const CLASS_MEMBER = new RegExp(`^${CLASS_NAME}\\s*:\\s*(.+)$`, "u");
const CLASS_ANNOTATION = new RegExp(`^<<\\s*([\\w-]+)\\s*>>\\s*${CLASS_NAME}\\s*$`, "u");

/**
 * clean(), keeping Mermaid's ~T~ generics as <T>: clean() drops anything
 * tag-shaped, which `List<int>` is, so the brackets travel as placeholders.
 */
const cleanGeneric = (s: string) =>
  clean(s.replace(/~([^~]+)~/g, "‹$1›")).replace(/‹([^›]*)›/g, "<$1>");

const CLASS_SKIP = /^(note|classDef|cssClass|style|click|callback|link|accTitle|accDescr|title)\b/;

/** A stereotype onto the class family's node types; others stay "class". */
function classTypeFor(stereotype: string): string | undefined {
  const s = stereotype.toLowerCase();
  if (s === "interface") return "interface";
  if (s === "abstract") return "abstract";
  if (s === "enumeration" || s === "enum") return "enum";
  return undefined;
}

/**
 * A UML arrow read as the class family's vocabulary (representations.ts:
 * inherits, implements, composition, aggregation, association, depends) and
 * the direction the Lucent edge runs: the child → its parent, the implementer
 * → its interface, the whole → its part, the dependent → what it needs.
 * `reverse` means the right-hand name is the edge's source.
 */
function classRelation(arrow: string): { relationship: string; reverse: boolean } {
  const dashed = arrow.includes("..");
  if (arrow.startsWith("<|"))
    return { relationship: dashed ? "implements" : "inherits", reverse: true };
  if (arrow.endsWith("|>"))
    return { relationship: dashed ? "implements" : "inherits", reverse: false };
  if (arrow.startsWith("*")) return { relationship: "composition", reverse: false };
  if (arrow.endsWith("*")) return { relationship: "composition", reverse: true };
  if (arrow.startsWith("o")) return { relationship: "aggregation", reverse: false };
  if (arrow.endsWith("o")) return { relationship: "aggregation", reverse: true };
  const relationship = dashed ? "depends" : "association";
  return { relationship, reverse: arrow.startsWith("<") };
}

function parseClass(lines: string[]): MermaidGraph {
  const nodes = new Map<
    string,
    { id: string; label: string; nodeType: string; groupId?: string; details?: NodeDetails }
  >();
  const members = new Map<string, string[]>();
  const edges: MermaidGraph["edges"] = [];
  const groups: MermaidGraph["groups"] = [];
  // What each open `{` belongs to: a namespace (a group) or a class body.
  const blocks: Array<{ type: "namespace" | "class"; id: string }> = [];
  let direction: "TD" | "LR" = "TD";
  let skipped = 0;

  const nameOf = (raw: string, generic?: string) => {
    const base = raw.replace(/^`|`$/g, "");
    return { id: base, label: cleanGeneric(generic ? `${base}~${generic}~` : base) || base };
  };
  const namespace = () => [...blocks].reverse().find((b) => b.type === "namespace")?.id;
  const declare = (raw: string, generic?: string, label?: string, standalone = false) => {
    const name = nameOf(raw, generic);
    const group = namespace();
    const existing = nodes.get(name.id);
    if (existing) {
      if (label) existing.label = label;
      else if (generic && existing.label === name.id) existing.label = name.label;
      // A `class X` inside a namespace puts X there, wherever a relation
      // first mentioned it (Mermaid's rule, as for flowchart subgraphs).
      if (standalone && group) existing.groupId = group;
      return existing;
    }
    const node = {
      id: name.id,
      label: label || name.label,
      nodeType: "class",
      ...(group ? { groupId: group } : {}),
    };
    nodes.set(name.id, node);
    return node;
  };
  const stereotype = (id: string, s: string) => {
    const type = classTypeFor(s);
    const node = nodes.get(id);
    if (type && node) node.nodeType = type;
  };
  // Members keep Mermaid's own UML notation ("+save(): void").
  const addMember = (id: string, raw: string) => {
    const text = cleanGeneric(raw);
    if (text) members.set(id, [...(members.get(id) ?? []), text]);
  };

  for (const [n, raw] of lines.entries()) {
    const line = raw.trim();
    if (n === 0) continue;
    const body = blocks[blocks.length - 1];
    if (line === "}") {
      blocks.pop();
      continue;
    }
    if (body?.type === "class") {
      const st = /^<<\s*([\w-]+)\s*>>$/.exec(line);
      if (st) stereotype(body.id, st[1]!);
      else addMember(body.id, line);
      continue;
    }
    const dir = /^direction\s+(TD|TB|LR|RL|BT)$/i.exec(line);
    if (dir) {
      direction = /^(LR|RL)$/i.test(dir[1]!) ? "LR" : "TD";
      continue;
    }
    if (CLASS_SKIP.test(line)) {
      skipped++;
      continue;
    }
    const ns = /^namespace\s+([\p{L}\p{N}_.-]+)\s*\{$/u.exec(line);
    if (ns) {
      const id = ns[1]!;
      if (!groups.some((g) => g.id === id)) groups.push({ id, label: id });
      blocks.push({ type: "namespace", id });
      continue;
    }
    const decl = CLASS_DECL.exec(line);
    if (decl) {
      const [, raw, generic, label, open] = decl;
      const node = declare(raw!, generic, label ? clean(label) : undefined, true);
      if (open) blocks.push({ type: "class", id: node.id });
      continue;
    }
    const rel = CLASS_RELATION.exec(line);
    if (rel) {
      const [, a, aGeneric, arrow, b, bGeneric, label] = rel;
      const left = declare(a!, aGeneric).id;
      const right = declare(b!, bGeneric).id;
      const { relationship, reverse } = classRelation(arrow!);
      // An association's name is what it is ("places"); the other kinds keep
      // their UML word, which is what the class lens draws the arrowhead from.
      const named = relationship === "association" && label ? clean(label) : "";
      edges.push({
        source: reverse ? right : left,
        target: reverse ? left : right,
        relationship: named || relationship,
      });
      continue;
    }
    const annotation = CLASS_ANNOTATION.exec(line);
    if (annotation) {
      const node = declare(annotation[2]!, annotation[3]);
      stereotype(node.id, annotation[1]!);
      continue;
    }
    const member = CLASS_MEMBER.exec(line);
    if (member) {
      const node = declare(member[1]!, member[2]);
      addMember(node.id, member[3]!);
      continue;
    }
    // Notes, styling, links and callbacks carry no class semantics.
    skipped++;
  }

  // A member with a parameter list is an operation; anything else an
  // attribute (an enum's are its values) — UML's two compartments.
  for (const [id, items] of members) {
    const node = nodes.get(id);
    if (!node) continue;
    const ops = items.filter((m) => m.includes("("));
    const attrs = items.filter((m) => !m.includes("("));
    const details = clampNodeDetails([
      ...(attrs.length
        ? [{ title: node.nodeType === "enum" ? "Values" : "Attributes", items: attrs }]
        : []),
      ...(ops.length ? [{ title: "Operations", items: ops }] : []),
    ]);
    if (details) node.details = details;
  }
  const used = new Set([...nodes.values()].map((x) => x.groupId).filter(Boolean));
  return {
    flavor: "class",
    kind: "class",
    direction,
    nodes: [...nodes.values()],
    edges,
    groups: groups.filter((g) => used.has(g.id)),
    skipped,
  };
}

// ---------------------------------------------------------------------------
// Public: parse and convert
// ---------------------------------------------------------------------------

/**
 * Parse Mermaid text into semantic pieces. Text that isn't a flavour we import
 * yields an empty flowchart graph, and the caller reports that nothing was
 * found.
 */
export function parseMermaid(text: string): MermaidGraph {
  const { lines, title } = prepare(text);
  const flavor = detectMermaid(text);
  const graph =
    flavor === "state"
      ? parseState(lines)
      : flavor === "mindmap"
        ? parseMindmap(lines)
        : flavor === "class"
          ? parseClass(lines)
          : flavor === "flowchart"
            ? parseFlowchart(lines)
            : {
                flavor: "flowchart" as const,
                kind: "flowchart" as const,
                direction: "TD" as const,
                nodes: [],
                edges: [],
                groups: [],
                skipped: 0,
              };
  // One edge per (source, target, relationship); no self-loops (the
  // validator refuses them — a state's self-transition is dropped, counted).
  const seen = new Set<string>();
  const edges = graph.edges.filter((e) => {
    const key = `${e.source}\u0000${e.target}\u0000${e.relationship}`;
    if (e.source === e.target || seen.has(key)) {
      if (e.source === e.target) graph.skipped++;
      return false;
    }
    seen.add(key);
    return true;
  });
  return { ...graph, edges, ...(title ? { title } : {}) };
}

export interface MermaidImportOptions {
  /**
   * Prefix every id (`<prefix>-<id>`), so importing twice — or onto a board
   * that already has an `A` — can't collide.
   */
  idPrefix?: string;
  /**
   * Land the diagram as a region (a group with its own kind) instead of
   * switching the whole board's kind — for importing onto a board that
   * already has content. Subgraphs / composite states flatten into it:
   * region membership is the node's one group.
   */
  region?: { id: string; label?: string };
}

/**
 * Convert Mermaid text into operations: the kind (or region) first, then
 * groups, nodes and edges, so the batch passes validation in order. Empty
 * when the text holds no diagram we import. Capped at MERMAID_LIMITS.
 */
export function mermaidToOps(text: string, options: MermaidImportOptions = {}): Operation[] {
  const graph = parseMermaid(text);
  if (graph.nodes.length === 0) return [];

  // Ids the reducer and every renderer accept, unique after cleaning.
  const ids = new Map<string, string>();
  const taken = new Set<string>();
  const idFor = (raw: string): string => {
    const known = ids.get(raw);
    if (known) return known;
    const base = raw.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 60) || "n";
    let id = options.idPrefix ? `${options.idPrefix}-${base}` : base;
    for (let k = 2; taken.has(id); k++)
      id = `${options.idPrefix ? `${options.idPrefix}-` : ""}${base}_${k}`;
    taken.add(id);
    ids.set(raw, id);
    return id;
  };

  const nodes = graph.nodes.slice(0, MERMAID_LIMITS.nodes);
  const kept = new Set(nodes.map((n) => n.id));
  const edges = graph.edges
    .filter((e) => kept.has(e.source) && kept.has(e.target))
    .slice(0, MERMAID_LIMITS.edges);

  // Node ids first, so a subgraph named like a node renames the group.
  for (const n of nodes) idFor(n.id);
  const ops: Operation[] = [];
  if (options.region) {
    const region = options.region.id;
    ops.push({
      op: "CREATE_GROUP",
      id: region,
      label: options.region.label ?? graph.title ?? DEFAULT_TITLE[graph.flavor],
      children: [],
      kind: graph.kind,
    });
    for (const n of nodes)
      ops.push({
        op: "CREATE_NODE",
        id: idFor(n.id),
        nodeType: n.nodeType,
        label: n.label,
        groupId: region,
        ...(n.details ? { details: n.details } : {}),
      });
  } else {
    ops.push({ op: "CREATE_DIAGRAM", kind: graph.kind });
    const used = new Set(nodes.map((n) => n.groupId).filter((g): g is string => Boolean(g)));
    const groupIds = new Map<string, string>();
    for (const g of graph.groups) {
      if (!used.has(g.id)) continue;
      const id = idFor(ids.has(g.id) ? `${g.id}_group` : g.id);
      groupIds.set(g.id, id);
      ops.push({ op: "CREATE_GROUP", id, label: g.label, children: [] });
    }
    for (const n of nodes) {
      const groupId = n.groupId ? groupIds.get(n.groupId) : undefined;
      ops.push({
        op: "CREATE_NODE",
        id: idFor(n.id),
        nodeType: n.nodeType,
        label: n.label,
        ...(groupId ? { groupId } : {}),
        ...(n.details ? { details: n.details } : {}),
      });
    }
  }
  for (const e of edges)
    ops.push({
      op: "CONNECT_NODES",
      source: idFor(e.source),
      target: idFor(e.target),
      relationship: e.relationship,
    });
  return ops;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/** Mermaid graph direction per diagram kind: trees read top-down, processes left-right. */
function mermaidDirection(kind: Workspace["diagramKind"]): "TD" | "LR" {
  return kind === "process" || kind === "journey" || kind === "timeline" ? "LR" : "TD";
}

/** Mermaid node shape that matches the semantics of a node type. */
function shapeFor(nodeType: string, label: string): string {
  const t = nodeType.toLowerCase();
  const safe = label.replace(/["\n]/g, " ").trim();
  if (t === "decision" || t === "condition") return `{"${safe}"}`;
  if (t === "start" || t === "end") return `(["${safe}"])`;
  if (t === "database" || t === "cache") return `[("${safe}")]`;
  if (t === "actor" || t === "person" || t === "role") return `(("${safe}"))`;
  return `["${safe}"]`;
}

/** Mermaid ids must be identifier-safe; keep a stable mapping. */
function mermaidId(id: string): string {
  const cleaned = id.replace(/[^A-Za-z0-9_]/g, "_");
  return /^[A-Za-z_]/.test(cleaned) ? cleaned : `n_${cleaned}`;
}

const START_TYPES = new Set(["start", "initial", "entry"]);
const END_TYPES = new Set(["end", "final", "exit"]);

/** Every details item, in order, flattened to one safe Mermaid line each. */
function detailItems(details: NodeDetails | undefined): string[] {
  return (details?.sections ?? [])
    .flatMap((s) => s.items)
    .map((item) => item.replace(/[{}]/g, " ").replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

/** The Mermaid arrow for each class-family relationship, and which end leads. */
const CLASS_ARROWS: Record<string, { arrow: string; reverse: boolean }> = {
  inherits: { arrow: "<|--", reverse: true },
  implements: { arrow: "<|..", reverse: true },
  composition: { arrow: "*--", reverse: false },
  aggregation: { arrow: "o--", reverse: false },
  depends: { arrow: "..>", reverse: false },
  association: { arrow: "-->", reverse: false },
};

/**
 * A class diagram exports as one, compartments and all: members from the
 * node's details (Mermaid sorts attributes from operations by the parameter
 * list, as the import does), the stereotype from its node type, and the UML
 * arrow from each edge's relationship — so the round trip is lossless for
 * everything but compartment titles.
 */
function toClassDiagram(ws: Workspace): string {
  const lines = ["classDiagram"];
  const stereotypes: Record<string, string> = {
    interface: "interface",
    abstract: "abstract",
    enum: "enumeration",
  };
  for (const n of Object.values(ws.nodes)) {
    const id = mermaidId(n.id);
    const label = n.label.replace(/["\n]/g, " ").trim();
    const head = label && label !== id ? `  class ${id}["${label}"]` : `  class ${id}`;
    const stereotype = stereotypes[n.nodeType];
    const members = detailItems(n.details);
    if (!stereotype && members.length === 0) {
      lines.push(head);
      continue;
    }
    lines.push(`${head} {`);
    if (stereotype) lines.push(`    <<${stereotype}>>`);
    // Mermaid spells generics ~T~ (an angle bracket would read as markup).
    for (const m of members) lines.push(`    ${m.replace(/<([^<>]*)>/g, "~$1~")}`);
    lines.push("  }");
  }
  for (const e of Object.values(ws.edges)) {
    if (!ws.nodes[e.source] || !ws.nodes[e.target]) continue;
    const known = CLASS_ARROWS[e.relationship];
    const a = mermaidId(e.source);
    const b = mermaidId(e.target);
    if (known) {
      lines.push(known.reverse ? `  ${b} ${known.arrow} ${a}` : `  ${a} ${known.arrow} ${b}`);
    } else {
      // Any other relationship is a named association.
      const name = e.relationship.replace(/[\n:]/g, " ").trim();
      lines.push(`  ${a} --> ${b}${name ? ` : ${name}` : ""}`);
    }
  }
  return lines.join("\n") + "\n";
}

function toStateDiagram(ws: Workspace): string {
  const lines = ["stateDiagram-v2"];
  const pseudo = (id: string) => {
    const t = ws.nodes[id]?.nodeType ?? "";
    return START_TYPES.has(t) || END_TYPES.has(t);
  };
  for (const n of Object.values(ws.nodes)) {
    if (pseudo(n.id)) continue;
    const id = mermaidId(n.id);
    const label = n.label.replace(/["\n]/g, " ").trim();
    lines.push(label && label !== id ? `  state "${label}" as ${id}` : `  ${id}`);
    // Details are the state's description lines — what the import reads back
    // as details. Mermaid descriptions have no headings, so titles stay home.
    for (const item of detailItems(n.details)) lines.push(`  ${id} : ${item}`);
  }
  for (const e of Object.values(ws.edges)) {
    if (!ws.nodes[e.source] || !ws.nodes[e.target]) continue;
    const a = pseudo(e.source) ? "[*]" : mermaidId(e.source);
    const b = pseudo(e.target) ? "[*]" : mermaidId(e.target);
    if (a === "[*]" && b === "[*]") continue;
    const event = e.relationship.replace(/[\n:]/g, " ").trim();
    lines.push(`  ${a} --> ${b}${event ? ` : ${event}` : ""}`);
  }
  return lines.join("\n") + "\n";
}

/** A mind map exports as one — when its edges form a single tree. */
function toMindmap(ws: Workspace): string | null {
  const parent = new Map<string, string>();
  const children = new Map<string, string[]>();
  for (const e of Object.values(ws.edges)) {
    if (!ws.nodes[e.source] || !ws.nodes[e.target]) continue;
    if (parent.has(e.target)) return null;
    parent.set(e.target, e.source);
    children.set(e.source, [...(children.get(e.source) ?? []), e.target]);
  }
  const roots = Object.keys(ws.nodes).filter((id) => !parent.has(id));
  if (roots.length !== 1) return null;
  const safe = (s: string) =>
    s
      .replace(/[()[\]{}\n]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  const lines = ["mindmap"];
  const seen = new Set<string>();
  const walk = (id: string, depth: number) => {
    if (seen.has(id)) return;
    seen.add(id);
    const label = safe(ws.nodes[id]!.label) || id;
    const pad = "  ".repeat(depth + 1);
    lines.push(depth === 0 ? `${pad}root((${label}))` : `${pad}${label}`);
    for (const c of children.get(id) ?? []) walk(c, depth + 1);
  };
  walk(roots[0]!, 0);
  // A cycle leaves nodes unreached: not a tree after all.
  return seen.size === Object.keys(ws.nodes).length ? lines.join("\n") + "\n" : null;
}

/**
 * Export the semantic graph as Mermaid. A state machine exports as a state
 * diagram, a class diagram as a class diagram and a tree-shaped mind map as a
 * mind map, so each round-trips as itself; everything else is a flowchart
 * with groups as subgraphs.
 * Sticky notes and shapes are omitted: Mermaid has no equivalent, and
 * inventing nodes for them would make the round trip lossy in a confusing
 * way.
 */
export function boardToMermaid(ws: Workspace): string {
  const nodes = Object.values(ws.nodes);
  if (nodes.length === 0) return "flowchart TD\n  %% empty board\n";
  if (ws.diagramKind === "statemachine") return toStateDiagram(ws);
  if (ws.diagramKind === "class") return toClassDiagram(ws);
  if (ws.diagramKind === "mindmap") {
    const tree = toMindmap(ws);
    if (tree) return tree;
  }

  const lines: string[] = [`flowchart ${mermaidDirection(ws.diagramKind)}`];
  const declared = new Set<string>();

  // Grouped nodes go inside a subgraph so the structure survives the export.
  for (const group of Object.values(ws.groups)) {
    const members = nodes.filter((n) => n.groupId === group.id);
    if (members.length === 0) continue;
    lines.push(`  subgraph ${mermaidId(group.id)}["${group.label.replace(/"/g, "'")}"]`);
    for (const n of members) {
      lines.push(`    ${mermaidId(n.id)}${shapeFor(n.nodeType, n.label)}`);
      declared.add(n.id);
    }
    lines.push("  end");
  }

  for (const n of nodes) {
    if (declared.has(n.id)) continue;
    lines.push(`  ${mermaidId(n.id)}${shapeFor(n.nodeType, n.label)}`);
  }

  for (const e of Object.values(ws.edges)) {
    if (!ws.nodes[e.source] || !ws.nodes[e.target]) continue;
    const label = e.relationship.replace(/[|\n]/g, " ").trim();
    lines.push(`  ${mermaidId(e.source)} -->${label ? `|${label}|` : ""} ${mermaidId(e.target)}`);
  }

  return lines.join("\n") + "\n";
}
