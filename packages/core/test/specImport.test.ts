import { describe, expect, it } from "vitest";
import {
  classifySpec,
  sqlDdlToOps,
  prismaToOps,
  openApiToOps,
  composeToOps,
  specToOps,
} from "../src/specImport.js";
import { createWorkspace } from "../src/model.js";
import { validateOperations } from "../src/validator.js";
import { applyOperations } from "../src/reducer.js";

describe("Specification & Code Ingestion (Initiative 4)", () => {
  describe("classifySpec", () => {
    it("classifies by filename extension", () => {
      expect(classifySpec("", "schema.sql")).toBe("sqlddl");
      expect(classifySpec("", "schema.prisma")).toBe("prisma");
      expect(classifySpec("", "docker-compose.yml")).toBe("compose");
      expect(classifySpec("", "openapi.yaml")).toBe("openapi");
      expect(classifySpec("", "swagger.json")).toBe("openapi");
    });

    it("sniffs SQL DDL content without filename", () => {
      const sql = "CREATE TABLE users (id INT PRIMARY KEY, name VARCHAR(100));";
      expect(classifySpec(sql)).toBe("sqlddl");
    });

    it("sniffs Prisma schema content without filename", () => {
      const prisma = `
        datasource db { provider = "postgresql" url = env("DATABASE_URL") }
        model User { id Int @id, email String }
      `;
      expect(classifySpec(prisma)).toBe("prisma");
    });

    it("sniffs OpenAPI JSON content without filename", () => {
      const json = JSON.stringify({ openapi: "3.0.0", info: { title: "API" }, paths: {} });
      expect(classifySpec(json)).toBe("openapi");
    });

    it("sniffs Docker Compose content without filename", () => {
      const compose = "services:\n  web:\n    image: nginx:latest\n";
      expect(classifySpec(compose)).toBe("compose");
    });
  });

  describe("SQL DDL Ingestion", () => {
    const sampleSql = `
      -- E-Commerce Schema
      CREATE TABLE users (
        id UUID PRIMARY KEY,
        email VARCHAR(255) NOT NULL UNIQUE,
        full_name VARCHAR(100),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE orders (
        id UUID PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id),
        total_cents INT NOT NULL,
        status VARCHAR(50) NOT NULL
      );

      CREATE TABLE order_items (
        id UUID PRIMARY KEY,
        order_id UUID NOT NULL,
        product_id UUID NOT NULL,
        quantity INT NOT NULL,
        FOREIGN KEY (order_id) REFERENCES orders(id)
      );
    `;

    it("parses tables, columns, and foreign keys into valid operations", () => {
      const ops = sqlDdlToOps(sampleSql);
      expect(ops.length).toBeGreaterThan(0);
      expect(ops[0]).toEqual({ op: "CREATE_DIAGRAM", kind: "er" });

      const nodeOps = ops.filter((o) => o.op === "CREATE_NODE");
      expect(nodeOps.length).toBe(3);

      const labels = nodeOps.map((n) => (n as any).label);
      expect(labels).toContain("users");
      expect(labels).toContain("orders");
      expect(labels).toContain("order_items");

      // Verify foreign key connectors
      const edgeOps = ops.filter((o) => o.op === "CONNECT_NODES");
      expect(edgeOps.length).toBe(2);

      // Verify operations pass core validation and reducer execution
      let ws = createWorkspace();
      const errors = validateOperations(ws, ops);
      expect(errors).toEqual([]);

      ws = applyOperations(ws, ops);
      expect(Object.keys(ws.nodes).length).toBe(3);
      expect(Object.keys(ws.edges).length).toBe(2);
      expect(ws.nodes.tbl_users?.details?.sections[0]?.items.length).toBeGreaterThan(0);
    });
  });

  describe("Prisma Schema Ingestion", () => {
    const samplePrisma = `
      datasource db {
        provider = "postgresql"
        url      = env("DATABASE_URL")
      }

      model Organization {
        id        String   @id @default(uuid())
        name      String
        users     User[]
        createdAt DateTime @default(now())
      }

      model User {
        id             String        @id @default(uuid())
        email          String        @unique
        name           String?
        orgId          String
        organization   Organization  @relation(fields: [orgId], references: [id])
        posts          Post[]
      }

      model Post {
        id       Int    @id @default(autoincrement())
        title    String
        authorId String
        author   User   @relation(fields: [authorId], references: [id])
      }
    `;

    it("parses models, fields, and relations into valid operations", () => {
      const ops = prismaToOps(samplePrisma);
      expect(ops[0]).toEqual({ op: "CREATE_DIAGRAM", kind: "er" });

      const nodeOps = ops.filter((o) => o.op === "CREATE_NODE");
      expect(nodeOps.length).toBe(3);

      const edgeOps = ops.filter((o) => o.op === "CONNECT_NODES");
      expect(edgeOps.length).toBeGreaterThanOrEqual(2);

      let ws = createWorkspace();
      const errors = validateOperations(ws, ops);
      expect(errors).toEqual([]);

      ws = applyOperations(ws, ops);
      expect(Object.keys(ws.nodes).length).toBe(3);
      expect(ws.nodes.model_user?.details?.sections[0]?.items).toBeDefined();
    });
  });

  describe("OpenAPI / Swagger Ingestion", () => {
    const sampleOpenApiJson = JSON.stringify({
      openapi: "3.0.0",
      info: { title: "Pet Store API", version: "1.0" },
      paths: {
        "/auth/login": {
          post: { tags: ["Auth"], summary: "Login user" },
        },
        "/pets": {
          get: { tags: ["Pets"], summary: "List pets" },
          post: { tags: ["Pets"], summary: "Create pet" },
        },
        "/pets/{id}": {
          get: { tags: ["Pets"], summary: "Get pet by id" },
        },
      },
      components: {
        schemas: {
          Pet: {
            type: "object",
            properties: {
              id: { type: "string" },
              name: { type: "string" },
              status: { type: "string" },
            },
          },
        },
      },
    });

    it("parses endpoints, tags, and schemas into architecture operations", () => {
      const ops = openApiToOps(sampleOpenApiJson);
      expect(ops[0]).toEqual({ op: "CREATE_DIAGRAM", kind: "architecture" });

      const groups = ops.filter((o) => o.op === "CREATE_GROUP");
      expect(groups.length).toBe(1); // "Pets" tag has 3 endpoints

      const nodes = ops.filter((o) => o.op === "CREATE_NODE");
      expect(nodes.length).toBe(5); // 4 endpoints + 1 Pet schema

      let ws = createWorkspace();
      const errors = validateOperations(ws, ops);
      expect(errors).toEqual([]);

      ws = applyOperations(ws, ops);
      expect(Object.keys(ws.nodes).length).toBe(5);
      expect(Object.keys(ws.groups).length).toBe(1);
    });
  });

  describe("Docker Compose Ingestion", () => {
    const sampleCompose = `
      services:
        web:
          image: nginx:alpine
          ports:
            - "80:80"
          depends_on:
            - api
        api:
          build: ./api
          depends_on:
            - postgres
            - redis
        postgres:
          image: postgres:16
        redis:
          image: redis:7-alpine
    `;

    it("parses container services and dependencies into architecture operations", () => {
      const ops = composeToOps(sampleCompose);
      expect(ops[0]).toEqual({ op: "CREATE_DIAGRAM", kind: "architecture" });

      const nodes = ops.filter((o) => o.op === "CREATE_NODE");
      expect(nodes.length).toBe(4);

      const edges = ops.filter((o) => o.op === "CONNECT_NODES");
      expect(edges.length).toBe(3); // web->api, api->postgres, api->redis

      let ws = createWorkspace();
      const errors = validateOperations(ws, ops);
      expect(errors).toEqual([]);

      ws = applyOperations(ws, ops);
      expect(Object.keys(ws.nodes).length).toBe(4);
      expect(Object.keys(ws.edges).length).toBe(3);
    });
  });

  describe("specToOps unified dispatcher", () => {
    it("dispatches SQL DDL with stats summary", () => {
      const res = specToOps("CREATE TABLE items (id INT PRIMARY KEY, name TEXT);", "items.sql");
      expect(res.format).toBe("sqlddl");
      expect(res.summary.nodes).toBe(1);
      expect(res.summary.title).toContain("SQL");
      expect(res.ops.length).toBeGreaterThan(0);
    });
  });
});
