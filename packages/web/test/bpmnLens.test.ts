/**
 * The BPMN V1 core subset (docs/19), pinned: the `bpmn` diagram kind is a
 * first-class lens — accepted by the operation contract, laid out, and
 * round-tripped through the XML adapter including the parallel gateway.
 * Everything here is Lucent's own code and the OMG standard's element names;
 * no bpmn.io code exists in this repo (doc 19's decision).
 */

import { describe, expect, it } from "vitest";
import {
  applyLayout,
  applyOperations,
  computeLayout,
  createWorkspace,
  safeParseOperations,
} from "@lucent/core";
import { toBpmnXml, fromBpmnXml } from "../src/diagram/bpmn/index.js";
import { bpmnShapeFor } from "../src/scene.js";
import { elkEligible } from "../src/diagram/layoutService.js";

/** The canonical onboarding process from the advisory's example. */
const onboarding: Array<Parameters<typeof applyOperations>[1][number]> = [
  { op: "CREATE_DIAGRAM", kind: "bpmn" },
  { op: "CREATE_NODE", id: "s0", nodeType: "entry", label: "Sign up" },
  { op: "CREATE_NODE", id: "s1", nodeType: "task", label: "Verify email" },
  { op: "CREATE_NODE", id: "s2", nodeType: "choice", label: "Verified?" },
  { op: "CREATE_NODE", id: "s3", nodeType: "task", label: "Resend email" },
  { op: "CREATE_NODE", id: "s4", nodeType: "parallel", label: "Provision" },
  { op: "CREATE_NODE", id: "s5", nodeType: "exit", label: "Active" },
  { op: "CONNECT_NODES", source: "s0", target: "s1", relationship: "then" },
  { op: "CONNECT_NODES", source: "s1", target: "s2", relationship: "then" },
  { op: "CONNECT_NODES", source: "s2", target: "s3", relationship: "then" },
  { op: "CONNECT_NODES", source: "s2", target: "s4", relationship: "then" },
  { op: "CONNECT_NODES", source: "s3", target: "s1", relationship: "then" },
  { op: "CONNECT_NODES", source: "s4", target: "s5", relationship: "then" },
];

describe("the bpmn diagram kind in the operation contract", () => {
  it("CREATE_DIAGRAM accepts kind: bpmn (schema, validator, model)", () => {
    const parsed = safeParseOperations(onboarding);
    expect(parsed.success).toBe(true);
    const ws = applyOperations(createWorkspace(), onboarding);
    expect(ws.diagramKind).toBe("bpmn");
    expect(Object.keys(ws.nodes).length).toBe(6);
    expect(ws.edges["s0->s1:then"]).toBeTruthy();
  });

  it("a bpmn board lays out to finite geometry under the layered strategy", () => {
    const ws = applyOperations(createWorkspace(), onboarding);
    const layout = computeLayout(ws);
    expect(Object.keys(layout).length).toBe(6);
    for (const entry of Object.values(layout)) {
      expect(Number.isFinite(entry.position.x)).toBe(true);
      expect(Number.isFinite(entry.position.y)).toBe(true);
    }
  });

  it("SET_GROUP_KIND can turn a region into a bpmn lens", () => {
    const ops = [
      ...onboarding.slice(1).map((op) => ({ ...op })),
      { op: "CREATE_GROUP", id: "proc", label: "Onboarding", children: ["s0", "s1"], kind: "bpmn" },
    ] as typeof onboarding;
    const ws = applyOperations(createWorkspace(), ops);
    expect(ws.groups["proc"]?.kind).toBe("bpmn");
  });
});

describe("the BPMN lens mapping (docs/19 V1 core)", () => {
  it("shapes render only under the bpmn lens; other boards unchanged", () => {
    expect(bpmnShapeFor("entry", "bpmn")).toBe("event");
    expect(bpmnShapeFor("start", "bpmn")).toBe("event");
    expect(bpmnShapeFor("exit", "bpmn")).toBe("eventEnd");
    expect(bpmnShapeFor("choice", "bpmn")).toBe("gateway");
    expect(bpmnShapeFor("gateway", "bpmn")).toBe("gateway");
    expect(bpmnShapeFor("decision", "bpmn")).toBe("gateway");
    expect(bpmnShapeFor("parallel", "bpmn")).toBe("gatewayParallel");
    expect(bpmnShapeFor("step", "bpmn")).toBe("task");
    expect(bpmnShapeFor("anything-else", "bpmn")).toBe("task"); // honest fallback
    // The lens decides — the same node under other kinds is the ordinary card.
    expect(bpmnShapeFor("entry", "flowchart")).toBeUndefined();
    expect(bpmnShapeFor("parallel", "process")).toBeUndefined();
    expect(bpmnShapeFor("entry", undefined)).toBeUndefined();
  });
});

describe("BPMN V1 core round-trip (incl. the parallel gateway)", () => {
  it("parallel gateways survive export and import", () => {
    // Doc 19's contract: export runs on the LAID-OUT workspace (DI bounds
    // derive from the layout, like Edge.route derives from the engine).
    const bare = applyOperations(createWorkspace(), onboarding);
    const ws = applyLayout(bare, computeLayout(bare));
    const { xml, warnings } = toBpmnXml(ws);
    expect(warnings).toEqual([]);
    expect(xml).toContain("parallelGateway");
    const back = fromBpmnXml(xml);
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.graph.ignored).toEqual([]);
    expect(back.workspace.diagramKind).toBe("bpmn");
    expect(back.workspace.nodes["s4"]!.nodeType).toBe("parallel");
    expect(back.workspace.nodes["s2"]!.nodeType).toBe("choice");
    expect(back.workspace.nodes["s1"]!.nodeType).toBe("task");
    expect(back.workspace.nodes["s0"]!.nodeType).toBe("entry");
    expect(back.workspace.nodes["s5"]!.nodeType).toBe("exit");
    expect(Object.keys(back.workspace.edges).length).toBe(6);
  });
});

describe("bpmn boards route to ELK (ADR 0039 hybrid)", () => {
  it("a bpmn board is ELK-eligible; a mixed board with a bpmn-foreign region is not", () => {
    const ws = applyOperations(createWorkspace(), onboarding);
    expect(elkEligible(ws)).toBe(true);
    const mixed = applyOperations(createWorkspace(), [
      ...onboarding.slice(1),
      { op: "CREATE_GROUP", id: "mind-island", label: "Mind", children: [], kind: "mindmap" },
    ] as typeof onboarding);
    expect(elkEligible(mixed)).toBe(false);
  });
});
