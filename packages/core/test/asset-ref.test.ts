import { describe, expect, it } from "vitest";
import { createWorkspace } from "../src/model.js";
import { applyOperations } from "../src/reducer.js";
import { inverseOperations } from "../src/inverse.js";
import { safeParseOperations, type Operation } from "../src/operations.js";
import { validateOperations } from "../src/validator.js";
import { parseWorkspace, parseWorkspaceOrDefault } from "../src/workspaceSchema.js";
import {
  ASSET_ID_PREFIX,
  ASSET_REF_SCHEME,
  assetRefId,
  formatAssetRef,
  isAssetRef,
} from "../src/schemaPrimitives.js";

/**
 * M3 moves image bytes out of the graph, and the reference to them travels in
 * the same `src` field the inline data URL used. These tests pin the three
 * properties that decision rests on:
 *
 *  - a reference survives every copy in the pipeline (schema, reducer, inverse),
 *    because nothing in reducer.ts or inverse.ts was changed to carry it;
 *  - a board written before M3 still parses, so the migration is not a flag day;
 *  - the reference grammar is too narrow to carry markup or a path escape into
 *    the SVG/iframe sinks, or into a storage key derived from the id.
 */

const REF = "asset:ast_m9k2x0aa11bb22cc";
const PNG = "data:image/png;base64,iVBORw0KGgo=";

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

describe("asset reference grammar", () => {
  it("round-trips an id through format and parse", () => {
    const id = `${ASSET_ID_PREFIX}m9k2x0aa11bb22cc`;
    expect(formatAssetRef(id)).toBe(`${ASSET_REF_SCHEME}${id}`);
    expect(assetRefId(formatAssetRef(id))).toBe(id);
    expect(isAssetRef(formatAssetRef(id))).toBe(true);
  });

  it("returns undefined rather than a bare string for a non-reference", () => {
    expect(assetRefId(PNG)).toBeUndefined();
    expect(assetRefId("https://x.test/a.png")).toBeUndefined();
    expect(assetRefId("ast_m9k2x0aa11bb22cc")).toBeUndefined();
  });

  it("throws when asked to format an id that would not parse back", () => {
    // A malformed reference in a workspace is a broken image on every client
    // from then on; failing at the call site that minted it is recoverable.
    expect(() => formatAssetRef("../../etc/passwd")).toThrow();
    expect(() => formatAssetRef("ast_UPPER")).toThrow();
    expect(() => formatAssetRef("")).toThrow();
  });

  it("refuses references that could escape a sink or a storage path", () => {
    for (const hostile of [
      "asset:ast_../../etc/passwd",
      "asset:ast_aaaaaa/../bbbbbb",
      'asset:ast_aaaaaa" onload="alert(1)',
      "asset:ast_aaaaaa?x=1",
      "asset:ast_aaa", // shorter than any minted id
      "asset:",
      "asset:ast_",
      `asset:ast_${"a".repeat(65)}`,
      "javascript:ast_aaaaaa",
      " asset:ast_aaaaaa",
    ]) {
      expect(isAssetRef(hostile), hostile).toBe(false);
    }
  });
});

describe("asset references in a workspace", () => {
  it("parses a stored board whose image is a reference", () => {
    const result = parseWorkspace(boardWith({ kind: "image", src: REF }));
    expect(result.ok).toBe(true);
    expect(result.workspace?.shapes.s1?.src).toBe(REF);
  });

  it("does not fall back to an empty board for a reference-bearing board", () => {
    const restored = parseWorkspaceOrDefault(boardWith({ kind: "image", src: REF }));
    expect(Object.keys(restored.shapes)).toEqual(["s1"]);
  });

  it("still parses a board written before M3, unchanged", () => {
    const before = parseWorkspace(boardWith({ kind: "image", src: PNG }));
    expect(before.ok).toBe(true);
    expect(before.workspace?.shapes.s1?.src).toBe(PNG);
  });

  it("accepts a reference on the operation path and validates it", () => {
    const parsed = safeParseOperations(createShape({ kind: "image", src: REF }));
    expect(parsed.success).toBe(true);
    expect(validateOperations(createWorkspace(), parsed.data!)).toEqual([]);
  });

  it("refuses a malformed reference on the operation path", () => {
    expect(safeParseOperations(createShape({ kind: "image", src: "asset:ast_../x" })).success).toBe(
      false,
    );
  });
});

describe("asset references survive the graph pipeline", () => {
  it("is copied through the reducer onto the shape", () => {
    const ops = safeParseOperations(createShape({ kind: "image", src: REF }));
    const after = applyOperations(createWorkspace(), ops.data!);
    expect(after.shapes.s1?.src).toBe(REF);
  });

  it("survives delete-then-undo, so an image does not vanish on undo", () => {
    // The reason the reference lives in `src` rather than in a new field: the
    // DELETE_SHAPE inverse rebuilds CREATE_SHAPE from the stored shape, and a
    // field it did not know about would be dropped here, silently.
    const created = applyOperations(
      createWorkspace(),
      safeParseOperations(createShape({ kind: "image", src: REF })).data!,
    );
    const del: Operation[] = [{ op: "DELETE_SHAPE", id: "s1" }];
    const deleted = applyOperations(created, del);
    expect(deleted.shapes.s1).toBeUndefined();

    const undo = inverseOperations(del, created);
    const restored = applyOperations(deleted, undo);
    expect(restored.shapes.s1?.src).toBe(REF);
  });

  it("lets a reference and an inline image coexist on one board", () => {
    // What a partially-lifted board looks like while the backfill is running.
    const mixed = {
      ...createWorkspace(),
      shapes: {
        a: {
          id: "a",
          kind: "image",
          src: REF,
          position: { x: 0, y: 0 },
          size: { width: 4, height: 4 },
        },
        b: {
          id: "b",
          kind: "image",
          src: PNG,
          position: { x: 8, y: 0 },
          size: { width: 4, height: 4 },
        },
      },
    };
    const parsed = parseWorkspace(mixed);
    expect(parsed.ok).toBe(true);
    expect(parsed.workspace?.shapes.a?.src).toBe(REF);
    expect(parsed.workspace?.shapes.b?.src).toBe(PNG);
  });
});
