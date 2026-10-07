import type { Edge, Workspace } from "./model.js";

/**
 * Production Code Export Engine (Initiative 5 / ADR 0052).
 *
 * Deterministically compiles visual canvas models (flowcharts, state machines,
 * ER diagrams, architecture diagrams) into production engineering code:
 * - XState v5 / TypeScript state machines
 * - Prisma ORM schemas (`schema.prisma`)
 * - SQL DDL (`CREATE TABLE`, foreign key constraints)
 * - Docker Compose infrastructure files (`docker-compose.yml`)
 * - TypeScript domain models & interfaces (`types.ts`)
 *
 * Pure, dependency-free TypeScript runnable in core, web, server, and MCP.
 */

export type CodeExportFormat = "xstate" | "prisma" | "sqlddl" | "compose" | "typescript";

export interface CodeExportResult {
  format: CodeExportFormat;
  fileName: string;
  mimeType: string;
  language: "typescript" | "prisma" | "sql" | "yaml";
  code: string;
  summary: string;
}

// ---------------------------------------------------------------------------
// Text Formatting & Sanitization Utilities
// ---------------------------------------------------------------------------

function toCamelCase(str: string): string {
  const words = str
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .split(/\s+/);
  if (words.length === 0 || !words[0]) return "node";
  const first = words[0].charAt(0).toLowerCase() + words[0].slice(1);
  return (
    first +
    words
      .slice(1)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join("")
  );
}

function toPascalCase(str: string): string {
  const camel = toCamelCase(str);
  return camel.charAt(0).toUpperCase() + camel.slice(1);
}

function toSnakeCase(str: string): string {
  return str
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

function toScreamingSnakeCase(str: string): string {
  return toSnakeCase(str).toUpperCase() || "EVENT";
}

function singularize(word: string): string {
  if (word.endsWith("ies")) return word.slice(0, -3) + "y";
  if (word.endsWith("ses")) return word.slice(0, -2);
  if (word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

// ---------------------------------------------------------------------------
// 1. XState v5 State Machine Exporter
// ---------------------------------------------------------------------------

export function boardToXState(workspace: Workspace): string {
  const nodes = Object.values(workspace.nodes);
  if (nodes.length === 0) {
    return `import { setup, createMachine } from "xstate";\n\n// No nodes on canvas to export as a state machine.\nexport const machine = setup({}).createMachine({\n  id: "empty",\n  initial: "idle",\n  states: {\n    idle: {},\n  },\n});\n`;
  }

  const edges = Object.values(workspace.edges);
  const nodeKeyById = new Map<string, string>();
  const idByNodeKey = new Map<string, string>();

  for (const n of nodes) {
    let key = toCamelCase(n.label || n.id);
    if (!key || /^[0-9]/.test(key)) key = `state_${key}`;
    // Deduplicate
    let uniqueKey = key;
    let counter = 1;
    while (idByNodeKey.has(uniqueKey)) {
      uniqueKey = `${key}_${counter++}`;
    }
    nodeKeyById.set(n.id, uniqueKey);
    idByNodeKey.set(uniqueKey, n.id);
  }

  // Find initial state (first node with no incoming edges, or first node)
  const incomingCount = new Map<string, number>();
  for (const n of nodes) incomingCount.set(n.id, 0);
  for (const e of edges) {
    incomingCount.set(e.target, (incomingCount.get(e.target) ?? 0) + 1);
  }

  let initialId = nodes[0]!.id;
  for (const n of nodes) {
    if ((incomingCount.get(n.id) ?? 0) === 0) {
      initialId = n.id;
      break;
    }
  }
  const initialKey = nodeKeyById.get(initialId) ?? "idle";

  // Collect events
  const eventTypes = new Set<string>();
  const outgoingBySource = new Map<string, Edge[]>();
  for (const e of edges) {
    const list = outgoingBySource.get(e.source) ?? [];
    list.push(e);
    outgoingBySource.set(e.source, list);

    const rel = e.relationship?.trim();
    const eventName = rel ? toScreamingSnakeCase(rel) : "NEXT";
    eventTypes.add(eventName);
  }

  const eventsUnion =
    eventTypes.size > 0
      ? Array.from(eventTypes)
          .map((ev) => `    | { type: "${ev}" }`)
          .join("\n")
      : `    | { type: "NEXT" }`;

  const stateLines: string[] = [];
  for (const n of nodes) {
    const sKey = nodeKeyById.get(n.id)!;
    const outgoing = outgoingBySource.get(n.id) ?? [];
    const isTerminal =
      outgoing.length === 0 &&
      (n.nodeType === "decision" || /done|finish|success|complete|fail|cancel|end/i.test(n.label));

    stateLines.push(`    ${sKey}: {`);
    if (n.label) {
      stateLines.push(`      description: ${JSON.stringify(n.label)},`);
    }

    if (isTerminal) {
      stateLines.push(`      type: "final",`);
    } else if (outgoing.length > 0) {
      stateLines.push(`      on: {`);
      for (const edge of outgoing) {
        const targetKey = nodeKeyById.get(edge.target);
        if (!targetKey) continue;
        const rel = edge.relationship?.trim();
        const ev = rel ? toScreamingSnakeCase(rel) : "NEXT";
        stateLines.push(`        ${ev}: { target: "${targetKey}" },`);
      }
      stateLines.push(`      },`);
    }
    stateLines.push(`    },`);
  }

  return `import { setup, createMachine } from "xstate";

/**
 * XState v5 State Machine
 * Exported from Lucent Visual Workspace (${workspace.name || "Workflow"})
 */
export const ${toCamelCase(workspace.name || "workflow")}Machine = setup({
  types: {
    events: {} as
${eventsUnion},
  },
  actions: {},
  guards: {},
}).createMachine({
  id: "${toSnakeCase(workspace.name || "workflow")}",
  initial: "${initialKey}",
  states: {
${stateLines.join("\n")}
  },
});
`;
}

// ---------------------------------------------------------------------------
// 2. Prisma Schema Exporter
// ---------------------------------------------------------------------------

export function boardToPrisma(workspace: Workspace): string {
  const nodes = Object.values(workspace.nodes);
  if (nodes.length === 0) {
    return `// No models on canvas to export as Prisma schema.\ndatasource db {\n  provider = "postgresql"\n  url      = env("DATABASE_URL")\n}\n\ngenerator client {\n  provider = "prisma-client-js"\n}\n`;
  }

  const edges = Object.values(workspace.edges);
  const modelNameById = new Map<string, string>();

  for (const n of nodes) {
    const name = toPascalCase(singularize(n.label || n.id));
    modelNameById.set(n.id, name || "Model");
  }

  // Relations map: target -> list of source nodes that reference it
  const incomingRefs = new Map<string, { sourceId: string; colName: string }[]>();
  const outgoingRefs = new Map<string, { targetId: string; colName: string }[]>();

  for (const edge of edges) {
    const sName = modelNameById.get(edge.source);
    const tName = modelNameById.get(edge.target);
    if (!sName || !tName || edge.source === edge.target) continue;

    const relMatch = edge.relationship?.match(/\(([\w]+)\)/);
    const colName = relMatch ? relMatch[1]! : `${toCamelCase(tName)}Id`;

    const inc = incomingRefs.get(edge.target) ?? [];
    inc.push({ sourceId: edge.source, colName });
    incomingRefs.set(edge.target, inc);

    const out = outgoingRefs.get(edge.source) ?? [];
    out.push({ targetId: edge.target, colName });
    outgoingRefs.set(edge.source, out);
  }

  const modelBlocks: string[] = [];

  for (const n of nodes) {
    const mName = modelNameById.get(n.id)!;
    const fields: string[] = [];
    const declaredCols = new Set<string>();

    // Parse columns from node details if available
    const sections = n.details?.sections ?? [];
    for (const sec of sections) {
      for (const item of sec.items) {
        const clean = item.replace(/^[🔑\s*-]+/u, "").trim();
        const m = clean.match(/^([a-zA-Z0-9_]+)\s*:\s*([a-zA-Z0-9_()]+)(.*)$/);
        if (m) {
          const rawCol = m[1]!;
          const rawType = m[2]!.toUpperCase();
          const rest = m[3]!.toUpperCase();
          const fName = toCamelCase(rawCol);
          declaredCols.add(rawCol.toLowerCase());
          declaredCols.add(fName.toLowerCase());

          const isPk = item.includes("🔑") || rest.includes("PRIMARY") || rawCol === "id";
          const isUnique = rest.includes("UNIQUE");
          const isNotNull = rest.includes("NOT NULL") || isPk;

          let pType = "String";
          if (/INT|SERIAL|BIGINT/.test(rawType)) pType = "Int";
          else if (/FLOAT|DOUBLE|DECIMAL|NUMERIC/.test(rawType)) pType = "Float";
          else if (/BOOL/.test(rawType)) pType = "Boolean";
          else if (/TIME|DATE/.test(rawType)) pType = "DateTime";
          else if (/JSON/.test(rawType)) pType = "Json";

          const opt = isNotNull ? "" : "?";
          let attrs = "";
          if (isPk) {
            attrs = pType === "Int" ? " @id @default(autoincrement())" : " @id @default(uuid())";
          } else if (isUnique) {
            attrs = " @unique";
          }

          fields.push(`  ${fName.padEnd(16)} ${pType}${opt}${attrs}`);
        }
      }
    }

    // If no primary key found, add default id
    if (!fields.some((f) => f.includes("@id"))) {
      fields.unshift(`  ${"id".padEnd(16)} String   @id @default(uuid())`);
      declaredCols.add("id");
    }

    // Add createdAt if not present
    if (!declaredCols.has("createdat") && !declaredCols.has("created_at")) {
      fields.push(`  ${"createdAt".padEnd(16)} DateTime @default(now())`);
    }

    // Add outgoing relation fields (foreign keys to other models)
    const outList = outgoingRefs.get(n.id) ?? [];
    for (const out of outList) {
      const targetModel = modelNameById.get(out.targetId);
      if (!targetModel) continue;
      const refField = toCamelCase(out.colName);
      const relObjName = toCamelCase(targetModel);

      // Only add scalar foreign key field if not already declared
      if (!declaredCols.has(refField.toLowerCase())) {
        fields.push(`  ${refField.padEnd(16)} String`);
        declaredCols.add(refField.toLowerCase());
      }
      fields.push(
        `  ${relObjName.padEnd(16)} ${targetModel} @relation(fields: [${refField}], references: [id])`,
      );
    }

    // Add incoming relation arrays (e.g. orders Order[])
    const incList = incomingRefs.get(n.id) ?? [];
    for (const inc of incList) {
      const sourceModel = modelNameById.get(inc.sourceId);
      if (!sourceModel) continue;
      const arrayName = toCamelCase(sourceModel) + "s";
      fields.push(`  ${arrayName.padEnd(16)} ${sourceModel}[]`);
    }

    modelBlocks.push(`model ${mName} {\n${fields.join("\n")}\n}`);
  }

  return `// Prisma Schema Definition
// Exported from Lucent Visual Workspace (${workspace.name || "Data Model"})

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

generator client {
  provider = "prisma-client-js"
}

${modelBlocks.join("\n\n")}
`;
}

// ---------------------------------------------------------------------------
// 3. SQL DDL Exporter (PostgreSQL)
// ---------------------------------------------------------------------------

export function boardToSqlDdl(workspace: Workspace): string {
  const nodes = Object.values(workspace.nodes);
  if (nodes.length === 0) {
    return `-- No database tables on canvas to export as SQL DDL.\n`;
  }

  const edges = Object.values(workspace.edges);
  const tableNameById = new Map<string, string>();

  for (const n of nodes) {
    const raw = toSnakeCase(n.label || n.id);
    tableNameById.set(n.id, raw || "table_entity");
  }

  const statements: string[] = [];

  for (const n of nodes) {
    const tName = tableNameById.get(n.id)!;
    const colLines: string[] = [];
    const declaredCols = new Set<string>();

    const sections = n.details?.sections ?? [];
    for (const sec of sections) {
      for (const item of sec.items) {
        const clean = item.replace(/^[🔑\s*-]+/u, "").trim();
        const m = clean.match(/^([a-zA-Z0-9_]+)\s*:\s*([a-zA-Z0-9_()]+)(.*)$/);
        if (m) {
          const colName = toSnakeCase(m[1]!);
          const colType = m[2]!.toUpperCase();
          const rest = m[3]!.toUpperCase();
          declaredCols.add(colName);

          const isPk = item.includes("🔑") || rest.includes("PRIMARY") || colName === "id";
          const isUnique = rest.includes("UNIQUE");
          const isNotNull = rest.includes("NOT NULL") || isPk;

          let line = `  ${colName.padEnd(16)} ${colType}`;
          if (isPk) line += " PRIMARY KEY";
          if (isNotNull && !isPk) line += " NOT NULL";
          if (isUnique && !isPk) line += " UNIQUE";
          colLines.push(line);
        }
      }
    }

    // Default primary key if none specified
    if (!colLines.some((l) => l.includes("PRIMARY KEY"))) {
      colLines.unshift(`  ${"id".padEnd(16)} UUID PRIMARY KEY DEFAULT gen_random_uuid()`);
      declaredCols.add("id");
    }

    // Foreign key constraints from outgoing edges
    const outgoing = edges.filter((e) => e.source === n.id && e.target !== n.id);
    for (const edge of outgoing) {
      const targetTable = tableNameById.get(edge.target);
      if (!targetTable) continue;

      const relMatch = edge.relationship?.match(/\(([\w]+)\)/);
      const fkCol = relMatch
        ? toSnakeCase(relMatch[1]!)
        : `${toSnakeCase(singularize(targetTable))}_id`;

      if (!declaredCols.has(fkCol)) {
        colLines.push(`  ${fkCol.padEnd(16)} UUID NOT NULL`);
        declaredCols.add(fkCol);
      }
      colLines.push(
        `  CONSTRAINT fk_${tName}_${fkCol} FOREIGN KEY (${fkCol}) REFERENCES ${targetTable}(id) ON DELETE CASCADE`,
      );
    }

    statements.push(`CREATE TABLE ${tName} (\n${colLines.join(",\n")}\n);`);
  }

  return `-- PostgreSQL DDL Schema
-- Exported from Lucent Visual Workspace (${workspace.name || "Database"})

${statements.join("\n\n")}
`;
}

// ---------------------------------------------------------------------------
// 4. Docker Compose Exporter
// ---------------------------------------------------------------------------

export function boardToDockerCompose(workspace: Workspace): string {
  const nodes = Object.values(workspace.nodes);
  if (nodes.length === 0) {
    return `# No architecture services on canvas to export as Docker Compose.\nversion: "3.8"\nservices: {}\n`;
  }

  const edges = Object.values(workspace.edges);
  const serviceNameById = new Map<string, string>();

  for (const n of nodes) {
    const raw = toSnakeCase(n.label || n.id);
    serviceNameById.set(n.id, raw || "service");
  }

  // Dependencies map: service -> array of services it depends on
  const depsByService = new Map<string, string[]>();
  for (const edge of edges) {
    const sName = serviceNameById.get(edge.source);
    const tName = serviceNameById.get(edge.target);
    if (!sName || !tName || sName === tName) continue;
    const list = depsByService.get(sName) ?? [];
    if (!list.includes(tName)) list.push(tName);
    depsByService.set(sName, list);
  }

  const serviceBlocks: string[] = [];
  const volumes = new Set<string>();

  for (const n of nodes) {
    const sName = serviceNameById.get(n.id)!;
    const lines: string[] = [`  ${sName}:`];

    // Infer image and ports based on node label, nodeType, or details
    const hay = `${n.label} ${n.nodeType}`.toLowerCase();
    let image = "node:20-alpine";
    let defaultPort = "3000:3000";
    let envVars: string[] = [];

    if (/postgres|pg|spanner/.test(hay) || n.nodeType === "database") {
      image = "postgres:16-alpine";
      defaultPort = "5432:5432";
      envVars = ["POSTGRES_DB: app_db", "POSTGRES_USER: postgres", "POSTGRES_PASSWORD: password"];
      volumes.add(`${sName}_data`);
    } else if (/redis|cache|memcached/.test(hay) || n.nodeType === "cache") {
      image = "redis:7-alpine";
      defaultPort = "6379:6379";
      volumes.add(`${sName}_data`);
    } else if (/kafka|rabbitmq|queue|nats|pulsar/.test(hay) || n.nodeType === "queue") {
      image = "rabbitmq:3-management-alpine";
      defaultPort = "5672:5672";
    } else if (/nginx|gateway|proxy|ingress|traefik/.test(hay) || n.nodeType === "gateway") {
      image = "nginx:alpine";
      defaultPort = "80:80";
    } else if (/python|flask|fastapi|django/.test(hay)) {
      image = "python:3.11-slim";
      defaultPort = "8000:8000";
    }

    // Check if details sections override image or ports
    for (const sec of n.details?.sections ?? []) {
      for (const item of sec.items) {
        const imgMatch = item.match(/^image:\s*([^\s]+)/i);
        if (imgMatch) image = imgMatch[1]!;
        const portMatch = item.match(/ports?:\s*([^\s]+)/i);
        if (portMatch) defaultPort = portMatch[1]!;
      }
    }

    lines.push(`    image: ${image}`);
    lines.push(`    ports:`);
    lines.push(`      - "${defaultPort}"`);

    const deps = depsByService.get(sName);
    if (deps && deps.length > 0) {
      lines.push(`    depends_on:`);
      for (const d of deps) {
        lines.push(`      - ${d}`);
      }
    }

    if (envVars.length > 0) {
      lines.push(`    environment:`);
      for (const ev of envVars) {
        lines.push(`      ${ev}`);
      }
    }

    if (volumes.has(`${sName}_data`)) {
      lines.push(`    volumes:`);
      lines.push(`      - ${sName}_data:/var/lib/${sName}/data`);
    }

    lines.push(`    networks:`);
    lines.push(`      - app-network`);

    serviceBlocks.push(lines.join("\n"));
  }

  const volBlock =
    volumes.size > 0
      ? `\nvolumes:\n${Array.from(volumes)
          .map((v) => `  ${v}:`)
          .join("\n")}\n`
      : "";

  return `# Docker Compose Configuration
# Exported from Lucent Visual Workspace (${workspace.name || "Infrastructure"})
version: "3.8"

services:
${serviceBlocks.join("\n\n")}
${volBlock}
networks:
  app-network:
    driver: bridge
`;
}

// ---------------------------------------------------------------------------
// 5. TypeScript Domain Types Exporter
// ---------------------------------------------------------------------------

export function boardToTypeScriptTypes(workspace: Workspace): string {
  const nodes = Object.values(workspace.nodes);
  if (nodes.length === 0) {
    return `// No entities on canvas to export as TypeScript types.\nexport interface EmptyBoard {}\n`;
  }

  const edges = Object.values(workspace.edges);
  const interfaceNameById = new Map<string, string>();

  for (const n of nodes) {
    const name = toPascalCase(singularize(n.label || n.id));
    interfaceNameById.set(n.id, name || "Entity");
  }

  const typeBlocks: string[] = [];

  for (const n of nodes) {
    const iName = interfaceNameById.get(n.id)!;
    const fields: string[] = [];
    const declared = new Set<string>();

    for (const sec of n.details?.sections ?? []) {
      for (const item of sec.items) {
        const clean = item.replace(/^[🔑\s*-]+/u, "").trim();
        const m = clean.match(/^([a-zA-Z0-9_]+)\s*:\s*([a-zA-Z0-9_()]+)(.*)$/);
        if (m) {
          const fName = toCamelCase(m[1]!);
          const rawType = m[2]!.toUpperCase();
          const rest = m[3]!.toUpperCase();
          declared.add(fName.toLowerCase());

          const isOptional = !rest.includes("NOT NULL") && !item.includes("🔑");
          let tsType = "string";
          if (/INT|FLOAT|DOUBLE|NUMBER|DECIMAL/.test(rawType)) tsType = "number";
          else if (/BOOL/.test(rawType)) tsType = "boolean";
          else if (/DATE|TIME/.test(rawType)) tsType = "Date";
          else if (/JSON/.test(rawType)) tsType = "Record<string, unknown>";

          fields.push(`  ${fName}${isOptional ? "?" : ""}: ${tsType};`);
        }
      }
    }

    if (!declared.has("id")) {
      fields.unshift(`  id: string;`);
      declared.add("id");
    }

    // Add related entity links based on edges
    const outgoing = edges.filter((e) => e.source === n.id);
    for (const edge of outgoing) {
      const targetName = interfaceNameById.get(edge.target);
      if (targetName && targetName !== iName) {
        const refName = toCamelCase(targetName);
        fields.push(`  ${refName}?: ${targetName};`);
      }
    }

    typeBlocks.push(`export interface ${iName} {\n${fields.join("\n")}\n}`);
  }

  const allNames = Array.from(interfaceNameById.values());
  const unionBlock = `export type DomainEntity =\n  | ${allNames.join("\n  | ")};`;

  return `/**
 * TypeScript Domain Models & Interfaces
 * Exported from Lucent Visual Workspace (${workspace.name || "Domain"})
 */

${typeBlocks.join("\n\n")}

${unionBlock}
`;
}

// ---------------------------------------------------------------------------
// Unified Exporter Dispatcher
// ---------------------------------------------------------------------------

export function exportBoardToCode(
  workspace: Workspace,
  format?: CodeExportFormat,
): CodeExportResult {
  // Auto-detect best format if omitted
  let resolvedFormat = format;
  if (!resolvedFormat) {
    if (workspace.diagramKind === "er") resolvedFormat = "prisma";
    else if (workspace.diagramKind === "architecture") resolvedFormat = "compose";
    else if (
      workspace.diagramKind === "flowchart" ||
      workspace.diagramKind === "statemachine" ||
      workspace.diagramKind === "journey" ||
      workspace.diagramKind === "process"
    )
      resolvedFormat = "xstate";
    else resolvedFormat = "typescript";
  }

  const baseName = toSnakeCase(workspace.name || "board");
  const nodeCount = Object.keys(workspace.nodes).length;
  const edgeCount = Object.keys(workspace.edges).length;

  switch (resolvedFormat) {
    case "xstate": {
      const code = boardToXState(workspace);
      return {
        format: "xstate",
        fileName: `${baseName}.machine.ts`,
        mimeType: "application/typescript",
        language: "typescript",
        code,
        summary: `XState v5 state machine with ${nodeCount} states and ${edgeCount} transitions`,
      };
    }

    case "prisma": {
      const code = boardToPrisma(workspace);
      return {
        format: "prisma",
        fileName: `schema.prisma`,
        mimeType: "text/plain",
        language: "prisma",
        code,
        summary: `Prisma ORM schema with ${nodeCount} models and relational mappings`,
      };
    }

    case "sqlddl": {
      const code = boardToSqlDdl(workspace);
      return {
        format: "sqlddl",
        fileName: `${baseName}_schema.sql`,
        mimeType: "application/sql",
        language: "sql",
        code,
        summary: `PostgreSQL DDL schema with ${nodeCount} tables and foreign key constraints`,
      };
    }

    case "compose": {
      const code = boardToDockerCompose(workspace);
      return {
        format: "compose",
        fileName: `docker-compose.yml`,
        mimeType: "application/yaml",
        language: "yaml",
        code,
        summary: `Docker Compose configuration with ${nodeCount} services and dependency graph`,
      };
    }

    case "typescript":
    default: {
      const code = boardToTypeScriptTypes(workspace);
      return {
        format: "typescript",
        fileName: `${baseName}.types.ts`,
        mimeType: "application/typescript",
        language: "typescript",
        code,
        summary: `TypeScript interfaces with ${nodeCount} domain models and types`,
      };
    }
  }
}
