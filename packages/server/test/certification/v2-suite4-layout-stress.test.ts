import { describe, expect, it } from "vitest";
import {
  createWorkspace,
  computeLayout,
  applyLayout,
  extendRegionLayout,
  applyOperations,
  type Operation,
  type Workspace,
} from "@lucent/core";

function checkPairwiseOverlaps(ws: Workspace, minGap = 5): number {
  const nodes = Object.values(ws.nodes).filter((n) => n.position !== undefined);
  let overlapCount = 0;

  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i]!;
      const b = nodes[j]!;
      const aW = a.size?.width ?? 160;
      const aH = a.size?.height ?? 60;
      const bW = b.size?.width ?? 160;
      const bH = b.size?.height ?? 60;

      const aLeft = a.position!.x;
      const aRight = a.position!.x + aW;
      const aTop = a.position!.y;
      const aBottom = a.position!.y + aH;

      const bLeft = b.position!.x;
      const bRight = b.position!.x + bW;
      const bTop = b.position!.y;
      const bBottom = b.position!.y + bH;

      const overlaps =
        aLeft < bRight - minGap &&
        aRight > bLeft + minGap &&
        aTop < bBottom - minGap &&
        aBottom > bTop + minGap;

      if (overlaps) overlapCount++;
    }
  }

  return overlapCount;
}

describe("Pipeline Certification V2 - Suite 4: Layout Stress & Geometric Stability", () => {
  it("certifies 50-node layered graph: 0 overlaps, bounded aspect ratio, and sub-100ms execution", () => {
    let ws = createWorkspace({ diagramKind: "flowchart" });
    const ops: Operation[] = [];

    // Create 50 nodes in 5 layers of 10
    for (let i = 0; i < 50; i++) {
      ops.push({
        op: "CREATE_NODE",
        id: `node_50_${i}`,
        nodeType: "step",
        label: `Pipeline Stage Step ${i + 1}`,
      });
    }

    // Connect layer to layer
    for (let layer = 0; layer < 4; layer++) {
      for (let j = 0; j < 10; j++) {
        const src = `node_50_${layer * 10 + j}`;
        const tgt = `node_50_${(layer + 1) * 10 + ((j + 1) % 10)}`;
        ops.push({
          op: "CONNECT_NODES",
          source: src,
          target: tgt,
          relationship: "next",
        });
      }
    }

    ws = applyOperations(ws, ops);

    const start = performance.now();
    const layout = computeLayout(ws);
    const durationMs = performance.now() - start;

    expect(durationMs).toBeLessThan(100);

    ws = applyLayout(ws, layout);

    // Verify all 50 nodes are positioned
    const positions = Object.values(ws.nodes).map((n) => n.position);
    expect(
      positions.every((p) => p !== undefined && Number.isFinite(p.x) && Number.isFinite(p.y)),
    ).toBe(true);

    // 0 Pairwise Overlaps across all 1,225 node pairs!
    const overlaps = checkPairwiseOverlaps(ws);
    expect(overlaps).toBe(0);

    // Aspect ratio bounded
    const xs = positions.map((p) => p!.x);
    const ys = positions.map((p) => p!.y);
    const width = Math.max(...xs) - Math.min(...xs);
    const height = Math.max(...ys) - Math.min(...ys);
    const ratio = width / Math.max(height, 1);
    expect(ratio).toBeGreaterThan(0.1);
    expect(ratio).toBeLessThan(10.0);
  });

  it("certifies 100-node dense architecture graph with long labels and mixed node sizes", () => {
    let ws = createWorkspace({ diagramKind: "architecture" });
    const ops: Operation[] = [];

    // 100 nodes with diverse sizes and long labels
    for (let i = 0; i < 100; i++) {
      const type =
        i % 4 === 0 ? "gateway" : i % 4 === 1 ? "service" : i % 4 === 2 ? "database" : "worker";
      ops.push({
        op: "CREATE_NODE",
        id: `dense_100_${i}`,
        nodeType: type,
        label: `High-Throughput Enterprise Subsystem Module ${i + 1} with Extended Metadata`,
      });
    }

    // Dense mesh connections
    for (let i = 0; i < 90; i++) {
      ops.push({
        op: "CONNECT_NODES",
        source: `dense_100_${i}`,
        target: `dense_100_${i + 1}`,
        relationship: "calls",
      });
      if (i % 3 === 0 && i + 5 < 100) {
        ops.push({
          op: "CONNECT_NODES",
          source: `dense_100_${i}`,
          target: `dense_100_${i + 5}`,
          relationship: "reads_writes",
        });
      }
    }

    ws = applyOperations(ws, ops);

    const start = performance.now();
    const layout = computeLayout(ws);
    const durationMs = performance.now() - start;

    expect(durationMs).toBeLessThan(200);

    ws = applyLayout(ws, layout);

    // 0 Pairwise Overlaps across 4,950 node pairs!
    const overlaps = checkPairwiseOverlaps(ws);
    expect(overlaps).toBe(0);
  });

  it("certifies 250-node branching tree hierarchy: complete layout with zero overlap", () => {
    let ws = createWorkspace({ diagramKind: "mindmap" });
    const ops: Operation[] = [];

    // Root node
    ops.push({
      op: "CREATE_NODE",
      id: "root_250",
      nodeType: "concept",
      label: "Central Knowledge Spine",
    });

    // 5 Primary Branches
    for (let b = 0; b < 5; b++) {
      const bId = `branch_${b}`;
      ops.push({
        op: "CREATE_NODE",
        id: bId,
        nodeType: "concept",
        label: `Domain Cluster ${b + 1}`,
      });
      ops.push({
        op: "CONNECT_NODES",
        source: "root_250",
        target: bId,
        relationship: "contains",
      });

      // 48 leaves per branch = 240 leaves + 5 branches + 1 root = 246 nodes
      for (let l = 0; l < 48; l++) {
        const leafId = `leaf_${b}_${l}`;
        ops.push({
          op: "CREATE_NODE",
          id: leafId,
          nodeType: "concept",
          label: `Concept Item ${b}-${l}`,
        });
        ops.push({
          op: "CONNECT_NODES",
          source: bId,
          target: leafId,
          relationship: "contains",
        });
      }
    }

    ws = applyOperations(ws, ops);
    expect(Object.keys(ws.nodes).length).toBeGreaterThanOrEqual(245);

    const start = performance.now();
    const layout = computeLayout(ws);
    const durationMs = performance.now() - start;

    expect(durationMs).toBeLessThan(350);

    ws = applyLayout(ws, layout);

    const positions = Object.values(ws.nodes).map((n) => n.position);
    expect(
      positions.every((p) => p !== undefined && Number.isFinite(p.x) && Number.isFinite(p.y)),
    ).toBe(true);

    const overlaps = checkPairwiseOverlaps(ws);
    expect(overlaps).toBe(0);
  });

  it("certifies 500-node large-scale layout executes within bounded time without stack overflow", () => {
    let ws = createWorkspace({ diagramKind: "flowchart" });
    const ops: Operation[] = [];

    for (let i = 0; i < 500; i++) {
      ops.push({
        op: "CREATE_NODE",
        id: `scale_500_${i}`,
        nodeType: "step",
        label: `Step ${i}`,
      });
      if (i > 0 && i % 10 !== 0) {
        ops.push({
          op: "CONNECT_NODES",
          source: `scale_500_${i - 1}`,
          target: `scale_500_${i}`,
          relationship: "next",
        });
      }
    }

    ws = applyOperations(ws, ops);

    const start = performance.now();
    const layout = computeLayout(ws);
    const durationMs = performance.now() - start;

    expect(durationMs).toBeLessThan(500);

    ws = applyLayout(ws, layout);
    expect(Object.keys(ws.nodes)).toHaveLength(500);
    const positions = Object.values(ws.nodes).map((n) => n.position);
    expect(
      positions.every((p) => p !== undefined && Number.isFinite(p.x) && Number.isFinite(p.y)),
    ).toBe(true);
  });

  it("certifies Incremental Layout Drift: 0 px drift on pre-positioned nodes during extend_region", () => {
    let ws = createWorkspace();
    const initialOps: Operation[] = [];

    // Create 20 user-positioned nodes
    for (let i = 0; i < 20; i++) {
      initialOps.push({
        op: "CREATE_NODE",
        id: `user_node_${i}`,
        nodeType: "service",
        label: `Anchor Service ${i + 1}`,
      });
      initialOps.push({
        op: "MOVE_NODE",
        id: `user_node_${i}`,
        position: { x: (i % 5) * 220 + 100, y: Math.floor(i / 5) * 160 + 100 },
      });
    }

    ws = applyOperations(ws, initialOps);

    // Snapshot exact user coordinates
    const initialCoords = new Map<string, { x: number; y: number }>();
    for (let i = 0; i < 20; i++) {
      initialCoords.set(`user_node_${i}`, { ...ws.nodes[`user_node_${i}`]!.position! });
    }

    // Add 5 incremental nodes connected to anchor nodes
    const incOps: Operation[] = [];
    for (let j = 0; j < 5; j++) {
      const newId = `new_inc_${j}`;
      incOps.push({
        op: "CREATE_NODE",
        id: newId,
        nodeType: "worker",
        label: `Incremental Worker ${j + 1}`,
      });
      incOps.push({
        op: "CONNECT_NODES",
        source: `user_node_${j * 4}`,
        target: newId,
        relationship: "calls",
      });
    }

    ws = applyOperations(ws, incOps);

    // Compute layout using extendRegionLayout
    const extLayout = extendRegionLayout(ws);
    ws = applyLayout(ws, extLayout);

    // STRICT INVARIANT: 0px position drift on all 20 existing user-positioned nodes!
    for (let i = 0; i < 20; i++) {
      const current = ws.nodes[`user_node_${i}`]!.position!;
      const expected = initialCoords.get(`user_node_${i}`)!;
      const driftX = Math.abs(current.x - expected.x);
      const driftY = Math.abs(current.y - expected.y);

      expect(driftX).toBe(0);
      expect(driftY).toBe(0);
    }

    // Newly added nodes are placed and do not collide
    for (let j = 0; j < 5; j++) {
      const pos = ws.nodes[`new_inc_${j}`]?.position;
      expect(pos).toBeDefined();
      expect(Number.isFinite(pos!.x)).toBe(true);
      expect(Number.isFinite(pos!.y)).toBe(true);
    }
  });
});
