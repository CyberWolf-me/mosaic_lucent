import { describe, it, expect } from "vitest";
import {
  createWorkspace,
  applyOperations,
  isDestructiveOperation,
  DESTRUCTIVE_OPS,
  type Operation,
} from "@lucent/core";
import { applyPreview } from "../src/views/CanvasView.js";

describe("Conversational editing & proposal review integrity", () => {
  describe("Destructive operations classification", () => {
    it("recognizes all destructive operation types", () => {
      expect(isDestructiveOperation({ op: "DELETE_NODE", id: "n1" })).toBe(true);
      expect(isDestructiveOperation({ op: "DELETE_GROUP", id: "g1" })).toBe(true);
      expect(isDestructiveOperation({ op: "DELETE_SHAPE", id: "s1" })).toBe(true);
      expect(isDestructiveOperation({ op: "DELETE_WIREFRAME", id: "w1" })).toBe(true);
      expect(isDestructiveOperation({ op: "TRANSFORM_DIAGRAM", to: "flowchart" })).toBe(true);
      expect(
        isDestructiveOperation({
          op: "DISCONNECT_NODES",
          source: "n1",
          target: "n2",
          relationship: "calls",
        }),
      ).toBe(true);
    });

    it("does not classify additive or modification operations as destructive", () => {
      expect(
        isDestructiveOperation({
          op: "CREATE_NODE",
          id: "n1",
          nodeType: "service",
          label: "Service",
        }),
      ).toBe(false);
      expect(
        isDestructiveOperation({
          op: "CONNECT_NODES",
          source: "n1",
          target: "n2",
          relationship: "calls",
        }),
      ).toBe(false);
      expect(isDestructiveOperation({ op: "CHANGE_TEXT", id: "n1", text: "Updated Label" })).toBe(
        false,
      );
      expect(isDestructiveOperation({ op: "SET_NODE_TYPE", id: "n1", nodeType: "database" })).toBe(
        false,
      );
    });
  });

  describe("Proposal gating decision logic", () => {
    function shouldRequireProposal(
      ops: Operation[],
      existingNodeCount: number,
      threshold = 5,
      forcePropose = false,
    ): boolean {
      const hasDestructive = ops.some((op) => {
        if (op.op === "TRANSFORM_DIAGRAM" && existingNodeCount === 0) return false;
        return isDestructiveOperation(op);
      });
      return (
        forcePropose === true ||
        (ops.length > threshold && existingNodeCount > 0) ||
        (hasDestructive && existingNodeCount > 0)
      );
    }

    it("requires proposal review for single-op DELETE_NODE on non-empty board", () => {
      const ops: Operation[] = [{ op: "DELETE_NODE", id: "auth-svc" }];
      expect(shouldRequireProposal(ops, 4)).toBe(true);
    });

    it("requires proposal review for single-op DISCONNECT_NODES on non-empty board", () => {
      const ops: Operation[] = [
        { op: "DISCONNECT_NODES", source: "auth-svc", target: "db", relationship: "reads" },
      ];
      expect(shouldRequireProposal(ops, 4)).toBe(true);
    });

    it("does not require proposal review for small additive batch (<= 5 ops) on non-empty board", () => {
      const ops: Operation[] = [
        { op: "CREATE_NODE", id: "cache", nodeType: "cache", label: "Redis Cache" },
        { op: "CONNECT_NODES", source: "auth-svc", target: "cache", relationship: "caches tokens" },
      ];
      expect(shouldRequireProposal(ops, 4)).toBe(false);
    });

    it("requires proposal review when batch size exceeds threshold (> 5 ops) on non-empty board", () => {
      const ops: Operation[] = [
        { op: "CREATE_NODE", id: "n1", nodeType: "service", label: "N1" },
        { op: "CREATE_NODE", id: "n2", nodeType: "service", label: "N2" },
        { op: "CREATE_NODE", id: "n3", nodeType: "service", label: "N3" },
        { op: "CREATE_NODE", id: "n4", nodeType: "service", label: "N4" },
        { op: "CREATE_NODE", id: "n5", nodeType: "service", label: "N5" },
        { op: "CREATE_NODE", id: "n6", nodeType: "service", label: "N6" },
      ];
      expect(shouldRequireProposal(ops, 2)).toBe(true);
    });

    it("does not require proposal review on empty board initialization", () => {
      const ops: Operation[] = [
        { op: "TRANSFORM_DIAGRAM", to: "architecture" },
        { op: "CREATE_NODE", id: "api", nodeType: "service", label: "API" },
      ];
      expect(shouldRequireProposal(ops, 0)).toBe(false);
    });

    it("requires proposal review for TRANSFORM_DIAGRAM on non-empty board", () => {
      const ops: Operation[] = [{ op: "TRANSFORM_DIAGRAM", to: "mindmap" }];
      expect(shouldRequireProposal(ops, 5)).toBe(true);
    });
  });

  describe("Canvas proposal preview fidelity (applyPreview)", () => {
    it("simulates additions, modifications, and keeps deleted nodes as ghost previews", () => {
      // 1. Initial workspace with 3 nodes and 2 edges
      let ws = createWorkspace();
      ws = applyOperations(ws, [
        { op: "CREATE_NODE", id: "client", nodeType: "client", label: "Web Client" },
        { op: "CREATE_NODE", id: "gateway", nodeType: "gateway", label: "API Gateway" },
        { op: "CREATE_NODE", id: "legacy-db", nodeType: "database", label: "Legacy DB" },
        { op: "CONNECT_NODES", source: "client", target: "gateway", relationship: "requests" },
        { op: "CONNECT_NODES", source: "gateway", target: "legacy-db", relationship: "queries" },
      ]);

      // 2. Proposal: delete legacy-db, rename gateway, add new-db, disconnect legacy, connect new
      const proposalOps: Operation[] = [
        { op: "DELETE_NODE", id: "legacy-db" },
        { op: "CHANGE_TEXT", id: "gateway", text: "Kong API Gateway" },
        { op: "CREATE_NODE", id: "new-db", nodeType: "database", label: "Postgres DB" },
        { op: "CONNECT_NODES", source: "gateway", target: "new-db", relationship: "queries" },
      ];

      const preview = applyPreview(ws, proposalOps);

      // Node additions are present
      expect(preview.nodes["new-db"]).toBeDefined();
      expect(preview.nodes["new-db"]?.label).toBe("Postgres DB");

      // Node renames are reflected
      expect(preview.nodes["gateway"]?.label).toBe("Kong API Gateway");

      // Node slated for deletion is PRESERVED in preview.nodes so it can be rendered as a ghost
      expect(preview.nodes["legacy-db"]).toBeDefined();
      expect(preview.nodes["legacy-db"]?.label).toBe("Legacy DB");

      // New connection exists
      const newEdgeId = "gateway->new-db:queries";
      expect(preview.edges[newEdgeId]).toBeDefined();

      // Disconnected edge to legacy DB is removed from active edges
      const oldEdgeId = "gateway->legacy-db:queries";
      expect(preview.edges[oldEdgeId]).toBeUndefined();

      // Original workspace was not mutated
      expect(ws.nodes["new-db"]).toBeUndefined();
      expect(ws.nodes["gateway"]?.label).toBe("API Gateway");
      expect(ws.edges[oldEdgeId]).toBeDefined();
    });
  });
});
