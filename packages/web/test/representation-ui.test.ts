import { describe, expect, it, vi } from "vitest";
import {
  DIAGRAM_KINDS,
  applyOperations,
  convertibleKinds,
  createWorkspace,
  elkKinds,
  getRepresentation,
  lensFor,
  listRepresentations,
  pseudoRoleFor,
  regionKinds,
  representationLabel,
  validateOperations,
  type DiagramKind,
  type Workspace,
} from "@lucent/core";
import {
  boardIsBlank,
  convertBoardOps,
  lensForKindChange,
  type CanvasLens,
} from "../src/workspace.js";
import {
  canvasTargetAt,
  clientToContent,
  convertSections,
  familyMenuItems,
} from "../src/views/familyMenu.js";
import { menuLevel, type MenuItem } from "../src/views/ContextMenu.js";
import { convertPaletteItems, filterItems } from "../src/ui/palette.js";
import { ELK_KINDS, elkEligible } from "../src/diagram/layoutService.js";
import { ELK_ELIGIBLE_KINDS } from "../src/diagram/elk/elkLayoutEngine.js";
import { bpmnShapeFor } from "../src/scene.js";

/**
 * V4: the web app's family UI reads the representation registry. These pin
 * that every list the UI shows — the lens a kind opens in, the convert and
 * region pickers, ⌘K's conversions, the ELK eligibility, the pseudo-node
 * shapes — is DERIVED from the registry, so one registry entry reaches all of
 * them and none can drift.
 */

const LENS_KINDS = listRepresentations().filter((r) => r.lens !== undefined);

describe("the lens follows the kind (lensForKindChange)", () => {
  it("the registry names at least the sequence and ER lenses", () => {
    expect(lensFor("sequence")).toBe("sequence");
    expect(lensFor("er")).toBe("er");
    expect(LENS_KINDS.length).toBeGreaterThanOrEqual(2);
  });

  it("arriving at a kind with a lens presents it, whatever lens was on screen", () => {
    for (const r of LENS_KINDS) {
      for (const current of ["visual", "kanban", "document", "wireframe"] as CanvasLens[]) {
        expect(lensForKindChange("flowchart", r.kind, current)).toBe(r.lens);
      }
    }
  });

  it("leaving a lens kind returns to visual only when its own lens is showing", () => {
    for (const r of LENS_KINDS) {
      expect(lensForKindChange(r.kind, "flowchart", r.lens!)).toBe("visual");
      // The person's own choice survives a conversion.
      expect(lensForKindChange(r.kind, "flowchart", "kanban")).toBe("kanban");
      expect(lensForKindChange(r.kind, "architecture", "document")).toBe("document");
    }
  });

  it("moving between two lens kinds switches straight across", () => {
    expect(lensForKindChange("sequence", "er", "sequence")).toBe("er");
    expect(lensForKindChange("er", "sequence", "er")).toBe("sequence");
  });

  it("a change between kinds without lenses never touches the lens", () => {
    for (const current of [
      "visual",
      "kanban",
      "document",
      "wireframe",
      "sequence",
    ] as CanvasLens[]) {
      expect(lensForKindChange("flowchart", "statemachine", current)).toBe(current);
    }
  });

  it("no change of kind, no change of lens", () => {
    expect(lensForKindChange("sequence", "sequence", "visual")).toBe("visual");
    expect(lensForKindChange("flowchart", "flowchart", "kanban")).toBe("kanban");
  });

  it("on boot a board's lens replaces only the default visual lens (a ?lens= link wins)", () => {
    expect(lensForKindChange(undefined, "sequence", "visual")).toBe("sequence");
    expect(lensForKindChange(undefined, "er", "visual")).toBe("er");
    expect(lensForKindChange(undefined, "sequence", "kanban")).toBe("kanban");
    expect(lensForKindChange(undefined, "flowchart", "sequence")).toBe("sequence");
    expect(lensForKindChange(undefined, "flowchart", "visual")).toBe("visual");
  });

  it("every kind without a registry lens keeps the visual canvas", () => {
    for (const kind of DIAGRAM_KINDS) {
      if (lensFor(kind)) continue;
      expect(lensForKindChange("sequence", kind, "sequence")).toBe("visual");
    }
  });
});

function withNode(ws: Workspace): Workspace {
  return applyOperations(ws, [{ op: "CREATE_NODE", id: "n1", nodeType: "step", label: "A" }]);
}

describe("converting a board (convertBoardOps)", () => {
  it("a new board is blank; nodes, groups and shapes each make it not blank", () => {
    const ws = createWorkspace();
    expect(boardIsBlank(ws)).toBe(true);
    expect(boardIsBlank(withNode(ws))).toBe(false);
    expect(
      boardIsBlank(
        applyOperations(ws, [{ op: "CREATE_GROUP", id: "g", label: "Lane", children: [] }]),
      ),
    ).toBe(false);
    expect(boardIsBlank({ ...ws, shapes: { s: {} as Workspace["shapes"][string] } })).toBe(false);
  });

  it("a blank board gets the family's starter — for every convertible kind, the current one included", () => {
    const ws = createWorkspace();
    for (const kind of convertibleKinds()) {
      const { ops, seeded } = convertBoardOps(ws, kind, "t1");
      expect(seeded).toBe(true);
      expect(validateOperations(ws, ops)).toEqual([]);
      const next = applyOperations(ws, ops);
      expect(next.diagramKind).toBe(kind);
      expect(Object.keys(next.nodes).length).toBeGreaterThan(0);
    }
    // The default kind is not a no-op on a blank board: it seeds its example.
    expect(convertBoardOps(ws, ws.diagramKind, "t2").seeded).toBe(true);
  });

  it("a board with content — even only an empty group — is transformed, never seeded", () => {
    const grouped = applyOperations(createWorkspace(), [
      { op: "CREATE_GROUP", id: "g", label: "Lane", children: [] },
    ]);
    for (const ws of [withNode(createWorkspace()), grouped]) {
      const { ops, seeded } = convertBoardOps(ws, "statemachine", "t3");
      expect(seeded).toBe(false);
      expect(ops).toEqual([{ op: "TRANSFORM_DIAGRAM", to: "statemachine" }]);
    }
  });
});

/** The choosable rows of a submenu (no headers, separators or Back). */
function choices(items: readonly MenuItem[] | undefined): MenuItem[] {
  return (items ?? []).filter((it) => !it.sep && !it.header);
}

function regionBoard(kind?: DiagramKind): Workspace {
  return applyOperations(createWorkspace(), [
    { op: "CREATE_NODE", id: "a", nodeType: "step", label: "A" },
    { op: "CREATE_GROUP", id: "g", label: "Checkout", children: ["a"] },
    ...(kind ? [{ op: "SET_GROUP_KIND" as const, id: "g", kind }] : []),
  ]);
}

describe("the family pickers read the registry", () => {
  it("'Convert board to…' lists convertibleKinds, grouped by category, summaries as tooltips", () => {
    const ws = withNode(createWorkspace());
    const onConvert = vi.fn();
    const items = familyMenuItems({
      workspace: ws,
      blank: false,
      onConvert,
      onRegionKind: vi.fn(),
    });
    expect(items).toHaveLength(1);
    const convert = items[0]!;
    expect(convert.label).toBe("Convert board to…");
    const rows = choices(convert.submenu);
    expect(rows.map((r) => r.label)).toEqual(
      convertSections().flatMap((s) => s.kinds.map((k) => representationLabel(k))),
    );
    expect(new Set(rows.map((r) => r.label))).toEqual(
      new Set(convertibleKinds().map((k) => representationLabel(k))),
    );
    for (const k of convertibleKinds()) {
      const row = rows.find((r) => r.label === representationLabel(k))!;
      expect(row.title).toBe(getRepresentation(k).summary);
    }
    // One header per category, in the order the categories first appear.
    const headers = (convert.submenu ?? []).filter((r) => r.header).map((r) => r.label);
    expect(headers).toEqual(convertSections().map((s) => s.title));
    expect(headers).toEqual(["Flow & process", "Structure", "Planning"]);
    // Picking a family converts to it.
    rows.find((r) => r.label === "State machine")!.onClick();
    expect(onConvert).toHaveBeenCalledWith("statemachine");
  });

  it("the current kind is marked, and pickable only on a blank board (its starter)", () => {
    const ws = withNode(createWorkspace());
    const current = representationLabel(ws.diagramKind);
    const full = choices(
      familyMenuItems({
        workspace: ws,
        blank: false,
        onConvert: vi.fn(),
        onRegionKind: vi.fn(),
      })[0]!.submenu,
    );
    const mark = full.find((r) => r.label === current)!;
    expect(mark.checked).toBe(true);
    expect(mark.disabled).toBe(true);
    expect(full.filter((r) => r.checked)).toHaveLength(1);

    const blank = choices(
      familyMenuItems({
        workspace: createWorkspace(),
        blank: true,
        onConvert: vi.fn(),
        onRegionKind: vi.fn(),
      })[0]!.submenu,
    );
    expect(blank.find((r) => r.label === current)!.disabled).toBe(false);
  });

  it("a region's picker lists regionKinds — not the convert list — and can go back to the board layout", () => {
    const ws = regionBoard("mindmap");
    const onRegionKind = vi.fn();
    const items = familyMenuItems({
      workspace: ws,
      groupId: "g",
      blank: false,
      onConvert: vi.fn(),
      onRegionKind,
    });
    expect(items.map((i) => i.label)).toEqual([
      'Region "Checkout" — Mind map',
      "Convert board to…",
    ]);
    const rows = choices(items[0]!.submenu);
    const kinds = rows.filter((r) => r.label !== "Back to board layout");
    expect(kinds.map((r) => r.label)).toEqual(regionKinds().map((k) => representationLabel(k)));
    // Families that cannot live inside another board are convert-only.
    for (const k of ["timeline", "matrix", "sequence", "er", "storymap"] as DiagramKind[]) {
      expect(regionKinds()).not.toContain(k);
      expect(convertibleKinds()).toContain(k);
    }
    expect(kinds.find((r) => r.label === "Mind map")!.checked).toBe(true);
    kinds.find((r) => r.label === "Flowchart")!.onClick();
    expect(onRegionKind).toHaveBeenLastCalledWith("g", "flowchart");
    rows.find((r) => r.label === "Back to board layout")!.onClick();
    expect(onRegionKind).toHaveBeenLastCalledWith("g", null);
  });

  it("a node in a plain group offers to make that group a region", () => {
    const onRegionKind = vi.fn();
    const items = familyMenuItems({
      workspace: regionBoard(),
      groupId: "g",
      blank: false,
      onConvert: vi.fn(),
      onRegionKind,
    });
    expect(items[0]!.label).toBe('Make "Checkout" a region');
    const rows = choices(items[0]!.submenu);
    expect(rows.map((r) => r.label)).toEqual(regionKinds().map((k) => representationLabel(k)));
    expect(rows.some((r) => r.checked)).toBe(false);
    rows.find((r) => r.label === "Decision tree")!.onClick();
    expect(onRegionKind).toHaveBeenCalledWith("g", "decisiontree");
  });

  it("a dangling group id falls back to the convert menu alone", () => {
    const items = familyMenuItems({
      workspace: createWorkspace(),
      groupId: "gone",
      blank: true,
      onConvert: vi.fn(),
      onRegionKind: vi.fn(),
    });
    expect(items.map((i) => i.label)).toEqual(["Convert board to…"]);
  });
});

describe("the drill-in menu resolves its level from the current items", () => {
  const leaf = { label: "Leaf", onClick: () => {} };
  const items: MenuItem[] = [
    { label: "Plain", onClick: () => {} },
    { label: "Sub", onClick: () => {}, submenu: [leaf] },
    { label: "Off", onClick: () => {}, submenu: [leaf], disabled: true },
  ];

  it("walks a valid path and names the item that opened it", () => {
    expect(menuLevel(items, [])).toEqual({ items, parent: null, depth: 0 });
    const sub = menuLevel(items, [1]);
    expect(sub.depth).toBe(1);
    expect(sub.parent?.label).toBe("Sub");
    expect(sub.items).toEqual([leaf]);
  });

  it("stops at the deepest level that still resolves", () => {
    expect(menuLevel(items, [0]).depth).toBe(0); // no submenu there
    expect(menuLevel(items, [2]).depth).toBe(0); // disabled
    expect(menuLevel(items, [9]).depth).toBe(0); // gone
    expect(menuLevel(items, [1, 0]).depth).toBe(1);
  });
});

describe("⌘K: one conversion per convertible family", () => {
  it("labels come from the registry, and they wait for a query", () => {
    const items = convertPaletteItems();
    expect(items.map((i) => i.label)).toEqual(
      convertibleKinds().map((k) => `Convert board to ${representationLabel(k)}`),
    );
    expect(items.every((i) => i.run.kind === "convert" && i.group === "action")).toBe(true);
    expect(filterItems(items, "")).toEqual([]);
    expect(filterItems(items, "convert")).toHaveLength(convertibleKinds().length);
  });

  it("the summary is searchable: say what you want to show", () => {
    const hits = filterItems(convertPaletteItems(), "lifecycles");
    expect(hits.map((h) => h.run)).toEqual([{ kind: "convert", to: "statemachine" }]);
  });
});

describe("ELK eligibility is the registry's elk flag", () => {
  it("the service and the region seam read one set: elkKinds()", () => {
    expect(ELK_KINDS).toEqual(new Set(elkKinds()));
    expect(ELK_ELIGIBLE_KINDS).toEqual(new Set(elkKinds()));
  });

  it("a flat board of each kind routes to ELK exactly when the registry says so", () => {
    for (const kind of DIAGRAM_KINDS) {
      const ws = { ...createWorkspace(), diagramKind: kind };
      expect(elkEligible(ws)).toBe(getRepresentation(kind).elk);
    }
  });
});

describe("pseudo-node shapes agree with the layout's pseudoRoleFor", () => {
  const START_SHAPES = new Set(["event", "initial"]);
  const END_SHAPES = new Set(["eventEnd", "final"]);

  it("every pseudo type of every family is drawn as a start or end shape", () => {
    const withPseudo = listRepresentations().filter((r) => r.pseudo);
    expect(withPseudo.map((r) => r.kind)).toEqual(expect.arrayContaining(["bpmn", "statemachine"]));
    for (const r of withPseudo) {
      for (const t of r.pseudo!.start) {
        expect(pseudoRoleFor(r.kind, t)).toBe("start");
        expect(START_SHAPES.has(bpmnShapeFor(t, r.kind) ?? "")).toBe(true);
      }
      for (const t of r.pseudo!.end) {
        expect(pseudoRoleFor(r.kind, t)).toBe("end");
        expect(END_SHAPES.has(bpmnShapeFor(t, r.kind) ?? "")).toBe(true);
      }
    }
  });

  it("a node the layout keeps full-size is never drawn as a pseudo shape", () => {
    for (const r of listRepresentations()) {
      for (const t of [...r.nodeTypes, "step", "decision", "start", "end", "entry", "exit"]) {
        if (pseudoRoleFor(r.kind, t)) continue;
        const shape = bpmnShapeFor(t, r.kind);
        expect(START_SHAPES.has(shape ?? "") || END_SHAPES.has(shape ?? "")).toBe(false);
      }
    }
  });

  it("the conventions: UML dots for the state machine, BPMN events for bpmn", () => {
    expect(bpmnShapeFor("start", "statemachine")).toBe("initial");
    expect(bpmnShapeFor("final", "statemachine")).toBe("final");
    expect(bpmnShapeFor("state", "statemachine")).toBeUndefined();
    expect(bpmnShapeFor("entry", "bpmn")).toBe("event");
    expect(bpmnShapeFor("end", "bpmn")).toBe("eventEnd");
    expect(bpmnShapeFor("parallel", "bpmn")).toBe("gatewayParallel");
    expect(bpmnShapeFor("task", "bpmn")).toBe("task");
    // A family without pseudo types renders its cards untouched.
    expect(bpmnShapeFor("start", "flowchart")).toBeUndefined();
  });
});

describe("what a right-click landed on", () => {
  it("clientToContent inverts the viewport transform (translate + scale about 50%/40%)", () => {
    const box = { left: 50, top: 30, width: 1000, height: 800 };
    const camera = { zoom: 200, pan: { x: 10, y: 20 } };
    // Forward: screen = box + pan + origin + s * (content - origin).
    const content = { x: 100, y: 200 };
    const s = camera.zoom / 100;
    const client = {
      x: box.left + camera.pan.x + 500 + s * (content.x - 500),
      y: box.top + camera.pan.y + 320 + s * (content.y - 320),
    };
    const back = clientToContent(client, box, camera);
    expect(back.x).toBeCloseTo(content.x);
    expect(back.y).toBeCloseTo(content.y);
    expect(
      clientToContent(
        { x: 7, y: 9 },
        { left: 0, top: 0, width: 10, height: 10 },
        { zoom: 100, pan: { x: 0, y: 0 } },
      ),
    ).toEqual({ x: 7, y: 9 });
  });

  const scene = {
    nodes: [
      { id: "n1", cx: 100, cy: 100, w: 160, h: 64 },
      { id: "n2", cx: 400, cy: 100, w: 160, h: 64 },
    ],
    groups: [
      { id: "outer", label: "Outer", x: 0, y: 0, width: 600, height: 400 },
      {
        id: "inner",
        label: "Inner",
        kind: "mindmap" as const,
        x: 300,
        y: 40,
        width: 220,
        height: 140,
      },
    ],
  };

  it("a card names its node; a miss falls back to the board", () => {
    expect(canvasTargetAt(scene, { x: 120, y: 110 }, "node")).toEqual({ kind: "node", id: "n1" });
    expect(canvasTargetAt(scene, { x: 250, y: 110 }, "node")).toEqual({ kind: "background" });
  });

  it("a region's box names the innermost region; its label pill above the box names it too", () => {
    expect(canvasTargetAt(scene, { x: 310, y: 170 }, "region")).toEqual({
      kind: "region",
      id: "inner",
    });
    expect(canvasTargetAt(scene, { x: 50, y: 300 }, "region")).toEqual({
      kind: "region",
      id: "outer",
    });
    expect(canvasTargetAt(scene, { x: 20, y: -5 }, "region")).toEqual({
      kind: "region",
      id: "outer",
    });
    expect(canvasTargetAt(scene, { x: 20, y: -40 }, "region")).toEqual({ kind: "background" });
  });

  it("the empty canvas is the board, whatever lies behind the point", () => {
    expect(canvasTargetAt(scene, { x: 120, y: 110 }, "background")).toEqual({ kind: "background" });
  });
});
