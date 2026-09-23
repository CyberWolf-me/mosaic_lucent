import { describe, it, expect } from "vitest";
import {
  applyOperations,
  createWorkspace,
  inverseOperations,
  normalizeIconRef,
  parseWorkspace,
  safeParseOperations,
  safeParseProgrammaticOperations,
  validateOperations,
  type Operation,
  type Workspace,
} from "@lucent/core";

/**
 * docs/26 §6.2: a node's icon is a registry reference, never markup. These pin
 * the contract the renderer and the AI both lean on: what parses, what a
 * model's near-miss is repaired to, and that choosing an icon is undoable.
 */

function withNode(icon?: string): Workspace {
  return applyOperations(createWorkspace({ name: "T", id: "ws_t" }), [
    {
      op: "CREATE_NODE",
      id: "db",
      nodeType: "database",
      label: "Orders DB",
      ...(icon ? { icon } : {}),
    },
  ]);
}

describe("node icons", () => {
  it("CREATE_NODE carries an icon onto the node", () => {
    expect(withNode("simple:postgresql").nodes.db?.icon).toBe("simple:postgresql");
    expect(withNode().nodes.db).not.toHaveProperty("icon");
  });

  it("accepts both registries and refuses anything that could be markup", () => {
    const create = (icon: string) =>
      safeParseProgrammaticOperations([
        { op: "CREATE_NODE", id: "n", nodeType: "service", label: "N", icon },
      ]).success;
    expect(create("iconoir:database")).toBe(true);
    expect(create("simple:postgresql")).toBe(true);
    expect(create("simple:hive_blockchain")).toBe(true);
    expect(create('iconoir:x" onload="alert(1)')).toBe(false);
    expect(create("<svg/>")).toBe(false);
    expect(create("https://example.com/icon.svg")).toBe(false);
    expect(create("fontawesome:database")).toBe(false);
  });

  it("repairs a model's near-miss instead of losing the node", () => {
    expect(normalizeIconRef("SI:Stripe")).toBe("simple:stripe");
    expect(normalizeIconRef("simple-icons:apache-kafka")).toBe("simple:apachekafka");
    expect(normalizeIconRef(" iconoir:Cloud Upload ")).toBe("iconoir:cloud-upload");
    expect(normalizeIconRef("database")).toBeUndefined();

    const parsed = safeParseOperations([
      { op: "CREATE_NODE", id: "a", nodeType: "service", label: "Payments", icon: "SI:Stripe" },
      { op: "CREATE_NODE", id: "b", nodeType: "service", label: "Mystery", icon: "<svg onload=x>" },
    ]);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data[0]).toMatchObject({ icon: "simple:stripe" });
    expect(parsed.data[1]).not.toHaveProperty("icon");
  });

  it("SET_NODE_ICON sets and clears, and each is undoable", () => {
    const before = withNode();
    const set: Operation[] = [{ op: "SET_NODE_ICON", id: "db", icon: "iconoir:database" }];
    const after = applyOperations(before, set);
    expect(after.nodes.db?.icon).toBe("iconoir:database");
    expect(applyOperations(after, inverseOperations(set, before)).nodes.db).not.toHaveProperty(
      "icon",
    );

    const clear: Operation[] = [{ op: "SET_NODE_ICON", id: "db", icon: null }];
    const cleared = applyOperations(after, clear);
    expect(cleared.nodes.db).not.toHaveProperty("icon");
    expect(applyOperations(cleared, inverseOperations(clear, after)).nodes.db?.icon).toBe(
      "iconoir:database",
    );
  });

  it("undoing a delete brings the icon back with the node", () => {
    const before = withNode("simple:postgresql");
    const del: Operation[] = [{ op: "DELETE_NODE", id: "db" }];
    const restored = applyOperations(applyOperations(before, del), inverseOperations(del, before));
    expect(restored.nodes.db?.icon).toBe("simple:postgresql");
  });

  it("an icon on a missing node is refused by the validator", () => {
    expect(
      validateOperations(withNode(), [{ op: "SET_NODE_ICON", id: "nope", icon: "iconoir:user" }]),
    ).not.toHaveLength(0);
  });

  it("a stored board keeps a good icon and drops a malformed one without failing to load", () => {
    const ws = JSON.parse(JSON.stringify(withNode("simple:redis")));
    const ok = parseWorkspace(ws);
    expect(ok.ok && ok.workspace.nodes.db?.icon).toBe("simple:redis");

    ws.nodes.db.icon = '"><script>';
    const tolerant = parseWorkspace(ws);
    expect(tolerant.ok).toBe(true);
    if (tolerant.ok) expect(tolerant.workspace.nodes.db?.icon).toBeUndefined();
  });
});
