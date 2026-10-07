import { describe, expect, it } from "vitest";
import {
  classifySpec,
  specToOps,
  createWorkspace,
  validateOperations,
  applyOperations,
} from "@lucent/core";

describe("Specification & Code Ingestion Web Integration (Initiative 4)", () => {
  it("classifies file extensions correctly for drag-and-drop", () => {
    expect(classifySpec("", "schema.sql")).toBe("sqlddl");
    expect(classifySpec("", "schema.prisma")).toBe("prisma");
    expect(classifySpec("services:\n  web:\n    image: nginx", "docker-compose.yml")).toBe(
      "compose",
    );
    expect(classifySpec('{"openapi": "3.0.0"}', "api-spec.json")).toBe("openapi");
  });

  it("converts SQL DDL into valid ER diagram operations accepted by reducer", () => {
    const sql = `
      CREATE TABLE accounts (
        id UUID PRIMARY KEY,
        email VARCHAR(255) NOT NULL UNIQUE
      );
      CREATE TABLE subscriptions (
        id UUID PRIMARY KEY,
        account_id UUID REFERENCES accounts(id),
        plan VARCHAR(50) NOT NULL
      );
    `;
    const res = specToOps(sql);
    expect(res.format).toBe("sqlddl");
    expect(res.summary.nodes).toBe(2);
    expect(res.summary.edges).toBe(1);

    let ws = createWorkspace();
    const val = validateOperations(ws, res.ops);
    expect(val).toEqual([]);

    ws = applyOperations(ws, res.ops);
    expect(ws.diagramKind).toBe("er");
    expect(Object.keys(ws.nodes).length).toBe(2);
    expect(Object.keys(ws.edges).length).toBe(1);

    const accountsNode = Object.values(ws.nodes).find((n) => n.label === "accounts");
    expect(accountsNode).toBeDefined();
    expect(accountsNode?.details?.sections[0]?.items).toContain("🔑 id: UUID");
  });

  it("converts OpenAPI 3.0 specification into valid Architecture operations with tag groups", () => {
    const openapi = JSON.stringify({
      openapi: "3.0.1",
      paths: {
        "/users": {
          get: { tags: ["Users"], summary: "Get users" },
          post: { tags: ["Users"], summary: "Create user" },
        },
      },
      components: {
        schemas: {
          User: {
            properties: {
              id: { type: "string" },
              email: { type: "string" },
            },
          },
        },
      },
    });

    const res = specToOps(openapi);
    expect(res.format).toBe("openapi");
    expect(res.summary.nodes).toBe(3); // 2 endpoints + 1 User schema
    expect(res.summary.groups).toBe(1); // Users API group (since >= 2 endpoints)

    let ws = createWorkspace();
    const val = validateOperations(ws, res.ops);
    expect(val).toEqual([]);

    ws = applyOperations(ws, res.ops);
    expect(ws.diagramKind).toBe("architecture");
    expect(Object.keys(ws.nodes).length).toBe(3);
    expect(Object.keys(ws.groups).length).toBe(1);
  });

  it("converts Prisma schema models and relations into ER diagram operations", () => {
    const prisma = `
      model Team {
        id String @id
        name String
        members Member[]
      }
      model Member {
        id String @id
        teamId String
        team Team @relation(fields: [teamId], references: [id])
      }
    `;

    const res = specToOps(prisma);
    expect(res.format).toBe("prisma");
    expect(res.summary.nodes).toBe(2);
    expect(res.summary.edges).toBe(1);

    let ws = createWorkspace();
    const val = validateOperations(ws, res.ops);
    expect(val).toEqual([]);

    ws = applyOperations(ws, res.ops);
    expect(ws.diagramKind).toBe("er");
    expect(Object.keys(ws.nodes).length).toBe(2);
    expect(Object.keys(ws.edges).length).toBe(1);
  });

  it("converts Docker Compose into architecture operations with dependencies and port details", () => {
    const compose = `
      services:
        web:
          image: nginx:alpine
          ports:
            - "80:80"
          depends_on:
            - api
        api:
          image: python:3.11-slim
          ports:
            - "5000:5000"
    `;

    const res = specToOps(compose);
    expect(res.format).toBe("compose");
    expect(res.summary.nodes).toBe(2);
    expect(res.summary.edges).toBe(1);

    let ws = createWorkspace();
    const val = validateOperations(ws, res.ops);
    expect(val).toEqual([]);

    ws = applyOperations(ws, res.ops);
    expect(ws.diagramKind).toBe("architecture");
    expect(Object.keys(ws.nodes).length).toBe(2);
    expect(Object.keys(ws.edges).length).toBe(1);
  });

  it("does not falsely classify generic conversational text as an engineering spec", () => {
    expect(classifySpec("Can you build a simple flowchart for the signup process?")).toBe(
      "unknown",
    );
    expect(classifySpec("Here is a list of features: 1. Auth 2. Profile")).toBe("unknown");
    expect(classifySpec("Hello world")).toBe("unknown");
  });
});
