import type { Workspace } from "@lucent/core";
import { buildBoardSvg, escapeAttr } from "./geometry.js";

/**
 * Presentations from frames (docs/26 §6.1). Every frame on the board is a
 * slide: Present steps through them, and "Slides PDF" prints one page per
 * frame at the frame's own size. There is no separate deck to keep in sync —
 * the slides are the board.
 *
 * Order: when every frame's name starts with a number ("1 Intro",
 * "2. Problem"), by that number; otherwise reading order — rows from top to
 * bottom, left to right within a row, where a frame starting less than half
 * its height below a row's top belongs to that row.
 */

export interface Slide {
  id: string;
  title: string;
  box: { x: number; y: number; width: number; height: number };
}

const NUMBERED = /^\s*(\d{1,3})(?:[.):\-\s]|$)/;

export function slidesOf(workspace: Workspace): Slide[] {
  const frames = Object.values(workspace.shapes)
    .filter((s) => s.kind === "frame" && !s.hidden)
    .map((s) => ({
      id: s.id,
      title: (s.text ?? "").trim(),
      box: { x: s.position.x, y: s.position.y, width: s.size.width, height: s.size.height },
    }));
  // Reading order: rows by top edge, then left to right.
  const byTop = [...frames].sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
  const rows: Slide[][] = [];
  for (const f of byTop) {
    const row = rows[rows.length - 1];
    const top = row ? Math.min(...row.map((r) => r.box.y)) : 0;
    const reach = row ? Math.min(...row.map((r) => r.box.height), f.box.height) / 2 : 0;
    if (row && f.box.y < top + reach) row.push(f);
    else rows.push([f]);
  }
  const reading = rows.flatMap((row) => row.sort((a, b) => a.box.x - b.box.x));
  const numbers = reading.map((f) => NUMBERED.exec(f.title)?.[1]);
  if (reading.length > 0 && numbers.every((n) => n !== undefined)) {
    return reading
      .map((f, i) => ({ f, n: Number(numbers[i]), i }))
      .sort((a, b) => a.n - b.n || a.i - b.i)
      .map(({ f }) => f);
  }
  return reading;
}

/**
 * The print document for "Slides PDF": one page per slide, each page the
 * frame's own size (a named @page per slide), each drawn by the board export
 * cropped to its frame. Same sandboxed-srcdoc route as the board PDF, so the
 * browser's "Save as PDF" makes the file — no PDF library. `autoPrint` is off
 * only for tests that render the document themselves.
 */
export function buildSlidesDocument(
  workspace: Workspace,
  slides: Slide[],
  title: string,
  autoPrint = true,
): string {
  const css: string[] = [];
  const pages: string[] = [];
  slides.forEach((s, i) => {
    const w = Math.max(1, Math.round(s.box.width));
    const h = Math.max(1, Math.round(s.box.height));
    css.push(
      `@page s${i}{size:${w}px ${h}px;margin:0}.s${i}{page:s${i};width:${w}px;height:${h}px}`,
    );
    pages.push(
      `<section class="slide s${i}" aria-label="${escapeAttr(s.title || `Slide ${i + 1}`)}">${buildBoardSvg(workspace, 0, s.id)}</section>`,
    );
  });
  return (
    `<!doctype html><html><head><title>${escapeAttr(title || "lucent-slides")}</title>` +
    `<style>*{margin:0;padding:0}html,body{background:#141416}.slide{overflow:hidden;break-after:page}.slide:last-child{break-after:auto}.slide svg{display:block;width:100%;height:100%}${css.join("")}</style>` +
    `</head><body>${pages.join("")}${autoPrint ? "<script>window.onload=()=>{window.print();}</script>" : ""}</body></html>`
  );
}
