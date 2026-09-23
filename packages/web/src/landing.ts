import type { CanvasLens, View } from "./workspace.js";
import { getViewQuery } from "./routes.js";
import { listProjects, loadProject } from "./persistence.js";

/** Every view a `?view=` deep link may name. Anything else is ignored. */
export const VALID_VIEWS: ReadonlySet<string> = new Set<View>([
  "home",
  "notifications",
  "dashboard",
  "canvas",
  "history",
  "meeting",
  "intelligence",
  "execution",
  "wireframe",
  "sequence",
  "er",
  "board",
  "document",
  "admin",
  "analytics",
]);

export const VALID_LENSES: ReadonlySet<string> = new Set<CanvasLens>([
  "visual",
  "kanban",
  "document",
  "wireframe",
  "sequence",
  "er",
]);

/**
 * Where a bare `/` lands. A returning user lands on Home — what needs them,
 * what changed — because Lucent is a workspace, not a file browser. Someone
 * with no work yet lands on the canvas hero: the first thing they should meet
 * is the core loop ("describe it, watch it appear"), not an empty dashboard.
 * A `?board=` link always opens that board.
 */
export function landingView(): View {
  if (new URLSearchParams(window.location.search).has("board")) return "canvas";
  try {
    const hasWork = listProjects()
      .slice(0, 8)
      .some((p) => {
        const ws = loadProject(p.id)?.workspace;
        if (!ws) return false;
        return Object.keys(ws.nodes).length + Object.keys(ws.shapes).length > 0;
      });
    return hasWork ? "home" : "canvas";
  } catch {
    return "canvas";
  }
}

/**
 * The view and lens the address bar asks for, resolved once.
 *
 * The workspace's view state must START here, not at a fixed "canvas": the
 * router mirrors state back into the URL on mount, so a hardcoded initial
 * view overwrote `?view=intelligence` with `?view=canvas` before the deep
 * link was ever read — and the session check's remount then read the
 * clobbered URL. Every view deep link landed on the canvas.
 */
export function initialLocation(): { view: View; lens: CanvasLens } {
  if (typeof window === "undefined") return { view: "canvas", lens: "visual" };
  const q = getViewQuery();
  const view = q.view && VALID_VIEWS.has(q.view) ? (q.view as View) : landingView();
  const lens = q.lens && VALID_LENSES.has(q.lens) ? (q.lens as CanvasLens) : "visual";
  return { view, lens };
}
