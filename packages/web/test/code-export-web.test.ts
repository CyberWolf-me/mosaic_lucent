import { describe, expect, it } from "vitest";
import { createWorkspace, applyOperations, exportBoardToCode, type Operation } from "@lucent/core";

describe("Production Code Export Web Integration (Initiative 5)", () => {
  it("exports ER diagram to Prisma schema with models and relations", () => {
    let ws = createWorkspace({ name: "Ecommerce", diagramKind: "er" });
    const ops: Operation[] = [
      {
        op: "CREATE_NODE",
        id: "users",
        nodeType: "database",
        label: "users",
        details: {
          sections: [{ items: ["🔑 id: UUID", "email: VARCHAR(255) NOT NULL UNIQUE"] }],
        },
      },
      {
        op: "CREATE_NODE",
        id: "orders",
        nodeType: "database",
        label: "orders",
        details: {
          sections: [{ items: ["🔑 id: UUID", "user_id: UUID NOT NULL", "total: INT NOT NULL"] }],
        },
      },
      {
        op: "CONNECT_NODES",
        source: "orders",
        target: "users",
        relationship: "references (user_id)",
      },
    ];
    ws = applyOperations(ws, ops);

    const res = exportBoardToCode(ws, "prisma");
    expect(res.format).toBe("prisma");
    expect(res.fileName).toBe("schema.prisma");
    expect(res.language).toBe("prisma");
    expect(res.code).toContain("model User {");
    expect(res.code).toContain("model Order {");
    expect(res.code).toContain(
      "user             User @relation(fields: [userId], references: [id])",
    );
    expect(res.code).toContain("orders           Order[]");
  });

  it("exports architecture diagram to Docker Compose with services, ports, and depends_on", () => {
    let ws = createWorkspace({ name: "Microservices", diagramKind: "architecture" });
    const ops: Operation[] = [
      {
        op: "CREATE_NODE",
        id: "gateway",
        nodeType: "gateway",
        label: "gateway",
        details: { sections: [{ items: ["image: nginx:alpine", "ports: 80:80"] }] },
      },
      {
        op: "CREATE_NODE",
        id: "api",
        nodeType: "service",
        label: "api",
        details: { sections: [{ items: ["image: node:20-alpine", "ports: 3000:3000"] }] },
      },
      {
        op: "CREATE_NODE",
        id: "postgres",
        nodeType: "database",
        label: "postgres",
      },
      { op: "CONNECT_NODES", source: "gateway", target: "api", relationship: "routes" },
      { op: "CONNECT_NODES", source: "api", target: "postgres", relationship: "queries" },
    ];
    ws = applyOperations(ws, ops);

    const res = exportBoardToCode(ws, "compose");
    expect(res.format).toBe("compose");
    expect(res.fileName).toBe("docker-compose.yml");
    expect(res.language).toBe("yaml");
    expect(res.code).toContain("gateway:");
    expect(res.code).toContain("api:");
    expect(res.code).toContain("postgres:");
    expect(res.code).toContain("depends_on:");
  });

  it("exports flowchart to XState v5 state machine with events and transitions", () => {
    let ws = createWorkspace({ name: "Checkout Flow", diagramKind: "flowchart" });
    const ops: Operation[] = [
      { op: "CREATE_NODE", id: "cart", nodeType: "process", label: "Cart" },
      { op: "CREATE_NODE", id: "pay", nodeType: "process", label: "Payment" },
      { op: "CREATE_NODE", id: "complete", nodeType: "service", label: "Order Complete" },
      { op: "CONNECT_NODES", source: "cart", target: "pay", relationship: "PROCEED_TO_PAY" },
      { op: "CONNECT_NODES", source: "pay", target: "complete", relationship: "PAYMENT_CONFIRMED" },
    ];
    ws = applyOperations(ws, ops);

    const res = exportBoardToCode(ws, "xstate");
    expect(res.format).toBe("xstate");
    expect(res.fileName).toBe("checkout_flow.machine.ts");
    expect(res.language).toBe("typescript");
    expect(res.code).toContain("checkoutFlowMachine = setup({");
    expect(res.code).toContain('{ type: "PROCEED_TO_PAY" }');
    expect(res.code).toContain('{ type: "PAYMENT_CONFIRMED" }');
  });

  it("exports entities to TypeScript domain interfaces", () => {
    let ws = createWorkspace({ name: "Core Models", diagramKind: "er" });
    const ops: Operation[] = [
      {
        op: "CREATE_NODE",
        id: "user",
        nodeType: "database",
        label: "User",
        details: { sections: [{ items: ["🔑 id: string", "email: string NOT NULL"] }] },
      },
    ];
    ws = applyOperations(ws, ops);

    const res = exportBoardToCode(ws, "typescript");
    expect(res.format).toBe("typescript");
    expect(res.fileName).toBe("core_models.types.ts");
    expect(res.language).toBe("typescript");
    expect(res.code).toContain("export interface User {");
    expect(res.code).toContain("email: string;");
  });
});
