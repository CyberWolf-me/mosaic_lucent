import {
  applyLayout,
  applyRoutes,
  computeLayoutWithRoutes,
  lensFor,
  parseWorkspace,
  parseWorkspaceOrDefault,
  relayoutRegionWithRoutes,
  starterFor,
  type DiagramKind,
  type Operation,
  type Workspace,
} from "@lucent/core";
import { pushRegionNeighbors } from "./diagram/regionGrowth.js";
import { settingsStore } from "./settings.js";
import type { CanvasLens, Proposal } from "./workspaceTypes.js";
import type { ServerProposal } from "./boards.js";

/**
 * The lens follows the kind (V4). A family whose registry entry names a lens
 * is only readable through it, so when the board's kind changes, the lens moves.
 */
export function lensForKindChange(
  prevKind: DiagramKind | undefined,
  nextKind: DiagramKind,
  currentLens: CanvasLens,
): CanvasLens {
  if (prevKind === nextKind) return currentLens;
  const nextLens = lensFor(nextKind);
  if (nextLens) {
    if (prevKind === undefined) return currentLens === "visual" ? nextLens : currentLens;
    return nextLens;
  }
  const prevLens = prevKind === undefined ? undefined : lensFor(prevKind);
  return prevLens !== undefined && currentLens === prevLens ? "visual" : currentLens;
}

/** Whether the board is blank for "Convert board to…". */
export function boardIsBlank(ws: Workspace): boolean {
  return (
    Object.keys(ws.nodes).length === 0 &&
    Object.keys(ws.groups).length === 0 &&
    Object.keys(ws.shapes).length === 0
  );
}

/** The operations "Convert board to <kind>" applies. */
export function convertBoardOps(
  ws: Workspace,
  kind: DiagramKind,
  idPrefix: string,
): { ops: Operation[]; seeded: boolean } {
  if (boardIsBlank(ws)) return { ops: starterFor(kind, idPrefix), seeded: true };
  return { ops: [{ op: "TRANSFORM_DIAGRAM", to: kind }], seeded: false };
}

/** Review-gate threshold from settings (UX-1): always=>0, large=>5, never=>Infinity. */
/** An undo/redo that removes at least this many objects asks for a yes first. */
export const LARGE_UNDO_OBJECTS = 5;

/** What applying `ops` would take off the board — the size of an undo or redo. */
export function removalOf(ops: readonly Operation[]): {
  objects: number;
  nodes: number;
  shapes: number;
  links: number;
} {
  let nodes = 0;
  let shapes = 0;
  let wireframes = 0;
  let links = 0;
  for (const op of ops) {
    if (op.op === "DELETE_NODE") nodes++;
    else if (op.op === "DELETE_SHAPE") shapes++;
    else if (op.op === "DELETE_WIREFRAME") wireframes++;
    else if (op.op === "DISCONNECT_NODES" || op.op === "DISCONNECT_SHAPES") links++;
  }
  return { objects: nodes + shapes + wireframes, nodes, shapes, links };
}

export function proposalThreshold(): number {
  const mode = settingsStore.get().approvalThreshold;
  if (mode === "always") return 0;
  if (mode === "never") return Infinity;
  return 5;
}

export function laidOut(ws: Workspace): Workspace {
  const { layout, routes } = computeLayoutWithRoutes(ws);
  return applyRoutes(applyLayout(ws, layout), routes);
}

/** What the synchronous pass decided — the async refinement's instruction. */
export interface LayoutScope {
  kind: "region" | "board";
  groupId?: string;
}

/** Spatial additivity commit path (M2). */
export function laidOutScoped(
  ws: Workspace,
  touched: ReadonlySet<string>,
): { ws: Workspace; scope: LayoutScope } {
  const full = (): { ws: Workspace; scope: LayoutScope } => ({
    ws: laidOut(ws),
    scope: { kind: "board" },
  });
  if (touched.size === 0) return full();
  const groupIds = new Set<string>();
  for (const id of touched) {
    const g = ws.nodes[id]?.groupId ?? ws.groups[id]?.id;
    if (!g) return full();
    groupIds.add(g);
  }
  if (groupIds.size !== 1) return full();
  const groupId = [...groupIds][0];
  if (!groupId) return full();
  const regionResult = relayoutRegionWithRoutes(ws, groupId);
  if (!regionResult) return full();
  let next = applyRoutes(applyLayout(ws, regionResult.layout), regionResult.routes);
  next = pushRegionNeighbors(next, groupId);
  return { ws: next, scope: { kind: "region", groupId } };
}

/** Node/group ids a batch creates or modifies. */
export function touchedIdsOf(ops: readonly Operation[]): Set<string> {
  const touched = new Set<string>();
  for (const op of ops) {
    switch (op.op) {
      case "CREATE_NODE":
      case "DELETE_NODE":
      case "CHANGE_TEXT":
      case "CHANGE_NODE_TYPE":
      case "SET_ISSUE":
      case "UPDATE_ISSUE":
      case "SET_STATEMENT":
      case "UPDATE_STATEMENT":
      case "MOVE_NODE":
      case "CONNECT_NODES":
      case "DISCONNECT_NODES": {
        if ("id" in op && typeof op.id === "string") touched.add(op.id);
        if ("source" in op && typeof op.source === "string") touched.add(op.source);
        if ("target" in op && typeof op.target === "string") touched.add(op.target);
        break;
      }
      case "CREATE_GROUP":
      case "DELETE_GROUP":
      case "SET_GROUP_KIND":
        touched.add(op.id);
        break;
      case "TRANSFORM_DIAGRAM":
        return new Set();
      default:
        break;
    }
  }
  return touched;
}

/** Whether a batch contains operations that alter semantic graph topology or layout. */
export function opsNeedLayout(ops: readonly Operation[]): boolean {
  for (const op of ops) {
    switch (op.op) {
      case "CREATE_NODE":
      case "DELETE_NODE":
      case "CHANGE_TEXT":
      case "CHANGE_NODE_TYPE":
      case "SET_ISSUE":
      case "UPDATE_ISSUE":
      case "SET_STATEMENT":
      case "UPDATE_STATEMENT":
      case "CONNECT_NODES":
      case "DISCONNECT_NODES":
      case "CREATE_GROUP":
      case "DELETE_GROUP":
      case "SET_GROUP_KIND":
      case "TRANSFORM_DIAGRAM":
        return true;
      default:
        break;
    }
  }
  return false;
}

export function withDefaults(ws: unknown): Workspace {
  return parseWorkspaceOrDefault(ws, "loaded workspace");
}

export function reviewWorkspace(
  value: unknown,
  what: string,
): { workspace: Workspace | null; error: string | null } {
  const parsed = parseWorkspace(value);
  if (parsed.ok && parsed.workspace) return { workspace: parsed.workspace, error: null };
  return {
    workspace: null,
    error: `${what} isn't a valid Lucent board: ${parsed.detail ?? "unrecognised format"}`,
  };
}

export function serverProposalToPanel(server: ServerProposal): Proposal {
  return {
    id: server.id,
    request: server.request,
    operations: server.operations as Operation[],
    explanation: server.explanation ?? "",
    meetingId: server.meetingId,
    ...(server.provenance?.quote ? { turns: [server.provenance.quote] } : {}),
    ...(server.provenance?.turnRange ? { turnRange: server.provenance.turnRange } : {}),
    ...(server.provenance?.turnKinds?.length ? { turnKinds: server.provenance.turnKinds } : {}),
    status: server.status,
    createdAt: server.createdAt,
  };
}

export function stripInviteFromUrl(): void {
  const url = new URL(window.location.href);
  if (!url.searchParams.has("invite")) return;
  url.searchParams.delete("invite");
  window.history.replaceState({}, "", url.toString());
}

export function stripBoardFromUrl(): void {
  const url = new URL(window.location.href);
  if (!url.searchParams.has("board")) return;
  url.searchParams.delete("board");
  window.history.replaceState({}, "", url.toString());
}
