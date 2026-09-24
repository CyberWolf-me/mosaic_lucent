import { describe, expect, it } from "vitest";
import { applyOperations, createWorkspace, type Operation, type Workspace } from "@lucent/core";
import {
  clipFromSelection,
  clipText,
  parseClip,
  planPaste,
  svgSize,
  svgTextToDataUrl,
  textPasteOp,
  type ClipPayload,
} from "../src/board/clipboard.js";

/**
 * docs/26 §6.4: the system clipboard. Copy carries a selection between boards
 * and tabs; paste turns what other apps put there into the right object; and a
 * payload is untrusted — any page can write the MIME type — so it must pass the
 * strict op schema or nothing is pasted.
 */

function board(id: string, ops: Operation[] = []): Workspace {
  return applyOperations(createWorkspace({ name: id, id }), ops);
}

const source = board("ws_a", [
  {
    op: "CREATE_SHAPE",
    id: "s1",
    kind: "sticky",
    position: { x: 0, y: 0 },
    size: { width: 100, height: 100 },
    text: "Idea",
    z: 1,
  },
  {
    op: "CREATE_SHAPE",
    id: "s2",
    kind: "rect",
    position: { x: 200, y: 0 },
    size: { width: 100, height: 100 },
    text: "Box",
    z: 2,
  },
  {
    op: "CREATE_SHAPE",
    id: "s3",
    kind: "rect",
    position: { x: 400, y: 0 },
    size: { width: 100, height: 100 },
    z: 3,
  },
  { op: "CONNECT_SHAPES", id: "l1", source: "s1", target: "s2", label: "leads to" },
  { op: "CONNECT_SHAPES", id: "l2", source: "s2", target: "s3" },
  { op: "CREATE_NODE", id: "api", nodeType: "service", label: "API", icon: "iconoir:server" },
  { op: "CREATE_NODE", id: "db", nodeType: "database", label: "Orders DB" },
  { op: "CREATE_NODE", id: "cache", nodeType: "cache", label: "Cache" },
  { op: "CONNECT_NODES", source: "api", target: "db", relationship: "reads/writes" },
  { op: "CONNECT_NODES", source: "api", target: "cache", relationship: "reads" },
]);

describe("copy", () => {
  it("carries the selection and only the ties inside it", () => {
    const p = clipFromSelection(source, ["s1", "s2"], ["api", "db"])!;
    expect(p.shapes.map((s) => s.id)).toEqual(["s1", "s2"]);
    expect(p.links.map((l) => l.id)).toEqual(["l1"]);
    expect(p.nodes).toEqual([
      { id: "api", label: "API", nodeType: "service", icon: "iconoir:server" },
      { id: "db", label: "Orders DB", nodeType: "database" },
    ]);
    expect(p.edges).toEqual([{ source: "api", target: "db", relationship: "reads/writes" }]);
    expect(clipText(p)).toBe("API\nOrders DB\nIdea\nBox");
  });

  it("has nothing to copy without a selection", () => {
    expect(clipFromSelection(source, [], [])).toBeNull();
    expect(clipFromSelection(source, ["gone"], ["gone"])).toBeNull();
  });
});

describe("paste a Lucent selection", () => {
  const payload = clipFromSelection(source, ["s1", "s2"], ["api", "db"])!;
  const roundTrip = parseClip(JSON.stringify(payload))!;

  it("back into its own board lands 24px down-right, with fresh ids and its link", () => {
    const plan = planPaste(source, roundTrip, { x: 999, y: 999 })!;
    const after = applyOperations(source, plan.ops);
    const [a, b] = plan.shapeIds.map((id) => after.shapes[id]!);
    expect(a!.position).toEqual({ x: 24, y: 24 });
    expect(b!.position).toEqual({ x: 224, y: 24 });
    expect(plan.shapeIds).not.toContain("s1");
    const link = Object.values(after.shapeLinks).find((l) => l.source === a!.id);
    expect(link).toMatchObject({ target: b!.id, label: "leads to" });
    // Pasted shapes stack above what was there.
    expect(a!.z).toBeGreaterThan(3);
  });

  it("gives nodes free ids and keeps their edge and icon", () => {
    const plan = planPaste(source, roundTrip, { x: 0, y: 0 })!;
    expect(plan.nodeIds).toEqual(["api-2", "db-2"]);
    const after = applyOperations(source, plan.ops);
    expect(after.nodes["api-2"]).toMatchObject({ label: "API", icon: "iconoir:server" });
    expect(
      Object.values(after.edges).some((e) => e.source === "api-2" && e.target === "db-2"),
    ).toBe(true);
  });

  it("into another board, centres on the viewport and keeps readable ids", () => {
    const other = board("ws_b");
    const plan = planPaste(other, roundTrip, { x: 1000, y: 500 })!;
    const after = applyOperations(other, plan.ops);
    const xs = plan.shapeIds.map((id) => after.shapes[id]!.position.x);
    // The two shapes span x 0..300 in the source: centred on 1000 → 850..1150.
    expect(xs).toEqual([850, 1050]);
    expect(plan.nodeIds).toEqual(["api", "db"]);
  });

  it("refuses a payload that fails the op schema — all of it", () => {
    const hostile: ClipPayload = {
      ...roundTrip,
      shapes: [
        { ...roundTrip.shapes[0]!, style: { fill: 'red" onmouseover="alert(1)' } },
        roundTrip.shapes[1]!,
      ],
    };
    expect(planPaste(source, hostile, { x: 0, y: 0 })).toBeNull();
    const scripted: ClipPayload = {
      ...roundTrip,
      shapes: [{ ...roundTrip.shapes[0]!, kind: "embed", src: "javascript:alert(1)" }],
    };
    expect(planPaste(source, scripted, { x: 0, y: 0 })).toBeNull();
    // Malformed enough to throw while planning: refused, not a crash.
    const broken = { ...roundTrip, shapes: [{ id: "x" }] } as unknown as ClipPayload;
    expect(planPaste(source, broken, { x: 0, y: 0 })).toBeNull();
  });

  it("reads back only a real payload", () => {
    expect(parseClip("not json")).toBeNull();
    expect(parseClip(JSON.stringify({ v: 2 }))).toBeNull();
    expect(parseClip(undefined)).toBeNull();
  });
});

describe("paste from other apps", () => {
  it("a link Lucent can show becomes an embed; other text becomes a text object", () => {
    const yt = textPasteOp("https://www.youtube.com/watch?v=dQw4w9WgXcQ", { x: 500, y: 300 }, 4)!;
    expect(yt).toMatchObject({
      kind: "embed",
      src: "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
    });
    expect(yt.position).toEqual({ x: 300, y: 170 });

    const text = textPasteOp("  Ship the pricing page by Friday  ", { x: 500, y: 300 }, 4)!;
    expect(text).toMatchObject({ kind: "text", text: "Ship the pricing page by Friday" });
    expect(text.size.width).toBeGreaterThanOrEqual(120);
    expect(textPasteOp("   ", { x: 0, y: 0 }, 1)).toBeNull();
  });

  it("an SVG document becomes a base64 image the schema accepts, at its own proportions", () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 320"><path d="M0 0h10"/></svg>';
    const url = svgTextToDataUrl(svg)!;
    expect(url.startsWith("data:image/svg+xml;base64,")).toBe(true);
    expect(svgSize(svg)).toEqual({ width: 320, height: 160 });
    expect(svgTextToDataUrl("hello <svg> world")).toBeNull();
    const op = textPasteOp("<b>not svg</b>", { x: 0, y: 0 }, 1);
    expect(op?.kind).toBe("text");
  });
});
