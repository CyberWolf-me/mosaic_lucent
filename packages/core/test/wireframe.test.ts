import { describe, it, expect } from "vitest";
import { createWorkspace } from "../src/model.js";
import { applyOperations } from "../src/reducer.js";
import { validateOperations } from "../src/validator.js";
import { safeParseOperations } from "../src/operations.js";
import type { Operation } from "../src/operations.js";

const checkoutWireframe: Operation = {
  op: "CREATE_WIREFRAME",
  id: "wf-checkout",
  title: "Checkout",
  viewport: "desktop",
  root: {
    kind: "screen",
    direction: "row",
    children: [
      {
        kind: "column",
        weight: 2,
        children: [
          { kind: "heading", label: "Contact" },
          { kind: "field", label: "Email", placeholder: "you@example.com" },
          { kind: "button", label: "Place order", variant: "primary" },
        ],
      },
      {
        kind: "card",
        weight: 1,
        children: [{ kind: "text", label: "Order summary" }],
      },
    ],
  },
};

describe("wireframe operations", () => {
  it("parses a nested wireframe op through the schema", () => {
    const result = safeParseOperations([checkoutWireframe]);
    expect(result.success).toBe(true);
  });

  it("creates and deletes a wireframe in the workspace", () => {
    const created = applyOperations(createWorkspace(), [checkoutWireframe]);
    expect(Object.keys(created.wireframes)).toEqual(["wf-checkout"]);
    expect(created.wireframes["wf-checkout"]?.root.children).toHaveLength(2);

    const deleted = applyOperations(created, [{ op: "DELETE_WIREFRAME", id: "wf-checkout" }]);
    expect(Object.keys(deleted.wireframes)).toEqual([]);
  });

  it("validates duplicate create and missing delete", () => {
    const created = applyOperations(createWorkspace(), [checkoutWireframe]);
    const dupErrors = validateOperations(created, [checkoutWireframe]);
    expect(dupErrors[0]?.message).toMatch(/already exists/);

    const missing = validateOperations(createWorkspace(), [{ op: "DELETE_WIREFRAME", id: "nope" }]);
    expect(missing[0]?.message).toMatch(/does not exist/);
  });

  it("tolerantly parses LLM variations in wireframe operations", () => {
    const rawVariation = [
      {
        op: "CREATE_WIREFRAME",
        id: "wf-home",
        name: "Homepage",
        viewport: "mobile-first",
        root: {
          kind: "screen",
          direction: "vertical",
          children: [
            { kind: "header", text: "Welcome to our store" },
            { kind: "button", text: "Shop Now", variant: "outline" },
            { kind: "input", title: "Search", placeholder: "Search listings..." },
          ],
        },
      },
    ];
    const parsed = safeParseOperations(rawVariation);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      const wf = parsed.data[0] as Extract<Operation, { op: "CREATE_WIREFRAME" }>;
      expect(wf.title).toBe("Homepage");
      expect(wf.viewport).toBe("mobile");
      expect(wf.root.direction).toBe("column");
      expect(wf.root.children?.[0]?.label).toBe("Welcome to our store");
      expect(wf.root.children?.[1]?.variant).toBe("secondary");
      expect(wf.root.children?.[2]?.placeholder).toBe("Search listings...");
    }
  });

  it("normalizes UPDATE_WIREFRAME and automatically wraps flat elements", () => {
    const rawUpdate = [
      {
        op: "UPDATE_WIREFRAME",
        id: "wf-home",
        title: "Updated Homepage",
        elements: [
          { kind: "nav", text: "Top Nav" },
          { kind: "section", text: "Product Grid" },
        ],
      },
    ];
    const parsed = safeParseOperations(rawUpdate);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      const wf = parsed.data[0] as Extract<Operation, { op: "CREATE_WIREFRAME" }>;
      expect(wf.op).toBe("CREATE_WIREFRAME");
      expect(wf.root.kind).toBe("screen");
      expect(wf.root.children).toHaveLength(2);
    }
  });
});
