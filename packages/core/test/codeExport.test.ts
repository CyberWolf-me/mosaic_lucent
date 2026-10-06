import { describe, expect, it } from "vitest";
import {
  createWorkspace,
  applyOperations,
  boardToXState,
  boardToPrisma,
  boardToSqlDdl,
  boardToDockerCompose,
  boardToTypeScriptTypes,
  exportBoardToCode,
  type Operation,
} from "../src/index.js";

describe("Production Code Export Engine (Initiative 5)", () => {
  describe("XState v5 State Machine Exporter", () => {
    it("compiles workflow nodes and edge transitions into executable XState v5 code", () => {
      let ws = createWorkspace({ name: "Auth Workflow", diagramKind: "flowchart" });
      const ops: Operation[] = [
        { op: "CREATE_NODE", id: "n_idle", nodeType: "service", label: "Idle State" },
        { op: "CREATE_NODE", id: "n_auth", nodeType: "process", label: "Authenticating" },
        { op: "CREATE_NODE", id: "n_success", nodeType: "service", label: "Dashboard Success" },
        { op: "CREATE_NODE", id: "n_error", nodeType: "decision", label: "Auth Failed" },
        { op: "CONNECT_NODES", source: "n_idle", target: "n_auth", relationship: "LOGIN_SUBMIT" },
        { op: "CONNECT_NODES", source: "n_auth", target: "n_success", relationship: "AUTH_OK" },
        { op: "CONNECT_NODES", source: "n_auth", target: "n_error", relationship: "AUTH_FAIL" },
        { op: "CONNECT_NODES", source: "n_error", target: "n_idle", relationship: "RETRY" },
      ];
      ws = applyOperations(ws, ops);

      const code = boardToXState(ws);
      expect(code).toContain('import { setup, createMachine } from "xstate";');
      expect(code).toContain("authWorkflowMachine = setup({");
      expect(code).toContain('{ type: "LOGIN_SUBMIT" }');
      expect(code).toContain('{ type: "AUTH_OK" }');
      expect(code).toContain('{ type: "AUTH_FAIL" }');
      expect(code).toContain('{ type: "RETRY" }');
      expect(code).toContain('initial: "idleState"');
      expect(code).toContain("idleState: {");
      expect(code).toContain("authenticating: {");
      expect(code).toContain("LOGIN_SUBMIT: { target: \"authenticating\" }");
      expect(code).toContain("AUTH_OK: { target: \"dashboardSuccess\" }");
    });

    it("handles empty boards cleanly", () => {
      const ws = createWorkspace();
      const code = boardToXState(ws);
      expect(code).toContain("createMachine");
    });
  });

  describe("Prisma Schema Exporter", () => {
    it("compiles ER diagrams with column details and relations into clean schema.prisma", () => {
      let ws = createWorkspace({ name: "Commerce Schema", diagramKind: "er" });
      const ops: Operation[] = [
        {
          op: "CREATE_NODE",
          id: "n_user",
          nodeType: "database",
          label: "users",
          details: {
            sections: [
              {
                title: "Columns",
                items: [
                  "🔑 id: UUID",
                  "email: VARCHAR(255) NOT NULL UNIQUE",
                  "full_name: VARCHAR(100)",
                  "created_at: TIMESTAMP NOT NULL",
                ],
              },
            ],
          },
        },
        {
          op: "CREATE_NODE",
          id: "n_order",
          nodeType: "database",
          label: "orders",
          details: {
            sections: [
              {
                title: "Columns",
                items: [
                  "🔑 id: UUID",
                  "user_id: UUID NOT NULL",
                  "total_cents: INT NOT NULL",
                  "status: VARCHAR(32) NOT NULL",
                ],
              },
            ],
          },
        },
        {
          op: "CONNECT_NODES",
          source: "n_order",
          target: "n_user",
          relationship: "references (user_id)",
        },
      ];
      ws = applyOperations(ws, ops);

      const prisma = boardToPrisma(ws);
      expect(prisma).toContain('datasource db {');
      expect(prisma).toContain('generator client {');
      expect(prisma).toContain("model User {");
      expect(prisma).toContain("model Order {");
      expect(prisma).toContain("id               String @id @default(uuid())");
      expect(prisma).toContain("email            String @unique");
      expect(prisma).toContain("totalCents       Int");
      expect(prisma).toContain("user             User @relation(fields: [userId], references: [id])");
      expect(prisma).toContain("orders           Order[]");
    });
  });

  describe("SQL DDL Exporter", () => {
    it("compiles ER diagrams into PostgreSQL DDL with foreign key constraints", () => {
      let ws = createWorkspace({ name: "SaaS DB", diagramKind: "er" });
      const ops: Operation[] = [
        {
          op: "CREATE_NODE",
          id: "t_org",
          nodeType: "database",
          label: "organizations",
          details: {
            sections: [
              {
                title: "Columns",
                items: ["🔑 id: UUID", "slug: VARCHAR(64) NOT NULL UNIQUE"],
              },
            ],
          },
        },
        {
          op: "CREATE_NODE",
          id: "t_member",
          nodeType: "database",
          label: "members",
          details: {
            sections: [
              {
                title: "Columns",
                items: ["🔑 id: UUID", "org_id: UUID NOT NULL", "role: VARCHAR(32) NOT NULL"],
              },
            ],
          },
        },
        {
          op: "CONNECT_NODES",
          source: "t_member",
          target: "t_org",
          relationship: "references (org_id)",
        },
      ];
      ws = applyOperations(ws, ops);

      const sql = boardToSqlDdl(ws);
      expect(sql).toContain("CREATE TABLE organizations (");
      expect(sql).toContain("CREATE TABLE members (");
      expect(sql).toContain("id               UUID PRIMARY KEY");
      expect(sql).toContain("slug             VARCHAR(64) NOT NULL UNIQUE");
      expect(sql).toContain("CONSTRAINT fk_members_org_id FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE");
    });
  });

  describe("Docker Compose Exporter", () => {
    it("compiles architecture services, images, ports, and dependencies into docker-compose.yml", () => {
      let ws = createWorkspace({ name: "Web Stack", diagramKind: "architecture" });
      const ops: Operation[] = [
        {
          op: "CREATE_NODE",
          id: "svc_web",
          nodeType: "service",
          label: "web",
          details: {
            sections: [{ items: ["image: nginx:alpine", "ports: 80:80"] }],
          },
        },
        {
          op: "CREATE_NODE",
          id: "svc_api",
          nodeType: "service",
          label: "api",
          details: {
            sections: [{ items: ["image: node:20-alpine", "ports: 3000:3000"] }],
          },
        },
        {
          op: "CREATE_NODE",
          id: "svc_pg",
          nodeType: "database",
          label: "postgres",
        },
        {
          op: "CREATE_NODE",
          id: "svc_redis",
          nodeType: "cache",
          label: "redis",
        },
        { op: "CONNECT_NODES", source: "svc_web", target: "svc_api", relationship: "proxies to" },
        { op: "CONNECT_NODES", source: "svc_api", target: "svc_pg", relationship: "queries" },
        { op: "CONNECT_NODES", source: "svc_api", target: "svc_redis", relationship: "caches in" },
      ];
      ws = applyOperations(ws, ops);

      const compose = boardToDockerCompose(ws);
      expect(compose).toContain('version: "3.8"');
      expect(compose).toContain("services:");
      expect(compose).toContain("web:");
      expect(compose).toContain("image: nginx:alpine");
      expect(compose).toContain('- "80:80"');
      expect(compose).toContain("api:");
      expect(compose).toContain("postgres:");
      expect(compose).toContain("image: postgres:16-alpine");
      expect(compose).toContain("redis:");
      expect(compose).toContain("image: redis:7-alpine");
      expect(compose).toContain("depends_on:");
      expect(compose).toContain("app-network:");
    });
  });

  describe("TypeScript Domain Types Exporter", () => {
    it("compiles entities into strongly-typed TypeScript interfaces", () => {
      let ws = createWorkspace({ name: "Domain Model", diagramKind: "er" });
      const ops: Operation[] = [
        {
          op: "CREATE_NODE",
          id: "n_user",
          nodeType: "database",
          label: "User",
          details: {
            sections: [
              {
                title: "Fields",
                items: [
                  "🔑 id: string",
                  "email: string NOT NULL",
                  "age: int",
                  "isActive: boolean NOT NULL",
                ],
              },
            ],
          },
        },
        {
          op: "CREATE_NODE",
          id: "n_profile",
          nodeType: "database",
          label: "Profile",
          details: {
            sections: [
              {
                title: "Fields",
                items: ["bio: string", "avatarUrl: string"],
              },
            ],
          },
        },
        {
          op: "CONNECT_NODES",
          source: "n_user",
          target: "n_profile",
          relationship: "has",
        },
      ];
      ws = applyOperations(ws, ops);

      const ts = boardToTypeScriptTypes(ws);
      expect(ts).toContain("export interface User {");
      expect(ts).toContain("export interface Profile {");
      expect(ts).toContain("email: string;");
      expect(ts).toContain("age?: number;");
      expect(ts).toContain("isActive: boolean;");
      expect(ts).toContain("profile?: Profile;");
      expect(ts).toContain("export type DomainEntity =");
    });
  });

  describe("exportBoardToCode unified dispatcher", () => {
    it("auto-resolves format to prisma for ER diagrams", () => {
      let ws = createWorkspace({ name: "Store DB", diagramKind: "er" });
      ws = applyOperations(ws, [
        { op: "CREATE_NODE", id: "n1", nodeType: "database", label: "products" },
      ]);
      const res = exportBoardToCode(ws);
      expect(res.format).toBe("prisma");
      expect(res.fileName).toBe("schema.prisma");
      expect(res.language).toBe("prisma");
      expect(res.code).toContain("model Product");
    });

    it("auto-resolves format to compose for architecture diagrams", () => {
      let ws = createWorkspace({ name: "Cloud Stack", diagramKind: "architecture" });
      ws = applyOperations(ws, [
        { op: "CREATE_NODE", id: "n1", nodeType: "service", label: "backend" },
      ]);
      const res = exportBoardToCode(ws);
      expect(res.format).toBe("compose");
      expect(res.fileName).toBe("docker-compose.yml");
      expect(res.language).toBe("yaml");
      expect(res.code).toContain("backend:");
    });

    it("auto-resolves format to xstate for flowchart diagrams", () => {
      let ws = createWorkspace({ name: "Payment Flow", diagramKind: "flowchart" });
      ws = applyOperations(ws, [
        { op: "CREATE_NODE", id: "n1", nodeType: "process", label: "checkout" },
      ]);
      const res = exportBoardToCode(ws);
      expect(res.format).toBe("xstate");
      expect(res.fileName).toBe("payment_flow.machine.ts");
      expect(res.language).toBe("typescript");
      expect(res.code).toContain("createMachine");
    });
  });
});
