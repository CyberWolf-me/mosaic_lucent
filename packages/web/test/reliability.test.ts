import { describe, it, expect, beforeEach, vi } from "vitest";
import { applyOperations, createWorkspace } from "@lucent/core";
import { buildBoardSvg } from "../src/board/geometry.js";
import { loadLastOpenProject, saveProject, setLastOpenProject } from "../src/persistence.js";

/**
 * Two checklist gaps that looked like data loss:
 *  - reloading always booted an empty board, so saved work appeared gone;
 *  - image and embed shapes were silently dropped from SVG/PNG/PDF export.
 */

// Minimal localStorage for the node test environment.
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

describe("restore the last open project", () => {
  beforeEach(() => {
    installStorage();
  });

  it("returns null on a first run", () => {
    expect(loadLastOpenProject()).toBeNull();
  });

  it("restores the project that was last open", () => {
    const ws = applyOperations(createWorkspace(), [
      { op: "CREATE_NODE", id: "a", nodeType: "service", label: "Kept" },
    ]);
    saveProject({ id: "p_1", name: "My board", workspace: ws, chat: [] });
    setLastOpenProject("p_1");

    const restored = loadLastOpenProject();
    expect(restored?.id).toBe("p_1");
    expect(restored?.name).toBe("My board");
    expect(restored?.workspace.nodes.a?.label).toBe("Kept");
  });

  it("restores the conversation alongside the board", () => {
    saveProject({
      id: "p_2",
      name: "Chatty",
      workspace: createWorkspace(),
      chat: [{ role: "user", text: "build a flow" }],
    });
    setLastOpenProject("p_2");
    expect(loadLastOpenProject()?.chat).toEqual([{ role: "user", text: "build a flow" }]);
  });

  it("falls back to the newest project when the pointer is stale", () => {
    saveProject({ id: "p_3", name: "Newest", workspace: createWorkspace(), chat: [] });
    setLastOpenProject("p_deleted");
    expect(loadLastOpenProject()?.id).toBe("p_3");
  });

  it("forgets the pointer when cleared", () => {
    saveProject({ id: "p_4", name: "X", workspace: createWorkspace(), chat: [] });
    setLastOpenProject("p_4");
    setLastOpenProject(null);
    // The saved project is still the newest, so the fallback still finds it —
    // clearing the pointer must not throw or wipe data.
    expect(loadLastOpenProject()?.id).toBe("p_4");
  });
});

describe("export fidelity", () => {
  const pngSafe = "data:image/png;base64,iVBORw0KGgo=";

  function boardWith(kind: "image" | "embed" | "file", extra: Record<string, unknown> = {}) {
    return applyOperations(createWorkspace(), [
      {
        op: "CREATE_SHAPE",
        id: "s1",
        kind,
        position: { x: 0, y: 0 },
        size: { width: 100, height: 80 },
        ...extra,
      } as never,
    ]);
  }

  it("embeds a data-URL image in the SVG", () => {
    const svg = buildBoardSvg(boardWith("image", { src: pngSafe }));
    expect(svg).toContain("<image");
    expect(svg).toContain("iVBORw0KGgo=");
  });

  it("draws a placeholder for a remote image instead of dropping it", () => {
    const svg = buildBoardSvg(boardWith("image", { src: "https://example.com/a.png" }));
    expect(svg).toContain("Linked image");
  });

  it("renders an embed placeholder rather than nothing", () => {
    const svg = buildBoardSvg(boardWith("embed", { src: "https://youtube.com/embed/x" }));
    expect(svg).toContain("▶");
  });

  it("renders a file chip with its name", () => {
    const svg = buildBoardSvg(boardWith("file", { text: "spec.pdf" }));
    expect(svg).toContain("spec.pdf");
  });

  it("wraps long sticky text across lines", () => {
    const ws = applyOperations(createWorkspace(), [
      {
        op: "CREATE_SHAPE",
        id: "n1",
        kind: "sticky",
        position: { x: 0, y: 0 },
        size: { width: 150, height: 110 },
        text: "This is a deliberately long sticky note that must wrap across several lines in the export",
      },
    ]);
    const svg = buildBoardSvg(ws);
    // More than one <text> element means the string was broken into lines.
    expect((svg.match(/<text/g) ?? []).length).toBeGreaterThan(1);
  });

  it("escapes quotes so a hostile label cannot break out of an attribute", () => {
    const ws = applyOperations(createWorkspace(), [
      {
        op: "CREATE_SHAPE",
        id: "x1",
        kind: "image",
        position: { x: 0, y: 0 },
        size: { width: 10, height: 10 },
        src: 'data:image/png;base64,AAA" onload="alert(1)',
      },
    ]);
    const svg = buildBoardSvg(ws);
    expect(svg).not.toContain('onload="alert(1)"');
    expect(svg).toContain("&quot;");
  });

  it("still reports an empty board", () => {
    expect(buildBoardSvg(createWorkspace())).toContain("Empty board");
  });
});
