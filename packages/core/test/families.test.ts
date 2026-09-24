import { describe, expect, it } from "vitest";
import {
  applyOperations,
  computeLayout,
  createWorkspace,
  parseWorkspace,
  safeParseProgrammaticOperations,
  timelineScale,
  timelineTicks,
  type Operation,
  type Workspace,
} from "@lucent/core";

/**
 * docs/27 D1: timeline, matrix and state machine as semantic kinds with their
 * own geometry. The model supplies meaning (dates, cells, transitions); these
 * pin that the engine turns it into the picture people expect.
 */

function board(ops: Operation[]): Workspace {
  return applyOperations(createWorkspace({ name: "T", id: "ws" }), ops);
}
const cx = (l: ReturnType<typeof computeLayout>, id: string) =>
  l[id]!.position.x + l[id]!.size.width / 2;
const cy = (l: ReturnType<typeof computeLayout>, id: string) =>
  l[id]!.position.y + l[id]!.size.height / 2;

describe("the kinds are part of the contract", () => {
  it("parse in ops and survive a stored board", () => {
    for (const kind of ["timeline", "matrix", "statemachine"] as const) {
      expect(safeParseProgrammaticOperations([{ op: "CREATE_DIAGRAM", kind }]).success).toBe(true);
      const ws = board([{ op: "CREATE_DIAGRAM", kind }]);
      const back = parseWorkspace(JSON.parse(JSON.stringify(ws)));
      expect(back.ok && back.workspace.diagramKind).toBe(kind);
    }
  });
});

describe("timeline", () => {
  const dated = (id: string, date: string, lane?: string): Operation[] => [
    { op: "CREATE_NODE", id, nodeType: "task", label: id, ...(lane ? { groupId: lane } : {}) },
    { op: "SET_ISSUE", id, issue: { type: "task", status: "open", dueDate: date } },
  ];

  it("places dated work left to right by date, on the shared scale", () => {
    const ws = board([
      { op: "CREATE_DIAGRAM", kind: "timeline" },
      ...dated("c", "2026-12-01"),
      ...dated("a", "2026-10-01"),
      ...dated("b", "2026-11-01"),
    ]);
    const l = computeLayout(ws);
    expect(cx(l, "a")).toBeLessThan(cx(l, "b"));
    expect(cx(l, "b")).toBeLessThan(cx(l, "c"));
    const s = timelineScale(ws)!;
    expect(cx(l, "a")).toBeCloseTo(0, 5);
    expect(cx(l, "c")).toBeCloseTo(s.span, 5);
    // The axis the canvas draws uses the same mapping: 1 Nov sits where "b" is.
    const nov = timelineTicks(ws).find((t) => t.label === "Nov")!;
    expect(nov.x).toBeCloseTo(cx(l, "b"), 5);
  });

  it("gives each group a lane, and undated items follow the last date", () => {
    const ws = board([
      { op: "CREATE_DIAGRAM", kind: "timeline" },
      { op: "CREATE_GROUP", id: "p", label: "Product", children: [] },
      { op: "CREATE_GROUP", id: "e", label: "Engineering", children: [] },
      ...dated("p1", "2026-10-01", "p"),
      ...dated("e1", "2026-10-15", "e"),
      ...dated("e2", "2026-11-15", "e"),
      { op: "CREATE_NODE", id: "later", nodeType: "task", label: "Someday", groupId: "p" },
    ]);
    const l = computeLayout(ws);
    expect(cy(l, "p1")).toBeLessThan(cy(l, "e1"));
    expect(cy(l, "e1")).toBeCloseTo(cy(l, "e2"), 5);
    expect(cx(l, "later")).toBeGreaterThan(cx(l, "e2"));
  });

  it("drops cards that would overlap in a lane into a sub-row", () => {
    const ws = board([
      { op: "CREATE_DIAGRAM", kind: "timeline" },
      ...dated("x", "2026-10-01"),
      ...dated("y", "2026-10-02"),
      ...dated("z", "2027-03-01"),
    ]);
    const l = computeLayout(ws);
    const [x, y] = [l.x!, l.y!];
    const overlapX =
      x.position.x < y.position.x + y.size.width && y.position.x < x.position.x + x.size.width;
    const overlapY =
      x.position.y < y.position.y + y.size.height && y.position.y < x.position.y + x.size.height;
    expect(overlapX && overlapY).toBe(false);
  });

  it("with fewer than two dates, order alone spaces the cards", () => {
    const ws = board([
      { op: "CREATE_DIAGRAM", kind: "timeline" },
      { op: "CREATE_NODE", id: "s1", nodeType: "task", label: "One" },
      { op: "CREATE_NODE", id: "s2", nodeType: "task", label: "Two" },
      { op: "CONNECT_NODES", source: "s2", target: "s1", relationship: "before" },
    ]);
    expect(timelineScale(ws)).toBeNull();
    expect(timelineTicks(ws)).toEqual([]);
    const l = computeLayout(ws);
    expect(cx(l, "s2")).toBeLessThan(cx(l, "s1"));
  });

  it("labels ticks by week, month or quarter depending on the range", () => {
    const span = (a: string, b: string) =>
      timelineTicks(
        board([{ op: "CREATE_DIAGRAM", kind: "timeline" }, ...dated("a", a), ...dated("b", b)]),
      );
    expect(span("2026-10-01", "2026-10-29")[0]!.label).toMatch(/^Oct \d+$/);
    expect(span("2026-10-01", "2027-02-01").map((t) => t.label)).toEqual([
      "Nov",
      "Dec",
      "Jan 2027",
      "Feb",
    ]);
    expect(span("2026-01-15", "2028-01-15")[0]!.label).toMatch(/^Q\d 20\d\d$/);
  });
});

describe("matrix", () => {
  it("tiles four cells as a 2×2 in reading order, items inside their cell", () => {
    const cells = ["tl", "tr", "bl", "br"];
    const ws = board([
      { op: "CREATE_DIAGRAM", kind: "matrix" },
      ...cells.flatMap((c): Operation[] => [
        { op: "CREATE_GROUP", id: c, label: c, children: [] },
        { op: "CREATE_NODE", id: `${c}1`, nodeType: "idea", label: `${c} one`, groupId: c },
      ]),
      { op: "CREATE_NODE", id: "tl2", nodeType: "idea", label: "tl two", groupId: "tl" },
      { op: "CREATE_NODE", id: "tl3", nodeType: "idea", label: "tl three", groupId: "tl" },
    ]);
    const l = computeLayout(ws);
    // Reading order: top-left is left of top-right and above bottom-left.
    expect(cx(l, "tl1")).toBeLessThan(cx(l, "tr1"));
    expect(cy(l, "tl1")).toBeLessThan(cy(l, "bl1"));
    // Equal cells on one grid: the single-item cells share columns and rows
    // exactly, however full the top-left cell is.
    expect(cx(l, "tr1")).toBeCloseTo(cx(l, "br1"), 5);
    expect(cy(l, "bl1")).toBeCloseTo(cy(l, "br1"), 5);
    expect(cx(l, "bl1")).toBeLessThan(cx(l, "br1"));
    // A cell's items stay in its column: all of top-left is left of top-right.
    for (const id of ["tl1", "tl2", "tl3"]) {
      expect(l[id]!.position.x + l[id]!.size.width).toBeLessThan(l.tr1!.position.x);
    }
  });

  it("lines ungrouped items up under the grid", () => {
    const ws = board([
      { op: "CREATE_DIAGRAM", kind: "matrix" },
      { op: "CREATE_GROUP", id: "a", label: "A", children: [] },
      { op: "CREATE_NODE", id: "in", nodeType: "idea", label: "In", groupId: "a" },
      { op: "CREATE_NODE", id: "out", nodeType: "idea", label: "Loose" },
    ]);
    const l = computeLayout(ws);
    expect(l.out!.position.y).toBeGreaterThan(l.in!.position.y + l.in!.size.height);
  });
});

describe("state machine", () => {
  it("lays states out in transition order", () => {
    const ws = board([
      { op: "CREATE_DIAGRAM", kind: "statemachine" },
      { op: "CREATE_NODE", id: "s", nodeType: "start", label: "Start" },
      { op: "CREATE_NODE", id: "d", nodeType: "state", label: "Draft" },
      { op: "CREATE_NODE", id: "p", nodeType: "state", label: "Published" },
      { op: "CONNECT_NODES", source: "s", target: "d", relationship: "create" },
      { op: "CONNECT_NODES", source: "d", target: "p", relationship: "publish [approved]" },
    ]);
    const l = computeLayout(ws);
    expect(cy(l, "s")).toBeLessThan(cy(l, "d"));
    expect(cy(l, "d")).toBeLessThan(cy(l, "p"));
  });
});
