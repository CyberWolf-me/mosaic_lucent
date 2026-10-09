import { describe, it, expect } from "vitest";
import { createWorkspace } from "../src/model.js";
import { applyOperations } from "../src/reducer.js";
import type { Operation } from "../src/operations.js";
import {
  computeLayout,
  applyLayout,
  findWeaklyConnectedComponents,
  extendRegionLayout,
} from "../src/layout.js";

describe("Stable Component Layout (Stage 5)", () => {
  describe("WCC decomposition and 2D shelf packing", () => {
    it("decomposes isolated nodes and disjoint subgraphs into weakly connected components", () => {
      const ops: Operation[] = [
        { op: "CREATE_NODE", id: "a1", nodeType: "service", label: "Auth API" },
        { op: "CREATE_NODE", id: "a2", nodeType: "database", label: "Auth DB" },
        { op: "CONNECT_NODES", source: "a1", target: "a2", relationship: "reads_writes" },

        { op: "CREATE_NODE", id: "b1", nodeType: "service", label: "Payment Service" },
        { op: "CREATE_NODE", id: "b2", nodeType: "service", label: "Stripe Gateway" },
        { op: "CONNECT_NODES", source: "b1", target: "b2", relationship: "calls" },

        { op: "CREATE_NODE", id: "c1", nodeType: "note", label: "Floating Idea 1" },
        { op: "CREATE_NODE", id: "c2", nodeType: "note", label: "Floating Idea 2" },
      ];
      const ws = applyOperations(createWorkspace(), ops);
      const components = findWeaklyConnectedComponents(Object.keys(ws.nodes), ws.edges);

      expect(components).toHaveLength(4);
      expect(components[0]).toEqual(["a1", "a2"]);
      expect(components[1]).toEqual(["b1", "b2"]);
      expect(components[2]).toEqual(["c1"]);
      expect(components[3]).toEqual(["c2"]);
    });

    it("prevents horizontal sprawl for 15 disconnected idea cards (2D bounding box instead of 3,000px line)", () => {
      const ops: Operation[] = [];
      for (let i = 0; i < 15; i++) {
        ops.push({
          op: "CREATE_NODE",
          id: `idea_${i}`,
          nodeType: "card",
          label: `Brainstorm Idea ${i + 1}`,
        });
      }
      const ws = applyOperations(createWorkspace({ diagramKind: "flowchart" }), ops);
      const layout = computeLayout(ws, { direction: "vertical" });

      const xs = Object.values(layout).map((p) => p.position.x);
      const ys = Object.values(layout).map((p) => p.position.y);

      const minX = Math.min(...xs);
      const maxX = Math.max(...Object.values(layout).map((p) => p.position.x + p.size.width));
      const minY = Math.min(...ys);
      const maxY = Math.max(...Object.values(layout).map((p) => p.position.y + p.size.height));

      const totalWidth = maxX - minX;
      const totalHeight = maxY - minY;

      // Old behavior: 15 nodes stacked along X in layer 0, resulting in > 3,000px width and single row height (64px).
      // New behavior: 2D shelf packing targets a 16:9 ratio, resulting in ~3-4 rows and width < 1,500px.
      expect(totalWidth).toBeLessThan(1500);
      expect(totalHeight).toBeGreaterThan(150);

      // Verify multiple distinct rows (Y coordinates) exist
      const distinctY = new Set(ys.map((y) => Math.round(y)));
      expect(distinctY.size).toBeGreaterThanOrEqual(3);

      // Verify aspect ratio is well-balanced (between 1.0 and 3.5, close to 16:9 ~ 1.78, NOT 48:1)
      const aspectRatio = totalWidth / totalHeight;
      expect(aspectRatio).toBeGreaterThan(1.0);
      expect(aspectRatio).toBeLessThan(3.5);
    });

    it("lays out multiple disjoint service DAGs cleanly without mixing their layers", () => {
      const ops: Operation[] = [
        // Subsystem 1: A1 -> A2 -> A3
        { op: "CREATE_NODE", id: "a1", nodeType: "service", label: "Order Service" },
        { op: "CREATE_NODE", id: "a2", nodeType: "service", label: "Fulfillment" },
        { op: "CREATE_NODE", id: "a3", nodeType: "database", label: "Orders DB" },
        { op: "CONNECT_NODES", source: "a1", target: "a2", relationship: "next" },
        { op: "CONNECT_NODES", source: "a2", target: "a3", relationship: "reads_writes" },

        // Subsystem 2: B1 -> B2
        { op: "CREATE_NODE", id: "b1", nodeType: "service", label: "User Service" },
        { op: "CREATE_NODE", id: "b2", nodeType: "database", label: "Users DB" },
        { op: "CONNECT_NODES", source: "b1", target: "b2", relationship: "reads_writes" },
      ];
      const ws = applyOperations(createWorkspace({ diagramKind: "architecture" }), ops);
      const layout = computeLayout(ws, { direction: "vertical" });

      // Subsystem 1's internal relative order: a1 is above a2, which is above a3
      expect(layout.a1!.position.y).toBeLessThan(layout.a2!.position.y);
      expect(layout.a2!.position.y).toBeLessThan(layout.a3!.position.y);

      // Subsystem 2's internal relative order: b1 is above b2
      expect(layout.b1!.position.y).toBeLessThan(layout.b2!.position.y);

      // The two components must not overlap in 2D space
      const boxA = {
        left: Math.min(layout.a1!.position.x, layout.a2!.position.x, layout.a3!.position.x),
        right: Math.max(
          layout.a1!.position.x + layout.a1!.size.width,
          layout.a2!.position.x + layout.a2!.size.width,
          layout.a3!.position.x + layout.a3!.size.width,
        ),
        top: Math.min(layout.a1!.position.y, layout.a2!.position.y, layout.a3!.position.y),
        bottom: Math.max(
          layout.a1!.position.y + layout.a1!.size.height,
          layout.a2!.position.y + layout.a2!.size.height,
          layout.a3!.position.y + layout.a3!.size.height,
        ),
      };

      const boxB = {
        left: Math.min(layout.b1!.position.x, layout.b2!.position.x),
        right: Math.max(
          layout.b1!.position.x + layout.b1!.size.width,
          layout.b2!.position.x + layout.b2!.size.width,
        ),
        top: Math.min(layout.b1!.position.y, layout.b2!.position.y),
        bottom: Math.max(
          layout.b1!.position.y + layout.b1!.size.height,
          layout.b2!.position.y + layout.b2!.size.height,
        ),
      };

      const overlaps =
        boxA.left < boxB.right &&
        boxA.right > boxB.left &&
        boxA.top < boxB.bottom &&
        boxA.bottom > boxB.top;
      expect(overlaps).toBe(false);
    });
  });

  describe("extend_region incremental stability", () => {
    it("preserves existing node coordinates strictly identically after incremental additions", () => {
      // 1. Initial board with 3 nodes
      const initialOps: Operation[] = [
        { op: "CREATE_NODE", id: "auth", nodeType: "service", label: "Auth Service" },
        { op: "CREATE_NODE", id: "db", nodeType: "database", label: "User DB" },
        { op: "CREATE_NODE", id: "cache", nodeType: "database", label: "Redis Cache" },
        { op: "CONNECT_NODES", source: "auth", target: "db", relationship: "reads_writes" },
        { op: "CONNECT_NODES", source: "auth", target: "cache", relationship: "reads_writes" },
      ];
      let ws = applyOperations(createWorkspace(), initialOps);
      ws = applyLayout(ws, computeLayout(ws));

      const initialPosAuth = { ...ws.nodes.auth!.position! };
      const initialPosDb = { ...ws.nodes.db!.position! };
      const initialPosCache = { ...ws.nodes.cache!.position! };

      // 2. Incremental turn: add new node 'audit' connected from 'auth'
      const incrementalOps: Operation[] = [
        { op: "CREATE_NODE", id: "audit", nodeType: "service", label: "Audit Logger" },
        { op: "CONNECT_NODES", source: "auth", target: "audit", relationship: "calls" },
      ];
      const updatedWs = applyOperations(ws, incrementalOps);

      // Compute layout using extend_region mutationScope
      const extendedLayout = extendRegionLayout(updatedWs);

      // Existing nodes MUST NOT MOVE by even 1 pixel
      expect(extendedLayout.auth!.position.x).toBe(initialPosAuth.x);
      expect(extendedLayout.auth!.position.y).toBe(initialPosAuth.y);
      expect(extendedLayout.db!.position.x).toBe(initialPosDb.x);
      expect(extendedLayout.db!.position.y).toBe(initialPosDb.y);
      expect(extendedLayout.cache!.position.x).toBe(initialPosCache.x);
      expect(extendedLayout.cache!.position.y).toBe(initialPosCache.y);

      // New node 'audit' is placed
      expect(extendedLayout.audit).toBeDefined();
      expect(extendedLayout.audit!.position.y).toBeGreaterThan(initialPosAuth.y);
    });

    it("anchors child nodes below parent and prevents overlap between multiple incremental siblings", () => {
      // Initial parent node
      const initialOps: Operation[] = [
        { op: "CREATE_NODE", id: "api", nodeType: "gateway", label: "API Gateway" },
      ];
      let ws = applyOperations(createWorkspace(), initialOps);
      ws = applyLayout(ws, computeLayout(ws));
      const initialApiPos = { ...ws.nodes.api!.position! };

      // Add two child nodes branching from api
      const extOps: Operation[] = [
        { op: "CREATE_NODE", id: "orders", nodeType: "service", label: "Order Service" },
        { op: "CREATE_NODE", id: "users", nodeType: "service", label: "User Service" },
        { op: "CONNECT_NODES", source: "api", target: "orders", relationship: "calls" },
        { op: "CONNECT_NODES", source: "api", target: "users", relationship: "calls" },
      ];
      const updatedWs = applyOperations(ws, extOps);

      const layout = extendRegionLayout(updatedWs);

      // api remains anchored
      expect(layout.api!.position).toEqual(initialApiPos);

      // Both children are below the API gateway
      expect(layout.orders!.position.y).toBeGreaterThan(initialApiPos.y);
      expect(layout.users!.position.y).toBeGreaterThan(initialApiPos.y);

      // orders and users do NOT overlap horizontally
      const leftChild =
        layout.orders!.position.x < layout.users!.position.x ? layout.orders! : layout.users!;
      const rightChild =
        layout.orders!.position.x < layout.users!.position.x ? layout.users! : layout.orders!;
      expect(rightChild.position.x).toBeGreaterThanOrEqual(
        leftChild.position.x + leftChild.size.width,
      );
    });

    it("places disconnected incremental nodes clear of the existing diagram without collision", () => {
      // Existing cluster
      const initialOps: Operation[] = [
        { op: "CREATE_NODE", id: "n1", nodeType: "step", label: "Step 1" },
        { op: "CREATE_NODE", id: "n2", nodeType: "step", label: "Step 2" },
        { op: "CONNECT_NODES", source: "n1", target: "n2", relationship: "next" },
      ];
      let ws = applyOperations(createWorkspace(), initialOps);
      ws = applyLayout(ws, computeLayout(ws));

      const oldN1 = { ...ws.nodes.n1!.position! };
      const oldN2 = { ...ws.nodes.n2!.position! };

      // Incremental addition with NO edges to existing nodes
      const extOps: Operation[] = [
        { op: "CREATE_NODE", id: "isolated", nodeType: "note", label: "Standalone Note" },
      ];
      const updatedWs = applyOperations(ws, extOps);

      const layout = extendRegionLayout(updatedWs);

      // Existing nodes strictly preserved
      expect(layout.n1!.position).toEqual(oldN1);
      expect(layout.n2!.position).toEqual(oldN2);

      // New node placed
      expect(layout.isolated).toBeDefined();

      // Check no collision between isolated note and existing nodes
      const isoLeft = layout.isolated!.position.x;
      const isoRight = isoLeft + layout.isolated!.size.width;
      const isoTop = layout.isolated!.position.y;
      const isoBottom = isoTop + layout.isolated!.size.height;

      for (const id of ["n1", "n2"]) {
        const nLeft = layout[id]!.position.x;
        const nRight = nLeft + layout[id]!.size.width;
        const nTop = layout[id]!.position.y;
        const nBottom = nTop + layout[id]!.size.height;

        const overlaps =
          isoLeft < nRight && isoRight > nLeft && isoTop < nBottom && isoBottom > nTop;
        expect(overlaps).toBe(false);
      }
    });

    it("computes layout with extend_region mutationScope flag seamlessly via computeLayout", () => {
      const ops: Operation[] = [
        { op: "CREATE_NODE", id: "start", nodeType: "step", label: "Initial Step" },
      ];
      let ws = applyOperations(createWorkspace(), ops);
      ws = applyLayout(ws, computeLayout(ws));
      const startPos = { ...ws.nodes.start!.position! };

      const extOps: Operation[] = [
        { op: "CREATE_NODE", id: "next_step", nodeType: "step", label: "Follow-up Step" },
        { op: "CONNECT_NODES", source: "start", target: "next_step", relationship: "next" },
      ];
      const updatedWs = applyOperations(ws, extOps);

      const layout = computeLayout(updatedWs, { mutationScope: "extend_region" });
      expect(layout.start!.position).toEqual(startPos);
      expect(layout.next_step!.position.y).toBeGreaterThan(startPos.y);
    });
  });
});
