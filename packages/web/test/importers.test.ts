import { describe, it, expect } from "vitest";
import { applyOperations, createWorkspace, validateOperations } from "@lucent/core";
import {
  classifyImport,
  documentToBlocks,
  documentToOps,
  pdfIsCompressed,
  pdfToBlocks,
  pdfToOps,
  svgToOps,
  collectAttachments,
} from "../src/board/importers.js";
import { Z_MAX } from "../src/shapes.js";

/**
 * Imports produce operations, so a file lands as one undoable commit and every
 * imported object is a real editable shape — not a picture of one.
 */

const apply = (ops: Parameters<typeof applyOperations>[1]) =>
  applyOperations(createWorkspace(), ops);

describe("classifyImport", () => {
  it("classifies by extension", () => {
    expect(classifyImport("board.json")).toBe("json");
    expect(classifyImport("rows.csv")).toBe("csv");
    expect(classifyImport("art.SVG")).toBe("svg");
    expect(classifyImport("spec.pdf")).toBe("pdf");
    expect(classifyImport("notes.md")).toBe("document");
    expect(classifyImport("shot.png")).toBe("image");
  });

  it("falls back to the MIME type when the name has no useful extension", () => {
    expect(classifyImport("blob", "image/png")).toBe("image");
    expect(classifyImport("blob", "application/pdf")).toBe("pdf");
    expect(classifyImport("blob", "text/plain")).toBe("document");
  });

  it("reports unknown rather than guessing", () => {
    expect(classifyImport("mystery.xyz")).toBe("unknown");
    expect(classifyImport("mystery")).toBe("unknown");
  });
});

describe("document import", () => {
  const doc = `# Project brief

Ship the refund flow by Q3.

- Support triages the request
- Finance approves the refund

## Risks
A very long paragraph ${"x".repeat(400)} end.`;

  it("splits prose into board-sized blocks", () => {
    const blocks = documentToBlocks(doc);
    expect(blocks).toContain("Project brief");
    expect(blocks).toContain("Ship the refund flow by Q3.");
    expect(blocks).toContain("Support triages the request");
  });

  it("strips Markdown decoration so notes read as content", () => {
    const blocks = documentToBlocks("# Heading\n\n- item one");
    expect(blocks).toEqual(["Heading", "item one"]);
  });

  it("clips a very long paragraph instead of making a wall of text", () => {
    const long = documentToBlocks(doc).find((b) => b.length > 200);
    expect(long?.length).toBeLessThanOrEqual(220);
    expect(long?.endsWith("…")).toBe(true);
  });

  it("produces valid sticky operations that the engine accepts", () => {
    const ops = documentToOps(doc);
    expect(ops.length).toBeGreaterThan(2);
    expect(validateOperations(createWorkspace(), ops)).toHaveLength(0);
    const ws = apply(ops);
    expect(Object.values(ws.shapes).every((s) => s.kind === "sticky")).toBe(true);
  });

  it("lays notes out in a grid rather than stacking them", () => {
    const ws = apply(documentToOps("one\n\ntwo\n\nthree"));
    const positions = Object.values(ws.shapes).map((s) => `${s.position.x},${s.position.y}`);
    expect(new Set(positions).size).toBe(positions.length);
  });

  it("returns nothing for an empty document", () => {
    expect(documentToOps("   \n\n  ")).toEqual([]);
  });

  it("keeps z inside the CSS-legal band", () => {
    for (const op of documentToOps("a\n\nb")) {
      if (op.op === "CREATE_SHAPE") expect(op.z).toBeLessThanOrEqual(Z_MAX);
    }
  });
});

describe("PDF import", () => {
  // A minimal text-bearing PDF content stream.
  const pdf = `%PDF-1.4
4 0 obj
<< /Length 120 >>
stream
BT /F1 12 Tf 72 720 Td (Refund policy) Tj ET
BT /F1 10 Tf 72 700 Td [(Approve within ) -20 (14 days)] TJ ET
endstream
endobj`;

  it("extracts text from Tj and TJ operators", () => {
    const blocks = pdfToBlocks(pdf);
    const joined = blocks.join(" ");
    expect(joined).toContain("Refund policy");
    expect(joined).toContain("Approve within 14 days");
  });

  it("unescapes PDF string escapes", () => {
    expect(pdfToBlocks(String.raw`BT (a\(b\) c) Tj ET`).join(" ")).toContain("a(b) c");
  });

  it("produces valid sticky operations", () => {
    const ops = pdfToOps(pdf);
    expect(ops.length).toBeGreaterThan(0);
    expect(validateOperations(createWorkspace(), ops)).toHaveLength(0);
  });

  it("detects a compressed PDF so the caller can report it honestly", () => {
    expect(pdfIsCompressed("<< /Filter /FlateDecode >>")).toBe(true);
    expect(pdfIsCompressed(pdf)).toBe(false);
  });

  it("returns nothing when there is no extractable text", () => {
    expect(pdfToBlocks("%PDF-1.4 no text operators here")).toEqual([]);
    expect(pdfToOps("%PDF-1.4")).toEqual([]);
  });
});

describe("SVG import (docs/26 V2: one editable vector)", () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300">
    <rect x="10" y="20" width="120" height="60" rx="8" fill="#f5c542" stroke="#333" stroke-width="2"/>
    <circle cx="200" cy="100" r="40" fill="#5599ff"/>
    <ellipse cx="300" cy="200" rx="50" ry="30" fill="none" stroke="#0a0"/>
    <line x1="10" y1="250" x2="110" y2="290" stroke="#000"/>
    <text x="20" y="120" font-size="16">Hello board</text>
    <path d="M 5 5 L 60 40 L 5 40 Z" fill="#eee"/>
  </svg>`;

  it("lands as one vector shape holding every drawable element, not an image", () => {
    const ws = apply(svgToOps(svg));
    const shapes = Object.values(ws.shapes);
    expect(shapes).toHaveLength(1);
    expect(shapes[0]!.kind).toBe("vector");
    expect(shapes[0]!.vector?.paths).toHaveLength(5);
    expect(shapes[0]!.vector?.viewBox).toEqual([0, 0, 400, 300]);
  });

  it("keeps paint and geometry: fill, stroke and width, fill=none, exact path data", () => {
    const paths = Object.values(apply(svgToOps(svg)).shapes)[0]!.vector!.paths;
    expect(paths[0]).toMatchObject({ fill: "#f5c542", stroke: "#333", strokeWidth: 2 });
    expect(paths[2]).toMatchObject({ fill: "none", stroke: "#0a0" });
    expect(paths[4]).toMatchObject({ d: "M5 5L60 40L5 40Z", fill: "#eee" });
  });

  it("sizes the shape from the file, fitted to the board", () => {
    const shape = Object.values(apply(svgToOps(svg)).shapes)[0]!;
    expect(shape.size).toEqual({ width: 320, height: 240 });
  });

  it("imports nothing when nothing drawable survives", () => {
    expect(svgToOps("<svg><text>only words</text></svg>")).toEqual([]);
    expect(svgToOps("<svg><script>alert(1)</script></svg>")).toEqual([]);
  });

  it("stacks the import above what is already there", () => {
    const [op] = svgToOps(svg, [{ z: 7 }]);
    expect(op).toMatchObject({ z: 8 });
  });
});

describe("collectAttachments", () => {
  const board = {
    shapes: {
      img: { id: "img", kind: "image", src: "data:image/png;base64,iVBORw0KGgo=" },
      remote: { id: "remote", kind: "image", src: "https://example.com/a.png" },
      weird: { id: "weird", kind: "image", src: "data:image/tiff;base64,AAAA" },
      note: { id: "note", kind: "sticky", text: "x".repeat(80) },
      short: { id: "short", kind: "sticky", text: "hi" },
    },
  };

  it("turns a selected data-URL image into a vision attachment", () => {
    const out = collectAttachments(board, ["img"]);
    expect(out.images).toEqual([{ data: "iVBORw0KGgo=", mediaType: "image/png" }]);
  });

  it("never asks the provider to fetch a remote image", () => {
    expect(collectAttachments(board, ["remote"]).images).toBeUndefined();
  });

  it("skips a media type the providers do not accept", () => {
    expect(collectAttachments(board, ["weird"]).images).toBeUndefined();
  });

  it("sends a long note as a document", () => {
    const out = collectAttachments(board, ["note"]);
    expect(out.documents?.[0]?.name).toBe("note");
  });

  it("ignores a short label, which is already in the board summary", () => {
    expect(collectAttachments(board, ["short"]).documents).toBeUndefined();
  });

  it("returns nothing for an empty selection or unknown ids", () => {
    expect(collectAttachments(board, [])).toEqual({});
    expect(collectAttachments(board, ["ghost"])).toEqual({});
  });
});
