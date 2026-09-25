import { describe, it, expect } from "vitest";
import {
  applyLayout,
  applyOperations,
  computeLayout,
  createWorkspace,
  nodeDetailsHeight,
  NODE_DETAILS_LIMITS,
  safeParseProgrammaticOperations,
  starterFor,
  type NodeDetails,
  type Operation,
} from "@lucent/core";
import {
  detailsEditOps,
  detailsPlaceholder,
  formatDetailsText,
  parseDetailsText,
} from "../src/nodeDetails.js";
import { detailColumns, toEr } from "../src/board/er.js";
import { buildBoardSvg, wrapDetailLine } from "../src/board/geometry.js";

/**
 * V4 node details on the web side: the inspector's text editor, the ER lens
 * reading columns from details, and the export drawing them — plus the export's
 * XML-safety fix, which a details line or a table cell can exercise.
 */

const CLASS: NodeDetails = {
  sections: [
    { title: "Attributes", items: ["+id: UUID", "+email: string"] },
    { title: "Operations", items: ["+save(): void"] },
  ],
};

describe("the details editor's text", () => {
  it("formats compartments as ## headings and lines, and parses them back", () => {
    const text = formatDetailsText(CLASS);
    expect(text).toBe("## Attributes\n+id: UUID\n+email: string\n\n## Operations\n+save(): void");
    expect(parseDetailsText(text)).toEqual(CLASS);
  });

  it("round-trips untitled sections, including one after the first", () => {
    const details: NodeDetails = {
      sections: [{ items: ["[React]", "Takes orders"] }, { items: ["second"] }],
    };
    const text = formatDetailsText(details);
    expect(text).toBe("[React]\nTakes orders\n\n##\nsecond");
    expect(parseDetailsText(text)).toEqual(details);
  });

  it("keeps a titled section with no items — an empty UML compartment", () => {
    expect(parseDetailsText("## Attributes\n+id\n## Operations")).toEqual({
      sections: [
        { title: "Attributes", items: ["+id"] },
        { title: "Operations", items: [] },
      ],
    });
  });

  it("ignores blank lines and trims; ### is an item, not a heading", () => {
    expect(parseDetailsText("\n  id PK  \n\n\temail\r\n### not a title\n")).toEqual({
      sections: [{ items: ["id PK", "email", "### not a title"] }],
    });
  });

  it("empty text is no details at all", () => {
    expect(parseDetailsText("")).toBeNull();
    expect(parseDetailsText("\n  \n##\n")).toBeNull();
    expect(formatDetailsText(undefined)).toBe("");
    expect(formatDetailsText(null)).toBe("");
  });

  it("clamps pasted text to the limits, so the op always validates", () => {
    const long = Array.from({ length: 200 }, (_, i) => `column_${i} ${"x".repeat(200)}`).join("\n");
    const details = parseDetailsText(`## ${"T".repeat(80)}\n${long}`)!;
    expect(details.sections[0]!.title).toHaveLength(NODE_DETAILS_LIMITS.titleChars);
    expect(details.sections[0]!.items.length).toBeLessThanOrEqual(NODE_DETAILS_LIMITS.items);
    expect(
      safeParseProgrammaticOperations([{ op: "SET_NODE_DETAILS", id: "n", details }]).success,
    ).toBe(true);
  });
});

describe("detailsEditOps", () => {
  it("emits nothing when the text says what the node already has", () => {
    expect(detailsEditOps("n", CLASS, formatDetailsText(CLASS))).toEqual([]);
    // Cosmetic differences (spacing, blank lines) are not an edit either.
    expect(
      detailsEditOps(
        "n",
        CLASS,
        "## Attributes\n  +id: UUID\n\n+email: string\n## Operations\n+save(): void\n",
      ),
    ).toEqual([]);
    expect(detailsEditOps("n", undefined, "")).toEqual([]);
  });

  it("emits one SET_NODE_DETAILS for a change, and null when cleared", () => {
    expect(detailsEditOps("n", CLASS, "## Columns\nid PK")).toEqual([
      {
        op: "SET_NODE_DETAILS",
        id: "n",
        details: { sections: [{ title: "Columns", items: ["id PK"] }] },
      },
    ]);
    expect(detailsEditOps("n", CLASS, "   ")).toEqual([
      { op: "SET_NODE_DETAILS", id: "n", details: null },
    ]);
    expect(detailsEditOps("n", undefined, "[Go]")).toEqual([
      { op: "SET_NODE_DETAILS", id: "n", details: { sections: [{ items: ["[Go]"] }] } },
    ]);
  });

  it("offers a placeholder in the notation of the node's family", () => {
    expect(detailsPlaceholder("entity")).toContain("## Columns");
    expect(detailsPlaceholder("interface")).toContain("## Operations");
    expect(detailsPlaceholder("container")).toContain("[Technology]");
    expect(detailsPlaceholder("step")).toContain("## Title");
  });
});

describe("the ER lens reads columns from details", () => {
  const board = (ops: Operation[]) => applyOperations(createWorkspace({ diagramKind: "er" }), ops);

  it("takes a Columns section's items as attributes, with PK as the key", () => {
    const ws = board([
      {
        op: "CREATE_NODE",
        id: "user",
        nodeType: "entity",
        label: "User",
        details: {
          sections: [
            { title: "Columns", items: ["id PK", "email varchar", "org_id FK"] },
            { title: "Indexes", items: ["email unique"] },
          ],
        },
      },
    ]);
    expect(toEr(ws).entities[0]!.attributes).toEqual([
      { name: "id", key: true },
      { name: "email varchar" },
      { name: "org_id FK" },
    ]);
  });

  it("an Attributes section counts too; untitled details are all columns", () => {
    expect(
      detailColumns({
        details: { sections: [{ title: "attributes", items: ["a"] }, { items: ["b"] }] },
      }),
    ).toEqual(["a"]);
    expect(
      detailColumns({ details: { sections: [{ items: ["a"] }, { title: "More", items: ["b"] }] } }),
    ).toEqual(["a", "b"]);
    expect(detailColumns({})).toBeNull();
  });

  it("reads the key markers people write, and not ones inside names", () => {
    const attrs = toEr(
      board([
        {
          op: "CREATE_NODE",
          id: "t",
          nodeType: "entity",
          label: "T",
          details: {
            sections: [{ items: ["id uuid (PK)", "code primary key", "pkg_name", "user_pk"] }],
          },
        },
      ]),
    ).entities[0]!.attributes;
    expect(attrs).toEqual([
      { name: "id uuid", key: true },
      { name: "code", key: true },
      { name: "pkg_name" },
      { name: "user_pk" },
    ]);
  });

  it("falls back to the synthetic id and metadata keys without details", () => {
    const ws = board([{ op: "CREATE_NODE", id: "e", nodeType: "entity", label: "E" }]);
    ws.nodes.e!.metadata = { email: true };
    expect(toEr(ws).entities[0]!.attributes).toEqual([
      { name: "id", key: true },
      { name: "email" },
    ]);
  });

  it("the ER starter's entities come with their columns", () => {
    const ws = applyOperations(createWorkspace(), starterFor("er", "s"));
    const user = toEr(ws).entities.find((e) => e.label === "User")!;
    expect(user.attributes).toEqual([
      { name: "id", key: true },
      { name: "email" },
      { name: "name" },
    ]);
  });
});

describe("export", () => {
  it("draws a card's details inside the height the layout reserved", () => {
    let ws = applyOperations(createWorkspace({ diagramKind: "class" }), [
      { op: "CREATE_NODE", id: "user", nodeType: "class", label: "User", details: CLASS },
    ]);
    ws = applyLayout(ws, computeLayout(ws));
    const svg = buildBoardSvg(ws);
    for (const text of [
      "ATTRIBUTES",
      "+id: UUID",
      "+email: string",
      "OPERATIONS",
      "+save(): void",
    ]) {
      expect(svg).toContain(`>${text}</text>`);
    }
    // The last details line stays inside the card.
    const node = ws.nodes.user!;
    const ys = [...svg.matchAll(/<text x="[-\d.]+" y="([-\d.]+)"[^>]*font-size="10.5"/g)].map((m) =>
      Number(m[1]),
    );
    expect(ys).toHaveLength(3);
    expect(Math.max(...ys)).toBeLessThan(node.position!.y + node.size!.height);
  });

  it("wraps an exported line exactly as the layout counted it", () => {
    for (const item of [
      "+save(): void",
      "+placeOrder(cart: Cart, coupon: Coupon): Order",
      "x".repeat(70),
      "",
    ]) {
      for (const width of [160, 220, 280]) {
        const perLine = Math.floor((width - 32) / 6.4);
        const reserved = nodeDetailsHeight({ sections: [{ items: [item] }] }, width) - 6 - 9;
        expect(wrapDetailLine(item, perLine).length * 15, `${item} @ ${width}`).toBe(reserved);
      }
    }
  });

  it("strips control characters XML 1.0 cannot carry, keeping tab and newline", () => {
    // A board that never met the op schema (an old import): a BEL in a label,
    // a form feed and a NUL in a table cell.
    const ws = applyOperations(createWorkspace(), [
      { op: "CREATE_NODE", id: "a", nodeType: "step", label: "Ding\u0007 dong\ttab" },
      {
        op: "CREATE_SHAPE",
        id: "t",
        kind: "table",
        position: { x: 0, y: 200 },
        size: { width: 200, height: 60 },
        table: { columns: [{ header: "H\u000c" }], rows: [{ cells: ["x\u0000y"] }] },
      },
    ]);
    const svg = buildBoardSvg(ws);
    // eslint-disable-next-line no-control-regex
    expect(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(svg)).toBe(false);
    expect(svg).toContain("Ding dong\ttab");
    expect(svg).toContain(">xy</text>");
  });
});
