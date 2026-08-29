import { describe, it, expect } from "vitest";
import { applyOperations, createWorkspace, validateOperations } from "@lucent/core";
import {
  classifyCode,
  composeToOps,
  packageJsonToOps,
  codeToOps,
} from "../src/board/codeImport.js";

const COMPOSE = `
services:
  web:
    image: nginx:latest
    depends_on:
      - api
  api:
    build: ./api
    depends_on:
      - db
      - cache
  db:
    image: postgres:16
  cache:
    image: redis:7
`;

describe("classifyCode", () => {
  it("detects compose by filename and by content", () => {
    expect(classifyCode("docker-compose.yml", "")).toBe("compose");
    expect(classifyCode("compose.yaml", "")).toBe("compose");
    expect(classifyCode("x.yml", COMPOSE)).toBe("compose");
  });
  it("detects package.json", () => {
    expect(classifyCode("package.json", "")).toBe("package");
    expect(classifyCode("x", '{"name":"a","dependencies":{}}')).toBe("package");
  });
  it("returns unknown for unrelated files", () => {
    expect(classifyCode("readme.md", "# hi")).toBe("unknown");
  });
});

describe("composeToOps", () => {
  it("creates a node per service", () => {
    const ops = composeToOps(COMPOSE);
    const ids = ops.filter((o) => o.op === "CREATE_NODE").map((o: any) => o.id);
    expect(ids.sort()).toEqual(["api", "cache", "db", "web"]);
  });
  it("maps images to sensible node types", () => {
    const ops = composeToOps(COMPOSE);
    const typeOf = (id: string) =>
      (ops.find((o) => o.op === "CREATE_NODE" && (o as any).id === id) as any).nodeType;
    expect(typeOf("db")).toBe("database");
    expect(typeOf("cache")).toBe("cache");
    expect(typeOf("web")).toBe("gateway");
    expect(typeOf("api")).toBe("service");
  });
  it("draws depends_on edges", () => {
    const ops = composeToOps(COMPOSE);
    const edges = ops
      .filter((o) => o.op === "CONNECT_NODES")
      .map((o: any) => `${o.source}->${o.target}`);
    expect(edges).toContain("web->api");
    expect(edges).toContain("api->db");
    expect(edges).toContain("api->cache");
  });
  it("handles inline list depends_on", () => {
    const ops = composeToOps(`
services:
  a:
    image: x
    depends_on: [b, c]
  b:
    image: y
  c:
    image: z
`);
    const edges = ops
      .filter((o) => o.op === "CONNECT_NODES")
      .map((o: any) => `${o.source}->${o.target}`);
    expect(edges).toContain("a->b");
    expect(edges).toContain("a->c");
  });
  it("produces a workspace that validates and applies", () => {
    const ops = composeToOps(COMPOSE);
    const ws = createWorkspace();
    expect(validateOperations(ws, ops)).toEqual([]);
    const next = applyOperations(ws, ops);
    expect(Object.keys(next.nodes).length).toBe(4);
    expect(next.diagramKind).toBe("architecture");
  });
  it("drops edges to services that don't exist", () => {
    const ops = composeToOps(`
services:
  a:
    image: x
    depends_on:
      - ghost
`);
    expect(ops.filter((o) => o.op === "CONNECT_NODES")).toHaveLength(0);
  });
  it("returns [] for a file with no services", () => {
    expect(composeToOps("version: '3'\n")).toEqual([]);
  });
});

describe("packageJsonToOps", () => {
  const PKG = JSON.stringify({
    name: "my-app",
    dependencies: { react: "^18", "react-dom": "^18" },
    devDependencies: { vitest: "^2" },
  });
  it("puts the package at the centre with an edge to each dependency", () => {
    const ops = packageJsonToOps(PKG);
    const nodes = ops.filter((o) => o.op === "CREATE_NODE").map((o: any) => o.label);
    expect(nodes).toContain("my-app");
    expect(nodes).toContain("react");
    expect(nodes).toContain("vitest");
    const edges = ops.filter((o) => o.op === "CONNECT_NODES");
    expect(edges.length).toBe(3);
  });
  it("labels dev dependencies differently", () => {
    const ops = packageJsonToOps(PKG);
    const rels = new Set(
      ops.filter((o) => o.op === "CONNECT_NODES").map((o: any) => o.relationship),
    );
    expect(rels.has("depends on")).toBe(true);
    expect(rels.has("dev dependency")).toBe(true);
  });
  it("validates and applies", () => {
    const ops = packageJsonToOps(PKG);
    const ws = createWorkspace();
    expect(validateOperations(ws, ops)).toEqual([]);
    expect(Object.keys(applyOperations(ws, ops).nodes).length).toBe(4);
  });
  it("returns [] on invalid JSON", () => {
    expect(packageJsonToOps("{not json")).toEqual([]);
  });
});

describe("codeToOps dispatch", () => {
  it("routes compose and package by filename", () => {
    expect(codeToOps("docker-compose.yml", COMPOSE).length).toBeGreaterThan(0);
    expect(
      codeToOps("package.json", '{"name":"a","dependencies":{"b":"1"}}').length,
    ).toBeGreaterThan(0);
  });
  it("returns [] for unknown", () => {
    expect(codeToOps("notes.txt", "hello")).toEqual([]);
  });
});
