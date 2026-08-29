import { describe, expect, it } from "vitest";
import { createWorkspace } from "../src/model.js";
import { safeParseOperations } from "../src/operations.js";
import { validateOperations } from "../src/validator.js";
import { parseWorkspace, parseWorkspaceOrDefault } from "../src/workspaceSchema.js";
import { IMAGE_DATA_URL_MAX_LENGTH, isImageDataUrl } from "../src/schemaPrimitives.js";

/**
 * Pasted, dropped and AI-generated images live in the workspace as base64 data
 * URLs until M3 moves them to object storage. `src` used to be http(s)-only,
 * so every board with an image on it failed to parse on read-back and
 * `parseWorkspaceOrDefault` substituted an empty workspace - a reload lost the
 * board. These tests pin both halves: inline images survive, and the data URL
 * grammar stays too narrow to carry markup into the SVG/iframe sinks.
 */

const PNG = "data:image/png;base64,iVBORw0KGgo=";
const JPEG = "data:image/jpeg;base64,/9j/4AAQSkZJRg==";

function boardWith(shape: Record<string, unknown>): unknown {
  return {
    ...createWorkspace(),
    shapes: {
      s1: {
        id: "s1",
        position: { x: 0, y: 0 },
        size: { width: 10, height: 10 },
        ...shape,
      },
    },
  };
}

function createShape(shape: Record<string, unknown>): unknown[] {
  return [
    {
      op: "CREATE_SHAPE",
      id: "s1",
      position: { x: 0, y: 0 },
      size: { width: 10, height: 10 },
      ...shape,
    },
  ];
}

describe("inline image src", () => {
  it("keeps a data-URL image when the workspace is read back", () => {
    const result = parseWorkspace(boardWith({ kind: "image", src: PNG }));
    expect(result.ok).toBe(true);
    expect(result.workspace?.shapes.s1?.src).toBe(PNG);
  });

  it("does not fall back to an empty board for a board with images", () => {
    const restored = parseWorkspaceOrDefault(boardWith({ kind: "image", src: JPEG }));
    expect(Object.keys(restored.shapes)).toEqual(["s1"]);
  });

  it("still accepts a remote image", () => {
    expect(parseWorkspace(boardWith({ kind: "image", src: "https://x.test/a.png" })).ok).toBe(true);
  });

  it("accepts an inline image on the operation path", () => {
    const parsed = safeParseOperations(createShape({ kind: "image", src: PNG }));
    expect(parsed.success).toBe(true);
  });

  it("refuses a percent-encoded data URL, which can carry markup", () => {
    const hostile = "data:image/svg+xml;utf8,%3Cscript%3Ealert(1)%3C/script%3E";
    expect(isImageDataUrl(hostile)).toBe(false);
    expect(parseWorkspace(boardWith({ kind: "image", src: hostile })).ok).toBe(false);
  });

  it("refuses a data URL with an attribute break in it", () => {
    const hostile = 'data:image/png;base64,AAA" onload="alert(1)';
    expect(parseWorkspace(boardWith({ kind: "image", src: hostile })).ok).toBe(false);
    expect(safeParseOperations(createShape({ kind: "image", src: hostile })).success).toBe(false);
  });

  it("refuses a non-image media type", () => {
    expect(isImageDataUrl("data:text/html;base64,PHNjcmlwdD4=")).toBe(false);
  });

  it("caps the encoded size", () => {
    const huge = `data:image/png;base64,${"A".repeat(IMAGE_DATA_URL_MAX_LENGTH)}`;
    expect(parseWorkspace(boardWith({ kind: "image", src: huge })).ok).toBe(false);
  });

  it("keeps embed shapes http(s)-only, because that src reaches an iframe", () => {
    const parsed = parseWorkspace(boardWith({ kind: "embed", src: PNG }));
    expect(parsed.ok).toBe(false);
    expect(parsed.detail).toContain("only allowed on an image shape");
    expect(parseWorkspace(boardWith({ kind: "embed", src: "https://x.test/e" })).ok).toBe(true);
  });

  it("refuses an inline image on an embed operation, in the validator", () => {
    const ops = safeParseOperations(createShape({ kind: "embed", src: PNG }));
    expect(ops.success).toBe(true);
    const errors = validateOperations(createWorkspace(), ops.data!);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain("only allowed on an image shape");
  });
});
