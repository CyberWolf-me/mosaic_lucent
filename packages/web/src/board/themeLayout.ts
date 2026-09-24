import type { Operation, Shape, Workspace } from "@lucent/core";

/**
 * Lay a theme sort out (docs/27 D2): one titled frame per theme, its stickies
 * in a tidy grid inside, the frames in rows starting where the stickies were.
 * The model named the themes and chose who belongs where; every coordinate
 * comes from here, deterministically (docs/03 — LLMs are poor at space).
 */

export const THEME_LAYOUT = { pad: 24, title: 44, gap: 16, frameGap: 56, maxCols: 4 } as const;

export interface ThemeSort {
  themes: Array<{ title: string; items: number[] }>;
}

/**
 * The stickies a sort may move: selected, unlocked, visible, with something
 * written on them — in selection order, which is the index order the sort
 * answers in.
 */
export function sortableStickies(ws: Workspace, selected: Iterable<string>): Shape[] {
  const out: Shape[] = [];
  for (const id of selected) {
    const s = ws.shapes[id];
    if (s && s.kind === "sticky" && !s.locked && !s.hidden && s.text?.trim()) out.push(s);
  }
  return out;
}

export function planThemeLayout(
  stickies: Shape[],
  sort: ThemeSort,
  newId: () => string,
): Operation[] {
  if (stickies.length === 0 || sort.themes.length === 0) return [];
  const { pad, title, gap, frameGap, maxCols } = THEME_LAYOUT;
  const origin = {
    x: Math.min(...stickies.map((s) => s.position.x)),
    y: Math.min(...stickies.map((s) => s.position.y)),
  };
  // One cell size for the whole wall keeps every frame's grid aligned.
  const cell = {
    w: Math.max(...stickies.map((s) => s.size.width)),
    h: Math.max(...stickies.map((s) => s.size.height)),
  };
  const frameZ = Math.min(...stickies.map((s) => s.z ?? 0)) - 1;

  const frames = sort.themes
    .map((t) => ({
      title: t.title,
      members: t.items.map((i) => stickies[i]).filter(Boolean) as Shape[],
    }))
    .filter((f) => f.members.length > 0)
    .map((f) => {
      const cols = Math.min(maxCols, Math.ceil(Math.sqrt(f.members.length)));
      const rows = Math.ceil(f.members.length / cols);
      return {
        ...f,
        cols,
        width: pad * 2 + cols * cell.w + (cols - 1) * gap,
        height: title + pad + rows * cell.h + (rows - 1) * gap,
      };
    });

  // Frames flow in rows, about as many per row as there are rows.
  const perRow = Math.max(1, Math.ceil(Math.sqrt(frames.length)));
  const ops: Operation[] = [];
  let y = origin.y;
  for (let r = 0; r < frames.length; r += perRow) {
    const row = frames.slice(r, r + perRow);
    let x = origin.x;
    for (const f of row) {
      ops.push({
        op: "CREATE_SHAPE",
        id: newId(),
        kind: "frame",
        position: { x, y },
        size: { width: f.width, height: f.height },
        text: f.title,
        z: frameZ,
      });
      f.members.forEach((s, k) => {
        const cx = x + pad + (k % f.cols) * (cell.w + gap) + (cell.w - s.size.width) / 2;
        const cy =
          y + title + Math.floor(k / f.cols) * (cell.h + gap) + (cell.h - s.size.height) / 2;
        ops.push({
          op: "UPDATE_SHAPE",
          id: s.id,
          position: { x: Math.round(cx), y: Math.round(cy) },
        });
      });
      x += f.width + frameGap;
    }
    y += Math.max(...row.map((f) => f.height)) + frameGap;
  }
  return ops;
}
