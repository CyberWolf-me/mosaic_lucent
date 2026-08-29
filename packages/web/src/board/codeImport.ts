import type { Operation } from "@lucent/core";

/**
 * Code / infrastructure → diagram.
 *
 * The field's recurring complaint is that AI diagram tools produce "an
 * illustration of your text, not a model of your system." Importing real source
 * of truth — a compose file, a package manifest — closes that gap: the diagram
 * is generated from the artifact, so it reflects what actually exists.
 *
 * Everything here is dependency-free and deterministic: a tiny indentation-based
 * YAML reader for compose files (enough for the `services:` block and its
 * `depends_on`/`image`/`ports`), and JSON for manifests. Output is the same
 * validated Operation[] the AI emits, so imports and generation share one path.
 */

export type CodeImportKind = "compose" | "package" | "terraform" | "unknown";

/** Classify a source file by name/content so the right parser runs. */
export function classifyCode(fileName: string, content: string): CodeImportKind {
  const f = fileName.toLowerCase();
  if (/docker-compose(\.[\w-]+)?\.ya?ml$/.test(f) || /compose\.ya?ml$/.test(f)) return "compose";
  if (f.endsWith("package.json")) return "package";
  if (f.endsWith(".tf")) return "terraform";
  // Content sniffing when the name is unhelpful.
  if (/^\s*services:\s*$/m.test(content) && /image:|build:/.test(content)) return "compose";
  if (/"dependencies"\s*:/.test(content) && /"name"\s*:/.test(content)) return "package";
  if (/^\s*resource\s+"/m.test(content)) return "terraform";
  return "unknown";
}

function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "node"
  );
}

/** Map a docker image / service name to a Lucent nodeType for a tech glyph. */
function serviceType(name: string, image: string): string {
  const hay = `${name} ${image}`.toLowerCase();
  if (/postgres|mysql|mariadb|mongo|cassandra|sqlite|cockroach/.test(hay)) return "database";
  if (/redis|memcached/.test(hay)) return "cache";
  if (/kafka|rabbitmq|nats|sqs|pulsar|amqp/.test(hay)) return "queue";
  if (/nginx|traefik|envoy|haproxy|gateway|kong/.test(hay)) return "gateway";
  return "service";
}

/**
 * Parse a docker-compose file into architecture operations. Reads the top-level
 * `services:` map, each service's `image`/`build`, and `depends_on` (both list
 * and map forms) to draw "depends on" edges.
 */
export function composeToOps(yaml: string): Operation[] {
  const lines = yaml.replace(/\t/g, "  ").split(/\r?\n/);
  interface Svc {
    id: string;
    label: string;
    image: string;
    dependsOn: string[];
  }
  const services: Svc[] = [];
  let inServices = false;
  let servicesIndent = -1;
  let current: Svc | null = null;
  let currentIndent = -1;
  let inDependsOn = false;
  let dependsIndent = -1;

  const indentOf = (l: string) => l.length - l.replace(/^\s+/, "").length;

  for (const raw of lines) {
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    const indent = indentOf(raw);
    const text = raw.trim();

    if (/^services:/.test(text) && indent === 0) {
      inServices = true;
      servicesIndent = indent;
      continue;
    }
    if (!inServices) continue;
    // A new top-level key ends the services block.
    if (indent <= servicesIndent && !/^services:/.test(text)) {
      inServices = false;
      continue;
    }

    // A service name: one level under `services:`, ends with a colon.
    if (current === null || indent <= currentIndent) {
      const m = text.match(/^([\w.-]+):\s*$/);
      if (m && (current === null || indent === currentIndent || indent < currentIndent + 1)) {
        // Only treat as a service if it sits directly under services (2 spaces
        // typically). Anything deeper belongs to the current service.
        if (currentIndent === -1 || indent === currentIndent) {
          current = { id: slug(m[1]!), label: m[1]!, image: "", dependsOn: [] };
          currentIndent = indent;
          services.push(current);
          inDependsOn = false;
          continue;
        }
      }
    }

    if (!current) continue;

    if (inDependsOn) {
      // List item: "- name"  or map key: "name:"
      if (indent > dependsIndent) {
        const dep = text.replace(/^-\s*/, "").replace(/:.*$/, "").trim();
        if (dep) current.dependsOn.push(slug(dep));
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
      // Inline list form: depends_on: [a, b]
      const inline = text.match(/^depends_on:\s*\[(.*)\]/);
      if (inline) {
        for (const d of inline[1]!.split(",")) {
          const dep = d.trim().replace(/["']/g, "");
          if (dep) current.dependsOn.push(slug(dep));
        }
        inDependsOn = false;
      }
      continue;
    }
  }

  if (services.length === 0) return [];

  const known = new Set(services.map((s) => s.id));
  const ops: Operation[] = [{ op: "CREATE_DIAGRAM", kind: "architecture" }];
  for (const s of services) {
    ops.push({
      op: "CREATE_NODE",
      id: s.id,
      nodeType: serviceType(s.label, s.image),
      label: s.label,
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

/**
 * Parse a package.json into a dependency diagram: the package at the centre with
 * an edge to each dependency. Dev dependencies are included but labelled.
 */
export function packageJsonToOps(json: string, maxDeps = 40): Operation[] {
  let parsed: {
    name?: string;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  const rootName = parsed.name || "package";
  const rootId = slug(rootName);
  const ops: Operation[] = [
    { op: "CREATE_DIAGRAM", kind: "architecture" },
    { op: "CREATE_NODE", id: rootId, nodeType: "system", label: rootName },
  ];
  const seen = new Set<string>([rootId]);
  const add = (deps: Record<string, string> | undefined, rel: string) => {
    for (const name of Object.keys(deps ?? {})) {
      if (ops.filter((o) => o.op === "CREATE_NODE").length > maxDeps) break;
      let id = slug(name);
      // Avoid id collisions between a dep and the root or another dep.
      while (seen.has(id) && id !== slug(name)) id += "-dep";
      if (seen.has(id)) id = `${id}-dep`;
      seen.add(id);
      ops.push({ op: "CREATE_NODE", id, nodeType: "external", label: name });
      ops.push({ op: "CONNECT_NODES", source: rootId, target: id, relationship: rel });
    }
  };
  add(parsed.dependencies, "depends on");
  add(parsed.devDependencies, "dev dependency");
  return ops;
}

/** True when a filename alone identifies an importable code/infra file, so the
 * drop handler can route it before falling back to document import. */
export function classifyCodeFile(fileName: string): CodeImportKind | null {
  const f = fileName.toLowerCase();
  if (/docker-compose(\.[\w-]+)?\.ya?ml$/.test(f) || /compose\.ya?ml$/.test(f)) return "compose";
  if (f.endsWith("package.json")) return "package";
  return null;
}

/** Dispatch to the right parser; returns [] when nothing recognizable is found. */
export function codeToOps(fileName: string, content: string): Operation[] {
  switch (classifyCode(fileName, content)) {
    case "compose":
      return composeToOps(content);
    case "package":
      return packageJsonToOps(content);
    default:
      return [];
  }
}
