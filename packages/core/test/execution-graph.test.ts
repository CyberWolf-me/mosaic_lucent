import { describe, expect, it } from "vitest";
import type { Operation } from "../src/model.js";
import {
  applyOperations,
  createWorkspace,
  DEPENDENCY_RELATIONSHIPS,
  dependencyReaches,
  derivedExecution,
  dependsOnGraph,
  inverseOperations,
  isOverdueUnfinished,
  stampAuthorship,
  validateOperations,
} from "../src/index.js";

/**
 * The execution graph (Stage D3, ADR 0029). The contract: dependencies are
 * typed relationships on existing edges; depends_on is canonical and blocks
 * normalizes to it; cycles are rejected at the authoritative validator (caught
 * within one batch); derived blocking is computed-on-read — manual state
 * (issue.status) and derived state (blockedBy/atRiskBy) never merge; at-risk
 * includes blocked-but-overdue upstream (trouble compounds); propagation
 * walks executable nodes only; and recovery is re-computation — nothing
 * derived is ever stored.
 */

const NOW = Date.UTC(2026, 8, 9, 12, 0); // 2026-09-09

function action(id: string, fields: { status?: string; dueDate?: string } = {}): Operation[] {
  return [
    { op: "CREATE_NODE", id, nodeType: "action", label: id.replace(/-/g, " ") },
    { op: "SET_STATEMENT", id, statement: { kind: "action", status: "open" } },
    {
      op: "SET_ISSUE",
      id,
      issue: { type: "task", status: fields.status ?? "open", ...(fields.dueDate ? { dueDate: fields.dueDate } : {}) },
    },
  ];
}

function depends(a: string, b: string): Operation {
  return { op: "CONNECT_NODES", source: a, target: b, relationship: "depends_on" };
}

function board(ops: Operation[]) {
  return applyOperations(createWorkspace(), stampAuthorship(ops, "test-user"));
}

/**
 * Split a fixture into (seed-ops, check-ops): everything up to the first
 * CONNECT_NODES seeds the board; the CONNECT/DISCONNECT ops validate
 * against it. This is the pattern the D2/D1 tests use — the validator sees
 * the batch the way a real caller submits it (the graph ops against
 * existing nodes), never re-running the creates.
 */
function split(ops: Operation[]): { seed: Operation[]; check: Operation[] } {
  const first = ops.findIndex((o) => o.op === "CONNECT_NODES" || o.op === "DISCONNECT_NODES");
  if (first === -1) return { seed: ops, check: [] };
  return { seed: ops.slice(0, first), check: ops.slice(first) };
}

function validateFixture(ops: Operation[]) {
  const { seed, check } = split(ops);
  const ws = board(seed);
  return { ws, errors: validateOperations(ws, stampAuthorship(check, "test-user")) };
}

describe("dependsOnGraph — the normalized upstream adjacency", () => {
  it('depends_on is canonical; blocks normalizes to the same form', () => {
    const ws = board([
      ...action('impl'),
      ...action('design'),
      ...action('qa'),
      depends('impl', 'design'),
      { op: 'CONNECT_NODES', source: 'design', target: 'qa', relationship: 'blocks' },
      { op: 'CREATE_NODE', id: 'x', nodeType: 'step', label: 'X' },
      { op: 'CREATE_NODE', id: 'y', nodeType: 'step', label: 'Y' },
      { op: 'CONNECT_NODES', source: 'x', target: 'y', relationship: 'related_to' },
    ]);
    const deps = dependsOnGraph(ws);
    expect(deps.get('impl')).toEqual(['design']);
    expect(deps.get('qa')).toEqual(['design']);
    expect(deps.get('x')).toBeUndefined();
    expect(deps.has('y')).toBe(false);
  });

  it("dependencyReaches walks transitively, seen-bounded", () => {
    const adj = new Map([
      ["c", ["b"]],
      ["b", ["a"]],
      ["a", []],
    ]);
    expect(dependencyReaches(adj, "c", "a")).toBe(true);
    expect(dependencyReaches(adj, "a", "c")).toBe(false);
    // A cyclic adjacency cannot hang the walk.
    const cyclic = new Map([
      ["a", ["b"]],
      ["b", ["a"]],
    ]);
    expect(dependencyReaches(cyclic, "a", "a")).toBe(true); // upstream loops back
    expect(dependencyReaches(cyclic, "a", "b")).toBe(true);
  });
});

describe("the validator's cycle rule", () => {
  it("the acceptance batch: 10 tasks, 6 dependencies — all land", () => {
    const ops: Operation[] = [];
    const tasks = ["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8", "t9", "t10"];
    for (const t of tasks) ops.push(...action(t));
    ops.push(depends("t2", "t1"), depends("t3", "t2"), depends("t4", "t3"));
    ops.push(depends("t6", "t5"), depends("t7", "t6"), depends("t8", "t7"));
    expect(validateFixture(ops).errors).toEqual([]);
  });

  it("rejects a cycle formed WITHIN one batch — names the cycle", () => {
    const ops: Operation[] = [
      ...action("a"),
      ...action("b"),
      ...action("c"),
      depends("a", "b"),
      depends("b", "c"),
      depends("c", "a"), // the cycle-closer
    ];
    const { errors } = validateFixture(ops);
    expect(errors.length).toBe(1);
    expect(errors[0]!.message).toContain("would form a cycle");
    expect(errors[0]!.message).toContain("c");
  });

  it("rejects a cycle across spellings: depends_on + blocks forming a loop", () => {
    // a depends_on b; then b blocks a ≡ a depends_on b — same edge, no
    // cycle. The real mixed-form cycle: a depends_on b, b depends_on c,
    // then a blocks c (≡ c depends_on a).
    const ops: Operation[] = [
      ...action("a"),
      ...action("b"),
      ...action("c"),
      depends("a", "b"),
      depends("b", "c"),
      { op: "CONNECT_NODES", source: "a", target: "c", relationship: "blocks" },
    ];
    const { errors } = validateFixture(ops);
    expect(errors.length).toBe(1);
    expect(errors[0]!.message).toContain("cycle");
  });

  it("related_to never cycles — any direction, any loop", () => {
    const ops: Operation[] = [
      ...action("a"),
      ...action("b"),
      { op: "CONNECT_NODES", source: "a", target: "b", relationship: "related_to" },
      { op: "CONNECT_NODES", source: "b", target: "a", relationship: "related_to" },
    ];
    expect(validateFixture(ops).errors).toEqual([]);
  });

  it("a cycle against PRE-EXISTING edges is also rejected", () => {
    const ws = board([
      ...action("a"),
      ...action("b"),
      depends("a", "b"),
    ]);
    const errors = validateOperations(ws, stampAuthorship([depends("b", "a")], "test-user"));
    expect(errors.length).toBe(1);
  });

  it("disconnect removes from the simulated adjacency — re-linking after a disconnect is valid", () => {
    const ws = board([
      ...action("a"),
      ...action("b"),
      depends("a", "b"),
    ]);
    const ops: Operation[] = [
      { op: "DISCONNECT_NODES", source: "a", target: "b", relationship: "depends_on" },
      depends("b", "a"), // valid only because the first edge is gone
    ];
    expect(validateOperations(ws, stampAuthorship(ops, "test-user"))).toEqual([]);
  });
});

describe("derivedExecution — computed project truth", () => {
  it("the owner's chain: Design blocked → Implementation, QA, Release all derived-blocked", () => {
    const ws = board([
      ...action("design", { status: "blocked" }),
      ...action("implementation"),
      ...action("qa"),
      ...action("release"),
      depends("implementation", "design"),
      depends("qa", "implementation"),
      depends("release", "qa"),
    ]);
    const derived = derivedExecution(ws, NOW);
    expect(derived.get("design")).toEqual({ blockedBy: [], atRiskBy: [] });
    expect(derived.get("implementation")).toEqual({ blockedBy: ["design"], atRiskBy: [] });
    expect(derived.get("qa")).toEqual({ blockedBy: ["design"], atRiskBy: [] });
    expect(derived.get("release")).toEqual({ blockedBy: ["design"], atRiskBy: [] });
  });

  it("THE DIAMOND: A blocked → B and C blocked, D blocked with the deduplicated set", () => {
    const ws = board([
      ...action("a", { status: "blocked" }),
      ...action("b"),
      ...action("c"),
      ...action("d"),
      depends("b", "a"),
      depends("c", "a"),
      depends("d", "b"),
      depends("d", "c"),
    ]);
    const derived = derivedExecution(ws, NOW);
    expect(derived.get("b")!.blockedBy).toEqual(["a"]);
    expect(derived.get("c")!.blockedBy).toEqual(["a"]);
    // D reaches A via BOTH paths but lists it once — the seen-set proof.
    expect(derived.get("d")!.blockedBy).toEqual(["a"]);
  });

  it("RECOVERY (blocked): upstream completed → derived state vanishes, not sticky", () => {
    const ws = board([
      ...action("a", { status: "blocked" }),
      ...action("b"),
      ...action("c"),
      depends("b", "a"),
      depends("c", "b"),
    ]);
    expect(derivedExecution(ws, NOW).get("c")!.blockedBy).toEqual(["a"]);
    const recovered = applyOperations(ws, stampAuthorship([{ op: "UPDATE_ISSUE", id: "a", status: "completed" }], "test-user"));
    const derived = derivedExecution(recovered, NOW);
    expect(derived.get("b")).toEqual({ blockedBy: [], atRiskBy: [] });
    expect(derived.get("c")).toEqual({ blockedBy: [], atRiskBy: [] });
  });

  it("RECOVERY (overdue): the deadline moves → at-risk vanishes", () => {
    const ws = board([
      ...action("research", { status: "in_progress", dueDate: "2026-09-01" }), // overdue
      ...action("build"),
      depends("build", "research"),
    ]);
    expect(derivedExecution(ws, NOW).get("build")!.atRiskBy).toEqual(["research"]);
    const moved = applyOperations(ws, stampAuthorship([{ op: "UPDATE_ISSUE", id: "research", dueDate: "2026-09-20" }], "test-user"));
    expect(derivedExecution(moved, NOW).get("build")).toEqual({ blockedBy: [], atRiskBy: [] });
  });

  it("blocked-but-overdue upstream contributes to atRiskBy (the settled clarification)", () => {
    const ws = board([
      ...action("design", { status: "blocked", dueDate: "2026-09-01" }), // blocked AND overdue
      ...action("implementation"),
      depends("implementation", "design"),
    ]);
    const derived = derivedExecution(ws, NOW);
    expect(derived.get("implementation")!.blockedBy).toEqual(["design"]);
    // NOT excluded from risk — trouble compounds.
    expect(derived.get("implementation")!.atRiskBy).toEqual(["design"]);
  });

  it("completed/cancelled upstream never contributes", () => {
    const ws = board([
      ...action("done", { status: "completed", dueDate: "2026-09-01" }),
      ...action("cancelled", { status: "cancelled", dueDate: "2026-09-01" }),
      ...action("next"),
      depends("next", "done"),
      depends("next", "cancelled"),
    ]);
    expect(derivedExecution(ws, NOW).get("next")).toEqual({ blockedBy: [], atRiskBy: [] });
  });

  it("blocks-form dependencies propagate identically to depends_on", () => {
    const ws = board([
      ...action("design", { status: "blocked" }),
      ...action("implementation"),
      { op: "CONNECT_NODES", source: "design", target: "implementation", relationship: "blocks" },
    ]);
    expect(derivedExecution(ws, NOW).get("implementation")!.blockedBy).toEqual(["design"]);
  });

  it("propagation walks EXECUTABLE nodes only — a plain node in the chain blocks nothing", () => {
    const ws = board([
      ...action("design", { status: "blocked" }),
      { op: "CREATE_NODE", id: "plain", nodeType: "step", label: "Plain" },
      ...action("implementation"),
      depends("plain", "design"),
      depends("implementation", "plain"),
    ]);
    const derived = derivedExecution(ws, NOW);
    // The plain node is not executable: it forwards nothing. The design's
    // blocked status stops at the plain node.
    expect(derived.get("implementation")).toEqual({ blockedBy: [], atRiskBy: [] });
    // The plain node itself is not in the derived map at all.
    expect(derived.has("plain")).toBe(false);
  });

  it("manual state stays untouched — the D1 independence pins hold over the graph", () => {
    const ws = board([
      ...action("design", { status: "blocked" }),
      ...action("implementation", { status: "in_progress" }),
      depends("implementation", "design"),
    ]);
    const derived = derivedExecution(ws, NOW);
    expect(derived.get("implementation")!.blockedBy).toEqual(["design"]);
    // The manual status is untouched: derived informs, never writes.
    expect(ws.nodes["implementation"]!.issue!.status).toBe("in_progress");
  });
});

describe("isOverdueUnfinished", () => {
  it("past due and not completed/cancelled — blocked counts, finished never", () => {
    expect(isOverdueUnfinished("2026-09-01", "in_progress", NOW)).toBe(true);
    expect(isOverdueUnfinished("2026-09-01", "blocked", NOW)).toBe(true);
    expect(isOverdueUnfinished("2026-09-01", "open", NOW)).toBe(true);
    expect(isOverdueUnfinished("2026-09-01", "completed", NOW)).toBe(false);
    expect(isOverdueUnfinished("2026-09-01", "cancelled", NOW)).toBe(false);
    expect(isOverdueUnfinished("2026-09-09", "open", NOW)).toBe(false); // today, not past
    expect(isOverdueUnfinished(undefined, "open", NOW)).toBe(false);
  });
});

describe("deletion and undo inherit the edge machinery", () => {
  it("DELETE_NODE drops dependency edges; undo restores them as CONNECT_NODES", () => {
    const ws = board([
      ...action("a"),
      ...action("b"),
      depends("b", "a"),
    ]);
    const del: Operation[] = [{ op: "DELETE_NODE", id: "a" }];
    const deleted = applyOperations(ws, stampAuthorship(del, "test-user"));
    expect(Object.keys(deleted.edges)).toEqual([]);
    const restored = applyOperations(deleted, stampAuthorship(inverseOperations(del, ws), "test-user"));
    expect(restored.edges["b->a:depends_on"]).toBeDefined();
    expect(restored.nodes["a"]?.issue).toBeDefined();
  });
});

describe("the vocabulary", () => {
  it("DEPENDENCY_RELATIONSHIPS is the closed convention", () => {
    expect(DEPENDENCY_RELATIONSHIPS).toEqual(["depends_on", "blocks", "related_to"]);
  });
});
