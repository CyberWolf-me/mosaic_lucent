import { describe, it, expect } from "vitest";
import { createWorkspace, applyOperations } from "@lucent/core";
import type { Operation } from "@lucent/core";
import { toEr } from "../src/board/er.js";

function graph() {
  const ops: Operation[] = [
    { op: "CREATE_NODE", id: "user", nodeType: "entity", label: "User" },
    { op: "CREATE_NODE", id: "order", nodeType: "entity", label: "Order" },
    { op: "CREATE_NODE", id: "item", nodeType: "entity", label: "Item" },
    { op: "CONNECT_NODES", source: "user", target: "order", relationship: "places" },
    { op: "CONNECT_NODES", source: "order", target: "item", relationship: "contains" },
    { op: "CONNECT_NODES", source: "order", target: "user", relationship: "belongs_to" },
  ];
  return applyOperations(createWorkspace(), ops);
}

describe("toEr (Phase D)", () => {
  it("creates one entity per node with an id key attribute", () => {
    const er = toEr(graph());
    expect(er.entities).toHaveLength(3);
    expect(er.entities[0]?.attributes[0]).toEqual({ name: "id", key: true });
  });

  it("creates one relationship per edge", () => {
    const er = toEr(graph());
    expect(er.relationships).toHaveLength(3);
    expect(er.relationships.find((r) => r.source === "user")?.label).toBe("places");
  });

  it("guesses 1..* cardinality for a source with multiple outgoing edges", () => {
    const er = toEr(graph());
    // order → item and order → user, so order relationships are 1..*
    const orderRels = er.relationships.filter((r) => r.source === "order");
    expect(orderRels.every((r) => r.cardinality === "1..*")).toBe(true);
    // user has a single outgoing edge → 1..1
    expect(er.relationships.find((r) => r.source === "user")?.cardinality).toBe("1..1");
  });

  it("is empty for an empty board", () => {
    expect(toEr(createWorkspace()).entities).toHaveLength(0);
  });
});
