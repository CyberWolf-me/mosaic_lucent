/**
 * The BPMN adapter (doc 18 Phase 6; docs/19): maps a laid-out process
 * workspace to BPMN 2.0 XML — model plus DI bounds derived from the layout —
 * and BPMN 2.0 XML back to workspace semantics. The workspace stays the only
 * canonical state (ADR 0038 clause 1): XML is derived output, like
 * `Edge.route`; import drops geometry because the layout engine owns where
 * things go.
 *
 * The vocabulary is the registry's `bpmn` family (core representations.ts):
 * entry / task / choice / parallel / exit. Export also reads the flowchart and
 * process words that mean the same thing (start, end, step, decision), so a
 * flowchart exports as the process it is. Import speaks only the registry
 * words, so an imported process renders through the BPMN lens and the AI
 * builds on it in the vocabulary its prompt teaches.
 *
 * Import is a pipeline of pure steps, mirroring core's Mermaid converter:
 * `parseBpmn` (XML → a neutral graph, capped and cleaned) then `bpmnToOps`
 * (graph → validated-shape operations). Neither throws: a file that can't be
 * imported yields `{ ok: false, error }` with a sentence a person can act on.
 * Elements outside the subset are skipped and counted, never guessed; the few
 * that have a near equivalent (a user task is a task, an inclusive gateway is
 * a branch point) come in as it and are counted as simplified.
 */

import {
  applyOperations,
  createWorkspace,
  pseudoRoleFor,
  routedVertices,
  routeStyleFor,
  type Operation,
  type Position,
  type Workspace,
} from "@lucent/core";
import { escapeXml, parseXml, XmlError, type XmlElement } from "./xmlLite.js";

export const BPMN_NS = "http://www.omg.org/spec/BPMN/20100524/MODEL";
const BPMNDI_NS = "http://www.omg.org/spec/BPMN/20100524/DI";
const DC_NS = "http://www.omg.org/spec/DD/20100524/DC";
const DI_NS = "http://www.omg.org/spec/DD/20100524/DI";
/**
 * The namespaces a BPMN 2.0 model may live in: the final standard's, and the
 * 2.0 beta one a few older modelers still write.
 */
export const BPMN_MODEL_NAMESPACES: readonly string[] = [
  BPMN_NS,
  "http://schema.omg.org/spec/BPMN/2.0",
];
const MODEL_NS = new Set(BPMN_MODEL_NAMESPACES);

/**
 * Import bounds, the Mermaid importer's numbers (core MERMAID_LIMITS): a board
 * past a few hundred nodes is unreadable anyway, and the caps keep a hostile
 * file from turning one paste into an unbounded batch. `size` is characters
 * (about bytes), checked before any parsing.
 */
export const BPMN_LIMITS = { size: 2_000_000, nodes: 500, edges: 1000, label: 200 } as const;

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/**
 * BPMN element → Lucent nodeType. `exact: false` marks the near equivalents:
 * imported as the closest registry type and counted as simplified, because
 * exporting them again yields the plainer element (an inclusive gateway comes
 * back exclusive). A Map, not an object: element names come from the file,
 * and "constructor" must not find Object.prototype.
 */
const IMPORT_TYPE = new Map<string, { type: string; exact: boolean }>([
  ["startEvent", { type: "entry", exact: true }],
  ["endEvent", { type: "exit", exact: true }],
  ["task", { type: "task", exact: true }],
  ["userTask", { type: "task", exact: true }],
  ["serviceTask", { type: "task", exact: true }],
  ["scriptTask", { type: "task", exact: true }],
  ["manualTask", { type: "task", exact: true }],
  ["businessRuleTask", { type: "task", exact: true }],
  ["sendTask", { type: "task", exact: true }],
  ["receiveTask", { type: "task", exact: true }],
  ["exclusiveGateway", { type: "choice", exact: true }],
  ["parallelGateway", { type: "parallel", exact: true }],
  // Branch points with a richer rule than XOR: still where the flow splits.
  ["inclusiveGateway", { type: "choice", exact: false }],
  ["complexGateway", { type: "choice", exact: false }],
  ["eventBasedGateway", { type: "choice", exact: false }],
  // Activities with inner structure, collapsed to the step they are.
  ["subProcess", { type: "task", exact: false }],
  ["adHocSubProcess", { type: "task", exact: false }],
  ["transaction", { type: "task", exact: false }],
  ["callActivity", { type: "task", exact: false }],
  // Mid-flow events have no registry type; as a step they keep the flow
  // connected ("Wait for payment") instead of cutting it in two.
  ["intermediateCatchEvent", { type: "task", exact: false }],
  ["intermediateThrowEvent", { type: "task", exact: false }],
  ["boundaryEvent", { type: "task", exact: false }],
]);

const SUBPROCESS = new Set(["subProcess", "adHocSubProcess", "transaction"]);
const GATEWAYS = new Set([
  "exclusiveGateway",
  "parallelGateway",
  "inclusiveGateway",
  "complexGateway",
  "eventBasedGateway",
]);

/** Process children that carry no flow meaning — not worth a "skipped". */
const SILENT = new Set([
  "documentation",
  "extensionElements",
  "ioSpecification",
  "property",
  "auditing",
  "monitoring",
]);

/**
 * Lucent nodeType → BPMN element for the types that are not pseudo-nodes.
 * Start/end come from the registry's `bpmn` pseudo lists (entry/start,
 * exit/end), so the export and the canvas agree on what an event is.
 */
const EXPORT_TAG = new Map<string, string>([
  ["choice", "exclusiveGateway"],
  ["decision", "exclusiveGateway"],
  ["gateway", "exclusiveGateway"],
  ["parallel", "parallelGateway"],
  // Words for "a unit of work" across the flow families: tasks, not fallbacks.
  ["task", "task"],
  ["step", "task"],
  ["activity", "task"],
  ["service", "task"],
]);

function bpmnTagFor(nodeType: string): { tag: string; exact: boolean } {
  const role = pseudoRoleFor("bpmn", nodeType);
  if (role === "start") return { tag: "startEvent", exact: true };
  if (role === "end") return { tag: "endEvent", exact: true };
  const tag = EXPORT_TAG.get(nodeType);
  return tag ? { tag, exact: true } : { tag: "task", exact: false };
}

/**
 * Relationships that say only "and then": no `name` on export (a label on
 * every arrow is noise in a BPMN tool) and "then" on import.
 */
const GENERIC_FLOW = new Set(["", "then", "next"]);

/**
 * Relationship words core gives typed semantics (dependency cycles, the
 * decision→action rule). A flow's name is free text from the file, so it must
 * never arrive as one of these and trip a validator rule meant for them.
 */
const RESERVED_RELATIONSHIPS = new Set(["depends_on", "blocks", "related_to", "drives"]);

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/** The neutral result of reading a BPMN file: raw ids, cleaned labels, capped. */
export interface BpmnGraph {
  /** The process's name (its pool's, when it has one) — a region's label. */
  title?: string;
  /** Flow nodes in document order; `laneId` names an entry of `lanes`. */
  nodes: Array<{ id: string; nodeType: string; label: string; laneId?: string }>;
  edges: Array<{ source: string; target: string; relationship: string }>;
  /**
   * The groups a whole-board import creates: lanes (innermost wins), or pools
   * when the file has several processes. Only those holding a kept node.
   */
  lanes: Array<{ id: string; label: string }>;
  /** Element kinds dropped as outside the subset, distinct. */
  ignored: string[];
  /** How many elements were dropped. */
  skipped: number;
  /** Element kinds imported as their nearest registry type, distinct. */
  approximated: string[];
  /** How many elements came in simplified. */
  simplified: number;
  /** Counts before the caps, so a caller can say what was left out. */
  total: { nodes: number; edges: number };
}

export type BpmnParse = { ok: true; graph: BpmnGraph } | { ok: false; error: string };

/** An element with its namespace resolved against the in-scope `xmlns`. */
interface NsElement {
  uri: string;
  local: string;
  attrs: Record<string, string>;
  children: NsElement[];
  text?: string;
}

function resolveNs(el: XmlElement, inherited: ReadonlyMap<string, string>): NsElement {
  let scope = inherited;
  for (const [key, value] of Object.entries(el.attrs)) {
    if (key !== "xmlns" && !key.startsWith("xmlns:")) continue;
    if (scope === inherited) scope = new Map(inherited);
    (scope as Map<string, string>).set(key === "xmlns" ? "" : key.slice(6), value);
  }
  const colon = el.name.indexOf(":");
  const prefix = colon < 0 ? "" : el.name.slice(0, colon);
  return {
    uri: scope.get(prefix) ?? "",
    local: colon < 0 ? el.name : el.name.slice(colon + 1),
    attrs: el.attrs,
    children: el.children.map((c) => resolveNs(c, scope)),
    ...(el.text !== undefined ? { text: el.text } : {}),
  };
}

const isModel = (el: NsElement, local?: string): boolean =>
  MODEL_NS.has(el.uri) && (local === undefined || el.local === local);

/** Label text as a person reads it: one line, no control characters, capped. */
function cleanLabel(raw: string | undefined): string {
  if (!raw) return "";
  let s = raw
    .slice(0, BPMN_LIMITS.label * 8)
    // eslint-disable-next-line no-control-regex -- flattening control characters is the point
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (s.length > BPMN_LIMITS.label) {
    s = s.slice(0, BPMN_LIMITS.label);
    // Never leave half a surrogate pair at the cut.
    if (/[\uD800-\uDBFF]$/.test(s)) s = s.slice(0, -1);
    s = s.trimEnd();
  }
  return s;
}

/** A flow's name as an edge relationship, never one of core's typed words. */
function flowRelationship(name: string, fallback: string): string {
  if (!name) return fallback;
  if (!RESERVED_RELATIONSHIPS.has(name)) return name;
  const spaced = name.replace(/_/g, " ");
  return RESERVED_RELATIONSHIPS.has(spaced) ? spaced[0]!.toUpperCase() + spaced.slice(1) : spaced;
}

/** The word a boundary event's link from its host reads as. */
function boundaryWord(el: NsElement): string {
  for (const d of el.children) {
    if (!isModel(d) || !d.local.endsWith("EventDefinition")) continue;
    const kind = d.local.slice(0, -"EventDefinition".length);
    return kind === "compensate" ? "compensation" : kind === "conditional" ? "condition" : kind;
  }
  return "boundary";
}

/**
 * Read a BPMN 2.0 document into a neutral graph. Never throws: an input that
 * is too big, carries a DTD, isn't well-formed or isn't BPMN comes back as
 * `{ ok: false, error }` with a sentence for the person who picked the file.
 */
export function parseBpmn(xml: string): BpmnParse {
  if (typeof xml !== "string" || xml.trim() === "") {
    return { ok: false, error: "That BPMN file is empty." };
  }
  if (xml.length > BPMN_LIMITS.size) {
    return {
      ok: false,
      error: `That BPMN file is too large to import — the limit is ${BPMN_LIMITS.size / 1_000_000} MB.`,
    };
  }
  // trimStart() also strips a byte-order mark (U+FEFF counts as whitespace).
  if (!xml.trimStart().startsWith("<")) {
    return { ok: false, error: "That isn't a BPMN 2.0 file — it isn't XML." };
  }
  // The parser refuses these too; checking first gives the specific reason.
  if (/<!(DOCTYPE|ENTITY)/i.test(xml)) {
    return {
      ok: false,
      error:
        "That file declares a DOCTYPE or entities, which Lucent never reads (they can pull in outside content). Export it again without a DTD.",
    };
  }
  let doc: XmlElement;
  try {
    doc = parseXml(xml, { maxLength: BPMN_LIMITS.size });
  } catch (err) {
    return {
      ok: false,
      error:
        err instanceof XmlError
          ? `That isn't XML Lucent can read: ${err.reason} (at character ${err.at}).`
          : "That file couldn't be read as XML.",
    };
  }
  const root = resolveNs(doc, new Map());
  if (!isModel(root, "definitions")) {
    return {
      ok: false,
      error: "That XML isn't a BPMN 2.0 diagram — its root isn't a BPMN definitions element.",
    };
  }
  const processes = root.children.filter((c) => isModel(c, "process"));
  if (processes.length === 0) {
    return { ok: false, error: "That BPMN file has no process to import." };
  }

  const ignored = new Map<string, number>();
  const approximated = new Map<string, number>();
  const skip = (what: string) => ignored.set(what, (ignored.get(what) ?? 0) + 1);
  const approx = (what: string) => approximated.set(what, (approximated.get(what) ?? 0) + 1);

  // Pools: a collaboration's participants name the processes they hold.
  const collaborations = root.children.filter((c) => isModel(c, "collaboration"));
  const pool = new Map<string, { id: string; name: string }>();
  for (const collab of collaborations) {
    for (const p of collab.children.filter((c) => isModel(c, "participant"))) {
      const ref = p.attrs.processRef;
      if (ref && p.attrs.id) pool.set(ref, { id: p.attrs.id, name: cleanLabel(p.attrs.name) });
    }
  }

  type RawNode = BpmnGraph["nodes"][number] & { process: number };
  const nodes: RawNode[] = [];
  const byId = new Map<string, RawNode>();
  // Every flow-node id seen, kept or past the cap, so a duplicate id counts once.
  const seenIds = new Set<string>();
  let totalNodes = 0;
  const flows: Array<{ id?: string; source: string; target: string; name: string }> = [];
  const defaults = new Set<string>();
  const boundaries: Array<{ host: string; event: string; word: string }> = [];
  // Lane membership, innermost wins: nested lanes list their parent's nodes too.
  const laneOf = new Map<string, { lane: string; depth: number }>();
  const laneLabel = new Map<string, string>();

  const collectLanes = (laneSet: NsElement, depth: number, parentLabel: string): void => {
    for (const lane of laneSet.children.filter((c) => isModel(c, "lane"))) {
      const laneId = lane.attrs.id;
      if (!laneId) continue;
      const label = cleanLabel(lane.attrs.name) || parentLabel;
      if (!laneLabel.has(laneId)) laneLabel.set(laneId, label);
      for (const ref of lane.children.filter((c) => isModel(c, "flowNodeRef"))) {
        const member = ref.text?.trim();
        if (!member) continue;
        const prev = laneOf.get(member);
        if (!prev || depth > prev.depth) laneOf.set(member, { lane: laneId, depth });
      }
      for (const child of lane.children.filter((c) => isModel(c, "childLaneSet"))) {
        collectLanes(child, depth + 1, label);
      }
    }
  };

  processes.forEach((proc, processIndex) => {
    for (const el of proc.children) {
      // Vendor extensions (camunda:, zeebe:, signavio:) are not the model.
      if (!isModel(el) || SILENT.has(el.local)) continue;
      if (el.local === "laneSet") {
        collectLanes(el, 0, "");
        continue;
      }
      if (el.local === "sequenceFlow") {
        const { id, sourceRef, targetRef } = el.attrs;
        if (sourceRef && targetRef) {
          flows.push({
            ...(id ? { id } : {}),
            source: sourceRef,
            target: targetRef,
            name: cleanLabel(el.attrs.name),
          });
        }
        continue;
      }
      const mapped = IMPORT_TYPE.get(el.local);
      if (!mapped) {
        skip(el.local);
        continue;
      }
      const id = el.attrs.id;
      // An id is how flows find a node; without one (or twice) it can't join.
      if (!id || seenIds.has(id)) continue;
      seenIds.add(id);
      totalNodes++;
      if (nodes.length >= BPMN_LIMITS.nodes) continue;
      const node: RawNode = {
        id,
        nodeType: mapped.type,
        label: cleanLabel(el.attrs.name),
        process: processIndex,
      };
      nodes.push(node);
      byId.set(id, node);
      if (!mapped.exact) approx(el.local);
      else {
        // A timer or message start/end event is still a start/end; the
        // trigger is what Lucent has no model for.
        for (const d of el.children) {
          if (isModel(d) && d.local.endsWith("EventDefinition")) approx(d.local);
        }
      }
      if (
        SUBPROCESS.has(el.local) &&
        el.children.some((c) => isModel(c) && IMPORT_TYPE.has(c.local))
      ) {
        skip(`${el.local} contents`);
      }
      if (GATEWAYS.has(el.local) && el.attrs.default) defaults.add(el.attrs.default);
      if (el.local === "boundaryEvent" && el.attrs.attachedToRef) {
        boundaries.push({ host: el.attrs.attachedToRef, event: id, word: boundaryWord(el) });
      }
    }
  });

  // Edges: sequence flows, each boundary event hung off its host (so the
  // exception path stays attached), then message flows between pools.
  const candidates: Array<{ source: string; target: string; relationship: string }> = [];
  for (const f of flows) {
    const fallback = f.id && defaults.has(f.id) ? "default" : "then";
    candidates.push({
      source: f.source,
      target: f.target,
      relationship: flowRelationship(f.name, fallback),
    });
  }
  for (const b of boundaries)
    candidates.push({ source: b.host, target: b.event, relationship: b.word });
  for (const collab of collaborations) {
    for (const m of collab.children.filter((c) => isModel(c, "messageFlow"))) {
      const { sourceRef, targetRef } = m.attrs;
      if (!sourceRef || !targetRef) continue;
      candidates.push({
        source: sourceRef,
        target: targetRef,
        relationship: flowRelationship(cleanLabel(m.attrs.name), "message"),
      });
    }
  }
  // One edge per (source, target, relationship) — the reducer's edge id — and
  // no self-loops, which the validator refuses.
  const seen = new Set<string>();
  const edges: BpmnGraph["edges"] = [];
  for (const e of candidates) {
    if (!byId.has(e.source) || !byId.has(e.target)) continue;
    if (e.source === e.target) {
      skip("self-loop");
      continue;
    }
    const key = `${e.source}\u0000${e.target}\u0000${e.relationship}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push(e);
  }
  const totalEdges = edges.length;

  // Groups for a whole-board import. One process: its lanes. Several: each
  // pool is a group, and a laned pool's lanes read "Pool · Lane" — a node
  // has one group, so the innermost container wins.
  const poolsWithNodes = new Set(nodes.map((n) => n.process));
  const multiPool = poolsWithNodes.size > 1;
  const poolOf = (index: number) => {
    const proc = processes[index]!;
    const p = proc.attrs.id ? pool.get(proc.attrs.id) : undefined;
    return {
      id: p?.id ?? proc.attrs.id ?? `Pool_${index + 1}`,
      label: p?.name || cleanLabel(proc.attrs.name) || `Pool ${index + 1}`,
    };
  };
  const lanes = new Map<string, string>();
  for (const node of nodes) {
    const lane = laneOf.get(node.id)?.lane;
    if (lane) {
      const label = laneLabel.get(lane) || "Lane";
      if (!lanes.has(lane))
        lanes.set(lane, multiPool ? `${poolOf(node.process).label} · ${label}` : label);
      node.laneId = lane;
    } else if (multiPool) {
      const p = poolOf(node.process);
      if (!lanes.has(p.id)) lanes.set(p.id, p.label);
      node.laneId = p.id;
    }
  }

  let title: string | undefined;
  if (poolsWithNodes.size === 1) {
    const only = [...poolsWithNodes][0]!;
    const proc = processes[only]!;
    title =
      (proc.attrs.id ? pool.get(proc.attrs.id)?.name : undefined) || cleanLabel(proc.attrs.name);
  }
  title ||= cleanLabel(root.attrs.name);

  return {
    ok: true,
    graph: {
      ...(title ? { title } : {}),
      nodes: nodes.map(({ process: _process, ...n }) => n),
      edges: edges.slice(0, BPMN_LIMITS.edges),
      lanes: [...lanes].map(([id, label]) => ({ id, label })),
      ignored: [...ignored.keys()],
      skipped: [...ignored.values()].reduce((a, b) => a + b, 0),
      approximated: [...approximated.keys()],
      simplified: [...approximated.values()].reduce((a, b) => a + b, 0),
      total: { nodes: totalNodes, edges: totalEdges },
    },
  };
}

export interface BpmnToOpsOptions {
  /**
   * Prefix every id (`<prefix>-<id>`), so importing twice — or onto a board
   * that already has a `Task_1` — can't collide.
   */
  idPrefix?: string;
  /**
   * Land the process as a region (a group of kind `bpmn`) instead of making
   * the whole board a BPMN board — for importing onto a board with content.
   * Lanes and pools flatten into it: a node has one group, and region
   * membership is that group.
   */
  region?: { id: string; label?: string };
}

/**
 * The graph as operations: the kind (or region) first, then groups, nodes and
 * edges, so the batch validates in order. Empty when there are no nodes.
 */
export function bpmnToOps(graph: BpmnGraph, options: BpmnToOpsOptions = {}): Operation[] {
  if (graph.nodes.length === 0) return [];
  const prefix = options.idPrefix ? `${options.idPrefix}-` : "";
  const taken = new Set<string>();
  if (options.region) taken.add(options.region.id);
  // Ids the reducer and every renderer accept, unique across nodes and
  // groups. "__proto__" is renamed: workspace collections are plain objects.
  const mint = (raw: string): string => {
    const base = raw.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 60) || "n";
    let id = `${prefix}${base}`;
    for (let k = 2; taken.has(id) || id === "__proto__"; k++) id = `${prefix}${base}_${k}`;
    taken.add(id);
    return id;
  };
  // Nodes first, so they keep their natural ids and a lane renames instead.
  const nodeId = new Map(graph.nodes.map((n) => [n.id, mint(n.id)] as const));

  const ops: Operation[] = [];
  if (options.region) {
    const region = options.region.id;
    ops.push({
      op: "CREATE_GROUP",
      id: region,
      label: options.region.label ?? graph.title ?? "BPMN process",
      children: [],
      kind: "bpmn",
    });
    for (const n of graph.nodes) {
      ops.push({
        op: "CREATE_NODE",
        id: nodeId.get(n.id)!,
        nodeType: n.nodeType,
        label: n.label,
        groupId: region,
      });
    }
  } else {
    ops.push({ op: "CREATE_DIAGRAM", kind: "bpmn" });
    const groupId = new Map<string, string>();
    for (const lane of graph.lanes) {
      const id = mint(lane.id);
      groupId.set(lane.id, id);
      ops.push({ op: "CREATE_GROUP", id, label: lane.label, children: [] });
    }
    for (const n of graph.nodes) {
      const group = n.laneId ? groupId.get(n.laneId) : undefined;
      ops.push({
        op: "CREATE_NODE",
        id: nodeId.get(n.id)!,
        nodeType: n.nodeType,
        label: n.label,
        ...(group ? { groupId: group } : {}),
      });
    }
  }
  for (const e of graph.edges) {
    ops.push({
      op: "CONNECT_NODES",
      source: nodeId.get(e.source)!,
      target: nodeId.get(e.target)!,
      relationship: e.relationship,
    });
  }
  return ops;
}

export type BpmnImport =
  | { ok: true; workspace: Workspace; graph: BpmnGraph }
  | { ok: false; error: string };

/**
 * BPMN 2.0 XML → a fresh `bpmn` workspace (the subset; geometry dropped).
 * Ids are kept where they are already valid, so a round trip is recognisable.
 */
export function fromBpmnXml(xml: string): BpmnImport {
  const parsed = parseBpmn(xml);
  if (!parsed.ok) return parsed;
  const base = createWorkspace({
    id: "bpmn-import",
    name: parsed.graph.title || "Imported process",
    diagramKind: "bpmn",
  });
  return {
    ok: true,
    workspace: applyOperations(base, bpmnToOps(parsed.graph)),
    graph: parsed.graph,
  };
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export interface BpmnExport {
  xml: string;
  /** Node types that fell back to `task`, and nodes with no layout for DI. */
  warnings: string[];
}

/** BPMN's drawn sizes: events and gateways are fixed glyphs, not cards. */
const EVENT_SIZE = 36;
const GATEWAY_SIZE = 50;

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const centre = (r: Rect): Position => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

/** Where the ray from `r`'s centre toward `toward` leaves `r`. */
function clipToRect(r: Rect, toward: Position): Position {
  const c = centre(r);
  const dx = toward.x - c.x;
  const dy = toward.y - c.y;
  if (dx === 0 && dy === 0) return c;
  const t = Math.min(
    dx === 0 ? Infinity : r.w / 2 / Math.abs(dx),
    dy === 0 ? Infinity : r.h / 2 / Math.abs(dy),
  );
  return { x: c.x + dx * t, y: c.y + dy * t };
}

const num = (v: number): string => String(Math.round(v));

/**
 * Workspace → BPMN 2.0 XML (model + DI). Exports every node, every edge
 * between them, and each group holding a node as a lane. The caller decides
 * WHAT to export (bpmnInterop's bpmnExportFor narrows the board) and lays out
 * first: DI bounds come from `position`/`size`, edge waypoints from the
 * routes the layout stamped.
 */
export function toBpmnXml(ws: Workspace): BpmnExport {
  const warnings: string[] = [];
  const nodes = Object.values(ws.nodes);
  const edges = Object.values(ws.edges).filter(
    (e) => ws.nodes[e.source] && ws.nodes[e.target] && e.source !== e.target,
  );

  // BPMN ids are XML NCNames and unique across the document; Lucent ids are
  // any string (an edge id reads "a->b:then"). Valid ids are kept, so a round
  // trip is recognisable; the rest are cleaned. Container ids are reserved
  // first, so a node called "Process_1" can't collide with the process.
  const taken = new Set([
    "Definitions_1",
    "Process_1",
    "LaneSet_1",
    "BPMNDiagram_1",
    "BPMNPlane_1",
  ]);
  const mint = (raw: string): string => {
    let base = raw.replace(/[^A-Za-z0-9_.-]/g, "_");
    if (!/^[A-Za-z_]/.test(base)) base = `_${base}`;
    let id = base;
    for (let k = 2; taken.has(id); k++) id = `${base}_${k}`;
    taken.add(id);
    return id;
  };
  const idOf = new Map(nodes.map((n) => [n.id, mint(n.id)] as const));
  const flowId = new Map(edges.map((e, k) => [e.id, mint(`Flow_${k + 1}`)] as const));

  const tagOf = new Map<string, string>();
  for (const node of nodes) {
    const { tag, exact } = bpmnTagFor(node.nodeType);
    if (!exact) warnings.push(`nodeType "${node.nodeType}" on ${node.id} exported as task`);
    tagOf.set(node.id, tag);
  }

  const flowLines: string[] = [];
  for (const node of nodes) {
    const tag = tagOf.get(node.id)!;
    const attrs = [
      `id="${escapeXml(idOf.get(node.id)!)}"`,
      ...(node.label ? [`name="${escapeXml(node.label)}"`] : []),
    ];
    const ins = edges
      .filter((e) => e.target === node.id)
      .map((e) => `      <bpmn:incoming>${flowId.get(e.id)!}</bpmn:incoming>`);
    const outs = edges
      .filter((e) => e.source === node.id)
      .map((e) => `      <bpmn:outgoing>${flowId.get(e.id)!}</bpmn:outgoing>`);
    flowLines.push(
      ins.length + outs.length === 0
        ? `    <bpmn:${tag} ${attrs.join(" ")}/>`
        : [`    <bpmn:${tag} ${attrs.join(" ")}>`, ...ins, ...outs, `    </bpmn:${tag}>`].join(
            "\n",
          ),
    );
  }

  // A flow's relationship is its name — a gateway branch's condition ("yes",
  // "over limit") — unless it only says "then".
  const flows = edges.map((e) => {
    const name = GENERIC_FLOW.has(e.relationship.trim())
      ? ""
      : ` name="${escapeXml(e.relationship)}"`;
    return `    <bpmn:sequenceFlow id="${flowId.get(e.id)!}" sourceRef="${escapeXml(idOf.get(e.source)!)}" targetRef="${escapeXml(idOf.get(e.target)!)}"${name}/>`;
  });

  // Lanes: each group holding a node, membership from the node's own
  // groupId (a node has one group) as the flowNodeRef list. Semantic only —
  // no lane DI: Lucent's group frames are not BPMN's full-width bands, and a
  // tool draws the flow correctly from the node shapes alone.
  const members = new Map<string, string[]>();
  for (const node of nodes) {
    if (!node.groupId || !ws.groups[node.groupId]) continue;
    const list = members.get(node.groupId) ?? [];
    list.push(idOf.get(node.id)!);
    members.set(node.groupId, list);
  }
  const lanes = [...members].map(([groupId, refs]) => {
    const label = ws.groups[groupId]!.label;
    return [
      `      <bpmn:lane id="${escapeXml(mint(groupId))}"${label ? ` name="${escapeXml(label)}"` : ""}>`,
      ...refs.map((ref) => `        <bpmn:flowNodeRef>${escapeXml(ref)}</bpmn:flowNodeRef>`),
      `      </bpmn:lane>`,
    ].join("\n");
  });
  const laneSet =
    lanes.length > 0 ? [`    <bpmn:laneSet id="LaneSet_1">`, ...lanes, `    </bpmn:laneSet>`] : [];

  // DI: a shape per laid-out node. Events and gateways take BPMN's glyph
  // sizes, centred where the layout put the node, so another tool draws them
  // as the circles and diamonds they are rather than stretched cards.
  const shapes: string[] = [];
  const rectOf = new Map<string, Rect>();
  for (const node of nodes) {
    if (!node.position || !node.size) {
      warnings.push(`node ${node.id} has no layout; no DI shape emitted`);
      continue;
    }
    const tag = tagOf.get(node.id)!;
    const glyph = tag.endsWith("Event") ? EVENT_SIZE : tag.endsWith("Gateway") ? GATEWAY_SIZE : 0;
    const laid: Rect = {
      x: node.position.x,
      y: node.position.y,
      w: node.size.width,
      h: node.size.height,
    };
    const c = centre(laid);
    const rect: Rect = glyph
      ? { x: c.x - glyph / 2, y: c.y - glyph / 2, w: glyph, h: glyph }
      : laid;
    rectOf.set(node.id, rect);
    const id = idOf.get(node.id)!;
    // bpmn-js draws an exclusive gateway's X only when the DI asks for it.
    const marker = tag === "exclusiveGateway" ? ` isMarkerVisible="true"` : "";
    shapes.push(
      [
        `      <bpmndi:BPMNShape id="${escapeXml(mint(`${id}_di`))}" bpmnElement="${escapeXml(id)}"${marker}>`,
        `        <dc:Bounds x="${num(rect.x)}" y="${num(rect.y)}" width="${num(rect.w)}" height="${num(rect.h)}"/>`,
        `      </bpmndi:BPMNShape>`,
      ].join("\n"),
    );
  }

  // DI edges: the drawn path the canvas draws — the layout's bend points
  // (Edge.route, bends only), squared in the family's route style — with the
  // ends clipped to the shapes' borders, as BPMN tools expect.
  const style = routeStyleFor(ws.diagramKind);
  const edgeDis: string[] = [];
  for (const e of edges) {
    const a = rectOf.get(e.source);
    const b = rectOf.get(e.target);
    if (!a || !b) continue;
    const path = routedVertices(centre(a), centre(b), e.route ?? [], style);
    const points = [
      clipToRect(a, path[1]!),
      ...path.slice(1, -1),
      clipToRect(b, path[path.length - 2]!),
    ];
    const id = flowId.get(e.id)!;
    edgeDis.push(
      [
        `      <bpmndi:BPMNEdge id="${escapeXml(mint(`${id}_di`))}" bpmnElement="${id}">`,
        ...points.map((p) => `        <di:waypoint x="${num(p.x)}" y="${num(p.y)}"/>`),
        `      </bpmndi:BPMNEdge>`,
      ].join("\n"),
    );
  }

  const processName = ws.name && ws.name !== "Untitled" ? ` name="${escapeXml(ws.name)}"` : "";
  const xml = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<bpmn:definitions xmlns:bpmn="${BPMN_NS}" xmlns:bpmndi="${BPMNDI_NS}" xmlns:dc="${DC_NS}" xmlns:di="${DI_NS}" id="Definitions_1" targetNamespace="http://lucent.dev/bpmn" exporter="Lucent">`,
    `  <bpmn:process id="Process_1"${processName} isExecutable="false">`,
    ...laneSet,
    ...flowLines,
    ...flows,
    `  </bpmn:process>`,
    `  <bpmndi:BPMNDiagram id="BPMNDiagram_1">`,
    `    <bpmndi:BPMNPlane id="BPMNPlane_1" bpmnElement="Process_1">`,
    ...shapes,
    ...edgeDis,
    `    </bpmndi:BPMNPlane>`,
    `  </bpmndi:BPMNDiagram>`,
    `</bpmn:definitions>`,
    ``,
  ].join("\n");

  return { xml, warnings };
}
