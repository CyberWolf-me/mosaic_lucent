/**
 * The BPMN adapter, pinned (doc 18 Phase 6, docs/19): the supported subset
 * round-trips both ways, unknown elements are ignored (and reported), and
 * geometry stays out of the imported semantics — the layout engine owns
 * where things go.
 */

import { describe, expect, it } from "vitest";
import { createWorkspace, type Workspace } from "@lucent/core";
import { fromBpmnXml, toBpmnXml } from "../src/diagram/bpmn/index.js";
import { parseXml } from "../src/diagram/bpmn/index.js";

/** The canonical onboarding process, laid out, with one lane. */
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
    ["e-1", "n-000", "n-001"],
    ["e-2", "n-001", "n-002"],
    ["e-3", "n-002", "n-003"],
    ["e-4", "n-003", "n-004"],
    ["e-5", "n-003", "n-005"],
    ["e-6", "n-004", "n-002"],
    ["e-7", "n-005", "n-006"],
  ];
  for (const [id, source, target] of edges) {
    ws.edges[id] = { id, source, target, relationship: "then" };
  }
  // A lane holding the automation steps.
  ws.nodes["n-001"]!.groupId = "lane-auto";
  ws.nodes["n-002"]!.groupId = "lane-auto";
  ws.groups["lane-auto"] = { id: "lane-auto", label: "Automation", children: ["n-001", "n-002"] };
  return ws;
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
  });

  it("emits lanes from groups with flowNodeRef membership", () => {
    const { xml } = toBpmnXml(processBoard());
    const doc = parseXml(xml);
    const lane = flatten(doc).find((c) => c.name === "bpmn:lane")!;
    expect(lane.attrs.id).toBe("lane-auto");
    const refs = lane.children.filter((c) => c.name === "bpmn:flowNodeRef");
    expect(refs.map((r) => r.text).sort()).toEqual(["n-001", "n-002"]);
  });

  it("is deterministic and escapes labels", () => {
    const ws = processBoard();
    ws.nodes["n-001"]!.label = 'Pay <&> "now"';
    const a = toBpmnXml(ws);
    const b = toBpmnXml(ws);
    expect(a.xml).toBe(b.xml);
    expect(a.xml).toContain('name="Pay &lt;&amp;&gt; &quot;now&quot;"');
    // …and the escaped label round-trips.
    const back = fromBpmnXml(a.xml);
    expect(back.workspace.nodes["n-001"]!.label).toBe('Pay <&> "now"');
  });

  it("reports unknown node types as task, with a warning", () => {
    const ws = processBoard();
    ws.nodes["n-005"]!.nodeType = "milestone";
    const { warnings } = toBpmnXml(ws);
    expect(warnings.some((w) => w.includes("n-005"))).toBe(true);
  });
});

describe("BPMN import (docs/19 subset)", () => {
  it("round-trips the canonical process; geometry is dropped", () => {
    const exported = toBpmnXml(processBoard());
    const { workspace, ignored } = fromBpmnXml(exported.xml);
    expect(ignored).toEqual([]);
    expect(Object.keys(workspace.nodes).length).toBe(7);
    expect(Object.keys(workspace.edges).length).toBe(7);
    expect(workspace.diagramKind).toBe("process");
    for (const [id, node] of Object.entries(processBoard().nodes)) {
      expect(workspace.nodes[id]!.label).toBe(node.label);
      expect(workspace.nodes[id]!.nodeType).toBe(node.nodeType);
      // The layout engine owns geometry: import carries none.
      expect(workspace.nodes[id]!.position).toBeUndefined();
      expect(workspace.nodes[id]!.size).toBeUndefined();
    }
    expect(workspace.edges["e-4"]!.source).toBe("n-003");
    expect(workspace.edges["e-4"]!.target).toBe("n-004");
    expect(workspace.groups["lane-auto"]!.children.sort()).toEqual(["n-001", "n-002"]);
    expect(workspace.nodes["n-002"]!.groupId).toBe("lane-auto");
  });

  it("ignores elements outside the subset, reporting them", () => {
    const { xml } = toBpmnXml(processBoard());
    const withTimer = xml.replace(
      "    <bpmn:sequenceFlow",
      '    <bpmn:timerEventDefinition id="t-1"/>\n    <bpmn:sequenceFlow',
    );
    const { ignored } = fromBpmnXml(withTimer);
    expect(ignored).toContain("bpmn:timerEventDefinition");
  });

  it("throws a positioned error on malformed XML", () => {
    expect(() => fromBpmnXml("<bpmn:definitions><bpmn:process>")).toThrow(/xml parse/);
  });
});

function flatten(el: ReturnType<typeof parseXml>): ReturnType<typeof parseXml>[] {
  return el.children.flatMap((c) => [c, ...flatten(c)]);
}
