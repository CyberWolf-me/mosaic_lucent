/**
 * The BPMN adapter (doc 18 Phase 6; docs/19): maps a laid-out process
 * workspace to BPMN 2.0 XML — model plus DI bounds derived from the layout —
 * and the supported subset back to workspace semantics. The workspace stays
 * the only canonical state (ADR 0038 clause 1): XML is derived output, like
 * `Edge.route`; import drops geometry because the layout engine owns where
 * things go.
 *
 * The subset and its license conditions are defined in docs/19. Unknown
 * elements are ignored on import (and reported), never guessed; unknown
 * Lucent node types export as `task`, reported as a warning — an honest
 * fallback, not a silent reinterpretation.
 */

import { createWorkspace, type Workspace } from "@lucent/core";
import { escapeXml, parseXml, type XmlElement } from "./xmlLite.js";

const BPMN_NS = "http://www.omg.org/spec/BPMN/20100524/MODEL";
const BPMNDI_NS = "http://www.omg.org/spec/BPMN/20100524/DI";
const DC_NS = "http://www.omg.org/spec/DD/20100524/DC";
const DI_NS = "http://www.omg.org/spec/DD/20100524/DI";

/** Lucent nodeType → BPMN element (docs/19's table). Unknown → task. */
const TYPE_TO_BPMN: Record<string, string> = {
  entry: "startEvent",
  exit: "endEvent",
  choice: "exclusiveGateway",
  gateway: "exclusiveGateway",
  step: "task",
  service: "task",
  task: "task",
};

const BPMN_TO_TYPE: Record<string, string> = {
  startEvent: "entry",
  endEvent: "exit",
  exclusiveGateway: "choice",
  task: "step",
};

export interface BpmnExport {
  xml: string;
  /** Node types that fell back to `task`, keyed by node id. */
  warnings: string[];
}

/** Workspace → BPMN 2.0 XML (model + DI). The caller lays out first. */
export function toBpmnXml(ws: Workspace): BpmnExport {
  const warnings: string[] = [];
  const nodes = Object.values(ws.nodes);
  const edges = Object.values(ws.edges);

  const flowLines: string[] = [];
  for (const node of nodes) {
    const tag = TYPE_TO_BPMN[node.nodeType] ?? "task";
    if (!TYPE_TO_BPMN[node.nodeType]) {
      warnings.push(`nodeType "${node.nodeType}" on ${node.id} exported as task`);
    }
    const outs = edges
      .filter((e) => e.source === node.id)
      .map((e) => `      <bpmn:outgoing>${escapeXml(e.id)}</bpmn:outgoing>`);
    const ins = edges
      .filter((e) => e.target === node.id)
      .map((e) => `      <bpmn:incoming>${escapeXml(e.id)}</bpmn:incoming>`);
    flowLines.push(
      [
        `    <bpmn:${tag} id="${escapeXml(node.id)}"${node.label ? ` name="${escapeXml(node.label)}"` : ""}>`,
        ...ins,
        ...outs,
        `    </bpmn:${tag}>`,
      ].join("\n"),
    );
  }

  const flows = edges.map(
    (e) =>
      `    <bpmn:sequenceFlow id="${escapeXml(e.id)}" sourceRef="${escapeXml(e.source)}" targetRef="${escapeXml(e.target)}"/>`,
  );

  // Lanes: plain groups become lanes; membership is the flowNodeRef list.
  const lanes = Object.values(ws.groups)
    .map((g) => {
      const refs = g.children
        .filter((id) => ws.nodes[id])
        .map((id) => `        <bpmn:flowNodeRef>${escapeXml(id)}</bpmn:flowNodeRef>`);
      if (refs.length === 0) return null;
      return [
        `      <bpmn:lane id="${escapeXml(g.id)}"${g.label ? ` name="${escapeXml(g.label)}"` : ""}>`,
        ...refs,
        `      </bpmn:lane>`,
      ].join("\n");
    })
    .filter((x): x is string => x !== null);
  const laneSet =
    lanes.length > 0 ? [`    <bpmn:laneSet id="LaneSet_1">`, ...lanes, `    </bpmn:laneSet>`] : [];

  // DI: shapes from laid-out nodes; edges from routes, or a straight line
  // between endpoint centres. Unlaid-out elements get no DI (they are
  // reported, because a viewer cannot draw what has no bounds).
  const shapes: string[] = [];
  const shapeOf = new Map<string, { x: number; y: number; w: number; h: number }>();
  for (const node of nodes) {
    if (!node.position || !node.size) {
      warnings.push(`node ${node.id} has no layout; no DI shape emitted`);
      continue;
    }
    shapeOf.set(node.id, {
      x: node.position.x,
      y: node.position.y,
      w: node.size.width,
      h: node.size.height,
    });
    shapes.push(
      [
        `      <bpmndi:BPMNShape id="${escapeXml(node.id)}_di" bpmnElement="${escapeXml(node.id)}">`,
        `        <dc:Bounds x="${node.position.x}" y="${node.position.y}" width="${node.size.width}" height="${node.size.height}"/>`,
        `      </bpmndi:BPMNShape>`,
      ].join("\n"),
    );
  }
  const edgeDis: string[] = [];
  for (const e of edges) {
    const a = shapeOf.get(e.source);
    const b = shapeOf.get(e.target);
    if (!a || !b) continue;
    const waypoints = (
      e.route ?? [
        { x: a.x + a.w / 2, y: a.y + a.h / 2 },
        { x: b.x + b.w / 2, y: b.y + b.h / 2 },
      ]
    )
      .map((p) => `        <di:waypoint x="${p.x}" y="${p.y}"/>`)
      .join("\n");
    edgeDis.push(
      [
        `      <bpmndi:BPMNEdge id="${escapeXml(e.id)}_di" bpmnElement="${escapeXml(e.id)}">`,
        waypoints,
        `      </bpmndi:BPMNEdge>`,
      ].join("\n"),
    );
  }

  const xml = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<bpmn:definitions xmlns:bpmn="${BPMN_NS}" xmlns:bpmndi="${BPMNDI_NS}" xmlns:dc="${DC_NS}" xmlns:di="${DI_NS}" id="Definitions_1" targetNamespace="http://lucent.dev/bpmn">`,
    `  <bpmn:process id="Process_1" isExecutable="false">`,
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

export interface BpmnImport {
  workspace: Workspace;
  /** Top-level BPMN elements outside the supported subset, by tag. */
  ignored: string[];
}

/** BPMN 2.0 XML → workspace semantics (the subset only; geometry dropped). */
export function fromBpmnXml(xml: string): BpmnImport {
  const doc = parseXml(xml);
  const process = find(doc, "bpmn:process");
  if (!process) throw new Error("no bpmn:process element found");
  const ws = createWorkspace({ id: "bpmn-import", name: "Imported process", diagramKind: "process" });
  const ignored: string[] = [];

  // Lanes are parsed FIRST (their refs are ids, valid regardless of whether
  // the nodes exist yet) but APPLIED after the nodes: membership filters on
  // existing nodes, which don't exist until the flow-element loop below.
  const laneMemberships: Array<{ id: string; label: string; refs: string[] }> = [];
  for (const laneSet of process.children.filter((c) => c.name === "bpmn:laneSet")) {
    for (const lane of laneSet.children.filter((c) => c.name === "bpmn:lane")) {
      const id = lane.attrs.id;
      if (!id) continue;
      const refs = lane.children
        .filter((c) => c.name === "bpmn:flowNodeRef")
        .map((c) => textOf(c))
        .filter((r): r is string => Boolean(r));
      laneMemberships.push({ id, label: lane.attrs.name ?? "", refs });
    }
  }

  for (const child of process.children) {
    // BPMN is conventionally `bpmn:`-prefixed; tolerate both spellings.
    const tag = child.name.replace(/^bpmn:/, "");
    const lucentType = BPMN_TO_TYPE[tag];
    if (lucentType) {
      const id = child.attrs.id;
      if (!id) continue;
      ws.nodes[id] = { id, nodeType: lucentType, label: child.attrs.name ?? "" };
    } else if (tag === "sequenceFlow") {
      const { id, sourceRef, targetRef } = child.attrs;
      if (id && sourceRef && targetRef) {
        ws.edges[id] = { id, source: sourceRef, target: targetRef, relationship: "then" };
      }
    } else if (tag !== "laneSet") {
      ignored.push(child.name);
    }
  }
  for (const lane of laneMemberships) {
    const members = lane.refs.filter((r) => Boolean(ws.nodes[r]));
    if (members.length === 0) continue;
    ws.groups[lane.id] = { id: lane.id, label: lane.label, children: members };
    for (const member of members) ws.nodes[member]!.groupId = lane.id;
  }
  return { workspace: ws, ignored };
}

function find(el: XmlElement, name: string): XmlElement | null {
  if (el.name === name) return el;
  for (const child of el.children) {
    const hit = find(child, name);
    if (hit) return hit;
  }
  return null;
}

function textOf(el: XmlElement): string | null {
  // flowNodeRef carries the member id as element text — the one text
  // carrier in the subset (names live in attributes).
  return el.text ?? null;
}
