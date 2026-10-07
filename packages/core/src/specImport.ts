import type { Operation } from "./operations.js";

/**
 * Code & Specification Ingestion (Initiative 4 / ADR 0051).
 *
 * Deterministically parses real engineering artifacts — OpenAPI 3.0/Swagger,
 * SQL DDL, Prisma schemas, and Docker Compose — into semantic Lucent
 * operations (nodes, connectors, groups, details compartments).
 *
 * Pure, dependency-free TypeScript engine runnable in core, web, server, and MCP.
 */

export type SpecFormat = "openapi" | "sqlddl" | "prisma" | "compose" | "unknown";

export interface SpecImportResult {
  format: SpecFormat;
  ops: Operation[];
  summary: {
    nodes: number;
    edges: number;
    groups: number;
    title: string;
  };
}

function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "item"
  );
}

/** Classify text or filename to detect format */
export function classifySpec(text: string, fileName?: string): SpecFormat {
  const f = (fileName ?? "").toLowerCase();
  if (f.endsWith(".sql")) return "sqlddl";
  if (f.endsWith(".prisma")) return "prisma";
  if (/docker-compose(\.[\w-]+)?\.ya?ml$/.test(f) || /compose\.ya?ml$/.test(f)) return "compose";
  if (/swagger(\.[\w-]+)?\.(json|ya?ml)$/.test(f) || /openapi(\.[\w-]+)?\.(json|ya?ml)$/.test(f))
    return "openapi";

  const trimmed = text.trim();

  // 1. OpenAPI / Swagger check (JSON or YAML)
  if (
    /["']?openapi["']?\s*:\s*["']?3\./.test(trimmed) ||
    /["']?swagger["']?\s*:\s*["']?2\./.test(trimmed) ||
    (trimmed.includes('"paths"') &&
      (trimmed.includes('"components"') || trimmed.includes('"info"'))) ||
    (/^\s*paths:\s*$/m.test(trimmed) &&
      (/info:\s*$/m.test(trimmed) || /components:\s*$/m.test(trimmed)))
  ) {
    return "openapi";
  }

  // 2. Prisma Schema check
  if (
    /^\s*model\s+[A-Za-z0-9_]+\s*\{/m.test(trimmed) &&
    (/@id\b/.test(trimmed) ||
      /datasource\s+[A-Za-z0-9_]+\s*\{/.test(trimmed) ||
      /generator\s+[A-Za-z0-9_]+\s*\{/.test(trimmed))
  ) {
    return "prisma";
  }

  // 3. SQL DDL check
  if (/CREATE\s+TABLE\s+(IF\s+NOT\s+EXISTS\s+)?[`"']?[A-Za-z0-9_.]+/i.test(trimmed)) {
    return "sqlddl";
  }

  // 4. Docker Compose check
  if (/^\s*services:\s*$/m.test(trimmed) && /image:|build:|ports:|depends_on:/.test(trimmed)) {
    return "compose";
  }

  return "unknown";
}

// ---------------------------------------------------------------------------
// SQL DDL Ingestion
// ---------------------------------------------------------------------------

export function sqlDdlToOps(sql: string): Operation[] {
  // Strip block comments /* ... */ and line comments -- ...
  const cleanSql = sql.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--.*$/gm, "");

  // Match CREATE TABLE [IF NOT EXISTS] [schema.]table_name ( body );
  const tableRegex =
    /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:[`"']?\w+[`"']?\.)?[`"']?(\w+)[`"']?\s*\(([\s\S]*?)\)(?:\s*;|\s*$)/gi;
  const ops: Operation[] = [{ op: "CREATE_DIAGRAM", kind: "er" }];

  interface TableMeta {
    id: string;
    name: string;
    columns: string[];
    foreignKeys: Array<{ col: string; refTable: string; refCol: string }>;
  }

  const tables: TableMeta[] = [];
  let match: RegExpExecArray | null;

  while ((match = tableRegex.exec(cleanSql)) !== null) {
    const rawName = match[1]!;
    const body = match[2]!;
    const tableId = `tbl_${slug(rawName)}`;

    const columns: string[] = [];
    const fks: Array<{ col: string; refTable: string; refCol: string }> = [];

    // Split body by commas, keeping parentheses together
    const tokens: string[] = [];
    let current = "";
    let depth = 0;
    for (let i = 0; i < body.length; i++) {
      const ch = body[i];
      if (ch === "(") depth++;
      else if (ch === ")") depth--;

      if (ch === "," && depth === 0) {
        tokens.push(current.trim());
        current = "";
      } else {
        current += ch;
      }
    }
    if (current.trim()) tokens.push(current.trim());

    for (const rawLine of tokens) {
      const line = rawLine.replace(/\s+/g, " ").trim();
      if (!line) continue;

      // Table-level Foreign Key: FOREIGN KEY (col) REFERENCES other_table(other_col)
      const fkMatch = line.match(
        /(?:CONSTRAINT\s+[`"']?\w+[`"']?\s+)?FOREIGN\s+KEY\s*\([`"']?(\w+)[`"']?\)\s+REFERENCES\s+[`"']?(\w+)[`"']?(?:\s*\([`"']?(\w+)[`"']?\))?/i,
      );
      if (fkMatch) {
        fks.push({
          col: fkMatch[1]!,
          refTable: fkMatch[2]!,
          refCol: fkMatch[3] ?? "id",
        });
        continue;
      }

      // Standalone PRIMARY KEY (col1, col2)
      if (/^(?:CONSTRAINT\s+[`"']?\w+[`"']?\s+)?PRIMARY\s+KEY\s*\(/i.test(line)) {
        continue;
      }

      // Standalone UNIQUE / CHECK / INDEX
      if (/^(?:CONSTRAINT\s+[`"']?\w+[`"']?\s+)?(?:UNIQUE|CHECK|KEY|INDEX)\s*\(/i.test(line)) {
        continue;
      }

      // Inline references: e.g. user_id UUID REFERENCES users(id)
      const inlineFk = line.match(
        /^[`"']?(\w+)[`"']?\s+.*?\bREFERENCES\s+[`"']?(\w+)[`"']?(?:\s*\([`"']?(\w+)[`"']?\))?/i,
      );
      if (inlineFk) {
        fks.push({
          col: inlineFk[1]!,
          refTable: inlineFk[2]!,
          refCol: inlineFk[3] ?? "id",
        });
      }

      // Clean column declaration: extract name and type
      const colDefMatch = line.match(/^[`"']?(\w+)[`"']?\s+([A-Za-z0-9_()]+)(.*)$/);
      if (colDefMatch) {
        const colName = colDefMatch[1]!;
        const colType = colDefMatch[2]!;
        const rest = colDefMatch[3]!;
        const isPk = /PRIMARY\s+KEY/i.test(rest) || /PRIMARY\s+KEY/i.test(line);
        const isNotNull = /NOT\s+NULL/i.test(rest);
        const marker = isPk ? "🔑 " : "";
        columns.push(`${marker}${colName}: ${colType}${isNotNull && !isPk ? " NOT NULL" : ""}`);
      } else {
        columns.push(line.slice(0, 80));
      }
    }

    tables.push({
      id: tableId,
      name: rawName,
      columns,
      foreignKeys: fks,
    });
  }

  if (tables.length === 0) return [];

  const tableIdByName = new Map<string, string>();
  for (const t of tables) {
    tableIdByName.set(t.name.toLowerCase(), t.id);
  }

  // Create table nodes with column details
  for (const t of tables) {
    ops.push({
      op: "CREATE_NODE",
      id: t.id,
      nodeType: "database",
      label: t.name,
      details: {
        sections: [
          {
            title: "Columns",
            items: t.columns.slice(0, 24),
          },
        ],
      },
    });
  }

  // Create connector edges for foreign keys
  const connectedPairs = new Set<string>();
  for (const t of tables) {
    for (const fk of t.foreignKeys) {
      const targetId = tableIdByName.get(fk.refTable.toLowerCase());
      if (targetId && targetId !== t.id) {
        const pairKey = `${t.id}->${targetId}:${fk.col}`;
        if (!connectedPairs.has(pairKey)) {
          connectedPairs.add(pairKey);
          ops.push({
            op: "CONNECT_NODES",
            source: t.id,
            target: targetId,
            relationship: `references (${fk.col})`,
          });
        }
      }
    }
  }

  return ops;
}

// ---------------------------------------------------------------------------
// Prisma Schema Ingestion
// ---------------------------------------------------------------------------

export function prismaToOps(prismaText: string): Operation[] {
  const clean = prismaText.replace(/\/\/.*$/gm, "");
  const modelRegex = /model\s+(\w+)\s*\{([\s\S]*?)\}/g;
  const ops: Operation[] = [{ op: "CREATE_DIAGRAM", kind: "er" }];

  interface PrismaModel {
    id: string;
    name: string;
    fields: string[];
    relations: Array<{ targetName: string; relName?: string }>;
  }

  const models: PrismaModel[] = [];
  let match: RegExpExecArray | null;

  while ((match = modelRegex.exec(clean)) !== null) {
    const modelName = match[1]!;
    const body = match[2]!;
    const modelId = `model_${slug(modelName)}`;

    const fields: string[] = [];
    const relations: Array<{ targetName: string; relName?: string }> = [];

    const lines = body
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    for (const line of lines) {
      if (line.startsWith("@@")) continue; // model-level directives (@@map, @@index)

      const parts = line.split(/\s+/);
      if (parts.length < 2) continue;
      const fieldName = parts[0]!;
      const fieldType = parts[1]!;
      const isPk = line.includes("@id");
      const isUnique = line.includes("@unique");

      // Check if fieldType is another model reference
      const cleanType = fieldType.replace(/[[\]?]/g, "");
      const isRelation =
        line.includes("@relation") ||
        (/^[A-Z]/.test(cleanType) &&
          ![
            "String",
            "Int",
            "Boolean",
            "DateTime",
            "Float",
            "Decimal",
            "Json",
            "Bytes",
            "BigInt",
          ].includes(cleanType));

      if (isRelation) {
        relations.push({ targetName: cleanType, relName: fieldName });
      }

      const prefix = isPk ? "🔑 " : "";
      const modifier = isUnique ? " [unique]" : "";
      fields.push(`${prefix}${fieldName}: ${fieldType}${modifier}`);
    }

    models.push({
      id: modelId,
      name: modelName,
      fields,
      relations,
    });
  }

  if (models.length === 0) return [];

  const modelMap = new Map<string, string>();
  for (const m of models) {
    modelMap.set(m.name.toLowerCase(), m.id);
  }

  // Create model nodes with field details
  for (const m of models) {
    ops.push({
      op: "CREATE_NODE",
      id: m.id,
      nodeType: "database",
      label: m.name,
      details: {
        sections: [
          {
            title: "Fields",
            items: m.fields.slice(0, 24),
          },
        ],
      },
    });
  }

  // Connect relations
  const connectedPairs = new Set<string>();
  for (const m of models) {
    for (const rel of m.relations) {
      const targetId = modelMap.get(rel.targetName.toLowerCase());
      if (targetId && targetId !== m.id) {
        const pairKey = [m.id, targetId].sort().join("::");
        if (!connectedPairs.has(pairKey)) {
          connectedPairs.add(pairKey);
          ops.push({
            op: "CONNECT_NODES",
            source: m.id,
            target: targetId,
            relationship: "has relation",
          });
        }
      }
    }
  }

  return ops;
}

// ---------------------------------------------------------------------------
// OpenAPI / Swagger Ingestion
// ---------------------------------------------------------------------------

interface OpenApiPathItem {
  tags?: string[];
  summary?: string;
  [key: string]: unknown;
}

interface OpenApiSchema {
  properties?: Record<string, { type?: string; $ref?: string; [key: string]: unknown }>;
  [key: string]: unknown;
}

interface OpenApiDoc {
  paths?: Record<string, Record<string, OpenApiPathItem>>;
  components?: {
    schemas?: Record<string, OpenApiSchema>;
  };
  definitions?: Record<string, OpenApiSchema>;
  [key: string]: unknown;
}

export function openApiToOps(text: string): Operation[] {
  let doc: OpenApiDoc | null = null;

  // Try JSON parse first
  try {
    doc = JSON.parse(text) as OpenApiDoc;
  } catch {
    // If not JSON, parse YAML via lightweight YAML extractor
    doc = parseYamlOpenApi(text);
  }

  if (!doc || typeof doc !== "object") return [];

  const ops: Operation[] = [{ op: "CREATE_DIAGRAM", kind: "architecture" }];
  const paths = doc.paths ?? {};
  const schemas = doc.components?.schemas ?? doc.definitions ?? {};

  // Group endpoints by tag if available
  const tagCounts = new Map<string, number>();
  for (const pathKey of Object.keys(paths)) {
    const item = paths[pathKey];
    if (!item || typeof item !== "object") continue;
    for (const method of ["get", "post", "put", "delete", "patch"]) {
      const opObj = item[method];
      if (opObj && typeof opObj === "object") {
        const tags: string[] = opObj.tags ?? [];
        for (const t of tags) {
          tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
        }
      }
    }
  }

  // Create groups for tags with 2 or more endpoints
  const createdGroups = new Map<string, string>();
  for (const [tag, count] of tagCounts.entries()) {
    if (count >= 2) {
      const groupId = `grp_${slug(tag)}`;
      createdGroups.set(tag, groupId);
      ops.push({
        op: "CREATE_GROUP",
        id: groupId,
        label: `${tag} API`,
        children: [],
      });
    }
  }

  // Schema nodes
  const schemaNodeIds = new Map<string, string>();
  for (const schemaName of Object.keys(schemas)) {
    const schemaObj = schemas[schemaName];
    if (!schemaObj || typeof schemaObj !== "object") continue;
    const schemaId = `schema_${slug(schemaName)}`;
    schemaNodeIds.set(schemaName.toLowerCase(), schemaId);

    const props = schemaObj.properties ?? {};
    const propLines: string[] = [];
    for (const propName of Object.keys(props).slice(0, 16)) {
      const p = props[propName] ?? {};
      const refStr = typeof p.$ref === "string" ? p.$ref.split("/").pop() : "any";
      const typeStr = p.type ?? refStr;
      propLines.push(`${propName}: ${typeStr}`);
    }

    ops.push({
      op: "CREATE_NODE",
      id: schemaId,
      nodeType: "database",
      label: schemaName,
      details: propLines.length
        ? {
            sections: [
              {
                title: "Properties",
                items: propLines,
              },
            ],
          }
        : undefined,
    });
  }

  // Path Endpoint nodes
  const endpointIds = new Map<string, string>();
  for (const pathKey of Object.keys(paths)) {
    const item = paths[pathKey];
    if (!item || typeof item !== "object") continue;

    for (const method of ["get", "post", "put", "delete", "patch"]) {
      const opObj = item[method];
      if (!opObj || typeof opObj !== "object") continue;

      const upperMethod = method.toUpperCase();
      const endpointId = `ep_${method}_${slug(pathKey)}`;
      endpointIds.set(`${upperMethod} ${pathKey}`, endpointId);

      const summary = typeof opObj.summary === "string" ? opObj.summary : "";
      const tags: string[] = opObj.tags ?? [];
      const primaryTag = tags[0];
      const groupId = primaryTag ? createdGroups.get(primaryTag) : undefined;

      const nodeType = method === "get" ? "service" : method === "post" ? "process" : "service";

      const detailsItems: string[] = [];
      if (summary) detailsItems.push(summary);
      if (opObj.operationId) detailsItems.push(`Op: ${opObj.operationId}`);

      ops.push({
        op: "CREATE_NODE",
        id: endpointId,
        nodeType,
        label: `${upperMethod} ${pathKey}`,
        groupId,
        details: detailsItems.length
          ? {
              sections: [
                {
                  title: "Details",
                  items: detailsItems,
                },
              ],
            }
          : undefined,
      });

      // Link endpoint to schema if mentioned in request or response
      const opStr = JSON.stringify(opObj);
      for (const [schemaName, sId] of schemaNodeIds.entries()) {
        if (
          opStr.toLowerCase().includes(`/${schemaName}`) ||
          opStr.toLowerCase().includes(`"${schemaName}"`)
        ) {
          ops.push({
            op: "CONNECT_NODES",
            source: endpointId,
            target: sId,
            relationship: method === "get" ? "returns" : "accepts",
          });
        }
      }
    }
  }

  return ops;
}

/** Lightweight YAML parser for OpenAPI paths & schemas when JSON is not used */
function parseYamlOpenApi(yaml: string): OpenApiDoc {
  const doc: OpenApiDoc = { paths: {}, components: { schemas: {} } };
  const lines = yaml.split(/\r?\n/);

  let inPaths = false;
  let inComponents = false;
  let inSchemas = false;
  let currentPath = "";
  let currentMethod = "";
  let currentSchema = "";

  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    if (/^paths:\s*$/.test(trimmed)) {
      inPaths = true;
      inComponents = false;
      continue;
    }
    if (/^components:\s*$/.test(trimmed)) {
      inPaths = false;
      inComponents = true;
      continue;
    }
    if (inComponents && /^\s*schemas:\s*$/.test(trimmed)) {
      inSchemas = true;
      continue;
    }

    if (inPaths) {
      // Path: /users:
      const pathMatch = trimmed.match(/^(\/[\w{}/.-]+):\s*$/);
      if (pathMatch) {
        currentPath = pathMatch[1]!;
        if (!doc.paths) doc.paths = {};
        doc.paths[currentPath] = {};
        currentMethod = "";
        continue;
      }

      // Method: get:
      const methodMatch = trimmed.match(/^(get|post|put|delete|patch):\s*$/i);
      if (methodMatch && currentPath) {
        currentMethod = methodMatch[1]!.toLowerCase();
        if (!doc.paths) doc.paths = {};
        if (!doc.paths[currentPath]) doc.paths[currentPath] = {};
        doc.paths[currentPath]![currentMethod] = { tags: [], summary: "" };
        continue;
      }

      // Summary
      if (currentPath && currentMethod && trimmed.startsWith("summary:")) {
        const item = doc.paths?.[currentPath]?.[currentMethod];
        if (item) {
          item.summary = trimmed.replace(/^summary:\s*["']?/, "").replace(/["']?$/, "");
        }
        continue;
      }

      // Tags: - Users
      if (currentPath && currentMethod && trimmed.startsWith("- ")) {
        const item = doc.paths?.[currentPath]?.[currentMethod];
        if (item) {
          if (!item.tags) item.tags = [];
          item.tags.push(trimmed.replace(/^-\s*/, ""));
        }
        continue;
      }
    }

    if (inSchemas) {
      const schemaMatch = trimmed.match(/^(\w+):\s*$/);
      if (schemaMatch && !["type", "properties", "required"].includes(schemaMatch[1]!)) {
        currentSchema = schemaMatch[1]!;
        if (!doc.components) doc.components = {};
        if (!doc.components.schemas) doc.components.schemas = {};
        doc.components.schemas[currentSchema] = { properties: {} };
        continue;
      }
      const propMatch = trimmed.match(/^(\w+):\s*$/);
      if (propMatch && currentSchema && trimmed.startsWith("  ")) {
        const schemas = doc.components?.schemas;
        if (schemas && schemas[currentSchema]) {
          const schema = schemas[currentSchema]!;
          if (!schema.properties) schema.properties = {};
          schema.properties[propMatch[1]!] = { type: "string" };
        }
      }
    }
  }

  return doc;
}

// ---------------------------------------------------------------------------
// Docker Compose Ingestion
// ---------------------------------------------------------------------------

export function composeToOps(yaml: string): Operation[] {
  const lines = yaml.replace(/\t/g, "  ").split(/\r?\n/);
  interface Svc {
    id: string;
    label: string;
    image: string;
    dependsOn: string[];
    ports: string[];
  }
  const services: Svc[] = [];
  let inServices = false;
  let servicesIndent = -1;
  let serviceIndent = -1;
  let current: Svc | null = null;
  let inDependsOn = false;
  let dependsIndent = -1;

  const indentOf = (l: string) => l.length - l.replace(/^\s+/, "").length;

  function serviceType(name: string, image: string): string {
    const hay = `${name} ${image}`.toLowerCase();
    if (/postgres|mysql|mariadb|mongo|cassandra|sqlite|cockroach/.test(hay)) return "database";
    if (/redis|memcached/.test(hay)) return "cache";
    if (/kafka|rabbitmq|nats|sqs|pulsar|amqp/.test(hay)) return "queue";
    if (/nginx|traefik|envoy|haproxy|gateway|kong/.test(hay)) return "gateway";
    return "service";
  }

  for (const raw of lines) {
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    const indent = indentOf(raw);
    const text = raw.trim();

    if (/^services:\s*$/.test(text)) {
      inServices = true;
      servicesIndent = indent;
      serviceIndent = -1;
      current = null;
      continue;
    }
    if (!inServices) continue;
    if (indent <= servicesIndent) {
      inServices = false;
      continue;
    }

    if (serviceIndent === -1 && indent > servicesIndent) {
      const m = text.match(/^([\w.-]+):\s*$/);
      if (m) {
        serviceIndent = indent;
        current = { id: `svc_${slug(m[1]!)}`, label: m[1]!, image: "", dependsOn: [], ports: [] };
        services.push(current);
        inDependsOn = false;
        continue;
      }
    }

    if (indent === serviceIndent) {
      const m = text.match(/^([\w.-]+):\s*$/);
      if (m) {
        current = { id: `svc_${slug(m[1]!)}`, label: m[1]!, image: "", dependsOn: [], ports: [] };
        services.push(current);
        inDependsOn = false;
        continue;
      }
    }

    if (!current) continue;

    if (inDependsOn) {
      if (indent > dependsIndent) {
        const dep = text.replace(/^-\s*/, "").replace(/:.*$/, "").trim();
        if (dep) current.dependsOn.push(`svc_${slug(dep)}`);
        continue;
      }
      inDependsOn = false;
    }

    const img = text.match(/^image:\s*["']?([^"'\s]+)["']?/);
    if (img) {
      current.image = img[1]!;
      continue;
    }

    if (/^depends_on:/.test(text)) {
      inDependsOn = true;
      dependsIndent = indent;
      const inline = text.match(/^depends_on:\s*\[(.*)\]/);
      if (inline) {
        for (const d of inline[1]!.split(",")) {
          const dep = d.trim().replace(/["']/g, "");
          if (dep) current.dependsOn.push(`svc_${slug(dep)}`);
        }
        inDependsOn = false;
      }
      continue;
    }

    const portMatch = text.match(/^-\s*["']?(\d+:\d+)["']?/);
    if (portMatch) {
      current.ports.push(portMatch[1]!);
    }
  }

  if (services.length === 0) return [];

  const known = new Set(services.map((s) => s.id));
  const ops: Operation[] = [{ op: "CREATE_DIAGRAM", kind: "architecture" }];

  for (const s of services) {
    const detailsItems: string[] = [];
    if (s.image) detailsItems.push(`Image: ${s.image}`);
    if (s.ports.length) detailsItems.push(`Ports: ${s.ports.join(", ")}`);

    ops.push({
      op: "CREATE_NODE",
      id: s.id,
      nodeType: serviceType(s.label, s.image),
      label: s.label,
      details: detailsItems.length
        ? {
            sections: [
              {
                title: "Container",
                items: detailsItems,
              },
            ],
          }
        : undefined,
    });
  }

  for (const s of services) {
    for (const dep of s.dependsOn) {
      if (known.has(dep) && dep !== s.id) {
        ops.push({ op: "CONNECT_NODES", source: s.id, target: dep, relationship: "depends on" });
      }
    }
  }

  return ops;
}

// ---------------------------------------------------------------------------
// Unified Spec Dispatcher
// ---------------------------------------------------------------------------

export function specToOps(text: string, fileName?: string): SpecImportResult {
  const format = classifySpec(text, fileName);
  let ops: Operation[] = [];

  switch (format) {
    case "openapi":
      ops = openApiToOps(text);
      break;
    case "sqlddl":
      ops = sqlDdlToOps(text);
      break;
    case "prisma":
      ops = prismaToOps(text);
      break;
    case "compose":
      ops = composeToOps(text);
      break;
    default:
      ops = [];
      break;
  }

  const nodes = ops.filter((o) => o.op === "CREATE_NODE").length;
  const edges = ops.filter((o) => o.op === "CONNECT_NODES").length;
  const groups = ops.filter((o) => o.op === "CREATE_GROUP").length;

  const titles: Record<SpecFormat, string> = {
    openapi: "OpenAPI / Swagger Architecture",
    sqlddl: "SQL Database ER Diagram",
    prisma: "Prisma Schema ER Diagram",
    compose: "Docker Compose Infrastructure",
    unknown: "Unknown Specification",
  };

  return {
    format,
    ops,
    summary: {
      nodes,
      edges,
      groups,
      title: titles[format],
    },
  };
}
