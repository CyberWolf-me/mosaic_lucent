/**
 * The BPMN adapter, pinned (doc 18 Phase 6, docs/19, V4): the supported
 * subset round-trips both ways in the registry's `bpmn` vocabulary, unknown
 * elements are skipped (and reported), invalid input is a sentence rather
 * than a throw, and geometry stays out of the imported semantics — the layout
 * engine owns where things go.
 */

import { describe, expect, it } from "vitest";
import { createWorkspace, edgeId, type Workspace } from "@lucent/core";
import { fromBpmnXml, parseBpmn, toBpmnXml } from "../src/diagram/bpmn/index.js";
import { parseXml } from "../src/diagram/bpmn/index.js";

/** The canonical onboarding process, laid out, with one lane (process words). */
function processBoard(): Workspace {
  const ws = createWorkspace({ id: "proc", name: "Onboarding", diagramKind: "process" });
  const nodes: Array<[string, string, string]> = [
    ["n-000", "entry", "Start"],
    ["n-001", "step", "Create account"],
    ["n-002", "step", "Verify email"],
    ["n-003", "choice", "Email verified?"],
    ["n-004", "step", "Resend"],
    ["n-005", "step", "Complete onboarding"],
    ["n-006", "exit", "End"],
  ];
  for (const [id, nodeType, label] of nodes) {
    const i = Number(id.slice(2));
    ws.nodes[id] = {
      id,
      nodeType,
      label,
      position: { x: i * 220, y: (i % 2) * 140 },
      size: { width: 160, height: 64 },
    };
  }
  const edges: Array<[string, string, string]> = [
    ["n-000", "n-001", "then"],
    ["n-001", "n-002", "then"],
    ["n-002", "n-003", "then"],
    ["n-003", "n-004", "no"],
    ["n-003", "n-005", "yes"],
    ["n-004", "n-002", "then"],
    ["n-005", "n-006", "then"],
  ];
  for (const [source, target, relationship] of edges) {
    const id = edgeId(source, target, relationship);
    ws.edges[id] = { id, source, target, relationship };
  }
  // A lane holding the automation steps.
  ws.nodes["n-001"]!.groupId = "lane-auto";
  ws.nodes["n-002"]!.groupId = "lane-auto";
  ws.groups["lane-auto"] = { id: "lane-auto", label: "Automation", children: ["n-001", "n-002"] };
  return ws;
}

function imported(xml: string) {
  const result = fromBpmnXml(xml);
  if (!result.ok) throw new Error(`import failed: ${result.error}`);
  return result;
}

describe("BPMN export (docs/19 subset)", () => {
  it("emits model + DI for the canonical process, no warnings", () => {
    const { xml, warnings } = toBpmnXml(processBoard());
    expect(warnings).toEqual([]);
    const doc = parseXml(xml); // the root IS bpmn:definitions
    const process = doc.children.find((c) => c.name === "bpmn:process")!;
    const tasks = process.children.filter((c) => c.name === "bpmn:task");
    expect(tasks.length).toBe(4); // step ×4 (choice/entry/exit are their own tags)
    const flows = process.children.filter((c) => c.name === "bpmn:sequenceFlow");
    expect(flows.length).toBe(7);
    const plane = doc.children.find((c) => c.name === "bpmndi:BPMNDiagram")!;
    expect(plane).toBeTruthy();
    const shapes = flatten(plane).filter((c) => c.name === "bpmndi:BPMNShape");
    expect(shapes.length).toBe(7);
    const edgeDi = flatten(plane).filter((c) => c.name === "bpmndi:BPMNEdge");
    expect(edgeDi.length).toBe(7);
  });

  it("gives every flow a valid BPMN id (Lucent's edge ids are not NCNames)", () => {
    const doc = parseXml(toBpmnXml(processBoard()).xml);
    const ids = flatten(doc)
      .map((c) => c.attrs.id)
      .filter((id): id is string => Boolean(id));
    for (const id of ids) expect(id).toMatch(/^[A-Za-z_][A-Za-z0-9_.-]*$/);
    expect(new Set(ids).size).toBe(ids.length); // unique across the document
  });

  it("emits lanes from groups with flowNodeRef membership", () => {
    const { xml } = toBpmnXml(processBoard());
    const doc = parseXml(xml);
    const lane = flatten(doc).find((c) => c.name === "bpmn:lane")!;
    expect(lane.attrs.id).toBe("lane-auto");
    const refs = lane.children.filter((c) => c.name === "bpmn:flowNodeRef");
    expect(refs.map((r) => r.text).sort()).toEqual(["n-001", "n-002"]);
  });

  it("names a flow by its relationship, unless it only says 'then'", () => {
    const doc = parseXml(toBpmnXml(processBoard()).xml);
    const flows = flatten(doc).filter((c) => c.name === "bpmn:sequenceFlow");
    const named = flows.filter((f) => f.attrs.name !== undefined).map((f) => f.attrs.name);
    expect(named.sort()).toEqual(["no", "yes"]);
  });

  it("draws events and gateways at BPMN's glyph sizes, centred on the layout", () => {
    const doc = parseXml(toBpmnXml(processBoard()).xml);
    const shape = (id: string) =>
      flatten(doc).find((c) => c.name === "bpmndi:BPMNShape" && c.attrs.bpmnElement === id)!;
    const bounds = (id: string) => shape(id).children[0]!.attrs;
    // n-003 is laid out at (660, 140) 160×64 → centre (740, 172).
    expect(bounds("n-003")).toMatchObject({ x: "715", y: "147", width: "50", height: "50" });
    expect(shape("n-003").attrs.isMarkerVisible).toBe("true");
    // n-000 at (0, 0) 160×64 → centre (80, 32), a 36px event.
    expect(bounds("n-000")).toMatchObject({ x: "62", y: "14", width: "36", height: "36" });
    // Tasks keep the laid-out card.
    expect(bounds("n-001")).toMatchObject({ x: "220", y: "140", width: "160", height: "64" });
  });

  it("starts and ends each DI edge on the shapes' borders", () => {
    const doc = parseXml(toBpmnXml(processBoard()).xml);
    const flowId = flatten(doc).find(
      (c) => c.name === "bpmn:sequenceFlow" && c.attrs.sourceRef === "n-001",
    )!.attrs.id;
    const edge = flatten(doc).find(
      (c) => c.name === "bpmndi:BPMNEdge" && c.attrs.bpmnElement === flowId,
    )!;
    const pts = edge.children.map((w) => ({ x: Number(w.attrs.x), y: Number(w.attrs.y) }));
    // n-001 (220,140 160×64) → n-002 (440,0 160×64), no bends: the centre
    // line leaves through n-001's top edge and enters n-002's bottom edge.
    expect(pts).toEqual([
      { x: 350, y: 140 },
      { x: 470, y: 64 },
    ]);
  });

  it("is deterministic and escapes labels", () => {
    const ws = processBoard();
    ws.nodes["n-001"]!.label = 'Pay <&> "now"';
    const a = toBpmnXml(ws);
    const b = toBpmnXml(ws);
    expect(a.xml).toBe(b.xml);
    expect(a.xml).toContain('name="Pay &lt;&amp;&gt; &quot;now&quot;"');
    // …and the escaped label round-trips.
    const back = imported(a.xml);
    expect(back.workspace.nodes["n-001"]!.label).toBe('Pay <&> "now"');
  });

  it("maps the registry and flow vocabulary without warnings", () => {
    const ws = createWorkspace({ diagramKind: "bpmn" });
    const types: Array<[string, string]> = [
      ["entry", "startEvent"],
      ["start", "startEvent"],
      ["exit", "endEvent"],
      ["end", "endEvent"],
      ["choice", "exclusiveGateway"],
      ["decision", "exclusiveGateway"],
      ["gateway", "exclusiveGateway"],
      ["parallel", "parallelGateway"],
      ["task", "task"],
      ["step", "task"],
    ];
    for (const [type] of types) ws.nodes[`x-${type}`] = { id: `x-${type}`, nodeType: type, label: type };
    const { xml, warnings } = toBpmnXml(ws);
    const process = parseXml(xml).children.find((c) => c.name === "bpmn:process")!;
    for (const [type, tag] of types) {
      expect(process.children.find((c) => c.attrs.id === `x-${type}`)!.name).toBe(`bpmn:${tag}`);
    }
    // No lossy warnings; the only ones are "no layout", as nothing was laid out.
    expect(warnings.filter((w) => !w.includes("no layout"))).toEqual([]);
  });

  it("reports unknown node types as task, with a warning", () => {
    const ws = processBoard();
    ws.nodes["n-005"]!.nodeType = "milestone";
    const { warnings } = toBpmnXml(ws);
    expect(warnings.some((w) => w.includes("n-005"))).toBe(true);
  });
});

describe("BPMN import (docs/19 subset)", () => {
  it("round-trips the canonical process in the registry vocabulary; geometry is dropped", () => {
    const board = processBoard();
    const { workspace, graph } = imported(toBpmnXml(board).xml);
    expect(graph.ignored).toEqual([]);
    expect(graph.approximated).toEqual([]);
    expect(Object.keys(workspace.nodes).length).toBe(7);
    expect(Object.keys(workspace.edges).length).toBe(7);
    expect(workspace.diagramKind).toBe("bpmn");
    const registry: Record<string, string> = { entry: "entry", exit: "exit", choice: "choice", step: "task" };
    for (const [id, node] of Object.entries(board.nodes)) {
      expect(workspace.nodes[id]!.label).toBe(node.label);
      expect(workspace.nodes[id]!.nodeType).toBe(registry[node.nodeType]);
      // The layout engine owns geometry: import carries none.
      expect(workspace.nodes[id]!.position).toBeUndefined();
      expect(workspace.nodes[id]!.size).toBeUndefined();
    }
    // Edges are keyed the reducer's way; a branch keeps its condition.
    expect(workspace.edges[edgeId("n-003", "n-004", "no")]).toBeTruthy();
    expect(workspace.edges[edgeId("n-003", "n-005", "yes")]).toBeTruthy();
    expect(workspace.edges[edgeId("n-000", "n-001", "then")]).toBeTruthy();
    expect(workspace.groups["lane-auto"]!.children.sort()).toEqual(["n-001", "n-002"]);
    expect(workspace.nodes["n-002"]!.groupId).toBe("lane-auto");
  });

  it("skips elements outside the subset, reporting them", () => {
    const { xml } = toBpmnXml(processBoard());
    const withData = xml.replace(
      "    <bpmn:sequenceFlow",
      '    <bpmn:dataObjectReference id="d-1"/>\n    <bpmn:textAnnotation id="a-1"/>\n    <bpmn:sequenceFlow',
    );
    const { graph } = imported(withData);
    expect(graph.ignored).toEqual(["dataObjectReference", "textAnnotation"]);
    expect(graph.skipped).toBe(2);
  });

  it("returns a sentence, never a throw, on malformed XML", () => {
    const result = fromBpmnXml("<bpmn:definitions><bpmn:process>");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/^That isn't XML Lucent can read: unterminated/);
  });

  it("reads the model by namespace, whatever the prefix", () => {
    const xml = [
      `<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:b2="http://www.omg.org/spec/BPMN/20100524/MODEL">`,
      `  <process id="P">`,
      `    <startEvent id="s"/>`,
      `    <b2:userTask id="t" name="Review"/>`,
      `    <sequenceFlow id="f" sourceRef="s" targetRef="t"/>`,
      `  </process>`,
      `</definitions>`,
    ].join("\n");
    const parsed = parseBpmn(xml);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.graph.nodes.map((n) => [n.id, n.nodeType])).toEqual([
      ["s", "entry"],
      ["t", "task"],
    ]);
  });
});

function flatten(el: ReturnType<typeof parseXml>): ReturnType<typeof parseXml>[] {
  return el.children.flatMap((c) => [c, ...flatten(c)]);
}
