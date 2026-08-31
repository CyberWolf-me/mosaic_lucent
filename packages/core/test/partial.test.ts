import { describe, it, expect } from "vitest";
import {
  applyValidOperations,
  createWorkspace,
  applyOperations,
  parseWorkspace,
  safeParseOperations,
} from "@lucent/core";
import type { Operation } from "@lucent/core";

/**
 * Partial application (M1): one bad operation must cost itself, not the
 * batch. Before this, the generate pipeline's strict gate rejected an entire
 * 40-op generation over one mis-referenced edge id — the single most damaging
 * way an AI canvas can fail, because the 39 valid ops (including every node)
 * went to zero with a generic rephrase message.
 *
 * The load-boundary drop of dangling edges is the mirror concern for stored
 * boards: never carry an edge whose endpoint doesn't resolve.
 */

const batchWithOneBadEdge = (): Operation[] => [
  { op: "CREATE_NODE", id: "a", nodeType: "service", label: "A" },
  { op: "CREATE_NODE", id: "b", nodeType: "service", label: "B" },
  { op: "CONNECT_NODES", source: "a", target: "b", relationship: "calls" },
  { op: "CONNECT_NODES", source: "a", target: "ghost", relationship: "calls" },
];

describe("applyValidOperations", () => {
  it("applies every valid op and skips only the invalid one", () => {
    const result = applyValidOperations(createWorkspace(), batchWithOneBadEdge());
    expect(result.applied).toHaveLength(3);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.reason).toContain('node "ghost" does not exist');
    // The valid edge really landed.
    expect(result.workspace.edges["a->b:calls"]).toBeDefined();
    // The invalid edge did not.
    expect(Object.keys(result.workspace.edges)).toHaveLength(1);
  });

  it("a clean batch takes the fast path with no skips", () => {
    const ops: Operation[] = [
      { op: "CREATE_NODE", id: "x", nodeType: "t", label: "X" },
      { op: "CREATE_NODE", id: "y", nodeType: "t", label: "Y" },
      { op: "CONNECT_NODES", source: "x", target: "y", relationship: "r" },
    ];
    const result = applyValidOperations(createWorkspace(), ops);
    expect(result.skipped).toHaveLength(0);
    expect(result.applied).toHaveLength(3);
  });

  it("a skipped CREATE does not poison a later CONNECT that references it", () => {
    // If CREATE_NODE "a" were skipped, the connect to "a" must also be
    // skipped — because it validates against the REAL state, not the
    // hypothetical one where the skip didn't happen. This is the
    // "one simulator" guarantee: validator and applier can't disagree.
    const ops: Operation[] = [
      { op: "DELETE_NODE", id: "nonexistent" }, // invalid: no such node
      { op: "CREATE_NODE", id: "a", nodeType: "t", label: "A" }, // valid on its own
      { op: "CONNECT_NODES", source: "a", target: "a", relationship: "self" }, // invalid: self-loop
    ];
    const result = applyValidOperations(createWorkspace(), ops);
    expect(result.applied.map((o) => o.op)).toEqual(["CREATE_NODE"]);
    expect(result.skipped).toHaveLength(2);
  });

  it("in-batch dependency order still works: connect after create in the same batch", () => {
    const ops: Operation[] = [
      { op: "CREATE_NODE", id: "a", nodeType: "t", label: "A" },
      { op: "CREATE_NODE", id: "b", nodeType: "t", label: "B" },
      { op: "CONNECT_NODES", source: "a", target: "b", relationship: "r" },
    ];
    const result = applyValidOperations(createWorkspace(), ops);
    expect(result.applied).toHaveLength(3);
    expect(result.workspace.edges["a->b:r"]).toBeDefined();
  });

  it("matches the strict validator exactly on a fully valid batch", () => {
    const parsed = safeParseOperations([
      { op: "CREATE_NODE", id: "a", nodeType: "t", label: "A" },
      { op: "CREATE_GROUP", id: "g", label: "G", children: ["a"] },
    ]);
    if (!parsed.success) throw new Error("fixture ops failed to parse");
    const ops = parsed.data;
    const strict = applyOperations(createWorkspace(), ops);
    const partial = applyValidOperations(createWorkspace(), ops);
    expect(partial.workspace.groups).toEqual(strict.groups);
    expect(partial.skipped).toHaveLength(0);
  });

  it("skipped ops are reported with their op for targeted repair", () => {
    const result = applyValidOperations(createWorkspace(), batchWithOneBadEdge());
    // The repair affordance needs the op back to re-ask the model for JUST it.
    expect(result.skipped[0]?.op.op).toBe("CONNECT_NODES");
    expect((result.skipped[0]?.op as { target: string }).target).toBe("ghost");
  });
});

describe("parseWorkspace drops dangling edges at the load boundary", () => {
  const validWs = applyOperations(createWorkspace(), [
    { op: "CREATE_NODE", id: "a", nodeType: "t", label: "A" },
    { op: "CREATE_NODE", id: "b", nodeType: "t", label: "B" },
    { op: "CONNECT_NODES", source: "a", target: "b", relationship: "r" },
  ]);

  it("keeps a fully-resolvable board untouched", () => {
    const result = parseWorkspace(validWs);
    expect(result.ok).toBe(true);
    expect(result.dropped).toBeUndefined();
    expect(Object.keys(result.workspace!.edges)).toHaveLength(1);
  });

  it("drops an edge whose target node id doesn't resolve, and reports it", () => {
    const withDangling = {
      ...validWs,
      edges: {
        ...validWs.edges,
        "broken-edge": {
          id: "broken-edge",
          source: "a",
          target: "no-such-node",
          relationship: "r",
        },
      },
    };
    const result = parseWorkspace(withDangling);
    expect(result.ok).toBe(true);
    expect(result.dropped).toEqual(["broken-edge"]);
    // The good edge survives; the board is still usable.
    expect(result.workspace!.edges["a->b:r"]).toBeDefined();
  });

  it("drops an edge whose SOURCE doesn't resolve too", () => {
    const withDangling = {
      ...validWs,
      edges: {
        ...validWs.edges,
        "broken-source": {
          id: "broken-source",
          source: "ghost",
          target: "b",
          relationship: "r",
        },
      },
    };
    const result = parseWorkspace(withDangling);
    expect(result.dropped).toEqual(["broken-source"]);
    expect(Object.keys(result.workspace!.edges)).toHaveLength(1);
  });

  it("a board with no edges reports nothing", () => {
    const result = parseWorkspace({ ...validWs, edges: {} });
    expect(result.ok).toBe(true);
    expect(result.dropped).toBeUndefined();
  });
});
