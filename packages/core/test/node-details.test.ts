import { describe, it, expect } from "vitest";
import {
  AI_OPERATION_NAMES,
  applyOperations,
  clampNodeDetails,
  computeLayout,
  createWorkspace,
  inverseOperations,
  measureNode,
  NODE_DETAILS_LIMITS,
  nodeCardExtraHeight,
  nodeDetailsHeight,
  parseWorkspace,
  safeParseOperations,
  safeParseProgrammaticOperations,
  toolParametersJsonSchema,
  validateOperations,
  type NodeDetails,
  type Operation,
  type Workspace,
} from "../src/index.js";

/**
 * V4 node details: the compartments a UML class, an ER entity and a C4
 * element carry under their name. These pin the contract — what parses, that
 * the AI may emit it, that every edit undoes exactly, that a stored board
 * tolerates a bad value, and that the layout makes room for it.
 */

const CLASS: NodeDetails = {
  sections: [
    { title: "Attributes", items: ["+id: UUID", "+email: string"] },
    { title: "Operations", items: ["+save(): void"] },
  ],
};

function board(details?: NodeDetails): Workspace {
  return applyOperations(createWorkspace({ id: "ws", name: "T", diagramKind: "class" }), [
    {
      op: "CREATE_NODE",
      id: "user",
      nodeType: "class",
      label: "User",
      ...(details ? { details } : {}),
    },
    { op: "CREATE_NODE", id: "order", nodeType: "class", label: "Order" },
    { op: "CONNECT_NODES", source: "user", target: "order", relationship: "association" },
  ]);
}

const parses = (details: unknown) =>
  safeParseProgrammaticOperations([{ op: "SET_NODE_DETAILS", id: "user", details }]).success;

describe("the details schema", () => {
  it("accepts sections with and without titles, empty sections, and null", () => {
    expect(parses(CLASS)).toBe(true);
    expect(parses({ sections: [{ items: ["[PostgreSQL]"] }] })).toBe(true);
    expect(parses({ sections: [{ title: "Operations", items: [] }] })).toBe(true);
    expect(parses({ sections: [] })).toBe(true);
    expect(parses(null)).toBe(true);
    expect(
      safeParseProgrammaticOperations([
        { op: "CREATE_NODE", id: "n", nodeType: "entity", label: "N", details: CLASS },
      ]).success,
    ).toBe(true);
  });

  it("enforces every limit", () => {
    const L = NODE_DETAILS_LIMITS;
    const section = (items: string[], title?: string) => ({ ...(title ? { title } : {}), items });
    expect(parses({ sections: Array.from({ length: L.sections }, () => section(["a"])) })).toBe(
      true,
    );
    expect(parses({ sections: Array.from({ length: L.sections + 1 }, () => section(["a"])) })).toBe(
      false,
    );
    expect(parses({ sections: [section(Array.from({ length: L.items }, () => "a"))] })).toBe(true);
    expect(parses({ sections: [section(Array.from({ length: L.items + 1 }, () => "a"))] })).toBe(
      false,
    );
    expect(parses({ sections: [section(["x".repeat(L.itemChars)])] })).toBe(true);
    expect(parses({ sections: [section(["x".repeat(L.itemChars + 1)])] })).toBe(false);
    expect(parses({ sections: [section([], "t".repeat(L.titleChars))] })).toBe(true);
    expect(parses({ sections: [section([], "t".repeat(L.titleChars + 1))] })).toBe(false);
    // Each line within its cap, the whole over the total: refused by the refine.
    const line = "x".repeat(L.itemChars);
    const lines = (n: number) => Array.from({ length: n }, () => line);
    expect(parses({ sections: [section(lines(25))] })).toBe(true); // 4000 exactly
    expect(parses({ sections: [section(lines(25)), section(["y"])] })).toBe(false);
  });

  it("refuses line breaks and control characters, and markup is just text", () => {
    expect(parses({ sections: [{ items: ["id PK\nemail"] }] })).toBe(false);
    expect(parses({ sections: [{ items: ["bell\u0007"] }] })).toBe(false);
    expect(parses({ sections: [{ title: "Tab\there", items: [] }] })).toBe(false);
    expect(parses({ sections: [{ items: ["<script>alert(1)</script>"] }] })).toBe(true);
    expect(parses({ sections: "Attributes" })).toBe(false);
    expect(
      safeParseProgrammaticOperations([
        { op: "SET_NODE_DETAILS", id: "user", details: null, extra: 1 },
      ]).success,
    ).toBe(false);
  });

  it("splits a model's multi-line item into the lines it meant", () => {
    const parsed = safeParseOperations([
      {
        op: "CREATE_NODE",
        id: "e",
        nodeType: "entity",
        label: "User",
        details: { sections: [{ title: "Columns", items: ["id PK\nemail\r\n\nuser_id FK"] }] },
      },
    ]);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data[0]).toMatchObject({
      details: { sections: [{ title: "Columns", items: ["id PK", "email", "user_id FK"] }] },
    });
  });

  it("is an AI operation, advertised in the tool the model is given", () => {
    expect(AI_OPERATION_NAMES).toContain("SET_NODE_DETAILS");
    const tool = JSON.stringify(toolParametersJsonSchema());
    expect(tool).toContain('"SET_NODE_DETAILS"');
    expect(tool).toContain('"details"');
  });
});

describe("clampNodeDetails", () => {
  it("fits anything inside the limits, so the result always validates", () => {
    const L = NODE_DETAILS_LIMITS;
    const clamped = clampNodeDetails([
      { title: "T".repeat(99), items: ["a\tb", "", "x".repeat(500), ...Array(80).fill("y")] },
      { items: ["z"] },
      { items: ["z"] },
      { items: ["z"] },
      { items: ["dropped: a fifth section"] },
    ])!;
    expect(clamped.sections).toHaveLength(L.sections);
    expect(clamped.sections[0]!.title).toHaveLength(L.titleChars);
    expect(clamped.sections[0]!.items[0]).toBe("a b");
    expect(clamped.sections[0]!.items[1]).toHaveLength(L.itemChars);
    expect(clamped.sections[0]!.items).toHaveLength(L.items - 1); // the empty line went
    expect(parses(clamped)).toBe(true);
    const huge = clampNodeDetails(
      Array.from({ length: 4 }, () => ({ items: Array(40).fill("x".repeat(160)) })),
    )!;
    expect(parses(huge)).toBe(true);
  });

  it("returns null when nothing is left — SET_NODE_DETAILS's clear", () => {
    expect(clampNodeDetails([])).toBeNull();
    expect(clampNodeDetails([{ items: ["", "   "] }])).toBeNull();
  });
});

describe("reducer and inverse", () => {
  it("CREATE_NODE carries details; a node without them carries nothing", () => {
    const ws = board(CLASS);
    expect(ws.nodes.user?.details).toEqual(CLASS);
    expect(ws.nodes.order).not.toHaveProperty("details");
  });

  it("stores a copy, never the op's own arrays", () => {
    const details: NodeDetails = { sections: [{ items: ["a"] }] };
    const op: Operation = { op: "SET_NODE_DETAILS", id: "user", details };
    const ws = applyOperations(board(), [op]);
    details.sections[0]!.items.push("mutated later");
    expect(ws.nodes.user?.details).toEqual({ sections: [{ items: ["a"] }] });
  });

  it("SET_NODE_DETAILS replaces wholesale; null and an empty list both clear", () => {
    const ws = board(CLASS);
    const next = { sections: [{ title: "Columns", items: ["id PK"] }] };
    expect(
      applyOperations(ws, [{ op: "SET_NODE_DETAILS", id: "user", details: next }]).nodes.user
        ?.details,
    ).toEqual(next);
    expect(
      applyOperations(ws, [{ op: "SET_NODE_DETAILS", id: "user", details: null }]).nodes.user,
    ).not.toHaveProperty("details");
    expect(
      applyOperations(ws, [{ op: "SET_NODE_DETAILS", id: "user", details: { sections: [] } }]).nodes
        .user,
    ).not.toHaveProperty("details");
  });

  const roundTrip = (before: Workspace, ops: Operation[]) => {
    const after = applyOperations(before, ops);
    return applyOperations(after, inverseOperations(ops, before));
  };

  it("undoes a set exactly — onto a node with details, without, and a clear", () => {
    const next = { sections: [{ items: ["[React]"] }] };
    for (const before of [board(), board(CLASS)]) {
      for (const details of [next, null, { sections: [] }]) {
        const ops: Operation[] = [{ op: "SET_NODE_DETAILS", id: "user", details }];
        expect(roundTrip(before, ops)).toEqual(before);
      }
    }
    // The inverse names the prior value, or null when there was none.
    expect(
      inverseOperations([{ op: "SET_NODE_DETAILS", id: "user", details: next }], board()),
    ).toEqual([{ op: "SET_NODE_DETAILS", id: "user", details: null }]);
    expect(
      inverseOperations([{ op: "SET_NODE_DETAILS", id: "user", details: null }], board(CLASS)),
    ).toEqual([{ op: "SET_NODE_DETAILS", id: "user", details: CLASS }]);
  });

  it("undoes a chain of sets back to the start", () => {
    const before = board(CLASS);
    const ops: Operation[] = [
      { op: "SET_NODE_DETAILS", id: "user", details: { sections: [{ items: ["one"] }] } },
      { op: "SET_NODE_DETAILS", id: "user", details: null },
      { op: "SET_NODE_DETAILS", id: "user", details: { sections: [{ items: ["two"] }] } },
    ];
    expect(roundTrip(before, ops)).toEqual(before);
  });

  it("undoing a delete brings the details back with the node", () => {
    const before = board(CLASS);
    const restored = roundTrip(before, [{ op: "DELETE_NODE", id: "user" }]);
    expect(restored.nodes.user?.details).toEqual(CLASS);
    expect(restored).toEqual(before);
  });

  it("the inverse is a copy: editing the board later cannot rewrite history", () => {
    const before = board(CLASS);
    const inverse = inverseOperations(
      [{ op: "SET_NODE_DETAILS", id: "user", details: null }],
      before,
    );
    before.nodes.user!.details!.sections[0]!.items.push("later");
    expect(inverse[0]).toEqual({ op: "SET_NODE_DETAILS", id: "user", details: CLASS });
  });
});

describe("validator", () => {
  it("refuses details for a node that does not exist", () => {
    const errors = validateOperations(board(), [
      { op: "SET_NODE_DETAILS", id: "ghost", details: CLASS },
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain("ghost");
  });

  it("accepts a node created earlier in the same batch, not one deleted earlier", () => {
    expect(
      validateOperations(createWorkspace(), [
        { op: "CREATE_NODE", id: "fresh", nodeType: "entity", label: "Fresh" },
        { op: "SET_NODE_DETAILS", id: "fresh", details: CLASS },
      ]),
    ).toEqual([]);
    expect(
      validateOperations(board(), [
        { op: "DELETE_NODE", id: "user" },
        { op: "SET_NODE_DETAILS", id: "user", details: null },
      ]),
    ).toHaveLength(1);
  });
});

describe("stored boards", () => {
  it("an old board without details parses unchanged", () => {
    const old = JSON.parse(JSON.stringify(board()));
    const parsed = parseWorkspace(old);
    expect(parsed.ok).toBe(true);
    expect(parsed.workspace?.nodes.user).not.toHaveProperty("details");
  });

  it("keeps good details and drops malformed ones without refusing the board", () => {
    const good = JSON.parse(JSON.stringify(board(CLASS)));
    expect(parseWorkspace(good).workspace?.nodes.user?.details).toEqual(CLASS);

    for (const bad of [
      "Attributes: id",
      { sections: "nope" },
      { sections: [{ items: ["line\nbreak"] }] },
      { sections: [{ items: ["x".repeat(NODE_DETAILS_LIMITS.itemChars + 1)] }] },
      { sections: Array.from({ length: 9 }, () => ({ items: [] })) },
    ]) {
      const ws = JSON.parse(JSON.stringify(board()));
      ws.nodes.user.details = bad;
      const parsed = parseWorkspace(ws);
      expect(parsed.ok).toBe(true);
      expect(parsed.workspace?.nodes.user?.label).toBe("User");
      expect(parsed.workspace?.nodes.user?.details).toBeUndefined();
    }
  });
});

describe("layout", () => {
  const base = { width: 160, height: 64 };
  const extra = (details?: NodeDetails, label = "User") =>
    nodeCardExtraHeight({ label, ...(details ? { details } : {}) });

  it("a node with details is taller, by its compartments", () => {
    const plain = extra();
    const one = extra({ sections: [{ items: ["a"] }] });
    const two = extra({ sections: [{ items: ["a", "b"] }] });
    const titled = extra({ sections: [{ title: "Columns", items: ["a", "b"] }] });
    expect(plain).toBe(15);
    expect(one).toBeGreaterThan(plain);
    expect(two - one).toBe(15); // one more line
    expect(titled).toBeGreaterThan(two); // the title row
    // A second compartment adds its rule and padding as well as its line.
    expect(extra({ sections: [{ items: ["a"] }, { items: ["b"] }] })).toBeGreaterThan(two);
    // An empty list is no details at all.
    expect(extra({ sections: [] })).toBe(plain);
  });

  it("counts wrapped lines, measured at the card's width", () => {
    const short = extra({ sections: [{ items: ["+save(): void"] }] });
    const long = extra({
      sections: [{ items: ["+placeOrder(cart: Cart, coupon: Coupon): Order"] }],
    });
    expect(long).toBeGreaterThan(short);
    // A wider card (a long label) wraps less.
    const wideLabel = "Payment Reconciliation Service";
    expect(measureNode(wideLabel, base).width).toBeGreaterThan(base.width);
    const item = { sections: [{ items: ["+placeOrder(cart: Cart, coupon: Coupon): Order"] }] };
    expect(extra(item, wideLabel)).toBeLessThan(extra(item, "User"));
    // An explicit width wins over the estimate.
    expect(nodeCardExtraHeight({ details: item }, 1000)).toBe(15 + nodeDetailsHeight(item, 1000));
    // A single unbroken token longer than a line still wraps (breaks anywhere).
    const token = { sections: [{ items: ["x".repeat(60)] }] };
    expect(nodeDetailsHeight(token, 160)).toBeGreaterThan(
      nodeDetailsHeight({ sections: [{ items: ["x"] }] }, 160),
    );
  });

  it("the layout reserves the height on the laid-out node", () => {
    const ws = board(CLASS);
    const layout = computeLayout(ws);
    const withDetails = layout.user!.size.height;
    const without = layout.order!.size.height;
    expect(withDetails).toBe(
      measureNode("User", base, { extraHeight: nodeCardExtraHeight(ws.nodes.user) }).height,
    );
    expect(withDetails).toBeGreaterThan(without);
  });
});
