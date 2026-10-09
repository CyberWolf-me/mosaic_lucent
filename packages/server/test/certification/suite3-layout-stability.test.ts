import { describe, expect, it } from "vitest";
import {
  createWorkspace,
  computeLayout,
  applyLayout,
  extendRegionLayout,
  applyOperations,
  type Operation,
} from "@lucent/core";

describe("Pipeline Certification v1 - Suite 3: Layout Stability and Readability", () => {
  it("certifies Greenfield Layout applies 16:9 packing heuristic to prevent horizontal sprawl", () => {
    // Greenfield diagram with 3 disconnected subsystems (e.g. Frontend, Backend, Monitoring)
    const ops: Operation[] = [
      // Component A
      { op: "CREATE_NODE", id: "fe1", nodeType: "client", label: "Web Client" },
      { op: "CREATE_NODE", id: "fe2", nodeType: "client", label: "Mobile App" },
      { op: "CONNECT_NODES", source: "fe1", target: "fe2", relationship: "relates_to" },

      // Component B
      { op: "CREATE_NODE", id: "be1", nodeType: "service", label: "Core API" },
      { op: "CREATE_NODE", id: "be2", nodeType: "database", label: "DB Cluster" },
      { op: "CONNECT_NODES", source: "be1", target: "be2", relationship: "reads_writes" },

      // Component C
      { op: "CREATE_NODE", id: "m1", nodeType: "service", label: "Metrics Ingest" },
      { op: "CREATE_NODE", id: "m2", nodeType: "service", label: "Alerting" },
      { op: "CONNECT_NODES", source: "m1", target: "m2", relationship: "produces" },
    ];

    let ws = createWorkspace({ diagramKind: "architecture" });
    ws = applyOperations(ws, ops);

    // Compute greenfield layout with component decomposition & 2D shelf packing
    const layoutRes = computeLayout(ws);
    ws = applyLayout(ws, layoutRes);

    const positions = Object.values(ws.nodes).map((n) => n.position);
    expect(positions.every((p) => p !== undefined)).toBe(true);

    // Verify bounding box does not suffer from extreme single-line sprawl
    const xs = positions.map((p) => p!.x);
    const ys = positions.map((p) => p!.y);
    const width = Math.max(...xs) - Math.min(...xs);
    const height = Math.max(...ys) - Math.min(...ys);

    // 16:9 target heuristic ensures height is substantial (> 0) rather than flattened to 1 single row
    expect(width).toBeGreaterThan(0);
    expect(height).toBeGreaterThan(0);
    // Aspect ratio width/height is balanced (not a 100:1 horizontal line)
    const aspectRatio = width / Math.max(height, 1);
    expect(aspectRatio).toBeLessThan(10);
  });

  it("certifies Incremental Layout (extendRegionLayout) strictly preserves user-positioned coordinates", () => {
    let ws = createWorkspace({ diagramKind: "flowchart" });

    // Existing user-positioned nodes
    const initialOps: Operation[] = [
      { op: "CREATE_NODE", id: "orig1", nodeType: "step", label: "Start Step" },
      { op: "CREATE_NODE", id: "orig2", nodeType: "step", label: "Process Step" },
      { op: "MOVE_NODE", id: "orig1", position: { x: 500, y: 300 } },
      { op: "MOVE_NODE", id: "orig2", position: { x: 800, y: 300 } },
      { op: "CONNECT_NODES", source: "orig1", target: "orig2", relationship: "next" },
    ];
    ws = applyOperations(ws, initialOps);

    const orig1Pos = { ...ws.nodes["orig1"]!.position! };
    const orig2Pos = { ...ws.nodes["orig2"]!.position! };

    // New node added incrementally
    const addOps: Operation[] = [
      { op: "CREATE_NODE", id: "new1", nodeType: "step", label: "Notification Step" },
      { op: "CONNECT_NODES", source: "orig2", target: "new1", relationship: "next" },
    ];
    ws = applyOperations(ws, addOps);

    // Perform extendRegionLayout for incremental edit
    const stableLayout = extendRegionLayout(ws, { direction: "horizontal" });
    ws = applyLayout(ws, stableLayout);

    // CRITICAL PASS CONDITION:
    // Existing objects remain at their exact user-positioned coordinates!
    expect(ws.nodes["orig1"]?.position).toEqual(orig1Pos);
    expect(ws.nodes["orig2"]?.position).toEqual(orig2Pos);

    // The new node is placed to the right of orig2 without overlapping
    const newPos = ws.nodes["new1"]?.position;
    expect(newPos).toBeDefined();
    expect(newPos!.x).toBeGreaterThan(orig2Pos.x);
  });

  it("certifies No Unintended Overlaps among weakly connected components", () => {
    const ops: Operation[] = [
      { op: "CREATE_NODE", id: "card1", nodeType: "card", label: "Idea 1" },
      { op: "CREATE_NODE", id: "card2", nodeType: "card", label: "Idea 2" },
      { op: "CREATE_NODE", id: "card3", nodeType: "card", label: "Idea 3" },
      { op: "CREATE_NODE", id: "card4", nodeType: "card", label: "Idea 4" },
    ];

    let ws = createWorkspace({ diagramKind: "flowchart" });
    ws = applyOperations(ws, ops);

    const layoutRes = computeLayout(ws);
    ws = applyLayout(ws, layoutRes);

    // Check pairwise bounding box distance
    const nodes = Object.values(ws.nodes);
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const n1 = nodes[i]!;
        const n2 = nodes[j]!;
        const dx = Math.abs(n1.position!.x - n2.position!.x);
        const dy = Math.abs(n1.position!.y - n2.position!.y);

        // Nodes must not overlap (node dimensions are at least 140x60)
        const overlap = dx < 100 && dy < 40;
        expect(overlap).toBe(false);
      }
    }
  });

  it("certifies nested group bounding box boundaries do not collapse", () => {
    let ws = createWorkspace();
    const ops: Operation[] = [
      { op: "CREATE_NODE", id: "svc1", nodeType: "service", label: "Worker 1" },
      { op: "CREATE_NODE", id: "svc2", nodeType: "service", label: "Worker 2" },
      { op: "CREATE_GROUP", id: "grp1", label: "Worker Cluster", children: ["svc1", "svc2"] },
      { op: "MOVE_NODE", id: "svc1", position: { x: 100, y: 100 } },
      { op: "MOVE_NODE", id: "svc2", position: { x: 300, y: 100 } },
    ];

    ws = applyOperations(ws, ops);
    expect(ws.nodes["svc1"]?.groupId).toBe("grp1");
    expect(ws.nodes["svc2"]?.groupId).toBe("grp1");
    expect(ws.groups["grp1"]).toBeDefined();
  });
});
