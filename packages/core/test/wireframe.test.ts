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
});
