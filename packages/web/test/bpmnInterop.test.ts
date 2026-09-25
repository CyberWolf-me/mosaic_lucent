import { describe, expect, it } from "vitest";
import {
  applyLayout,
  applyOperations,
  applyRoutes,
  computeLayoutWithRoutes,
  createWorkspace,
  starterFor,
  validateOperations,
  type Operation,
  type Workspace,
} from "@lucent/core";
import { bpmnExportFor, detectBpmn, planBpmnImport } from "../src/board/bpmnInterop.js";
import { parseBpmn, parseXml } from "../src/diagram/bpmn/index.js";

/**
 * BPMN XML in and out as real `bpmn` diagrams (docs/19, V4), the canvas side:
 * an empty board becomes the process, a board with content gains it as a
 * region, the ops validate, and the vocabulary is the registry's both ways.
 */

/** A byte-order mark, as some Windows tools write at the start of a file. */
const BOM = String.fromCharCode(0xfeff);

const NS = `xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC"`;

/** A modeler-style file: a pool, two lanes, vendor extensions, DI. */
const LANED = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions ${NS} xmlns:camunda="http://camunda.org/schema/1.0/bpmn" id="Definitions_1" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:collaboration id="Collab_1">
    <bpmn:participant id="Pool_1" name="Order handling" processRef="Process_1"/>
  </bpmn:collaboration>
  <bpmn:process id="Process_1" isExecutable="true">
    <bpmn:documentation>Handles an order end to end.</bpmn:documentation>
    <bpmn:laneSet id="LaneSet_1">
      <bpmn:lane id="Lane_sales" name="Sales">
        <bpmn:flowNodeRef>Start_1</bpmn:flowNodeRef>
        <bpmn:flowNodeRef>Review_1</bpmn:flowNodeRef>
        <bpmn:flowNodeRef>Gate_1</bpmn:flowNodeRef>
        <bpmn:flowNodeRef>Rejected_1</bpmn:flowNodeRef>
      </bpmn:lane>
      <bpmn:lane id="Lane_wh" name="Warehouse">
        <bpmn:flowNodeRef>Ship_1</bpmn:flowNodeRef>
        <bpmn:flowNodeRef>Done_1</bpmn:flowNodeRef>
      </bpmn:lane>
    </bpmn:laneSet>
    <bpmn:startEvent id="Start_1" name="Order received"/>
    <bpmn:userTask id="Review_1" name="Review order" camunda:assignee="sales">
      <bpmn:extensionElements><camunda:properties/></bpmn:extensionElements>
    </bpmn:userTask>
    <bpmn:exclusiveGateway id="Gate_1" name="Approved?"/>
    <bpmn:serviceTask id="Ship_1" name="Ship order"/>
    <bpmn:endEvent id="Done_1" name="Shipped"/>
    <bpmn:endEvent id="Rejected_1" name="Rejected"/>
    <bpmn:sequenceFlow id="F1" sourceRef="Start_1" targetRef="Review_1"/>
    <bpmn:sequenceFlow id="F2" sourceRef="Review_1" targetRef="Gate_1"/>
    <bpmn:sequenceFlow id="F3" name="yes" sourceRef="Gate_1" targetRef="Ship_1"/>
    <bpmn:sequenceFlow id="F4" name="no" sourceRef="Gate_1" targetRef="Rejected_1"/>
    <bpmn:sequenceFlow id="F5" sourceRef="Ship_1" targetRef="Done_1"/>
  </bpmn:process>
  <bpmndi:BPMNDiagram id="D1">
    <bpmndi:BPMNPlane id="PL1" bpmnElement="Collab_1">
      <bpmndi:BPMNShape id="Start_1_di" bpmnElement="Start_1"><dc:Bounds x="100" y="100" width="36" height="36"/></bpmndi:BPMNShape>
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</bpmn:definitions>`;

/** A one-process document around `body`. */
function doc(body: string, extra = ""): string {
  return `<bpmn:definitions ${NS} id="D">${extra}<bpmn:process id="P">${body}</bpmn:process></bpmn:definitions>`;
}

function laidOut(ops: Operation[], base: Workspace = createWorkspace()): Workspace {
  const ws = applyOperations(base, ops);
  const { layout, routes } = computeLayoutWithRoutes(ws);
  return applyRoutes(applyLayout(ws, layout), routes);
}

function planned(ws: Workspace, xml: string, prefix: string) {
  const plan = planBpmnImport(ws, xml, prefix);
  if (!plan.ok) throw new Error(`plan failed: ${plan.error}`);
  return plan;
}

describe("detectBpmn", () => {
  it("recognises BPMN 2.0 definitions by namespace, whatever the prefix", () => {
    expect(detectBpmn(LANED)).toBe(true);
    expect(
      detectBpmn(
        `<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"><process id="p"/></definitions>`,
      ),
    ).toBe(true);
    expect(
      detectBpmn(
        `${BOM}<?xml version="1.0"?>\n<!-- exported -->\n<bpmn2:definitions id="d" xmlns:bpmn2="http://www.omg.org/spec/BPMN/20100524/MODEL"/>`,
      ),
    ).toBe(true);
    // The 2.0 beta namespace older tools write.
    expect(detectBpmn(`<definitions xmlns='http://schema.omg.org/spec/BPMN/2.0'/>`)).toBe(true);
    // Sniffed past a DOCTYPE, so the import can say why it refuses it.
    expect(detectBpmn(`<!DOCTYPE x [<!ENTITY a "b">]><bpmn:definitions ${NS}/>`)).toBe(true);
  });

  it("says no to everything else", () => {
    expect(detectBpmn("")).toBe(false);
    expect(detectBpmn("flowchart TD\n  A --> B")).toBe(false);
    expect(detectBpmn("Definitions of done: <bpmn> is a format")).toBe(false);
    expect(detectBpmn(`<svg xmlns="http://www.w3.org/2000/svg"/>`)).toBe(false);
    expect(detectBpmn(`<definitions xmlns="urn:something-else"/>`)).toBe(false);
    // The root's prefix must be the one bound to BPMN.
    expect(
      detectBpmn(
        `<foo:definitions xmlns:foo="urn:x" xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"/>`,
      ),
    ).toBe(false);
    expect(detectBpmn(`<bpmn:process ${NS}/>`)).toBe(false);
  });
});

describe("planBpmnImport — onto an empty board", () => {
  it("the board becomes the process; lanes become groups", () => {
    const plan = planned(createWorkspace(), LANED, "t1");
    expect(plan.ops[0]).toEqual({ op: "CREATE_DIAGRAM", kind: "bpmn" });
    expect(plan.ops.slice(1, 3)).toEqual([
      { op: "CREATE_GROUP", id: "t1-Lane_sales", label: "Sales", children: [] },
      { op: "CREATE_GROUP", id: "t1-Lane_wh", label: "Warehouse", children: [] },
    ]);
    expect(plan.nodeIds).toEqual([
      "t1-Start_1",
      "t1-Review_1",
      "t1-Gate_1",
      "t1-Ship_1",
      "t1-Done_1",
      "t1-Rejected_1",
    ]);
    expect(plan.message).toBe("Imported a BPMN process — 6 nodes.");
    expect(validateOperations(createWorkspace(), plan.ops)).toEqual([]);

    const ws = applyOperations(createWorkspace(), plan.ops);
    expect(ws.diagramKind).toBe("bpmn");
    const types = Object.values(ws.nodes).map((n) => [n.label, n.nodeType, n.groupId]);
    expect(types).toEqual([
      ["Order received", "entry", "t1-Lane_sales"],
      ["Review order", "task", "t1-Lane_sales"],
      ["Approved?", "choice", "t1-Lane_sales"],
      ["Ship order", "task", "t1-Lane_wh"],
      ["Shipped", "exit", "t1-Lane_wh"],
      ["Rejected", "exit", "t1-Lane_sales"],
    ]);
    const rels = Object.values(ws.edges).map((e) => `${e.source}>${e.target}:${e.relationship}`);
    expect(rels).toContain("t1-Gate_1>t1-Ship_1:yes");
    expect(rels).toContain("t1-Gate_1>t1-Rejected_1:no");
    expect(rels).toContain("t1-Start_1>t1-Review_1:then");
    expect(rels.length).toBe(5);
  });
});

describe("planBpmnImport — onto a board with content", () => {
  const architecture = () =>
    applyOperations(createWorkspace({ diagramKind: "architecture" }), [
      { op: "CREATE_NODE", id: "api", nodeType: "service", label: "API" },
    ]);

  it("gains a bpmn region, keeps its kind, and flattens the lanes into it", () => {
    const ws = architecture();
    const plan = planned(ws, LANED, "t2");
    expect(validateOperations(ws, plan.ops)).toEqual([]);
    expect(plan.ops[0]).toEqual({
      op: "CREATE_GROUP",
      id: "t2-region",
      label: "Order handling",
      children: [],
      kind: "bpmn",
    });
    // One group: a node has one group, and here that group is the region.
    expect(plan.ops.filter((o) => o.op === "CREATE_GROUP").length).toBe(1);
    for (const op of plan.ops) {
      if (op.op === "CREATE_NODE") expect(op.groupId).toBe("t2-region");
    }
    const next = applyOperations(ws, plan.ops);
    expect(next.diagramKind).toBe("architecture");
    expect(next.groups["t2-region"]).toMatchObject({ kind: "bpmn" });
    expect(next.groups["t2-region"]!.children.length).toBe(6);
    expect(next.nodes.api!.groupId).toBeUndefined();
    expect(plan.message).toBe(
      "Imported a BPMN process — 6 nodes, as its own region. Its lanes were flattened into the region.",
    );
  });

  it("importing the same file twice never collides", () => {
    const once = applyOperations(architecture(), planned(architecture(), LANED, "a").ops);
    const again = planned(once, LANED, "b");
    expect(validateOperations(once, again.ops)).toEqual([]);
    const twice = applyOperations(once, again.ops);
    expect(Object.keys(twice.nodes).length).toBe(1 + 6 + 6);
    expect(Object.values(twice.groups).filter((g) => g.kind === "bpmn").length).toBe(2);
  });

  it("the plan itself refuses ops that would not apply (a reused prefix)", () => {
    const once = applyOperations(architecture(), planned(architecture(), LANED, "a").ops);
    expect(planBpmnImport(once, LANED, "a")).toEqual({
      ok: false,
      error: "That BPMN process couldn't be added to this board.",
    });
  });
});

describe("the registry vocabulary, both ways", () => {
  it("import: events, tasks and gateways land as entry/task/choice/parallel/exit", () => {
    const xml = doc(
      [
        `<bpmn:startEvent id="a"/>`,
        `<bpmn:task id="b"/>`,
        `<bpmn:userTask id="c"/>`,
        `<bpmn:serviceTask id="d"/>`,
        `<bpmn:scriptTask id="e"/>`,
        `<bpmn:manualTask id="f"/>`,
        `<bpmn:businessRuleTask id="g"/>`,
        `<bpmn:sendTask id="h"/>`,
        `<bpmn:receiveTask id="i"/>`,
        `<bpmn:exclusiveGateway id="j"/>`,
        `<bpmn:parallelGateway id="k"/>`,
        `<bpmn:endEvent id="l"/>`,
      ].join(""),
    );
    const parsed = parseBpmn(xml);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(Object.fromEntries(parsed.graph.nodes.map((n) => [n.id, n.nodeType]))).toEqual({
      a: "entry",
      b: "task",
      c: "task",
      d: "task",
      e: "task",
      f: "task",
      g: "task",
      h: "task",
      i: "task",
      j: "choice",
      k: "parallel",
      l: "exit",
    });
    expect(parsed.graph.approximated).toEqual([]);
  });

  it("import: near equivalents come in simplified, and the message says so", () => {
    const xml = doc(
      [
        `<bpmn:startEvent id="s"><bpmn:timerEventDefinition/></bpmn:startEvent>`,
        `<bpmn:inclusiveGateway id="g" default="f2"/>`,
        `<bpmn:userTask id="t" name="Approve"/>`,
        `<bpmn:boundaryEvent id="late" name="2 days" attachedToRef="t"><bpmn:timerEventDefinition/></bpmn:boundaryEvent>`,
        `<bpmn:task id="chase" name="Chase approver"/>`,
        `<bpmn:subProcess id="sub" name="Fulfil"><bpmn:task id="inner"/></bpmn:subProcess>`,
        `<bpmn:dataObjectReference id="data"/>`,
        `<bpmn:sequenceFlow id="f1" sourceRef="s" targetRef="g"/>`,
        `<bpmn:sequenceFlow id="f2" sourceRef="g" targetRef="t"/>`,
        `<bpmn:sequenceFlow id="f3" name="rush" sourceRef="g" targetRef="sub"/>`,
        `<bpmn:sequenceFlow id="f4" sourceRef="late" targetRef="chase"/>`,
      ].join(""),
    );
    const plan = planned(createWorkspace(), xml, "v");
    const ws = applyOperations(createWorkspace(), plan.ops);
    expect(ws.nodes["v-g"]!.nodeType).toBe("choice");
    expect(ws.nodes["v-sub"]!.nodeType).toBe("task");
    expect(ws.nodes["v-late"]!.nodeType).toBe("task");
    expect(ws.nodes["v-inner"]).toBeUndefined(); // collapsed into its sub-process
    const rels = Object.values(ws.edges).map((e) => `${e.source}>${e.target}:${e.relationship}`);
    // The gateway's default flow, and the boundary event hung off its host.
    expect(rels).toContain("v-g>v-t:default");
    expect(rels).toContain("v-g>v-sub:rush");
    expect(rels).toContain("v-t>v-late:timer");
    expect(rels).toContain("v-late>v-chase:then");
    expect(plan.message).toBe(
      "Imported a BPMN process — 6 nodes. Simplified 4 elements to the nearest shape (timer event definition, inclusive gateway, boundary event, …). Skipped 2 elements outside the supported subset (sub process contents, data object reference).",
    );
  });

  it("export → import round-trips the registry starter: nodes, types and edges", () => {
    const board = laidOut(starterFor("bpmn", "s"));
    const file = bpmnExportFor(board);
    expect(file).not.toBeNull();
    const plan = planned(createWorkspace(), file!.xml, "rt");
    expect(validateOperations(createWorkspace(), plan.ops)).toEqual([]);
    const back = applyOperations(createWorkspace(), plan.ops);
    expect(back.diagramKind).toBe("bpmn");
    expect(Object.keys(back.nodes).length).toBe(Object.keys(board.nodes).length);
    for (const node of Object.values(board.nodes)) {
      expect(back.nodes[`rt-${node.id}`]).toMatchObject({
        nodeType: node.nodeType,
        label: node.label,
      });
    }
    // Same endpoints; a condition survives, a bare "next" reads back as "then".
    const shape = (ws: Workspace, strip: (id: string) => string) =>
      Object.values(ws.edges)
        .map((e) => {
          const rel = e.relationship === "next" ? "then" : e.relationship;
          return `${strip(e.source)}>${strip(e.target)}:${rel}`;
        })
        .sort();
    expect(shape(back, (id) => id.replace(/^rt-/, ""))).toEqual(shape(board, (id) => id));
  });

  it("export: a flowchart speaks BPMN without fallbacks", () => {
    const file = bpmnExportFor(laidOut(starterFor("flowchart", "f")))!;
    const process = parseXml(file.xml).children.find((c) => c.name === "bpmn:process")!;
    expect(process.children.map((c) => c.name).filter((n) => n !== "bpmn:sequenceFlow")).toEqual([
      "bpmn:startEvent",
      "bpmn:task",
      "bpmn:endEvent",
    ]);
    expect(file.message).toBe("Exported 3 nodes as BPMN 2.0.");
  });

  it("a flow's name never arrives as one of core's typed relationships", () => {
    // Two flows named "blocks" in a loop would be a dependency cycle the
    // validator refuses; as BPMN they are only labels.
    const xml = doc(
      [
        `<bpmn:task id="a"/><bpmn:task id="b"/>`,
        `<bpmn:sequenceFlow id="f1" name="blocks" sourceRef="a" targetRef="b"/>`,
        `<bpmn:sequenceFlow id="f2" name="blocks" sourceRef="b" targetRef="a"/>`,
        `<bpmn:sequenceFlow id="f3" name="depends_on" sourceRef="a" targetRef="b"/>`,
      ].join(""),
    );
    const plan = planned(createWorkspace(), xml, "r");
    expect(validateOperations(createWorkspace(), plan.ops)).toEqual([]);
    const rels = plan.ops.flatMap((o) => (o.op === "CONNECT_NODES" ? [o.relationship] : []));
    expect(rels).toEqual(["Blocks", "Blocks", "depends on"]);
  });
});

describe("pools and message flows", () => {
  const TWO_POOLS = `<bpmn:definitions ${NS} id="D">
    <bpmn:collaboration id="C">
      <bpmn:participant id="PCust" name="Customer" processRef="P1"/>
      <bpmn:participant id="PShop" name="Shop" processRef="P2"/>
      <bpmn:messageFlow id="M1" sourceRef="order" targetRef="receive"/>
    </bpmn:collaboration>
    <bpmn:process id="P1"><bpmn:startEvent id="want"/><bpmn:sendTask id="order" name="Place order"/>
      <bpmn:sequenceFlow id="a" sourceRef="want" targetRef="order"/></bpmn:process>
    <bpmn:process id="P2"><bpmn:laneSet><bpmn:lane id="L" name="Desk"><bpmn:flowNodeRef>receive</bpmn:flowNodeRef></bpmn:lane></bpmn:laneSet>
      <bpmn:receiveTask id="receive" name="Take order"/><bpmn:endEvent id="done"/>
      <bpmn:sequenceFlow id="b" sourceRef="receive" targetRef="done"/></bpmn:process>
  </bpmn:definitions>`;

  it("several pools become groups on a whole-board import; message flows are edges", () => {
    const plan = planned(createWorkspace(), TWO_POOLS, "m");
    expect(validateOperations(createWorkspace(), plan.ops)).toEqual([]);
    const ws = applyOperations(createWorkspace(), plan.ops);
    expect(Object.values(ws.groups).map((g) => g.label)).toEqual([
      "Customer",
      "Shop · Desk",
      "Shop",
    ]);
    expect(ws.nodes["m-order"]!.groupId).toBe("m-PCust");
    expect(ws.nodes["m-receive"]!.groupId).toBe("m-L");
    expect(ws.nodes["m-done"]!.groupId).toBe("m-PShop");
    expect(Object.values(ws.edges).map((e) => e.relationship)).toContain("message");
  });

  it("…and all flatten into one region on a board with content", () => {
    const board = applyOperations(createWorkspace({ diagramKind: "mindmap" }), [
      { op: "CREATE_NODE", id: "idea", nodeType: "idea", label: "Idea" },
    ]);
    const plan = planned(board, TWO_POOLS, "m");
    const next = applyOperations(board, plan.ops);
    expect(Object.keys(next.groups)).toEqual(["m-region"]);
    expect(next.groups["m-region"]!.label).toBe("BPMN process"); // two pools: no one name
  });
});

describe("bpmnExportFor", () => {
  it("is null when the board holds no process", () => {
    expect(bpmnExportFor(createWorkspace({ diagramKind: "bpmn" }))).toBeNull();
    const arch = laidOut(starterFor("architecture", "a"));
    expect(bpmnExportFor(arch)).toBeNull();
    expect(bpmnExportFor(laidOut(starterFor("mindmap", "m")))).toBeNull();
  });

  it("exports a bpmn board with DI from the laid-out positions", () => {
    const board = laidOut(starterFor("bpmn", "s"));
    board.name = "Returns: v2 / draft";
    const file = bpmnExportFor(board)!;
    expect(file.filename).toBe("Returns v2 draft.bpmn");
    expect(file.message).toBe("Exported 6 nodes as BPMN 2.0.");
    const root = parseXml(file.xml);
    const all = flatten(root);
    expect(all.filter((c) => c.name === "bpmndi:BPMNShape").length).toBe(6);
    expect(all.filter((c) => c.name === "bpmndi:BPMNEdge").length).toBe(5);
    // A task's DI bounds are exactly where the layout put it.
    const task = board.nodes["s-task"]!;
    const bounds = all.find(
      (c) => c.name === "bpmndi:BPMNShape" && c.attrs.bpmnElement === "s-task",
    )!.children[0]!.attrs;
    expect(Number(bounds.x)).toBe(Math.round(task.position!.x));
    expect(Number(bounds.width)).toBe(Math.round(task.size!.width));
  });

  it("lays out first when the board was never laid out", () => {
    const bare = applyOperations(createWorkspace(), starterFor("bpmn", "s"));
    const file = bpmnExportFor(bare)!;
    expect(flatten(parseXml(file.xml)).filter((c) => c.name === "bpmndi:BPMNShape").length).toBe(6);
    expect(file.filename).toBe("lucent-process.bpmn");
  });

  it("exports a BPMN region from another family's board, and only it", () => {
    const arch = laidOut(starterFor("architecture", "a"));
    const withRegion = laidOut(planned(arch, LANED, "t").ops, arch);
    const file = bpmnExportFor(withRegion)!;
    expect(file.filename).toBe("Order handling.bpmn");
    const back = parseBpmn(file.xml);
    if (!back.ok) throw new Error(back.error);
    expect(back.graph.nodes.length).toBe(6);
    expect(back.graph.lanes).toEqual([]); // one region is the process itself
  });

  it("leaves out members of regions drawn as another family", () => {
    const board = laidOut([
      ...starterFor("bpmn", "s"),
      { op: "CREATE_GROUP", id: "mm", label: "Ideas", children: [], kind: "mindmap" },
      { op: "CREATE_NODE", id: "i1", nodeType: "idea", label: "One", groupId: "mm" },
      { op: "CREATE_NODE", id: "i2", nodeType: "idea", label: "Two", groupId: "mm" },
    ]);
    const file = bpmnExportFor(board)!;
    expect(file.message).toBe(
      "Exported 6 nodes as BPMN 2.0. Left out 2 nodes in regions of other kinds.",
    );
    expect(file.xml).not.toContain('name="One"');
  });

  it("exports one region by id, when its kind is a process family", () => {
    const board = laidOut([
      { op: "CREATE_DIAGRAM", kind: "architecture" },
      { op: "CREATE_NODE", id: "api", nodeType: "service", label: "API" },
      { op: "CREATE_GROUP", id: "flow", label: "Signup flow", children: [], kind: "flowchart" },
      { op: "CREATE_NODE", id: "f1", nodeType: "start", label: "Start", groupId: "flow" },
      { op: "CREATE_NODE", id: "f2", nodeType: "step", label: "Sign up", groupId: "flow" },
      { op: "CONNECT_NODES", source: "f1", target: "f2", relationship: "then" },
    ]);
    // Not a bpmn region, so the board as a whole has nothing to export…
    expect(bpmnExportFor(board)).toBeNull();
    // …but asked for by id, the flowchart region is a process.
    const file = bpmnExportFor(board, { regionId: "flow" })!;
    expect(file.filename).toBe("Signup flow.bpmn");
    expect(file.message).toBe("Exported 2 nodes as BPMN 2.0.");
    expect(bpmnExportFor(board, { regionId: "nope" })).toBeNull();
  });
});

function flatten(el: ReturnType<typeof parseXml>): ReturnType<typeof parseXml>[] {
  return el.children.flatMap((c) => [c, ...flatten(c)]);
}
