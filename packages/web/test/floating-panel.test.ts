import { afterEach, describe, expect, it, vi } from "vitest";
import { EDGE, clampToViewport, loadPosition, savePosition } from "../src/ui/floatingPanel.js";

/**
 * The movable tool palette: wherever it's dragged it stays on screen, and
 * where it was put is remembered in this browser — or quietly forgotten when
 * storage is blocked, never breaking the board.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

function memoryStorage() {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  return store;
}

describe("clampToViewport", () => {
  const size = { width: 600, height: 44 };
  const viewport = { width: 1440, height: 900 };

  it("leaves a spot on screen alone, and rounds it", () => {
    expect(clampToViewport({ x: 300.4, y: 500.6 }, size, viewport)).toEqual({ x: 300, y: 501 });
  });

  it("keeps the whole panel in, EDGE px from every side", () => {
    expect(clampToViewport({ x: -200, y: -50 }, size, viewport)).toEqual({ x: EDGE, y: EDGE });
    expect(clampToViewport({ x: 5000, y: 5000 }, size, viewport)).toEqual({
      x: 1440 - 600 - EDGE,
      y: 900 - 44 - EDGE,
    });
  });

  it("a panel wider than the window sits at the left edge", () => {
    expect(clampToViewport({ x: 300, y: 10 }, { width: 2000, height: 44 }, viewport).x).toBe(EDGE);
  });
});

describe("remembering where it was put", () => {
  it("saves, loads, and forgets", () => {
    const store = memoryStorage();
    savePosition("k", { x: 120, y: 640 });
    expect(loadPosition("k")).toEqual({ x: 120, y: 640 });
    savePosition("k", null);
    expect(store.has("k")).toBe(false);
    expect(loadPosition("k")).toBeNull();
  });

  it("ignores anything that isn't a position", () => {
    const store = memoryStorage();
    for (const junk of ["not json", '{"x":"1","y":2}', '{"x":1}', "null", '{"x":1e999,"y":0}']) {
      store.set("k", junk);
      expect(loadPosition("k"), junk).toBeNull();
    }
  });

  it("blocked storage means no memory, not an error", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("SecurityError");
      },
      removeItem: () => {
        throw new Error("SecurityError");
      },
    });
    expect(loadPosition("k")).toBeNull();
    expect(() => savePosition("k", { x: 1, y: 2 })).not.toThrow();
  });
});
