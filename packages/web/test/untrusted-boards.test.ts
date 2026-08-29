import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { applyOperations, createWorkspace } from "@lucent/core";
import { reviewWorkspace } from "../src/workspace.js";
import { buildPrintDocument } from "../src/views/CanvasView.js";
import { isSafeImageSrc } from "../src/ui/ShapeToolbar.js";
import { loadProject, saveProject } from "../src/persistence.js";

/**
 * Untrusted board JSON, and the two sinks board text still reaches.
 *
 * A workspace arrives in the app three ways that no operation validator ever
 * saw: a file the user imports, a blob read back out of localStorage, and a
 * board broadcast by the server. `importWorkspace` used to hand-roll a repair
 * spread and `openProject` passed the stored blob straight into History, so a
 * hand-edited file or an XSS-written storage entry could seat a hostile `src` in
 * the model. Both now go through parseWorkspace, and the two sinks that
 * interpolate board text — the PDF export's `<title>` and an image shape's
 * `<img src>` — are guarded where they are used, not only where data enters.
 */

/** A real pasted image: the shortest base64 PNG the schema accepts. */
const PNG = "data:image/png;base64,iVBORw0KGgo=";

/** localStorage for the node test environment (same shim as reliability.test.ts). */
function installStorage() {
  const map = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  });
  return map;
}

/** A board built by hand, the way a JSON file or a stale storage blob is. */
function rawBoard(shape: Record<string, unknown>) {
  return {
    id: "w_1",
    name: "Board",
    diagramKind: "flowchart",
    nodes: {},
    edges: {},
    groups: {},
    shapes: {
      s1: { id: "s1", position: { x: 0, y: 0 }, size: { width: 40, height: 40 }, ...shape },
    },
  };
}

describe("importing an untrusted board file", () => {
  it("refuses a payload that is not a board at all, with a reason to show", () => {
    const review = reviewWorkspace("not a board", "That file");
    expect(review.workspace).toBeNull();
    expect(review.error).toContain("That file isn't a valid Lucent board");
  });

  it("refuses a board whose image src is a script URL rather than importing it", () => {
    const review = reviewWorkspace(
      rawBoard({ kind: "image", src: "javascript:alert(1)" }),
      "That file",
    );
    // Nothing to open means nothing to seat in History: the spread this replaced
    // would have produced a workspace with that shape still in it.
    expect(review.workspace).toBeNull();
    expect(review.error).toContain("src");
  });

  it("refuses a percent-encoded data URL, which can still carry markup", () => {
    const review = reviewWorkspace(
      rawBoard({ kind: "image", src: "data:image/svg+xml;utf8,<svg onload=alert(1)>" }),
      "That file",
    );
    expect(review.workspace).toBeNull();
  });

  it("refuses an inline image on an embed shape, whose src reaches an iframe", () => {
    expect(
      reviewWorkspace(rawBoard({ kind: "embed", src: PNG }), "That file").workspace,
    ).toBeNull();
  });

  it("keeps the tolerance the repair spread provided: missing collections default", () => {
    // The spread existed so a board from an older build could not crash a
    // reducer that assumes these keys. The schema defaults them, so dropping the
    // spread costs nothing.
    const review = reviewWorkspace(
      { id: "w_2", name: "Old", diagramKind: "flowchart" },
      "That file",
    );
    expect(review.error).toBeNull();
    expect(review.workspace?.shapes).toEqual({});
    expect(review.workspace?.wireframes).toEqual({});
    expect(review.workspace?.comments).toEqual({});
    expect(review.workspace?.shapeLinks).toEqual({});
  });

  it("still imports a legitimate board, pasted image and all", () => {
    const ws = applyOperations(createWorkspace({ name: "Real" }), [
      { op: "CREATE_NODE", id: "a", nodeType: "service", label: "Kept" },
      {
        op: "CREATE_SHAPE",
        id: "s1",
        kind: "image",
        position: { x: 0, y: 0 },
        size: { width: 40, height: 40 },
        src: PNG,
      },
    ]);
    const review = reviewWorkspace(JSON.parse(JSON.stringify(ws)), "That file");
    expect(review.error).toBeNull();
    expect(review.workspace?.nodes.a?.label).toBe("Kept");
    expect(review.workspace?.shapes.s1?.src).toBe(PNG);
  });
});

describe("opening a stored project", () => {
  beforeEach(() => installStorage());
  afterEach(() => vi.unstubAllGlobals());

  /** The sequence openProject runs: read the blob back, then review it. */
  function openStored(workspace: unknown) {
    saveProject({ id: "p_1", name: "Saved", workspace: workspace as never, chat: [] });
    const data = loadProject("p_1");
    const review = reviewWorkspace(data?.workspace, "That saved board");
    return { review, opened: review.workspace ?? createWorkspace() };
  }

  it("does not let a hostile src survive into the board", () => {
    const { review, opened } = openStored(rawBoard({ kind: "image", src: "javascript:alert(1)" }));
    expect(review.error).toContain("That saved board isn't a valid Lucent board");
    // Whatever reaches the canvas carries no trace of the payload.
    expect(JSON.stringify(opened)).not.toContain("javascript:");
    expect(Object.keys(opened.shapes)).toHaveLength(0);
  });

  it("tells the user instead of opening a silently empty canvas", () => {
    const { review } = openStored({ nodes: "not an object" });
    expect(review.error).not.toBeNull();
  });

  it("opens a genuine saved board untouched, image included", () => {
    const ws = applyOperations(createWorkspace({ name: "Mine" }), [
      {
        op: "CREATE_SHAPE",
        id: "s1",
        kind: "image",
        position: { x: 1, y: 2 },
        size: { width: 40, height: 40 },
        src: PNG,
      },
    ]);
    const { review, opened } = openStored(ws);
    expect(review.error).toBeNull();
    expect(opened.shapes.s1?.src).toBe(PNG);
  });
});

describe("the PDF export's document title", () => {
  it("cannot be closed early by a hostile project name", () => {
    const doc = buildPrintDocument("<svg/>", "</title><script>alert(1)</script>");
    expect(doc).not.toContain("<script>alert(1)");
    expect(doc).not.toContain("</title><script");
    expect(doc).toContain("&lt;/title&gt;");
    // Exactly one real </title>: the injected one was neutralised, not counted.
    expect(doc.match(/<\/title>/g) ?? []).toHaveLength(1);
  });

  it("escapes quotes in a name too", () => {
    expect(buildPrintDocument("<svg/>", 'He said "go"')).toContain("&quot;");
  });

  it("leaves an ordinary name readable", () => {
    expect(buildPrintDocument("<svg/>", "Q3 roadmap")).toContain("<title>Q3 roadmap</title>");
  });

  it("falls back to a filename-ish title when the project is unnamed", () => {
    expect(buildPrintDocument("<svg/>", "")).toContain("<title>lucent-board</title>");
  });

  it("still embeds the board and the auto-print hook", () => {
    const doc = buildPrintDocument('<svg id="board"/>', "Board");
    expect(doc).toContain('<svg id="board"/>');
    expect(doc).toContain("window.print()");
  });
});

describe("the image shape's src guard", () => {
  it("allows the two forms the schema allows", () => {
    expect(isSafeImageSrc("https://example.com/a.png")).toBe(true);
    expect(isSafeImageSrc("http://example.com/a.png")).toBe(true);
    expect(isSafeImageSrc(PNG)).toBe(true);
    expect(isSafeImageSrc("data:image/svg+xml;base64,PHN2Zy8+")).toBe(true);
  });

  it("refuses everything else, so nothing else reaches the img element", () => {
    const bad = [
      undefined,
      "",
      "javascript:alert(1)",
      "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
      "data:image/svg+xml;utf8,<svg onload=alert(1)>",
      'data:image/png;base64,AAA" onload="alert(1)',
      "//example.com/a.png",
      "file:///etc/passwd",
    ];
    for (const value of bad) {
      expect(isSafeImageSrc(value), `${String(value)} was allowed`).toBe(false);
    }
  });
});
