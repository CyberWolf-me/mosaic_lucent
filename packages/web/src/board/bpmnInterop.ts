import {
  applyLayout,
  applyRoutes,
  computeLayoutWithRoutes,
  createWorkspace,
  validateOperations,
  type DiagramKind,
  type Operation,
  type Workspace,
} from "@lucent/core";
import {
  BPMN_LIMITS,
  BPMN_MODEL_NAMESPACES,
  bpmnToOps,
  parseBpmn,
  toBpmnXml,
} from "../diagram/bpmn/index.js";

/**
 * BPMN onto and off the canvas (docs/19, V4). The canvas side of the adapter,
 * shaped like the Mermaid import (mermaidImport.ts) so the two behave alike:
 *
 *   - an EMPTY board becomes the process (CREATE_DIAGRAM bpmn), its lanes —
 *     or its pools, when the file has several — as groups;
 *   - a board WITH content gains the process as a `bpmn` region, keeping its
 *     own kind; lanes flatten into the region, because a node has one group
 *     and region membership is that group;
 *   - ids are prefixed per import, so the same file imported twice lands twice.
 *
 * Everything here is pure: text in, operations or XML out. The canvas applies
 * the operations as one undoable commit through the same validated path as
 * any other edit, so an import is reversible like every AI action.
 */

/**
 * Board kinds whose whole board exports as a BPMN process: BPMN itself, and
 * the two flow families that already speak its vocabulary (start/end events,
 * steps as tasks, decisions as exclusive gateways, swimlanes as lanes). Other
 * families — an architecture, a mind map — are not processes, so they export
 * only their `bpmn` regions, or nothing.
 */
const EXPORTABLE: ReadonlySet<DiagramKind> = new Set<DiagramKind>(["bpmn", "process", "flowchart"]);

/** How much of a pasted text the sniff reads: the root tag sits at the top. */
const SNIFF = 65_536;

/**
 * Cheap sniff: is this BPMN 2.0 XML? True when, past the prolog (XML
 * declaration, comments, a DOCTYPE), the root element is `definitions` in a
 * BPMN model namespace. It reads only the head and parses nothing, so paste
 * handling can call it on every paste. A true here is not a promise the file
 * imports — planBpmnImport still validates, and says why when it can't (a
 * DOCTYPE is sniffed past on purpose, so the refusal can name it).
 */
export function detectBpmn(text: string): boolean {
  if (typeof text !== "string") return false;
  const head = text.slice(0, SNIFF);
  let i = head.charCodeAt(0) === 0xfeff ? 1 : 0;
  for (;;) {
    while (i < head.length && /\s/.test(head[i]!)) i++;
    if (head.startsWith("<?", i)) {
      const close = head.indexOf("?>", i + 2);
      if (close < 0) return false;
      i = close + 2;
    } else if (head.startsWith("<!--", i)) {
      const close = head.indexOf("-->", i + 4);
      if (close < 0) return false;
      i = close + 3;
    } else if (head.startsWith("<!DOCTYPE", i)) {
      const close = head.indexOf(">", i);
      const subset = head.indexOf("[", i);
      if (close < 0) return false;
      // An internal subset holds `>` of its own: skip to the `]>` that ends it.
      const end = subset >= 0 && subset < close ? head.indexOf("]", subset) : close;
      const gt = end < 0 ? -1 : head.indexOf(">", end);
      if (gt < 0) return false;
      i = gt + 1;
    } else break;
  }
  const tag = /^<(?:([A-Za-z_][\w.-]*):)?definitions(?=[\s>/])[^>]*>/.exec(
    head.slice(i, i + 16_384),
  );
  if (!tag) return false;
  // The root's own prefix (or the default namespace) must be bound to BPMN.
  const attr = tag[1] ? `xmlns:${tag[1].replace(/\./g, "\\.")}` : "xmlns";
  const decl = new RegExp(`\\s${attr}\\s*=\\s*(["'])([^"']*)\\1`).exec(tag[0]);
  return decl !== null && BPMN_MODEL_NAMESPACES.includes(decl[2]!);
}

export type BpmnImportPlan =
  | { ok: true; ops: Operation[]; nodeIds: string[]; message: string }
  | { ok: false; error: string };

function importPrefix(): string {
  return `bp${Date.now().toString(36).slice(-4)}${Math.random().toString(36).slice(2, 4)}`;
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/** "inclusiveGateway" → "inclusive gateway"; capped, since names come from the file. */
function listed(names: readonly string[]): string {
  const shown = names.slice(0, 3).map((name) =>
    name
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .slice(0, 40),
  );
  return `${shown.join(", ")}${names.length > 3 ? ", …" : ""}`;
}

/**
 * Plan a BPMN import onto `ws` — the planMermaidImport contract. An empty
 * board becomes the process; a board with content gains it as a region. The
 * ops are checked against the board before they are returned, so a plan that
 * says ok applies cleanly.
 */
export function planBpmnImport(
  ws: Workspace,
  xml: string,
  prefix: string = importPrefix(),
): BpmnImportPlan {
  const parsed = parseBpmn(xml);
  if (!parsed.ok) return parsed;
  const { graph } = parsed;
  if (graph.nodes.length === 0) {
    return {
      ok: false,
      error: "That BPMN process has no events, tasks or gateways to import.",
    };
  }
  const onto = Object.keys(ws.nodes).length > 0;
  const ops = bpmnToOps(graph, {
    idPrefix: prefix,
    ...(onto ? { region: { id: `${prefix}-region` } } : {}),
  });
  if (validateOperations(ws, ops).length > 0) {
    return { ok: false, error: "That BPMN process couldn't be added to this board." };
  }
  const nodeIds = ops.flatMap((o) => (o.op === "CREATE_NODE" ? [o.id] : []));
  const n = nodeIds.length;
  let message = `Imported a BPMN process — ${plural(n, "node")}${onto ? ", as its own region" : ""}.`;
  if (onto && graph.lanes.length > 0) message += " Its lanes were flattened into the region.";
  if (graph.total.nodes > n) message += ` Only the first ${n} of ${graph.total.nodes} came in.`;
  if (graph.total.edges > BPMN_LIMITS.edges) {
    message += ` Only the first ${BPMN_LIMITS.edges} of ${graph.total.edges} flows came in.`;
  }
  if (graph.simplified > 0) {
    message += ` Simplified ${plural(graph.simplified, "element")} to the nearest shape (${listed(graph.approximated)}).`;
  }
  if (graph.skipped > 0) {
    message += ` Skipped ${plural(graph.skipped, "element")} outside the supported subset (${listed(graph.ignored)}).`;
  }
  return { ok: true, ops, nodeIds, message };
}

export interface BpmnExportFile {
  /** BPMN 2.0 XML: the process model plus DI shapes and edges. */
  xml: string;
  /** A download name ending in `.bpmn`, from the board's or region's name. */
  filename: string;
  /** A one-line summary for the toast. */
  message: string;
}

interface ExportScope {
  name: string;
  kind: DiagramKind;
  nodeIds: Set<string>;
  /** Groups that become lanes; every other group membership is dropped. */
  lanes: Set<string>;
}

function membersOf(ws: Workspace, groupId: string): string[] {
  return Object.values(ws.nodes)
    .filter((n) => n.groupId === groupId)
    .map((n) => n.id);
}

function exportScope(ws: Workspace, regionId: string | undefined): ExportScope | null {
  if (regionId !== undefined) {
    const region = ws.groups[regionId];
    if (!region?.kind || !EXPORTABLE.has(region.kind)) return null;
    return {
      name: region.label,
      kind: region.kind,
      nodeIds: new Set(membersOf(ws, regionId)),
      lanes: new Set(),
    };
  }
  if (EXPORTABLE.has(ws.diagramKind)) {
    // The whole board, minus members of regions drawn as another family: a
    // mind-map region's ideas are not steps in the process.
    const nodeIds = new Set<string>();
    const lanes = new Set<string>();
    for (const node of Object.values(ws.nodes)) {
      const group = node.groupId ? ws.groups[node.groupId] : undefined;
      if (group?.kind && !EXPORTABLE.has(group.kind)) continue;
      nodeIds.add(node.id);
      if (group) lanes.add(group.id);
    }
    return { name: ws.name, kind: ws.diagramKind, nodeIds, lanes };
  }
  // Another family's board: its BPMN regions (an imported process sitting
  // beside an architecture). One region is the process; several become
  // lanes of one, so each node keeps where it came from.
  const regions = Object.values(ws.groups).filter(
    (g) => g.kind === "bpmn" && membersOf(ws, g.id).length > 0,
  );
  if (regions.length === 0) return null;
  return {
    name: regions.length === 1 ? regions[0]!.label : ws.name,
    kind: "bpmn",
    nodeIds: new Set(regions.flatMap((g) => membersOf(ws, g.id))),
    lanes: regions.length > 1 ? new Set(regions.map((g) => g.id)) : new Set(),
  };
}

/** A download name: the board's name without path or reserved characters. */
function filenameFor(name: string): string {
  const base = name
    // eslint-disable-next-line no-control-regex -- control characters can't be in a filename
    .replace(/[\u0000-\u001F\u007F<>:"/\\|?*]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, 80)
    .trim();
  return `${base && base !== "Untitled" ? base : "lucent-process"}.bpmn`;
}

/**
 * The board as a BPMN 2.0 file, or null when it holds no process to export.
 *
 *   - A `bpmn`, `process` or `flowchart` board exports whole: groups become
 *     lanes; members of regions of other kinds are left out.
 *   - Any other board exports its `bpmn` regions (null when it has none).
 *   - `regionId` exports just that region, when its kind is one of the three.
 *
 * DI comes from the positions the layout already stamped on the board; a node
 * that has none (a board never laid out) triggers one layout pass here, so
 * the file always opens with shapes in another tool.
 */
export function bpmnExportFor(
  ws: Workspace,
  options: { regionId?: string } = {},
): BpmnExportFile | null {
  const scope = exportScope(ws, options.regionId);
  if (!scope || scope.nodeIds.size === 0) return null;

  let source = ws;
  if ([...scope.nodeIds].some((id) => !ws.nodes[id]?.position || !ws.nodes[id]?.size)) {
    const { layout, routes } = computeLayoutWithRoutes(ws);
    source = applyRoutes(applyLayout(ws, layout), routes);
  }

  // The slice of the board that becomes the process: the scope's nodes, the
  // edges between them, and the groups kept as lanes.
  const sub = createWorkspace({ id: ws.id, name: scope.name, diagramKind: scope.kind });
  for (const id of scope.nodeIds) {
    const node = source.nodes[id]!;
    if (node.groupId && !scope.lanes.has(node.groupId)) {
      const { groupId: _dropped, ...rest } = node;
      sub.nodes[id] = rest;
    } else {
      sub.nodes[id] = node;
    }
  }
  for (const edge of Object.values(source.edges)) {
    if (scope.nodeIds.has(edge.source) && scope.nodeIds.has(edge.target)) sub.edges[edge.id] = edge;
  }
  for (const id of scope.lanes) {
    const group = source.groups[id];
    if (group) sub.groups[id] = group;
  }

  const { xml, warnings } = toBpmnXml(sub);
  const n = scope.nodeIds.size;
  let message = `Exported ${plural(n, "node")} as BPMN 2.0.`;
  const fallbacks = warnings.filter((w) => w.startsWith("nodeType")).length;
  if (fallbacks > 0) {
    message += ` ${plural(fallbacks, "node")} with no BPMN equivalent became ${fallbacks === 1 ? "a task" : "tasks"}.`;
  }
  const left =
    options.regionId === undefined && EXPORTABLE.has(ws.diagramKind)
      ? Object.keys(ws.nodes).length - n
      : 0;
  if (left > 0) message += ` Left out ${plural(left, "node")} in regions of other kinds.`;
  return { xml, filename: filenameFor(scope.name), message };
}
