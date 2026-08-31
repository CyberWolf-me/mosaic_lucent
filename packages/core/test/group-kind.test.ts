import { describe, it, expect } from "vitest";
import { createWorkspace, applyOperations, inverseOperations } from "@lucent/core";
import { validateOperations, safeParseOperations, parseWorkspace } from "@lucent/core";
import type { Operation } from "@lucent/core";

const region: Operation[] = [
  { op: "CREATE_NODE", id: "center", nodeType: "topic", label: "Pricing" },
  { op: "CREATE_NODE", id: "tier1", nodeType: "idea", label: "Free" },
  { op: "CREATE_NODE", id: "tier2", nodeType: "idea", label: "Pro" },
  { op: "CONNECT_NODES", source: "center", target: "tier1", relationship: "branch" },
  { op: "CONNECT_NODES", source: "center", target: "tier2", relationship: "branch" },
  {
    op: "CREATE_GROUP",
    id: "pricing",
    label: "Pricing",
    children: ["center", "tier1", "tier2"],
    kind: "mindmap",
  },
];

describe("diagram regions (group kind)", () => {
  it("CREATE_GROUP persists the kind and SET_GROUP_KIND rewrites it", () => {
    const ws = applyOperations(createWorkspace(), region);
    expect(ws.groups.pricing?.kind).toBe("mindmap");

    const changed = applyOperations(ws, [
      { op: "SET_GROUP_KIND", id: "pricing", kind: "orgchart" },
    ]);
    expect(changed.groups.pricing?.kind).toBe("orgchart");
    // Membership and semantics untouched — a kind is a rendering lens only.
    expect(changed.groups.pricing?.children).toEqual(["center", "tier1", "tier2"]);
    expect(Object.keys(changed.edges)).toHaveLength(2);
  });

  it("SET_GROUP_KIND with null dissolves the region back into the board", () => {
    const ws = applyOperations(createWorkspace(), region);
    const cleared = applyOperations(ws, [{ op: "SET_GROUP_KIND", id: "pricing", kind: null }]);
    expect(cleared.groups.pricing?.kind).toBeUndefined();
    expect("kind" in (cleared.groups.pricing ?? {})).toBe(false);
    expect(cleared.groups.pricing?.label).toBe("Pricing");
  });

  it("undo reverts a kind change exactly, including clearing to null", () => {
    const ws = applyOperations(createWorkspace(), region);
    const flip: Operation[] = [{ op: "SET_GROUP_KIND", id: "pricing", kind: "process" }];
    const done = applyOperations(ws, flip);
    const undone = applyOperations(done, inverseOperations(flip, ws));
    expect(undone.groups.pricing?.kind).toBe("mindmap");

    // From a plain group (no kind) to a region, undone back to plain.
    const plain = applyOperations(createWorkspace(), [
      { op: "CREATE_NODE", id: "n1", nodeType: "step", label: "A" },
      { op: "CREATE_GROUP", id: "g", label: "G", children: ["n1"] },
    ]);
    const setOp: Operation[] = [{ op: "SET_GROUP_KIND", id: "g", kind: "journey" }];
    const regioned = applyOperations(plain, setOp);
    expect(regioned.groups.g?.kind).toBe("journey");
    const back = applyOperations(regioned, inverseOperations(setOp, plain));
    expect("kind" in (back.groups.g ?? {})).toBe(false);
  });

  it("deleting a kind-group and undoing recreates it with its kind", () => {
    const ws = applyOperations(createWorkspace(), region);
    const del: Operation[] = [{ op: "DELETE_GROUP", id: "pricing" }];
    const gone = applyOperations(ws, del);
    expect(gone.groups.pricing).toBeUndefined();
    const restored = applyOperations(gone, inverseOperations(del, ws));
    expect(restored.groups.pricing?.kind).toBe("mindmap");
    expect(restored.groups.pricing?.children).toEqual(["center", "tier1", "tier2"]);
  });

  it("rejects SET_GROUP_KIND on a missing group", () => {
    const errors = validateOperations(createWorkspace(), [
      { op: "SET_GROUP_KIND", id: "ghost", kind: "mindmap" },
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain('group "ghost" does not exist');
  });

  it("rejects an unknown kind literal at the schema layer", () => {
    const ops = [{ op: "SET_GROUP_KIND", id: "g", kind: "spiderweb" }] as unknown as Operation[];
    expect(safeParseOperations(ops).success).toBe(false);
  });

  it("workspaceSchema accepts old boards (no kind) and new region boards", () => {
    const legacy = parseWorkspace({
      id: "w",
      name: "W",
      diagramKind: "flowchart",
      groups: { g: { id: "g", label: "G", children: [] } },
    });
    expect(legacy.ok).toBe(true);
    expect(legacy.workspace?.groups.g?.kind).toBeUndefined();

    const modern = parseWorkspace({
      id: "w",
      name: "W",
      diagramKind: "flowchart",
      groups: {
        g: { id: "g", label: "G", children: [], kind: "architecture" },
      },
    });
    expect(modern.ok).toBe(true);
    expect(modern.workspace?.groups.g?.kind).toBe("architecture");

    const bad = parseWorkspace({
      id: "w",
      name: "W",
      diagramKind: "flowchart",
      groups: { g: { id: "g", label: "G", children: [], kind: "nope" } },
    });
    expect(bad.ok).toBe(false);
  });
});
