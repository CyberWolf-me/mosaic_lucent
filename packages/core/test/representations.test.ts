import { describe, it, expect } from "vitest";
import {
  DIAGRAM_KINDS,
  REPRESENTATIONS,
  aiCreatableKinds,
  applyOperations,
  computeLayout,
  convertibleKinds,
  createWorkspace,
  elkKinds,
  getRepresentation,
  lensFor,
  listRepresentations,
  layoutStrategyFor,
  pseudoRoleFor,
  regionKinds,
  representationCatalogPrompt,
  representationLabel,
  routeStyleFor,
  starterFor,
  validateOperations,
  type DiagramKind,
} from "../src/index.js";

/**
 * V4 (docs/26 §6.1): the representation registry is the single table that
 * defines every diagram family. These pin that it stays total over
 * `DiagramKind`, that the layout and routing tables are genuinely derived from
 * it (not a second copy that could drift), and that the derived values match
 * the pre-registry behavior.
 */

describe("representation registry", () => {
  it("has exactly one entry per diagram kind, keyed by that kind", () => {
    expect(Object.keys(REPRESENTATIONS).sort()).toEqual([...DIAGRAM_KINDS].sort());
    for (const kind of DIAGRAM_KINDS) {
      expect(REPRESENTATIONS[kind].kind).toBe(kind);
      expect(REPRESENTATIONS[kind].label.length).toBeGreaterThan(0);
      expect(REPRESENTATIONS[kind].summary.length).toBeGreaterThan(0);
    }
  });

  it("lists representations in DIAGRAM_KINDS order", () => {
    expect(listRepresentations().map((r) => r.kind)).toEqual([...DIAGRAM_KINDS]);
  });

  it("layoutStrategyFor and routeStyleFor read from the registry", () => {
    for (const kind of DIAGRAM_KINDS) {
      expect(layoutStrategyFor(kind)).toBe(REPRESENTATIONS[kind].layout);
      expect(routeStyleFor(kind)).toBe(REPRESENTATIONS[kind].route);
    }
  });

  it("preserves the pre-registry layout strategies (regression guard)", () => {
    const expected: Record<DiagramKind, string> = {
      flowchart: "layered",
      architecture: "layered",
      journey: "layered",
      mindmap: "radial",
      decisiontree: "tree",
      orgchart: "tree",
      process: "swimlane",
      bpmn: "layered",
      timeline: "timeline",
      matrix: "grid",
      statemachine: "layered",
      dependency: "layered",
      c4: "layered",
      network: "layered",
      sequence: "layered",
      er: "layered",
      class: "layered",
      storymap: "grid",
    };
    for (const kind of DIAGRAM_KINDS) {
      expect(layoutStrategyFor(kind)).toBe(expected[kind]);
    }
  });

  it("preserves the pre-registry (benchmark) route styles (regression guard)", () => {
    const expected: Record<DiagramKind, string> = {
      flowchart: "ortho",
      architecture: "ortho",
      journey: "ortho",
      mindmap: "polyline",
      decisiontree: "polyline",
      process: "ortho",
      orgchart: "polyline",
      bpmn: "ortho",
      timeline: "polyline",
      matrix: "polyline",
      statemachine: "ortho",
      dependency: "ortho",
      c4: "ortho",
      network: "ortho",
      sequence: "polyline",
      er: "ortho",
      class: "ortho",
      storymap: "polyline",
    };
    for (const kind of DIAGRAM_KINDS) {
      expect(routeStyleFor(kind)).toBe(expected[kind]);
    }
  });

  it("exposes every family as convertible and AI-creatable, closing the old 7-of-11 gap", () => {
    // The pre-V4 region picker offered only 7 kinds; V4 makes the newer
    // families (bpmn, timeline, matrix, statemachine) first-class targets too.
    for (const kind of ["bpmn", "timeline", "matrix", "statemachine"] as const) {
      expect(convertibleKinds()).toContain(kind);
      expect(aiCreatableKinds()).toContain(kind);
    }
  });

  it("registers the V4 graph/architecture variants", () => {
    for (const kind of ["dependency", "c4", "network"] as const) {
      expect(DIAGRAM_KINDS).toContain(kind);
      expect(getRepresentation(kind).category).toBe("structure");
      expect(convertibleKinds()).toContain(kind);
      expect(aiCreatableKinds()).toContain(kind);
    }
  });

  it("registers sequence and ER as creatable, convertible kinds (presented via lenses)", () => {
    for (const kind of ["sequence", "er"] as const) {
      expect(DIAGRAM_KINDS).toContain(kind);
      expect(convertibleKinds()).toContain(kind);
      expect(aiCreatableKinds()).toContain(kind);
    }
  });

  it("labels every kind and getRepresentation is total", () => {
    for (const kind of DIAGRAM_KINDS) {
      expect(representationLabel(kind)).toBe(getRepresentation(kind).label);
    }
  });

  it("every family names its node vocabulary, and its starter speaks it", () => {
    for (const spec of listRepresentations()) {
      expect(spec.nodeTypes.length, spec.kind).toBeGreaterThan(0);
      const used = spec
        .starter("t")
        .flatMap((op) => (op.op === "CREATE_NODE" ? [op.nodeType] : []));
      for (const t of used) expect(spec.nodeTypes, `${spec.kind}: ${t}`).toContain(t);
    }
  });

  it("pseudo-nodes are one answer for the layout and the canvas", () => {
    expect(pseudoRoleFor("statemachine", "start")).toBe("start");
    expect(pseudoRoleFor("statemachine", "final")).toBe("end");
    // An entry point is a real state in a state machine, not a dot.
    expect(pseudoRoleFor("statemachine", "entry")).toBeNull();
    expect(pseudoRoleFor("bpmn", "entry")).toBe("start");
    expect(pseudoRoleFor("bpmn", "exit")).toBe("end");
    expect(pseudoRoleFor("bpmn", "initial")).toBeNull();
    expect(pseudoRoleFor("flowchart", "start")).toBeNull();

    // The layout shrinks exactly the registry's pseudo-nodes.
    const ws = applyOperations(createWorkspace(), [
      { op: "CREATE_DIAGRAM", kind: "statemachine" },
      { op: "CREATE_NODE", id: "s", nodeType: "start", label: "Start" },
      { op: "CREATE_NODE", id: "e", nodeType: "entry", label: "Entry point" },
      { op: "CONNECT_NODES", source: "s", target: "e", relationship: "go" },
    ]);
    const layout = computeLayout(ws);
    expect(layout.s?.size.width).toBe(36);
    expect(layout.e?.size.width).toBeGreaterThan(36);
  });

  it("only group-independent, canvas-drawn families are offered as regions", () => {
    const regions = regionKinds();
    for (const kind of ["matrix", "timeline", "storymap", "sequence", "er"] as const) {
      expect(regions).not.toContain(kind);
    }
    for (const kind of ["flowchart", "mindmap", "orgchart", "process", "c4"] as const) {
      expect(regions).toContain(kind);
    }
  });

  it("sequence and ER open in their lenses; ELK takes the layered structure families", () => {
    expect(lensFor("sequence")).toBe("sequence");
    expect(lensFor("er")).toBe("er");
    expect(lensFor("flowchart")).toBeUndefined();
    const elk = elkKinds();
    for (const kind of ["flowchart", "architecture", "bpmn", "c4", "network", "class"] as const) {
      expect(elk).toContain(kind);
    }
    expect(elk).not.toContain("mindmap");
  });

  it("the catalog carries each family's construction rules under its line", () => {
    const text = representationCatalogPrompt();
    const at = text.indexOf("- matrix —");
    expect(at).toBeGreaterThan(-1);
    expect(text.slice(at)).toMatch(/- matrix —[^\n]*\n {4}One CREATE_GROUP per cell/);
    expect(text).toContain("- class —");
    expect(text).toContain("- storymap —");
  });
});

describe("representationCatalogPrompt", () => {
  const catalog = representationCatalogPrompt();

  it("names every AI-creatable family so the model reads them from the registry", () => {
    for (const kind of aiCreatableKinds()) {
      expect(catalog).toContain(`- ${kind} —`);
    }
  });

  it("mentions the operations it drives", () => {
    expect(catalog).toContain("CREATE_DIAGRAM");
    expect(catalog).toContain("TRANSFORM_DIAGRAM");
  });
});

describe("registered families lay out through the engine", () => {
  it("computes a layout for a board of every kind without throwing", () => {
    for (const kind of DIAGRAM_KINDS) {
      const ws = createWorkspace();
      ws.diagramKind = kind;
      ws.nodes = {
        a: { id: "a", nodeType: "step", label: "A" },
        b: { id: "b", nodeType: "step", label: "B" },
      };
      ws.edges = { e: { id: "e", source: "a", target: "b", relationship: "next" } };
      const layout = computeLayout(ws);
      expect(layout.a?.position).toBeDefined();
      expect(layout.b?.position).toBeDefined();
    }
  });
});

describe("starter templates", () => {
  it("every family has a starter whose first op creates that diagram kind", () => {
    for (const kind of DIAGRAM_KINDS) {
      const ops = starterFor(kind, "seed");
      expect(ops.length).toBeGreaterThan(0);
      expect(ops[0]).toEqual({ op: "CREATE_DIAGRAM", kind });
    }
  });

  it("every starter applies cleanly through the validator and reducer, and lays out", () => {
    for (const kind of DIAGRAM_KINDS) {
      const ops = starterFor(kind, "seed");
      // Valid against the op contract...
      expect(validateOperations(createWorkspace(), ops)).toEqual([]);
      // ...and reduces to a board of the right kind with real nodes.
      const ws = applyOperations(createWorkspace(), ops);
      expect(ws.diagramKind).toBe(kind);
      expect(Object.keys(ws.nodes).length).toBeGreaterThan(0);
      // Every node lands with a position from the engine.
      const layout = computeLayout(ws);
      for (const id of Object.keys(ws.nodes)) {
        expect(layout[id]?.position).toBeDefined();
      }
    }
  });

  it("namespaces ids by prefix so two inserts never collide", () => {
    const a = starterFor("flowchart", "one");
    const b = starterFor("flowchart", "two");
    const merged = createWorkspace();
    // Both batches validate against a fresh board; distinct prefixes mean the
    // second batch introduces no id already present from the first.
    expect(validateOperations(merged, a)).toEqual([]);
    const after = applyOperations(merged, a);
    expect(validateOperations(after, b)).toEqual([]);
  });
});
