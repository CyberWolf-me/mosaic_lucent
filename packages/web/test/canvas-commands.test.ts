import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyOperations, createWorkspace } from "@lucent/core";
import {
  frameEntries,
  onCanvasCommand,
  sendCanvasCommand,
  type CanvasCommand,
} from "../src/canvasCommands.js";

/**
 * docs/26 §6.4: the palette drives the canvas's camera. A command sent while
 * the canvas is mounted is delivered at once; one sent in the same click that
 * switches to the canvas waits for it to mount — it must never be lost.
 */

beforeEach(() => {
  // The suite runs in Node: a bare EventTarget stands in for window.
  vi.stubGlobal("window", Object.assign(new EventTarget(), { setTimeout }));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("canvas commands", () => {
  it("delivers to a mounted canvas", () => {
    const got: CanvasCommand[] = [];
    const off = onCanvasCommand((c) => got.push(c));
    sendCanvasCommand({ kind: "fit" });
    sendCanvasCommand({ kind: "frame", id: "f1" });
    off();
    sendCanvasCommand({ kind: "back" });
    expect(got).toEqual([{ kind: "fit" }, { kind: "frame", id: "f1" }]);
    // The last one is held for the next canvas, not dropped.
    const later: CanvasCommand[] = [];
    const off2 = onCanvasCommand((c) => later.push(c));
    return new Promise<void>((done) =>
      setTimeout(() => {
        expect(later).toEqual([{ kind: "back" }]);
        off2();
        done();
      }, 5),
    );
  });

  it("holds a command sent before the canvas mounts, and runs it once", async () => {
    sendCanvasCommand({ kind: "frame", id: "f9" });
    const got: CanvasCommand[] = [];
    const off = onCanvasCommand((c) => got.push(c));
    await new Promise((r) => setTimeout(r, 5));
    expect(got).toEqual([{ kind: "frame", id: "f9" }]);
    off();
    const again: CanvasCommand[] = [];
    const off2 = onCanvasCommand((c) => again.push(c));
    await new Promise((r) => setTimeout(r, 5));
    expect(again).toEqual([]);
    off2();
  });
});

describe("frameEntries", () => {
  it("lists visible frames in reading order, naming untitled ones", () => {
    const ws = applyOperations(createWorkspace(), [
      {
        op: "CREATE_SHAPE",
        id: "b",
        kind: "frame",
        position: { x: 600, y: 0 },
        size: { width: 100, height: 100 },
        text: "Pricing",
      },
      {
        op: "CREATE_SHAPE",
        id: "a",
        kind: "frame",
        position: { x: 0, y: 0 },
        size: { width: 100, height: 100 },
        text: "  ",
      },
      {
        op: "CREATE_SHAPE",
        id: "c",
        kind: "frame",
        position: { x: 0, y: 400 },
        size: { width: 100, height: 100 },
        text: "Launch",
      },
      {
        op: "CREATE_SHAPE",
        id: "h",
        kind: "frame",
        position: { x: 0, y: 800 },
        size: { width: 100, height: 100 },
        text: "Hidden",
        hidden: true,
      },
      {
        op: "CREATE_SHAPE",
        id: "r",
        kind: "rect",
        position: { x: 0, y: 900 },
        size: { width: 10, height: 10 },
        text: "Not a frame",
      },
    ]);
    expect(frameEntries(ws)).toEqual([
      { id: "a", title: "Frame 1" },
      { id: "b", title: "Pricing" },
      { id: "c", title: "Launch" },
    ]);
  });
});
