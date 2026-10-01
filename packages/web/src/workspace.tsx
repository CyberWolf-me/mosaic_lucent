import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { gatePlanOps } from "./planGate.js";
import {
  OperationHistory,
  applyLayout,
  applyOperations,
  applyRoutes,
  applyValidOperations,
  attachPlanProvenance,
  attachProvenance,
  computeLayoutWithRoutes,
  createWorkspace,
  existingTopics,
  foldStatementTopics,
  stampTrust,
  withEditTrust,
  isConversationOnly,
  lensFor,
  parseWorkspace,
  parseWorkspaceOrDefault,
  relayoutRegionWithRoutes,
  representationLabel,
  starterFor,
  validateOperations,
  type DiagramKind,
  type Operation,
  type RepresentationLens,
  type Workspace,
} from "@lucent/core";
import { streamGenerate, PlanRefusalError } from "./api.js";
import {
  elkEligible,
  elkRegionEligible,
  layoutBoard,
  relayoutRegionScoped,
} from "./diagram/layoutService.js";
import { WORKER_ELK_ENGINE } from "./diagram/elk/index.js";
import { pushRegionNeighbors } from "./diagram/regionGrowth.js";
import { classifyTurn } from "./meetings.js";
import { BoardSync, type Peer, type Spotlight, type Viewport } from "./boardSync.js";
import {
  createServerProposal,
  decideServerProposal,
  fetchBoard,
  joinBoard,
  listServerProposals,
  saveBoard,
  askLucent,
  type BoardRole,
  type ServerProposal,
} from "./boards.js";
import {
  appendThread,
  askLocalBoard,
  clearThread,
  loadThread,
  threadScope,
} from "./workspaceAsk.js";
import { loadOrgs } from "./orgs.js";
import { getSessionUser, hasSession } from "./session.js";
import {
  archiveDecision,
  getSharedBoardId,
  loadLastOpenProject,
  loadProject,
  mirrorProjectId,
  newProjectId,
  uniqueProjectName,
  newProposalId,
  onStorageError,
  openProposalIn,
  proposalIsPending,
  saveProject,
  setLastOpenProject,
  setSharedBoardId,
  type ChatEntry,
  type PersistedProposal,
} from "./persistence.js";
import { settingsStore } from "./settings.js";
import { initialLocation } from "./landing.js";
import { turnEffect } from "./turnEffect.js";

/**
 * Central workspace state: the real @lucent/core Workspace + History, the
 * conversation, and the pending AI proposal. Replaces the prototype's
 * window.__lucentGo globals with typed React context. All coordinates come from
 * computeLayout — the AI never sets them (docs/03, docs/11).
 */

export type View =
  | "home"
  | "dashboard"
  | "canvas"
  | "history"
  | "meeting"
  | "meetings"
  | "projects"
  | "review"
  | "intelligence"
  | "execution"
  | "wireframe"
  | "sequence"
  | "er"
  | "board"
  | "document"
  | "admin"
  | "analytics"
  | "notifications";

/** Views that are really canvas lenses (UX-1), and the lens each one means. */
const LEGACY_LENS_VIEWS: Partial<Record<View, CanvasLens>> = {
  board: "kanban",
  document: "document",
  wireframe: "wireframe",
  sequence: "sequence",
  er: "er",
};

/** Canvas sub-state is derived from the data, not stored separately. */
export type CanvasPhase = "empty" | "generating" | "main" | "proposing" | "voice";

/**
 * Canvas lenses (UX-1): alternate renderings of the same board on the canvas.
 * The registry's family lenses (sequence, ER) are part of the union by type,
 * so a family that gains a lens in the registry is a lens here too.
 */
export type CanvasLens = "visual" | "kanban" | "document" | "wireframe" | RepresentationLens;

/**
 * The lens follows the kind (V4). A family whose registry entry names a lens
 * (a sequence diagram, an ER diagram) is only readable through it, so when the
 * board's kind changes — the user converts it, the AI creates one, a peer
 * converts it, a board is opened — the lens moves with it:
 *
 *  - arriving at a kind with a lens presents that lens;
 *  - leaving one returns to the visual canvas, but ONLY when the lens on
 *    screen is the one the old kind implied — kanban, document or wireframe
 *    is the person's own choice, and a conversion never overrides it;
 *  - `prevKind` undefined is the board's first appearance (boot): its lens
 *    replaces only the default visual lens, so a `?lens=` deep link wins.
 *
 * Pure so the rule is tested without a provider; the provider calls it once
 * per kind change, during render, so the canvas never paints a frame of a
 * sequence board as boxes-and-arrows before switching.
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

/**
 * Whether the board is blank for the purpose of "Convert board to…": no
 * nodes, no groups (empty swimlanes or matrix cells are structure someone
 * built) and no manual shapes (stickies are content too — seeding a starter
 * among them would drop an example into someone's notes). Converting a blank
 * board seeds the family's starter instead of switching the kind of nothing.
 */
export function boardIsBlank(ws: Workspace): boolean {
  return (
    Object.keys(ws.nodes).length === 0 &&
    Object.keys(ws.groups).length === 0 &&
    Object.keys(ws.shapes).length === 0
  );
}

/**
 * The operations "Convert board to <kind>" applies: on a blank board the
 * family's registry starter (a minimal, editable example — so picking "State
 * machine" on an empty board shows a state machine, including when that is
 * already the board's kind), otherwise one TRANSFORM_DIAGRAM that keeps every
 * node and edge and re-lays them out in the new geometry. `idPrefix`
 * namespaces the starter's ids; the caller passes a fresh one per insert.
 */
export function convertBoardOps(
  ws: Workspace,
  kind: DiagramKind,
  idPrefix: string,
): { ops: Operation[]; seeded: boolean } {
  if (boardIsBlank(ws)) return { ops: starterFor(kind, idPrefix), seeded: true };
  return { ops: [{ op: "TRANSFORM_DIAGRAM", to: kind }], seeded: false };
}

/** Realtime link state. "offline" covers both signed-out and disconnected. */
export type SyncStatus = "offline" | "connecting" | "online";

import type { ProposalStatus } from "./persistence.js";

/**
 * A review-gate proposal. One shape for the live state AND the persisted
 * record (2026-09: persisting proposals is the reliability fix — a refresh
 * used to drop the AI's proposed ops while the chat reply describing them
 * survived, which read as Lucent losing work). `status` is `"pending"`
 * whenever the panel is open; decide/transition helpers in persistence.ts
 * keep every change idempotent. The active slot on the project record is
 * the current-or-most-recently-decided record; terminal ones are the audit
 * trail in `proposalHistory`.
 */
export interface Proposal {
  request: string;
  operations: Operation[];
  explanation: string;
  /**
   * Meeting provenance, when this batch came from live capture: stamped onto
   * whatever it creates at apply time, so the board can always answer "why
   * is this here?".
   */
  meetingId: string | null;
  /** The source turns, quoted, when the proposal came from meeting capture. */
  turns?: string[];
  /** Stable index range of those turns in the meeting (Stage A provenance). */
  turnRange?: [number, number];
  /** Kinds of the source turns, when the capture classified them. */
  turnKinds?: string[];
  /** Stable across saves; a new proposal mints a new id. */
  id: string;
  status: ProposalStatus;
  createdAt: number;
}

/** Files the user attached to a request: images to look at, documents to read. */
export interface SendAttachments {
  images?: Array<{ data: string; mediaType: string }>;
  documents?: Array<{ name: string; text: string }>;
  /**
   * Provenance to stamp on whatever this request creates (M2). Meeting
   * extraction passes its transcript id and the turns' span, so every node
   * the model adds from the conversation can answer "why is this here?"
   * — the board's audit trail for AI-generated content.
   *
   * Stage A: `turns` gains stable per-turn references alongside the quoted
   * text. The quote is presentation (it changes if transcript normalization
   * changes); the ids/range are the durable link — and they are what a later
   * reverse navigation (open a transcript turn, jump back to the object it
   * created) keys on, so the data is shaped for that now.
   */
  provenance?: {
    meetingId: string;
    /** Turn texts that fed this request, quoted in the provenance record. */
    turns: string[];
    /** Stable references to those turns — the index range in the meeting. */
    turnRange?: [number, number];
    /** Kinds of the source turns (decision / proposal / …) when classified. */
    turnKinds?: string[];
  };
  /**
   * Stage D2: this request is a PLAN derived from the named statement nodes.
   * Present → the model's ops are gated against PLAN_SAFE_OPS (no lifecycle
   * conversion — the acceptance rule is mechanical) and every created node is
   * stamped with createdFrom (the source statement ids) through
   * attachPlanProvenance — the fourth provenance writer, exactly where the
   * meeting loop already stamps its evidence.
   */
  plan?: { statementIds: string[] };
  /** Where the person asked, when it wasn't typed on the canvas (ADR 0047's run record). */
  surface?: "voice";
  /**
   * docs/27 D2: this request's result is ALWAYS a proposal, whatever its
   * size and however empty the board — "make these stickies a flowchart"
   * restructures the person's own content, so they review it first.
   */
  propose?: boolean;
}

/** UX-2: user-facing generation phases (stream chars are display-only detail). */
export type GenPhase = "understanding" | "constructing" | "validating" | "applying";

/**
 * What a `send` actually did (P1-MT-002) — the honest terminal states the
 * pipeline can reach. `applied`/`proposed` carry the op count so callers can
 * say precisely what landed or awaits review; `failed` carries the message
 * already shown in chat, for callers that report status elsewhere (the
 * meeting view's extraction heartbeat).
 */
export type SendOutcome =
  /**
   * `reply` on the three answered kinds is what Lucent says back in a voice
   * conversation (the model's conversational reply, or its explanation when it
   * gave none) — the canvas and the meeting speak it.
   */
  | { outcome: "applied"; ops: number; reply: string }
  | { outcome: "proposed"; ops: number; reply: string }
  /** A zero-op reply — often a clarifying question — carried as `text` so a
   *  caller outside the chat (the meeting's voice loop) can relay it. */
  | { outcome: "answered"; text: string; reply: string }
  | { outcome: "rejected" }
  | { outcome: "failed"; error: string }
  | { outcome: "busy" }
  | { outcome: "refused" }
  | { outcome: "cancelled" };

export interface WorkspaceState {
  view: View;
  setView: (v: View) => void;
  /** Active canvas lens (UX-1). Only meaningful when `view` is `"canvas"`. */
  lens: CanvasLens;
  setLens: (l: CanvasLens) => void;

  projectId: string;
  projectName: string;
  setProjectName: (n: string) => void;

  workspace: Workspace;
  chat: ChatEntry[];

  busy: boolean;
  /** M5/E1: streamed-payload characters received so far while busy; 0 otherwise. */
  streamChars: number;
  /** Node labels parsed from the stream so far — a live build preview; [] when idle. */
  streamNodes: string[];
  /** Sketch choreography: nodeId → flow-order index for the batch just
   * generated, so the canvas reveals it node-by-node; null when idle. */
  sketchOrder: Record<string, number> | null;
  /** End the sketch reveal now (called when the user starts interacting). */
  cancelSketch: () => void;
  /** UX-2: which generation phase the pill should name; null when idle. */
  genPhase: GenPhase | null;
  /** UX-2: abort the in-flight generation; safe before apply, no-op otherwise. */
  cancelSend: () => void;
  listening: boolean;
  setListening: (v: boolean) => void;

  proposal: Proposal | null;
  canvasPhase: CanvasPhase;

  history: OperationHistory;
  canUndo: boolean;
  canRedo: boolean;

  /** Live collaborators on the current board (empty when offline/solo). */
  peers: Peer[];
  /** Report this user's cursor/selection/viewport to collaborators. */
  setPresence: (update: {
    cursor?: { x: number; y: number } | null;
    selection?: string[];
    viewport?: Viewport | null;
  }) => void;
  /** docs/28 S5: who has the board's spotlight (everyone follows their view). */
  spotlight: Spotlight | null;
  /** Take the spotlight, or give it up. */
  setSpotlight: (on: boolean) => void;
  /** Bring everyone else to this view, once. */
  summon: (viewport: Viewport) => void;
  /** The latest "bring everyone here" that reached this board, for the canvas to follow. */
  lastSummon: { from: Spotlight; viewport: Viewport; at: number } | null;
  /** Realtime connection state, for the share dialog and a status dot. */
  syncStatus: SyncStatus;
  /** This user's role on the shared board, once connected. */
  syncRole: BoardRole | null;
  /**
   * True when this user may look but not touch: they joined someone else's
   * shared board as a viewer. The server already rejects their operations, so
   * without this the UI would offer edits that silently bounce. Every editing
   * entry point must check it — `applyManual` and `send` refuse outright, and
   * the views hide the affordances rather than letting them fail.
   */
  readOnly: boolean;
  /**
   * True when this person may comment, react and vote (docs/26 F8): everyone
   * but a viewer. A commenter is `readOnly` for content but not for talk.
   */
  canComment: boolean;
  /** Server-side board id when this project is shared; null when local-only. */
  boardId: string | null;
  /**
   * Publish the current board to the server and join its realtime room, so a
   * second person opening the same URL collaborates live. Returns the board id,
   * or null when not signed in / the server refused.
   */
  startSharing: () => Promise<string | null>;
  /**
   * Open a board that lives on the server, by board id. Distinct from
   * `openProject`, which loads a local project out of localStorage: a server
   * board has no local copy to load, so the workspace comes from the API and
   * the realtime room has to be joined -- otherwise two people opening the
   * same board from the dashboard would quietly edit separate copies of it.
   * False when the board is gone or not shared with this user.
   */
  openBoard: (id: string) => Promise<boolean>;

  /**
   * The outcome of a `send` — the contract callers need to report honestly
   * (P1-MT-002): "Extracted N turns" used to print even when generation
   * failed, was refused, or was skipped because another request was busy,
   * because `send` returned void and swallowed its own failures. Every
   * terminal state the pipeline can reach is named here.
   */
  send: (
    message: string,
    selection?: string[],
    attachments?: SendAttachments,
  ) => Promise<SendOutcome>;
  /**
   * Ask Lucent (Stage C1): the read direction of the AI pill's Build/Ask
   * split. The question goes to POST /api/boards/:id/ask over the shared
   * board's history; the reply lands in the chat with citations attached.
   * Read-only: an ask never mutates the board, and a viewer may ask (asking
   * is reading — the same content the history view shows, answered by the
   * model instead of listed).
   */
  /**
   * Ask about the board (the Ask lens). Resolves to what was said back — the
   * answer, or the reason there isn't one — so a voice conversation can speak
   * it; null when nothing was asked.
   */
  ask: (question: string) => Promise<string | null>;
  /** The pill's Build/Ask mode; shared across views so the toggle persists. */
  pillMode: "build" | "ask";
  setPillMode: (mode: "build" | "ask") => void;
  /**
   * Citation navigation (Stage C1): jump to a cited node, meeting, or
   * revision. Node → select+focus on the canvas; meeting → the transcript
   * (with the turn range highlighted); revision → the history view. No-op
   * when the cited object no longer exists.
   */
  onCitation: (citation: {
    kind: "node" | "meeting" | "revision";
    id: string;
    turnRange?: [number, number];
  }) => void;
  /** ADR 0048: select and frame several nodes on the canvas (an answer's evidence). */
  revealNodes: (ids: string[]) => void;
  /**
   * docs/27 D2: open a client-computed batch (a sorted sticky wall) as a
   * proposal. False when there is nothing valid to propose or the board is
   * read-only.
   */
  proposeOps: (operations: Operation[], request: string, explanation: string) => Promise<boolean>;
  applyProposal: () => void;
  cancelProposal: () => void;
  undo: () => void;
  redo: () => void;
  restoreVersion: (index: number) => void;
  selectDiagram: (kind: DiagramKind) => void;
  /**
   * "Convert board to <kind>" — the context menu's and ⌘K's one path. A blank
   * board gets the family's starter; a board with content is transformed
   * (`convertBoardOps`). The lens follows the new kind on its own.
   */
  convertBoard: (kind: DiagramKind) => void;
  /**
   * Change one region's diagram kind (a group with a kind), or clear it back
   * to the board-wide layout with `null`. The manual counterpart of the AI's
   * SET_GROUP_KIND — same op, same undo.
   */
  setRegionKind: (groupId: string, kind: DiagramKind | null) => void;
  /**
   * Doc 18 Phase 4 — the two-phase layout's async half, surfaced. `refining`
   * while the ELK worker re-flows the board/region phase 1 just committed;
   * `degraded` when every engine failed on a commit-path re-flow (phase-1
   * geometry is on screen; `retryLayout` re-attempts). Never an error state
   * the user must clear — the board is always valid.
   */
  layoutStatus: { phase: "idle" } | { phase: "refining" } | { phase: "degraded" };
  retryLayout: () => void;
  /** Apply manual board operations (shapes/links/node moves) and commit to
   * history (docs/13). Returns false when the batch fails validation, so callers
   * can report the failure instead of appearing to succeed. */
  applyManual: (ops: Operation[], label: string) => boolean;

  /**
   * Parallel diagrams: create a fresh board and run `prompt` against it. The
   * current board is untouched — this is the action behind the AI's "this
   * looks like a new board" reply.
   */
  startNewBoardFor: (prompt: string) => void;

  /**
   * Resolve a user id to a display name. Combines the local signed-in user,
   * peer presence, and a fallback to the raw id so unknown authors don't
   * disappear from comment threads (M0.4).
   */
  nameFor: (userId: string) => string;

  newProject: () => void;
  openProject: (id: string) => void;
  /**
   * Adopt a board from a file the user picked. Typed `unknown` because the value
   * arrives straight from `JSON.parse`: it is parsed here, not by the caller.
   */
  importWorkspace: (imported: unknown, name?: string) => void;
}

const Ctx = createContext<WorkspaceState | null>(null);

/** Review-gate threshold from settings (UX-1): always=>0, large=>5, never=>Infinity. */
export function proposalThreshold(): number {
  const mode = settingsStore.get().approvalThreshold;
  if (mode === "always") return 0;
  if (mode === "never") return Infinity;
  return 5;
}

function laidOut(ws: Workspace): Workspace {
  // No strategy is passed: computeLayout picks radial for mind maps and layered
  // otherwise, so switching representation actually changes the arrangement.
  // No direction either (Phase 5): core resolves the board's layout intent
  // (SET_LAYOUT_INTENT) as the default — absent intent stays vertical, so
  // existing boards render exactly as before. Routes ride along (V5): the
  // same pass derives the long edges' bend points, stamped exactly like the
  // node positions it computes.
  const { layout, routes } = computeLayoutWithRoutes(ws);
  return applyRoutes(applyLayout(ws, layout), routes);
}

/** What the synchronous pass decided — the async refinement's instruction. */
interface LayoutScope {
  kind: "region" | "board";
  /** The region that re-flowed (kind: "region"). */
  groupId?: string;
}

/**
 * The spatial-additivity commit path (M2): if every node this batch TOUCHES
 * (creates or edits) sits inside one group, re-layout just that group at its
 * current origin and leave the rest of the board pixel-identical. This is the
 * product invariant "never rearrange what's built" — a meeting that grows the
 * pricing region must not shuffle the product region the user already read.
 * Falls back to the full-board pass when the batch is unscoped (or the group
 * is unknown), which is the correct behaviour for whole-board transforms.
 *
 * `touched` is the set of node ids the batch creates or modifies, derived by
 * the caller from the ops themselves.
 *
 * Doc 18 Phase 4: this is now PHASE 1 of the two-phase commit. The return
 * carries the scope so the caller can run the async ELK refinement (phase 2)
 * over exactly the same region — the refinement re-lays out only what this
 * pass already decided to re-flow, so the spatial-additivity invariant holds
 * for both engines.
 */
function laidOutScoped(
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
    if (!g) return full(); // unscoped: a batch touching loose nodes relayouts all
    groupIds.add(g);
  }
  if (groupIds.size !== 1) return full(); // crosses regions: global pass
  const groupId = [...groupIds][0];
  if (!groupId) return full();
  const regionResult = relayoutRegionWithRoutes(ws, groupId);
  if (!regionResult) return full();
  let next = applyRoutes(applyLayout(ws, regionResult.layout), regionResult.routes);
  // Growth can extend the region into a right-hand neighbour; push only the
  // neighbours actually overlapped (never a global shuffle).
  next = pushRegionNeighbors(next, groupId);
  return { ws: next, scope: { kind: "region", groupId } };
}

/** Node/group ids a batch creates or modifies — the "what did we touch" set. */
function touchedIdsOf(ops: readonly Operation[]): Set<string> {
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
        // Both endpoints count for an edge op: a connect implies the pair's
        // region grew, and either endpoint's group is the natural scope.
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
        // A whole-board transform is explicitly global — scope to nothing so
        // the full pass runs.
        return new Set();
      default:
        break;
    }
  }
  return touched;
}

/** Whether a batch contains operations that alter semantic graph topology or layout. */
function opsNeedLayout(ops: readonly Operation[]): boolean {
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

/**
 * Fill in collections a workspace may predate, so a board saved by an older
 * build (or fetched from the server) never crashes a reducer that assumes them.
 * Now passes through the M0.5 schema parser, which validates sink-bearing fields
 * and warns on real corruption rather than silently swallowing it.
 */
function withDefaults(ws: unknown): Workspace {
  return parseWorkspaceOrDefault(ws, "loaded workspace");
}

/**
 * Parse an untrusted workspace and keep the reason it failed.
 *
 * `withDefaults` is right where nobody asked for this particular board — a
 * server broadcast, a reconnect, a reload — because substituting an empty one
 * beats a blank screen and the console warning is for operators. It is wrong
 * where the user pointed at *this* file or *this* saved project: there an empty
 * canvas with no explanation reads as lost work, so the caller needs a detail to
 * show. Exported because this is the whole boundary between an untrusted JSON
 * blob and the render sinks, and the wording below is what the user reads.
 */
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

/**
 * Drop `invite` from the address bar once it has been redeemed. The token grants
 * access to anyone who reloads the URL, so leaving it visible turns a one-time
 * invite into a link the recipient can forward.
 */
/**
 * Mirror a server-side proposal record into the panel's Proposal shape
 * (Stage B3). The panel renders from the local type; this adapter keeps the
 * two contracts in one visible place instead of scattering field mappings.
 */
function serverProposalToPanel(server: ServerProposal): Proposal {
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

function stripInviteFromUrl(): void {
  const url = new URL(window.location.href);
  if (!url.searchParams.has("invite")) return;
  url.searchParams.delete("invite");
  window.history.replaceState({}, "", url.toString());
}

function stripBoardFromUrl(): void {
  const url = new URL(window.location.href);
  if (!url.searchParams.has("board")) return;
  url.searchParams.delete("board");
  window.history.replaceState({}, "", url.toString());
}

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  // Resume the project that was open before the reload. Doing this during the
  // initial state computation (rather than in an effect) avoids a flash of an
  // empty board and keeps History seeded with the restored workspace.
  const restored = useRef(loadLastOpenProject()).current;

  // The restored blob comes out of localStorage, so it gets the same parse as a
  // board fetched from the server. Silent here on purpose: this runs before any
  // chat surface exists to report into, and nobody asked for this board by name —
  // parseWorkspaceOrDefault warns the console and hands back an empty one.
  // Doc 18 Phase 4: a board saved by this build carries geometry (ELK-refined
  // boards included), so boot lays out ONLY when positions are missing —
  // same conditional as adoptBoard/openProject. Unconditional relayout would
  // re-stamp built-in geometry over a saved ELK board and rearrange it on
  // every reload (the M2 never-rearrange violation).
  const bootNeedsLayout = Boolean(
    restored && Object.values(withDefaults(restored.workspace).nodes).some((n) => !n.position),
  );
  const historyRef = useRef(
    new OperationHistory(
      // A restored board may predate positions (history replay, an old save,
      // a server fetch): lay it out once at boot so the canvas never renders
      // every card stacked at the origin.
      restored
        ? bootNeedsLayout
          ? laidOut(withDefaults(restored.workspace))
          : withDefaults(restored.workspace)
        : createWorkspace(),
      restored ? "loaded" : "initial",
    ),
  );
  // Seeded from the address bar (landing.ts explains why a fixed "canvas"
  // broke every view deep link). Legacy lens views fold into canvas + lens,
  // exactly as setView does below.
  const [initialLocationRef] = useState(initialLocation);
  const [view, setViewState] = useState<View>(() =>
    LEGACY_LENS_VIEWS[initialLocationRef.view] ? "canvas" : initialLocationRef.view,
  );
  // The restored board's own lens (a reloaded sequence board opens in the
  // sequence lens) unless the address bar asked for another one.
  const [lens, setLens] = useState<CanvasLens>(() =>
    lensForKindChange(
      undefined,
      historyRef.current.current().diagramKind,
      LEGACY_LENS_VIEWS[initialLocationRef.view] ?? initialLocationRef.lens,
    ),
  );
  /**
   * The board's current kind, readable from `setView` (a stable callback
   * declared before the workspace state). Assigned during render below.
   */
  const boardKindRef = useRef<DiagramKind>(historyRef.current.current().diagramKind);
  /**
   * UX-1: legacy board-like views are canvas lenses now. Keep the `View` type
   * unchanged for compat, but fold those cases into canvas+lens so one board
   * URL (`?view=canvas&lens=kanban`) covers them. Direct `"canvas"` resets to
   * the board's own lens — the visual canvas, or the registry lens its kind is
   * read through (V4: a sequence board opened from the rail, a link or a
   * reload shows the sequence, not its actors as boxes); lens buttons do
   * `setView("canvas")` then `setLens(...)` in that order so the reset does
   * not wipe the lens.
   */
  const setView = useCallback((v: View) => {
    switch (v) {
      case "board":
        setLens("kanban");
        setViewState("canvas");
        return;
      case "document":
        setLens("document");
        setViewState("canvas");
        return;
      case "wireframe":
        setLens("wireframe");
        setViewState("canvas");
        return;
      case "sequence":
        setLens("sequence");
        setViewState("canvas");
        return;
      case "er":
        setLens("er");
        setViewState("canvas");
        return;
      case "canvas":
        setLens(lensFor(boardKindRef.current) ?? "visual");
        setViewState("canvas");
        return;
      default:
        setViewState(v);
        return;
    }
  }, []);
  const [projectId, setProjectId] = useState(restored?.id ?? newProjectId());
  const [projectName, setProjectName] = useState(restored?.name ?? uniqueProjectName());
  // Called, not passed: `useState` treats a bare function as a lazy initializer
  // and would invoke `current` detached from the instance — `this.workspace`
  // on undefined. The arrow keeps it bound and runs exactly once.
  const [workspace, setWorkspace] = useState<Workspace>(() => historyRef.current.current());
  /**
   * The lens follows the kind (`lensForKindChange`). Adjusted DURING render —
   * React's "state from the previous render" pattern — not in an effect: an
   * effect would paint one frame of the old lens over the new kind (a fresh
   * sequence diagram flashing as boxes). Every path that changes the kind
   * lands here — a conversion, the AI's CREATE_DIAGRAM, a peer's frame, undo,
   * opening another project — so none of them has to remember the lens.
   */
  const [lensKind, setLensKind] = useState<DiagramKind>(workspace.diagramKind);
  if (lensKind !== workspace.diagramKind) {
    setLensKind(workspace.diagramKind);
    setLens((current) => lensForKindChange(lensKind, workspace.diagramKind, current));
  }
  boardKindRef.current = workspace.diagramKind;
  const [chat, setChat] = useState<ChatEntry[]>(restored?.chat ?? []);
  const [busy, setBusy] = useState(false);
  /** M5/E1: characters of the streamed payload received so far (display only). */
  const [streamChars, setStreamChars] = useState(0);
  /** Node labels parsed from the stream as the model writes them — a live
   * preview of the diagram taking shape (display only; the validated batch at
   * `done` is still authoritative). */
  const [streamNodes, setStreamNodes] = useState<string[]>([]);
  /** Google-Stitch-style reveal: nodeId → its position in the just-generated
   * batch's flow sequence, so the canvas sketches the diagram in node-by-node
   * (connectors drawing after each). Null when idle; cleared once the sequence
   * has played, so pans and manual edits stay instant. */
  const [sketchOrder, setSketchOrder] = useState<Record<string, number> | null>(null);
  const sketchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** End the reveal immediately. The moment the user grabs a node, the sketch
   * animation (which hides each node/edge until its turn) must get out of the
   * way — otherwise a drag during the ~2s reveal fights the still-hidden cards
   * and connectors and reads as a glitch. Idempotent. */
  const cancelSketch = useCallback(() => {
    if (sketchTimer.current) {
      clearTimeout(sketchTimer.current);
      sketchTimer.current = null;
    }
    setSketchOrder((cur) => (cur === null ? cur : null));
  }, []);
  /** UX-2: named generation phase; drives the pill status + Cancel. */
  const [genPhase, setGenPhase] = useState<GenPhase | null>(null);
  const genAbortRef = useRef<AbortController | null>(null);
  /** UX-2: user cancellation. Aborts the stream; the send catch reports it. */
  const cancelSend = useCallback(() => {
    genAbortRef.current?.abort();
  }, []);
  const [listening, setListening] = useState(false);
  /**
   * Stage C1: the AI pill's Build/Ask mode. Workspace-level (not view-level)
   * so the toggle survives view switches the same way the conversation does.
   */
  const [pillMode, setPillMode] = useState<"build" | "ask">("build");
  // A pending proposal restores from the project record (2026-09: the
  // reliability fix — a refresh used to drop the AI's proposed ops). Terminal
  // records stay on disk as the audit trail but don't reopen the panel.
  const [proposal, setProposal] = useState<Proposal | null>(
    restored?.proposal && proposalIsPending(restored.proposal) ? restored.proposal : null,
  );
  /**
   * The durable record, mirrored so persist() can write it without churn at
   * its call sites, and so double-decisions can be caught synchronously.
   * `decidedRef` is the idempotency guard: applyProposal/cancelProposal set
   * it before any await, so a double-click, a keyboard replay, or a
   * rehydrated-but-already-decided record reads "already decided" and no-ops.
   */
  const proposalRecordRef = useRef<PersistedProposal | undefined>(restored?.proposal);
  const proposalHistoryRef = useRef<PersistedProposal[]>(restored?.proposalHistory ?? []);
  const decidedRef = useRef<string | null>(null);
  /**
   * Stage B3: the server-side record id of the currently open proposal, when
   * the board is server-adopted. A proposal on a shared board lives on the
   * SERVER — peers see it, and the decision is enforced once where both
   * browsers can see it. Undefined on local boards (the localStorage record
   * remains that path's contract) and for local previews of a server proposal
   * before the create round-trip completes.
   */
  const serverProposalRef = useRef<{ boardId: string; id: string } | null>(null);
  const [tick, setTick] = useState(0); // force re-read of history undo/redo flags
  /**
   * Doc 18 Phase 4 — the two-phase layout, status half. Phase 1 is the
   * synchronous built-in pass every commit already runs (instant, scoped,
   * contract-identical to pre-Phase-4 behaviour). Phase 2 is the async ELK
   * refinement (ADR 0039's hybrid selection) that follows a legitimate
   * re-flow and re-lays out the same scope through the worker: better
   * geometry on the flat graph families, off the main thread. `refining`
   * while in flight; `degraded` when ELK and every fallback failed on a
   * commit-path re-flow — phase-1 geometry is already on screen and valid,
   * so that is a quality notice ("Layout couldn't be updated — retry"),
   * never a blank canvas (doc 18 Phase 4 item 3).
   */
  const [layoutStatus, setLayoutStatus] = useState<
    { phase: "idle" } | { phase: "refining" } | { phase: "degraded" }
  >({ phase: "idle" });
  /**
   * Latest-value mirrors (assigned during render, read in async landings —
   * a state change always renders before any promise callback can run, so
   * these are current whenever a refinement lands):
   *  - `workspaceRef` is the staleness guard: a refinement carries the
   *    workspace it was computed FROM, and applies only if that object is
   *    still the current one. Any commit, undo, remote frame, or project
   *    switch replaces the workspace object and thereby drops every
   *    in-flight refinement — async work must never clobber newer sync state.
   *  - `chatRef`/`projectNameRef` let a refinement persist the ELK geometry
   *    with the LATEST conversation, never the conversation captured when it
   *    fired (persisting a stale one would drop the newest chat entries).
   */
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;
  const chatRef = useRef(chat);
  chatRef.current = chat;
  const projectNameRef = useRef(projectName);
  projectNameRef.current = projectName;
  /**
   * Live handle to the refinement (assigned during render, right after its
   * definition below). `connectSync` and `adoptBoard` are defined EARLIER in
   * the component body than `refineLayout` and capture their closures once
   * (deps `[]` / `[connectSync]`), so they reach the refinement through this
   * ref — the same read-at-call-time pattern the armed STT callbacks use.
   * Without it, a remote frame arriving after a project switch would run a
   * refinement whose `persist` still points at the previous project's slot.
   */
  const refineRef = useRef<(from: Workspace, scope: LayoutScope, persistOnLand?: boolean) => void>(
    () => {},
  );
  // Live collaborators. Populated only when a server-side board is open and the
  // realtime socket is connected; empty in the offline/solo localStorage flow.
  const [peers, setPeers] = useState<Peer[]>([]);
  const [spotlight, setSpotlightState] = useState<Spotlight | null>(null);
  const [lastSummon, setLastSummon] = useState<{
    from: Spotlight;
    viewport: Viewport;
    at: number;
  } | null>(null);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>("offline");
  const [syncRole, setSyncRole] = useState<BoardRole | null>(null);
  const [boardId, setBoardId] = useState<string | null>(null);
  // A viewer may read the board but not change it; a commenter may also talk
  // on it (docs/26 F8). Derived rather than stored so it can never disagree
  // with the role the server assigned.
  const readOnly = syncRole === "viewer" || syncRole === "commenter";
  const canComment = syncRole !== "viewer";
  const syncRef = useRef<BoardSync | null>(null);
  // Set while applying a server broadcast, so the echo isn't re-sent as a new
  // local edit (which would loop the room).
  const applyingRemote = useRef(false);

  const setPresence = useCallback(
    (update: {
      cursor?: { x: number; y: number } | null;
      selection?: string[];
      viewport?: Viewport | null;
    }) => {
      syncRef.current?.setPresence(update);
    },
    [],
  );
  const setSpotlight = useCallback((on: boolean) => syncRef.current?.setSpotlight(on), []);
  const summon = useCallback((viewport: Viewport) => syncRef.current?.summon(viewport), []);

  /**
   * Attach a realtime session to a server-side board. The server is
   * authoritative: its broadcasts replace local state, and local commits are
   * sent for sequencing rather than applied twice.
   */
  const connectSync = useCallback((id: string, initial: Workspace) => {
    syncRef.current?.disconnect();
    // A new board's room says who has its spotlight when it welcomes us.
    setSpotlightState(null);
    setLastSummon(null);
    const sync = new BoardSync(id, initial, {
      onWorkspace: (ws) => {
        applyingRemote.current = true;
        // A remote broadcast is not a local commit: don't push it onto the
        // undo stack, otherwise undoing my own change would revert the peer's
        // edit and then a follow-up undo would put it back. The workspace
        // state catches up without history pollution (M0.4).
        // WHOLESALE deliveries (the welcome catchup replay, a resync) rebuild
        // the workspace from ops, which carry no coordinates — nodes land
        // unpositioned and stack at (0,0) under the region labels. Incremental
        // frames never drop positions (applyOperations preserves fields), so
        // Re-layout ONLY when positions are genuinely missing from both the incoming
        // workspace and our local workspace (M2). Incremental frames or echos of
        // operations we already positioned must keep their coordinates rather than
        // triggering a delayed relayout.
        const currentNodes = workspaceRef.current.nodes;
        const mergedNodes = { ...ws.nodes };
        for (const [id, node] of Object.entries(mergedNodes)) {
          if (!node.position && currentNodes[id]?.position) {
            mergedNodes[id] = { ...node, position: currentNodes[id].position };
          }
        }
        const wsWithPositions = { ...ws, nodes: mergedNodes };
        const hasUnpositioned = Object.values(wsWithPositions.nodes).some((n) => !n.position);
        const positioned = hasUnpositioned ? laidOut(wsWithPositions) : wsWithPositions;
        historyRef.current.syncFromRemote(positioned);
        setWorkspace(positioned);
        setTick((t) => t + 1);
        applyingRemote.current = false;
        // Phase 2 (doc 18 Phase 4): a wholesale delivery re-derived geometry,
        // so the ELK refinement is legitimate — WITHOUT persisting (peers
        // derive their own geometry; ops carry no coordinates) and without
        // history (already handled above by syncFromRemote). Reached through
        // the live ref: this callback is armed once, before `refineLayout`
        // exists, and a project switch must leave a late frame refining the
        // CURRENT board with the CURRENT persist slot.
        if (hasUnpositioned) refineRef.current(positioned, { kind: "board" });
      },
      onPeers: setPeers,
      onStatus: setSyncStatus,
      onRole: setSyncRole,
      onSpotlight: setSpotlightState,
      onSummon: (from, viewport) => setLastSummon({ from, viewport, at: Date.now() }),
      onRejected: (error) => {
        // A viewer's edit, or a stale op. The server state we already hold wins.
        setChat((c) => [...c, { role: "error", text: `Change refused: ${error}` }]);
      },
      // Stage B4: a server-level error is never swallowed. "board deleted"
      // from an eviction means this client is editing a ghost — the honest
      // reaction is leaving the board, not letting the user type into it.
      onError: (message) => {
        if (/deleted/i.test(message)) {
          setChat((c) => [...c, { role: "error", text: "This board was deleted." }]);
          setView("dashboard");
          return;
        }
        setChat((c) => [...c, { role: "error", text: message }]);
      },
      // Stage B3: a peer's proposal opens on this board too — the record is
      // server-side now, so the panel is board state, not a local draft.
      onProposalCreated: (server, supersededId) => {
        serverProposalRef.current = { boardId: server.boardId, id: server.id };
        decidedRef.current = null;
        setProposal(serverProposalToPanel(server));
        // A create supersedes the pending record this browser held locally
        // (the same-board predecessor): its local mirror closes with it.
        if (supersededId && proposalRecordRef.current?.id === supersededId) {
          proposalRecordRef.current = undefined;
        }
      },
      onProposalDecided: (event) => {
        // The decision happened — possibly here, possibly on a peer. The
        // panel closes either way; the ops (if approved) arrive as the room's
        // ordinary broadcast, applying through onWorkspace above.
        setProposal((p) => (p && p.id === event.id ? null : p));
        if (serverProposalRef.current?.id === event.id) serverProposalRef.current = null;
      },
      // Stage D7: an inbound-queue decision (accept/dismiss, this browser
      // or a peer's). The Intelligence view refetches the queue through
      // its own effect; the board state itself converges through the op
      // frame the accept committed. This callback exists so the frame is
      // not silently dropped (the default handler would log an unknown
      // message kind).
      onInboundDecided: () => {},
    });
    syncRef.current = sync;
    sync.connect();
  }, []);

  /**
   * Take a board fetched from the server as the live one: its workspace, name,
   * our role on it, a fresh history baseline, and the realtime room.
   *
   * Factored out because two entry points need exactly this state -- the
   * reload/invite-link path below and `openBoard` from the dashboard -- and a
   * second copy of it is how one of them ends up subtly different (joining the
   * room but not setting the role, say, which would show a viewer editing tools
   * that the server then rejects).
   */
  const adoptBoard = useCallback(
    (board: { id: string; name: string; workspace: Workspace; role: BoardRole }): void => {
      setSharedBoardId(board.id);
      setBoardId(board.id);
      // Autosave writes under whichever `projectId` is current, so a server board
      // has to claim a slot of its own: without this, opening a shared board made
      // the next autosave overwrite whatever local project happened to be open
      // with the shared board's content. `mirrorProjectId` derives the slot from
      // the board id, so re-opening the same board reuses one mirror rather than
      // leaving a new local project behind on every visit.
      setProjectId(mirrorProjectId(board.id));
      setProjectName(board.name);
      // A different project's proposal record must not leak into this
      // board's autosave slot (same class of cross-project bug as above).
      proposalRecordRef.current = undefined;
      proposalHistoryRef.current = [];
      decidedRef.current = null;
      serverProposalRef.current = null;
      setProposal(null);
      // Stage B3: a shared board's pending proposal lives on the server, so
      // adopting the board re-reads it — a refresh no longer drops the panel
      // (and a peer's pending extraction opens on this browser as soon as
      // the socket's proposal-created frame lands).
      void listServerProposals(board.id).then((list) => {
        const pending = list.find((p) => p.status === "pending");
        if (pending) {
          serverProposalRef.current = { boardId: board.id, id: pending.id };
          setProposal(serverProposalToPanel(pending));
        }
      });
      // The server tells us our role on this board; trusting it here means the
      // read-only UI is correct before the socket's `welcome` arrives.
      setSyncRole(board.role);
      // A board stored without node positions (any write path that skips the
      // client's layout pass — the ops API, MCP's apply_canvas_operations,
      // external tooling) would render every node stacked at (0,0), piled
      // under the region labels — the same failure the undo/redo paths fix
      // with their own relayout. Lay out only when positions are actually
      // missing: a fully-positioned board is never rearranged (M2's
      // never-rearrange invariant), and the layout engine is deterministic,
      // so the same stored board lays out identically on every load.
      const safeRaw = withDefaults(board.workspace);
      const hasUnpositioned = Object.values(safeRaw.nodes).some((n) => !n.position);
      const safe = hasUnpositioned ? laidOut(safeRaw) : safeRaw;
      historyRef.current = new OperationHistory(safe, "loaded shared board");
      setWorkspace(safe);
      setTick((t) => t + 1);
      // Phase 2 (doc 18 Phase 4): geometry was re-derived for an unpositioned
      // server board, so the ELK refinement follows — without persisting
      // (this board is server-owned; the localStorage slot belongs to the
      // previous local project). Via the live ref like connectSync's frame.
      if (hasUnpositioned) refineRef.current(safe, { kind: "board" });
      connectSync(board.id, safe);
    },
    [connectSync],
  );

  // Reconnect on reload when a board is shared, and tear the socket down on
  // unmount so a hot reload doesn't leak sockets.
  useEffect(() => {
    return () => {
      syncRef.current?.disconnect();
      syncRef.current = null;
    };
  }, []);

  /**
   * Leave the shared-board session — the full teardown, not just the pointer
   * clear. Every deliberate move to a LOCAL board (New workspace, open a
   * project, import) ends the shared session atomically: the socket drops so
   * `commitAndShare` can never carry a local edit to the old room, the role
   * and status reset so the UI stops advertising a live board, and ?board=
   * leaves the address bar so a reload cannot rejoin either. The save pointer
   * (`setSharedBoardId(null)`) is the caller's move — this helper owns only
   * the transport/role/URL half so the audit's P0 fix composes with the
   * existing per-path pointer clears instead of duplicating them.
   */
  const leaveSharedBoard = useCallback(() => {
    syncRef.current?.disconnect();
    syncRef.current = null;
    setSyncRole(null);
    setSyncStatus("offline");
    setPeers([]);
    setSpotlightState(null);
    setLastSummon(null);
    setBoardId(null);
    stripBoardFromUrl();
  }, []);

  // Surface a localStorage failure as a chat error (M0.5). Without this the
  // user kept editing a board that wouldn't survive a reload because the
  // autosave silently threw.
  useEffect(() => {
    return onStorageError((message) => {
      setChat((c) => [...c, { role: "error", text: message }]);
    });
  }, []);

  const persist = useCallback(
    (ws: Workspace, conversation: ChatEntry[], name: string) => {
      if (!settingsStore.get().autosave) return;
      saveProject({
        id: projectId,
        name,
        workspace: ws,
        chat: conversation,
        // The durable proposal record (2026-09 reliability fix): whatever is
        // in the ref is what gets saved — open, decided, or absent. Terminal
        // records persist as the audit trail even though only pending ones
        // reopen the panel.
        ...(proposalRecordRef.current ? { proposal: proposalRecordRef.current } : {}),
        ...(proposalHistoryRef.current.length > 0
          ? { proposalHistory: proposalHistoryRef.current }
          : {}),
      });
      setLastOpenProject(projectId);
    },
    [projectId],
  );

  /**
   * Doc 18 Phase 4 — the async half of the two-phase layout. Runs AFTER the
   * synchronous built-in pass has already committed phase-1 geometry (which
   * is valid, so nothing below can blank the canvas) and re-lays out the SAME
   * scope through the layout service with the worker ELK engine as primary:
   *
   *  - `scope.kind === "region"`: the region phase 1 re-flowed, re-laid by
   *    ELK, merged at its current origin, with the same neighbour-push as
   *    phase 1 (ELK can need more room than the built-in geometry did).
   *  - `scope.kind === "board"`: a full-board pass over the ELK-eligible
   *    families only (`elkEligible`); everything else skips before any
   *    worker traffic.
   *
   * Ownership: a refinement never touches history (it is geometry over an
   * already-committed batch, not a semantic change) and never sends ops (ops
   * carry no coordinates — every client derives geometry from the same
   * semantics deterministically, so peers' own refinements converge to the
   * same ELK output without any traffic).
   *
   * Staleness + coalescing: a landing applies only if `from` is still the
   * current workspace object — any commit/undo/remote-frame/project-switch
   * replaces the object and thereby drops every in-flight refinement. While
   * one refinement is in flight, further fires are skipped and remembered;
   * when the in-flight one lands, the remembered fire re-runs against the
   * CURRENT board. A multiplayer op burst therefore costs at most one ELK
   * run per burst, not one per frame.
   *
   * `persistOnLand` is set ONLY by the paths that already persist phase-1
   * geometry with a conversation (commit/undo/redo/restore, an unpositioned
   * boot). The remote/adopt paths never persist a refinement: peers derive
   * their own geometry, and an adopted shared board shares the previous
   * project's localStorage slot — writing it would corrupt that record.
   */
  const refineInFlight = useRef(false);
  const refineQueued = useRef<{
    from: Workspace;
    scope: LayoutScope;
    persistOnLand: boolean;
  } | null>(null);
  const refineLayout = useCallback(
    async (from: Workspace, scope: LayoutScope, persistOnLand = false) => {
      // ELK refinement is an opt-in path (docs/AGENTS.md: hand-written engine
      // in core stays default; ELK is opted-in). When elkLayout is disabled,
      // the synchronous phase-1 geometry produced by core is final.
      if (!settingsStore.get().elkLayout) {
        return;
      }
      // Skip before any worker traffic: families ELK did not win, and region
      // scopes whose region is not ELK-eligible (the service would answer
      // with the built-in engine — geometry phase 1 already produced).
      if (scope.kind === "board" ? !elkEligible(from) : !elkRegionEligible(from, scope.groupId!)) {
        return;
      }
      if (refineInFlight.current) {
        refineQueued.current = { from, scope, persistOnLand };
        return;
      }
      refineInFlight.current = true;
      setLayoutStatus({ phase: "refining" });
      let degraded = false;
      try {
        let refined: Workspace | null = null;
        if (scope.kind === "region" && scope.groupId) {
          const result = await relayoutRegionScoped(
            from,
            scope.groupId,
            {},
            {
              primary: WORKER_ELK_ENGINE,
            },
          );
          // The built-in fallback inside the service re-produces phase-1's
          // own geometry — applying it would be a no-op, so only an ELK
          // outcome continues. `degraded` here means both engines failed;
          // the region keeps phase-1 geometry and the notice fires.
          if (result.degraded) {
            degraded = true;
          } else if (result.engineId === WORKER_ELK_ENGINE.id) {
            refined = pushRegionNeighbors(result.workspace, scope.groupId);
          }
        } else {
          const result = await layoutBoard(from, {}, { primary: WORKER_ELK_ENGINE });
          if (result.degraded) {
            degraded = true;
          } else if (result.engineId === WORKER_ELK_ENGINE.id) {
            refined = result.workspace;
          }
        }
        if (refined && workspaceRef.current === from) {
          setWorkspace(refined);
          setTick((t) => t + 1);
          if (persistOnLand) persist(refined, chatRef.current, projectNameRef.current);
        }
      } catch {
        // The service's own contract makes an exception here near-impossible
        // (it degrades rather than throws), but a crash in the refinement
        // must never reach the render path. Phase-1 geometry stands.
      } finally {
        refineInFlight.current = false;
        setLayoutStatus(degraded ? { phase: "degraded" } : { phase: "idle" });
        // The queued fire re-runs with its OWN from — the board it was fired
        // for. If that board was replaced while the earlier refinement ran
        // (a project switch, a peer frame), the re-fire's landing gate drops
        // it; firing it against the CURRENT board instead would refine a
        // board that never asked (and a queued region scope could even
        // rearrange a freshly loaded positioned board — an M2 violation).
        const queued = refineQueued.current;
        refineQueued.current = null;
        if (queued) {
          void refineLayout(queued.from, queued.scope, queued.persistOnLand);
        }
      }
    },
    [persist],
  );
  refineRef.current = (...args) => {
    // Fire-and-forget by design (the call sites never await refinement);
    // the wrapper makes the float explicit instead of assigning an async
    // function into a void slot, which reads as an accident.
    void refineLayout(...args);
  };

  /** Retry a degraded refinement: same board, same rules, fresh attempt. */
  const retryLayout = useCallback(() => {
    void refineLayout(workspaceRef.current, { kind: "board" });
  }, [refineLayout]);

  /**
   * The boot phase-2 fire: a restored board whose positions were missing got
   * phase-1 geometry in the initial state computation above — the ELK
   * refinement follows once the hooks exist to fire it. StrictMode's double
   * mount is harmless: the second fire coalesces behind the first, and the
   * landing gate makes both idempotent. Not persisted — the record's turn to
   * write comes with the next commit.
   */
  useEffect(() => {
    if (restored && bootNeedsLayout) {
      refineRef.current(historyRef.current.current(), { kind: "board" });
    }
    // Boot fires once; the flags are captured on purpose.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Apply a local batch and record it as one history entry. Inverse ops are
   * computed against the pre-batch workspace so undo is multiplayer-safe (M0.4).
   *
   * M2: the relayout is SCOPED — when the batch touched nodes all inside one
   * group, only that group re-flows at its current origin and the rest of the
   * board keeps its committed positions (the spatial-additivity invariant).
   *
   * Doc 18 Phase 4: two-phase. Phase 1 is the sync scoped pass above (the
   * commit is durable and interactive the moment it returns); phase 2 — the
   * async ELK refinement over the same scope — follows, epoch-guarded. A
   * phase-2 landing that arrives after another change already replaced the
   * workspace is dropped; the newer commit's own refinement replaces it.
   */
  const commit = useCallback(
    (next: Workspace, ops: Operation[], label: string, conversation: ChatEntry[], name: string) => {
      const needsLayout = opsNeedLayout(ops);
      const { ws: positioned, scope } = needsLayout
        ? laidOutScoped(next, touchedIdsOf(ops))
        : { ws: next, scope: null };
      historyRef.current.commit(ops, label);
      setWorkspace(positioned);
      setTick((t) => t + 1);
      persist(positioned, conversation, name);
      if (scope) {
        void refineLayout(positioned, scope, true);
      }
      return positioned;
    },
    [persist, refineLayout],
  );

  /**
   * Commit local operations and, when sharing, send them to the room so peers
   * see them. Applying is still local-first for responsiveness; the server's echo
   * is deduped by sequence number inside BoardSync.
   */
  const commitAndShare = useCallback(
    (
      next: Workspace,
      ops: Operation[],
      label: string,
      conversation: ChatEntry[],
      name: string,
      runId?: string,
    ) => {
      const positioned = commit(next, ops, label, conversation, name);
      if (!applyingRemote.current) {
        syncRef.current?.updateWorkspace(positioned);
        syncRef.current?.commit(ops, label, runId);
      }
    },
    [commit],
  );

  /**
   * Publish this project as a server-side board and join its room. This is the
   * step that turns a local board into a shared one — the realtime room is keyed
   * by board id, so it has to exist server-side before anyone can join it.
   */
  const startSharing = useCallback(async (): Promise<string | null> => {
    // A board belongs to a tenant, and when the client does not say which the
    // server falls back to `memberships[0]` (app.ts:2183) -- whichever org the
    // membership query returned first. A user in two orgs would publish into an
    // arbitrary one and then not find the board in the list for the org they
    // were looking at. Resolve the org that is actually on screen and name it.
    const { current } = await loadOrgs();
    if (!current) return null;
    const summary = await saveBoard(current.id, projectName, workspace, boardId ?? undefined);
    if (!summary) return null;
    setBoardId(summary.id);
    setSharedBoardId(summary.id);
    if (typeof window !== "undefined") {
      const u = new URL(window.location.href);
      u.searchParams.set("board", summary.id);
      window.history.replaceState(null, "", u.toString());
    }
    connectSync(summary.id, workspace);
    return summary.id;
  }, [projectName, workspace, boardId, connectSync]);

  // Rejoin the shared board after a reload, and honour a ?board=<id> link so an
  // invitee lands in the same room rather than their own local board. When the
  // URL also carries ?invite=<token> we redeem it first: a board id alone is
  // not a capability, so without this step a non-member's fetch 404s and the
  // invite silently does nothing.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const fromLink = params.get("board");
    const invite = params.get("invite");
    const saved = fromLink ?? getSharedBoardId();
    if (!saved || syncRef.current) return;
    let cancelled = false;
    void (async () => {
      if (invite && fromLink) {
        const joined = await joinBoard(fromLink, invite);
        if (cancelled) return;
        if (!joined.ok) {
          // Say so rather than returning silently — an invite that looks like
          // it worked but didn't is the worst of the three outcomes.
          setChat((c) => [...c, { role: "error", text: joined.error }]);
          stripInviteFromUrl();
          return;
        }
      }
      const board = await fetchBoard(saved);
      if (cancelled) return;
      if (!board) {
        if (fromLink) {
          setChat((c) => [
            ...c,
            {
              role: "error",
              text: invite
                ? "Joined, but the board could not be opened. Ask the owner to re-share it."
                : "That board isn't shared with you. Ask the owner for an invite link.",
            },
          ]);
        } else {
          // Not ours any more (or signed out): forget it rather than retrying.
          setSharedBoardId(null);
        }
        stripInviteFromUrl();
        return;
      }
      adoptBoard(board);
      // The token has been redeemed into a membership row; leaving it in the
      // address bar invites re-sharing a spent capability.
      stripInviteFromUrl();
    })();
    return () => {
      cancelled = true;
    };
  }, [adoptBoard]);

  /**
   * Open a batch for review. Shared board (Stage B3): the record goes to the
   * SERVER, which is what makes a pending proposal visible to every member —
   * the localStorage path could never do that. The server supersedes any
   * pending predecessor; peers' panels open via proposal-created. Local board
   * (or the server create failed — the panel must still open): the
   * localStorage record is that path's durability.
   */
  const openProposal = useCallback(
    async ({
      operations,
      request,
      explanation,
      provenance,
      runId,
    }: {
      operations: Operation[];
      request: string;
      explanation: string;
      provenance?: SendAttachments["provenance"];
      runId?: string;
    }): Promise<void> => {
      const serverRecord = boardId
        ? await createServerProposal(boardId, {
            operations,
            request,
            explanation,
            ...(runId ? { runId } : {}),
            ...(provenance?.meetingId ? { meetingId: provenance.meetingId } : {}),
            ...(provenance?.turnRange || provenance?.turnKinds?.length || provenance?.turns?.length
              ? {
                  provenance: {
                    // Stage C2: the full evidence record, so the server's
                    // approve-time enrichment (ADR 0022) can stamp the ops
                    // for every peer, not just the proposer's browser.
                    ...(provenance.turnRange ? { turnRange: provenance.turnRange } : {}),
                    ...(provenance.turnKinds?.length ? { turnKinds: provenance.turnKinds } : {}),
                    ...(provenance.turns?.length
                      ? { quote: provenance.turns.join(" ").slice(0, 240) }
                      : {}),
                  },
                }
              : {}),
          })
        : null;
      if (serverRecord) {
        serverProposalRef.current = {
          boardId: boardId ?? serverRecord.boardId,
          id: serverRecord.id,
        };
        decidedRef.current = null;
        setProposal(serverProposalToPanel(serverRecord));
        return;
      }
      const opened = openProposalIn(
        { proposal: proposalRecordRef.current, proposalHistory: proposalHistoryRef.current },
        {
          id: newProposalId(),
          boardId,
          meetingId: provenance?.meetingId ?? null,
          ...(provenance?.turns ? { turns: provenance.turns } : {}),
          ...(provenance?.turnRange ? { turnRange: provenance.turnRange } : {}),
          ...(provenance?.turnKinds?.length ? { turnKinds: provenance.turnKinds } : {}),
          operations,
          createdAt: Date.now(),
          request,
          explanation,
        },
      );
      proposalRecordRef.current = opened.proposal;
      proposalHistoryRef.current = opened.proposalHistory;
      decidedRef.current = null; // the new record is undecided
      setProposal(opened.proposal);
    },
    [boardId],
  );

  const send = useCallback(
    async (
      message: string,
      selection?: string[],
      attachments?: SendAttachments,
    ): Promise<SendOutcome> => {
      const text = message.trim();
      // Busy is a no-op the caller must know about (P1-MT-002): the meeting
      // loop used to print "Extracted N turns" even when this arm swallowed
      // the batch because another generation was in flight.
      if (!text) return { outcome: "busy" };
      if (busy) return { outcome: "busy" };
      setListening(false);
      if (readOnly) {
        setChat((c) => [
          ...c,
          { role: "user", text },
          {
            role: "error",
            text: "You're viewing this board. Ask the owner for edit access to change it.",
          },
        ]);
        return { outcome: "refused" };
      }
      const withUser: ChatEntry[] = [...chat, { role: "user", text }];
      setChat(withUser);
      setBusy(true);
      // UX-2: named phases replace the raw char counter as the status model.
      const aborter = new AbortController();
      genAbortRef.current = aborter;
      setGenPhase("understanding");
      try {
        // `chat` (not withUser) is the prior conversation; the current message is
        // sent separately, so passing withUser would duplicate it.
        let streamed = 0;
        let deltaBuffer = "";
        let sawDelta = false;
        setStreamNodes([]);
        const result = await streamGenerate(
          text,
          workspace,
          (delta) => {
            streamed += delta.length;
            setStreamChars(streamed);
            // Progressive preview: surface node labels AS the model writes them,
            // so the wait shows the diagram taking shape rather than an opaque
            // character count. A heuristic parse of the streamed op JSON — it
            // only drives the progress display; the validated batch at `done`
            // is still the single source of truth for the canvas.
            deltaBuffer += delta;
            const labels = [...deltaBuffer.matchAll(/"label"\s*:\s*"((?:[^"\\]|\\.)*)"/g)].map(
              (m) => (m[1] ?? "").replace(/\\"/g, '"'),
            );
            if (labels.length) setStreamNodes(labels);
            if (!sawDelta) {
              sawDelta = true;
              setGenPhase("constructing");
            }
          },
          selection,
          chat,
          attachments,
          aborter.signal,
          (phase) => setGenPhase(phase),
          // ADR 0047: what the run is for — this board, and where the person asked.
          {
            ...(boardId ? { boardId } : {}),
            surface: attachments?.provenance?.meetingId
              ? "meeting"
              : attachments?.surface === "voice"
                ? "voice"
                : "canvas",
          },
        );
        setStreamChars(0);
        setStreamNodes([]);
        setGenPhase("validating");
        // Answer-only reply (a question about the board): no ops, just explain.
        // A "this belongs on its own board" reply (the prompt's parallel-diagram
        // rule) is the other case that arrives with no ops — the explanation says
        // the topic looks unrelated, and the entry is marked so the chat can
        // offer the one-click "build it on a new board".
        if (result.operations.length === 0) {
          // Nothing to draw AND nothing said is a failed attempt, not an
          // answer: it used to land as "(no answer)", and on an empty board
          // the canvas went quietly back to the launch screen with the
          // request apparently lost. The failure arm records it with the
          // prompt, and the launch screen offers it back.
          if (!result.explanation?.trim() && !result.reply?.trim()) {
            throw new Error(
              "The AI answered but drew nothing — try again, or describe it another way.",
            );
          }
          const explanation = result.explanation?.trim() || result.reply!.trim();
          const reply = result.reply?.trim() || explanation;
          const suggestsBoard =
            Object.keys(workspace.nodes).length > 0 &&
            /own board|separate board|new board/i.test(explanation);
          const conversation: ChatEntry[] = [
            ...withUser,
            {
              role: "ai",
              text: explanation,
              reply,
              ...(suggestsBoard ? { suggestNewBoard: true, originPrompt: text } : {}),
              drewNothing: true,
            },
          ];
          setChat(conversation);
          // Zero-op replies are still turns the user asked for: a question
          // answered, a "this belongs on its own board" refusal. Without this
          // write they existed only in React state and vanished on reload —
          // the user's message and the answer simply disappeared (found live:
          // a "move the monitoring stack" answer was gone after a reload).
          persist(workspace, conversation, projectName);
          return { outcome: "answered", text: explanation, reply };
        }
        const errors = validateOperations(workspace, result.operations);
        if (errors.length > 0) {
          const conversation: ChatEntry[] = [
            ...withUser,
            {
              role: "error",
              text: `Rejected invalid operations: ${errors[0]?.message ?? "unknown"}`,
            },
          ];
          setChat(conversation);
          // Same reasoning as the zero-op path: the rejected attempt is part
          // of the board's story, not ephemeral UI state.
          persist(workspace, conversation, projectName);
          return { outcome: "rejected" };
        }
        const explanation = result.explanation ?? `Applied ${result.operations.length} operations.`;
        const reply = result.reply?.trim() || explanation;

        // Provenance (M2 → Stage C2, ADR 0022): enrich the OPS with the
        // meeting evidence before anything else touches them, so the stamp
        // lands in the undo history, on peers via the room, in the server's
        // board, and in the op log — everywhere the ops go. The old post-pass
        // wrote metadata.meeting onto the workspace object only this
        // browser held, which the next remote sync silently overwrote; the
        // recon for C2 proved that divergence, and ops are the fix.
        //
        // attachProvenance adds the field to CREATE_NODE (creation evidence)
        // and embeds it in SET_STATEMENT (the evidence behind a decision),
        // idempotently per op.
        const provenance = attachments?.provenance;
        const enrichedOps: Operation[] = provenance
          ? attachProvenance(result.operations, {
              meetingId: provenance.meetingId,
              // Stable references (Stage A): the index range survives
              // transcript normalization where the quote cannot.
              ...(provenance.turnRange ? { turnRange: provenance.turnRange } : {}),
              // Deterministic kinds, per source turn, in turn order (P0-3) —
              // preferring the kinds the caller derived over re-deriving.
              ...(provenance.turnKinds?.length
                ? { turnKinds: provenance.turnKinds }
                : provenance.turns.some((t) => classifyTurn(t))
                  ? {
                      turnKinds: provenance.turns
                        .map((t) => classifyTurn(t))
                        .filter((k): k is NonNullable<ReturnType<typeof classifyTurn>> =>
                          Boolean(k),
                        ),
                    }
                  : {}),
              quote: provenance.turns.join(" ").slice(0, 240),
            })
          : attachments?.plan
            ? // A plan's evidence is its source statements (createdFrom,
              // stamped below); its "message" is machine-written.
              result.operations
            : // ADR 0042: a request typed or spoken to the board is evidence
              // too — who asked, when, and the words — so a chat-built node
              // can answer "why is this here?" like a meeting-built one.
              attachProvenance(result.operations, {
                conversation: {
                  at: Date.now(),
                  ...(getSessionUser()?.name ? { by: getSessionUser()!.name.slice(0, 80) } : {}),
                },
                quote: text.slice(0, 240),
              });
        // The plan gate (Stage D2, ADR 0028): a PLAN request's ops are
        // filtered against PLAN_SAFE_OOPS before they touch anything —
        // lifecycle conversion (UPDATE_STATEMENT) is mechanically absent, so
        // a proposal can never silently become a confirmed task. Skipped
        // ops join the reply's skippedNote so the gate is honest about
        // what it refused. Then createdFrom stamps the sources onto every
        // created node — the fourth provenance writer, at the same place
        // the meeting loop stamps, before the fold and before the proposal
        // opens.
        const plan = attachments?.plan;
        const gated = plan ? gatePlanOps(enrichedOps) : null;
        const planStampedOps: Operation[] =
          gated && plan ? attachPlanProvenance(gated.allowed, plan.statementIds) : enrichedOps;
        const planSkippedNote =
          gated && gated.skipped.length > 0
            ? { skippedOps: gated.skipped.map((s) => ({ op: s.op, reason: s.reason })) }
            : {};
        // The topic fold (Stage C5, ADR 0025): these are the MODEL's ops —
        // generate or the meeting-extraction loop — so their statement
        // topics fold against the workspace this browser holds, before send
        // and before local apply. This covers the meeting loop's
        // user-actor batches the room's ai-only rule deliberately won't
        // touch, and local boards fold identically to shared ones (the
        // fourth boundary of the AI/MCP/WS/Web divergence). The human's
        // own edits (applyManual) never pass through here.
        // ADR 0047: the person asked for this, so what it states is theirs —
        // except what a meeting's extraction states, which stays a suggestion
        // until each claim is reviewed.
        const foldedOps: Operation[] = stampTrust(
          foldStatementTopics(planStampedOps, existingTopics(workspace)),
          "requested",
          workspace,
        );

        // The workspace after this batch, provenance and folded topics riding the ops.
        const applyStamped = (): Workspace => applyOperations(workspace, foldedOps);

        // Partial-application report (M1): the server may have skipped ops
        // that failed validation while applying the rest. Attach them to the
        // reply so the chat can show exactly what didn't land — the old
        // all-or-nothing path lost the whole generation over one bad op.
        // The plan gate's refusals (Stage D2) join the same report — the
        // union of what the server skipped and what the gate refused.
        const skippedNote = {
          ...((result.warnings?.length
            ? { skippedOps: result.warnings.map((w) => ({ op: w.op, reason: w.reason })) }
            : {}) as Record<string, unknown>),
          ...planSkippedNote,
        };

        // Large batches on an existing diagram present as a proposal to review.
        // Threshold is dynamic from settings (UX-1): always=>0 (everything
        // proposes), large=>5, never=>Infinity (destructive/external still
        // propose on the server path; kept simple here).
        const isLarge =
          attachments?.propose === true ||
          (result.operations.length > proposalThreshold() &&
            Object.keys(workspace.nodes).length > 0);
        setGenPhase("applying");

        if (isLarge) {
          const conversation: ChatEntry[] = [
            ...withUser,
            {
              role: "ai",
              text: `${explanation} — review ${result.operations.length} proposed changes.`,
              reply: `${reply} It's waiting for your review.`,
              ...skippedNote,
            },
          ];
          setChat(conversation);
          setBusy(true);
          // Enriched+FOLDED ops (Stage C2 + C5): the client already carries
          // the evidence; the server's approve-time enrichment is idempotent
          // over these and backfills any older client's raw ops.
          await openProposal({
            operations: foldedOps,
            request: text,
            explanation,
            ...(provenance ? { provenance } : {}),
            ...(result.runId ? { runId: result.runId } : {}),
          });
          // The ops themselves apply only on approval, but the request and
          // the review-gate reply are durable from this moment on.
          persist(workspace, conversation, projectName);
          return {
            outcome: "proposed",
            ops: result.operations.length,
            reply: `${reply} It's waiting for your review.`,
          };
        } else if (foldedOps.length === 0) {
          // Nothing to draw AND nothing said: that's a failed attempt, not an
          // answer. It used to land as "Applied 0 operations." — and on an
          // empty board the canvas went quietly back to the launch screen,
          // the request apparently lost. The failure arm below records it
          // with the prompt, and the launch screen offers it back.
          if (!result.explanation?.trim() && !result.reply?.trim() && !skippedNote.skippedOps) {
            throw new Error(
              "The AI answered but drew nothing — try again, or describe it another way.",
            );
          }
          // A clarifying reply (docs/26 locked philosophy): faced with an
          // ambiguous request the model asked a question instead of guessing,
          // so it returned no operations. Surface its question as a
          // conversational answer and commit nothing — no empty history entry,
          // no room broadcast, no canvas change.
          const conversation: ChatEntry[] = [
            ...withUser,
            { role: "ai", text: explanation, reply, ...skippedNote, drewNothing: true },
          ];
          setChat(conversation);
          persist(workspace, conversation, projectName);
          return { outcome: "answered", text: explanation, reply };
        } else {
          const next = applyStamped();
          // Google-Stitch-style reveal: sketch the new nodes in FLOW ORDER with
          // their connectors drawing in after each. The model emits CREATE_NODE
          // start→end, so creation order is flow order. Cleared on a timer so
          // later renders (pans, culling mounts, manual edits) stay instant —
          // only this freshly generated batch choreographs.
          const createdIds = foldedOps.flatMap((op) => (op.op === "CREATE_NODE" ? [op.id] : []));
          if (createdIds.length >= 2) {
            const order: Record<string, number> = {};
            createdIds.forEach((id, idx) => (order[id] = idx));
            setSketchOrder(order);
            if (sketchTimer.current) clearTimeout(sketchTimer.current);
            sketchTimer.current = setTimeout(
              () => setSketchOrder(null),
              Math.min(createdIds.length * 240 + 900, 6000),
            );
          }
          const conversation: ChatEntry[] = [
            ...withUser,
            {
              role: "ai",
              text: explanation,
              reply,
              ...skippedNote,
              effect: turnEffect(foldedOps),
            },
          ];
          setChat(conversation);
          // The folded ops, not the raw model batch — the stamp and the
          // folded topic ride into history and the room with them (Stage C2
          // + C5).
          commitAndShare(next, foldedOps, explanation, conversation, projectName, result.runId);
          return { outcome: "applied", ops: foldedOps.length, reply };
        }
      } catch (err) {
        // Retriable-failure affordance (found live, 2026-09-10): a transient
        // provider 502 left an empty board behind a transient toast; the
        // error persisted in chat, but re-running meant retyping the whole
        // request. A plan or quota refusal is NOT retriable by retrying — the
        // message already says what to do instead — so only transport and
        // provider failures carry the prompt. A user Cancel is never
        // retriable-as-failure: nothing was applied and retry is the pill.
        const msg = (err as Error).message ?? "";
        const cancelled = /^cancelled\b/i.test(msg);
        const retriable =
          !cancelled &&
          !(err instanceof PlanRefusalError) &&
          !/quota|rate limit|plan|auth|access/i.test(msg);
        const conversation: ChatEntry[] = [
          ...withUser,
          {
            role: "error",
            text: (err as Error).message,
            ...(retriable && text ? { retryPrompt: text } : {}),
          },
        ];
        setChat(conversation);
        // A network failure mid-stream used to swallow the user's message
        // entirely — on reload the board looked like the request never
        // happened. Keep the failed attempt visible.
        persist(workspace, conversation, projectName);
        return cancelled
          ? { outcome: "cancelled" }
          : { outcome: "failed", error: (err as Error).message };
      } finally {
        setBusy(false);
        setGenPhase(null);
        genAbortRef.current = null;
      }
    },
    [busy, chat, workspace, commitAndShare, projectName, readOnly, persist, openProposal],
  );

  /**
   * A batch computed on this side (docs/27 D2: a sticky wall sorted into
   * themes) that must be reviewed before it lands: validated here, then
   * opened as a proposal exactly like a model's large batch, with the request
   * and the review-gate reply in the chat.
   */
  const proposeOps = useCallback(
    async (operations: Operation[], request: string, explanation: string): Promise<boolean> => {
      if (readOnly || operations.length === 0) return false;
      if (validateOperations(workspace, operations).length > 0) return false;
      const conversation: ChatEntry[] = [
        ...chat,
        { role: "user", text: request },
        { role: "ai", text: `${explanation} — review ${operations.length} proposed changes.` },
      ];
      setChat(conversation);
      await openProposal({ operations, request, explanation });
      persist(workspace, conversation, projectName);
      return true;
    },
    [readOnly, workspace, chat, openProposal, persist, projectName],
  );

  /**
   * Ask Lucent (Stage C1): the read direction of the pill. Deliberately
   * permissive where `send` is strict — a VIEWER may ask (asking is reading:
   * the board's history is already viewer-visible, and the server validates
   * every citation against the caller's own window) — and deliberately
   * strict where `send` is loose: no shared boardId, no ask, because the
   * server-side history the answer draws from does not exist for a local
   * board. The refusal says how to fix that (share first), which is the
   * honest answer rather than an empty history.
   */
  const ask = useCallback(
    async (question: string): Promise<string | null> => {
      const text = question.trim();
      if (!text || busy) return null;
      const withUser: ChatEntry[] = [...chat, { role: "user", text }];
      setChat(withUser);
      setBusy(true);
      try {
        // Recent turns only (recentHistory caps at 8): follow-ups like
        // "and who did that?" resolve against the same conversation the
        // build path sends.
        const turns = chat
          .filter((c) => c.role === "user" || c.role === "ai")
          .slice(-8)
          .map((c) => ({
            role: c.role === "user" ? ("user" as const) : ("ai" as const),
            text: c.text,
          }));
        // ADR 0048: a board that lives only in this browser is asked from
        // what it holds (no history or meetings to cite); a shared board from
        // the server's full context.
        const result = boardId
          ? await askLucent(boardId, text, turns)
          : await askLocalBoard(text, workspace, projectName, turns);
        if ("error" in result) {
          const conversation: ChatEntry[] = [...withUser, { role: "error", text: result.error }];
          setChat(conversation);
          persist(workspace, conversation, projectName);
          return result.error;
        }
        const conversation: ChatEntry[] = [
          ...withUser,
          {
            role: "ai",
            text: result.answer,
            ...(result.citations.length
              ? {
                  citations: result.citations.map(
                    ({ kind, id, label, detail, why, turnRange }) => ({
                      kind,
                      id,
                      label,
                      ...(detail ? { detail } : {}),
                      ...(why ? { why } : {}),
                      ...(turnRange ? { turnRange } : {}),
                    }),
                  ),
                }
              : {}),
            ...("hasMore" in result && result.hasMore ? { historyTruncated: true } : {}),
            ...(result.confidence
              ? { confidence: { level: result.confidence.level, reason: result.confidence.reason } }
              : {}),
          },
        ];
        setChat(conversation);
        persist(workspace, conversation, projectName);
        return result.answer;
      } catch (err) {
        const conversation: ChatEntry[] = [
          ...withUser,
          { role: "error", text: (err as Error).message },
        ];
        setChat(conversation);
        persist(workspace, conversation, projectName);
        return (err as Error).message;
      } finally {
        setBusy(false);
      }
    },
    [busy, boardId, chat, workspace, persist, projectName],
  );

  // J7 (ADR 0048): a shared board's conversation is this person's thread on
  // the server, so it follows them to another browser and the meeting's
  // spoken questions share its context. It loads when the board opens (what
  // this browser held goes up the first time), each new user or Lucent turn
  // is appended, and clearing the chat clears the thread. Local boards keep
  // their chat in the browser: there is no server scope to hold it.
  const threadSync = useRef<{ boardId: string | null; sent: number; loading: boolean }>({
    boardId: null,
    sent: 0,
    loading: false,
  });
  useEffect(() => {
    if (!boardId || !hasSession()) {
      threadSync.current = { boardId: null, sent: 0, loading: false };
      return;
    }
    if (threadSync.current.boardId === boardId) return;
    threadSync.current = { boardId, sent: 0, loading: true };
    let cancelled = false;
    void loadThread(threadScope.board(boardId)).then((messages) => {
      if (cancelled || threadSync.current.boardId !== boardId) return;
      if (messages && messages.length > 0) {
        const entries: ChatEntry[] = messages.map((m) => ({
          role: m.role,
          text: m.text,
          ...(m.reply ? { reply: m.reply } : {}),
          ...(Array.isArray(m.citations) && m.citations.length
            ? { citations: m.citations as NonNullable<ChatEntry["citations"]> }
            : {}),
        }));
        threadSync.current = { boardId, sent: entries.length, loading: false };
        setChat(entries);
      } else {
        threadSync.current = { boardId, sent: 0, loading: false };
        // Nothing on the server yet: the append effect sends what's here.
        setChat((c) => [...c]);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [boardId]);
  useEffect(() => {
    const sync = threadSync.current;
    if (!boardId || sync.boardId !== boardId || sync.loading) return;
    const said = chat.filter((c) => c.role === "user" || c.role === "ai");
    if (said.length < sync.sent) {
      sync.sent = said.length;
      if (said.length === 0) void clearThread(threadScope.board(boardId));
      return;
    }
    const fresh = said.slice(sync.sent);
    if (fresh.length === 0) return;
    sync.sent = said.length;
    void appendThread(
      threadScope.board(boardId),
      fresh.map((c) => ({
        role: c.role as "user" | "ai",
        text: c.text,
        surface: c.citations ? ("ask" as const) : ("chat" as const),
        at: Date.now(),
        ...(c.reply && c.reply !== c.text ? { reply: c.reply } : {}),
        ...(c.citations?.length ? { citations: c.citations } : {}),
      })),
    );
  }, [chat, boardId]);

  /**
   * Citation navigation (Stage C1). The views own the actual navigation
   * (canvas focus, transcript scrolling, history deep-link); this is the
   * workspace-level seam that picks the destination view and sets the URL
   * params the views' mount effects honor:
   *
   *   node     → canvas, selection handled by the view's own handler
   *   meeting  → ?meeting=<id>[&turn=<start>] + the meeting view
   *   revision → ?rev=<seq> + the history view
   *
   * The node case just switches to the canvas here — the select+focus jump
   * is CanvasView's, driven through the same URL-free path its Tab traversal
   * uses; the citation's id travels in the search params for simplicity and
   * deep-linkability of the other two.
   */
  const onCitation = useCallback(
    (citation: {
      kind: "node" | "meeting" | "revision";
      id: string;
      turnRange?: [number, number];
    }) => {
      const params = new URLSearchParams(window.location.search);
      if (citation.kind === "node") {
        params.set("reveal", citation.id);
        window.history.replaceState(null, "", `?${params.toString()}`);
        setView("canvas");
        return;
      }
      if (citation.kind === "meeting") {
        params.set("meeting", citation.id);
        if (citation.turnRange) params.set("turn", String(citation.turnRange[0]));
        window.history.replaceState(null, "", `?${params.toString()}`);
        setView("meeting");
        return;
      }
      params.set("rev", citation.id);
      window.history.replaceState(null, "", `?${params.toString()}`);
      setView("history");
    },
    [setView],
  );

  /** ADR 0048: show an answer's evidence together — the canvas selects and frames them all. */
  const revealNodes = useCallback(
    (ids: string[]) => {
      if (ids.length === 0) return;
      const params = new URLSearchParams(window.location.search);
      params.set("reveal", ids.join(","));
      window.history.replaceState(null, "", `?${params.toString()}`);
      setView("canvas");
    },
    [setView],
  );

  /** Shared idempotency: claim the pending record, or no-op when decided. */
  const claimDecision = useCallback((decision: "approved" | "rejected"): boolean => {
    const record = proposalRecordRef.current;
    // Nothing open, or already decided (a double-click, a replayed call, or
    // a record rehydrated after its decision): a no-op, never a second
    // apply of the same batch.
    if (!record || !proposalIsPending(record)) return false;
    if (decidedRef.current === record.id) return false;
    decidedRef.current = record.id;
    const archived = archiveDecision(
      { proposal: record, proposalHistory: proposalHistoryRef.current },
      decision,
    );
    proposalRecordRef.current = archived.proposal;
    proposalHistoryRef.current = archived.proposalHistory;
    return true;
  }, []);

  const applyProposal = useCallback(() => {
    if (!proposal) return;
    if (readOnly) return;
    // Server-side record (Stage B3): the decision goes to the server, which
    // re-validates against the CURRENT board, commits through the room (so
    // peers receive the same sequenced entry, stamped with the AI actor and
    // the accountability chain), and enforces once-only — a second browser's
    // approve is a read. This browser's local state catches up through the
    // room's ordinary broadcast, so there is nothing to apply locally.
    const server = serverProposalRef.current;
    if (server) {
      // The same synchronous guard as claimDecision: a double-click must not
      // fire two requests. The server is the durable backstop.
      if (decidedRef.current === proposal.id) return;
      decidedRef.current = proposal.id;
      setProposal(null); // the panel closes immediately; the ops arrive via WS
      void decideServerProposal(server.boardId, server.id, "approve").then((out) => {
        serverProposalRef.current = null;
        if (!out) {
          setChat((c) => [
            ...c,
            { role: "error", text: "Could not approve the proposal on the server." },
          ]);
          decidedRef.current = null; // allow a retry
          return;
        }
        setChat((c) => [
          ...c,
          {
            role: "ai",
            text: out.duplicate
              ? "Proposal was already decided by someone else."
              : `Applied ${out.proposal.appliedSeq !== null ? "the" : ""} proposal changes as one commit.`,
          },
        ]);
      });
      return;
    }
    // Idempotency FIRST — a double click must not commit the batch twice.
    if (!claimDecision("approved")) return;
    // Re-validate against the CURRENT board: a rehydrated proposal may
    // reference nodes deleted before the reload. Partial application (the
    // same one-simulator partition the server uses, M1) applies the valid
    // remainder and surfaces the skips, instead of blindly committing ops
    // against a board that changed under them.
    //
    // Stage C2 (ADR 0022): a local proposal's evidence rides its ops, exactly
    // like the send path and the server's approve path. The proposal record
    // carries the meeting id/turns/kinds; enrich the ops BEFORE applying, so
    // the stamp reaches history, peers, and the server with the batch instead
    // of living in this browser's memory (the divergence this replaces).
    const evidence = proposal.meetingId
      ? {
          meetingId: proposal.meetingId,
          ...(proposal.turnRange ? { turnRange: proposal.turnRange } : {}),
          ...(proposal.turnKinds?.length
            ? { turnKinds: proposal.turnKinds }
            : proposal.turns?.some((t) => classifyTurn(t))
              ? {
                  turnKinds: (proposal.turns ?? [])
                    .map((t) => classifyTurn(t))
                    .filter((k): k is NonNullable<ReturnType<typeof classifyTurn>> => Boolean(k)),
                }
              : {}),
          ...((proposal.turns?.length ?? 0) > 0
            ? { quote: (proposal.turns ?? []).join(" ").slice(0, 240) }
            : {}),
        }
      : undefined;
    const candidateOps = evidence
      ? attachProvenance(proposal.operations, evidence)
      : proposal.operations;
    // The topic fold (Stage C5): a local proposal is the model's output —
    // fold its topics against the workspace before applying, mirroring the
    // server's approve-time fold. (The server path above folds at commit;
    // this browser-local path is local boards' only fold site.)
    // ADR 0047, the local twin of the server's approve: a meeting's
    // extraction stays a suggestion; a request the person reviewed is theirs.
    const foldedProposalOps = stampTrust(
      foldStatementTopics(candidateOps, existingTopics(workspace)),
      proposal.meetingId ? "agent" : "requested",
      workspace,
    );
    const partial = applyValidOperations(workspace, foldedProposalOps);
    const appliedOps = partial.applied.length > 0 ? partial.applied : foldedProposalOps;
    const next = partial.workspace;
    const skippedNote =
      partial.skipped.length > 0
        ? ` (${partial.skipped.length} skipped — the board changed since this was proposed)`
        : "";
    const conversation: ChatEntry[] = [
      ...chat,
      {
        role: "ai",
        text: `Applied ${appliedOps.length} changes as one commit.${skippedNote}`,
        effect: turnEffect(appliedOps),
      },
    ];
    setChat(conversation);
    commitAndShare(next, appliedOps, proposal.explanation, conversation, projectName);
    // The panel closes; the record (now status:"approved") stays in the ref
    // so the very next persist() archives it durably.
    setProposal(null);
  }, [proposal, workspace, chat, claimDecision, commitAndShare, projectName, readOnly]);

  const cancelProposal = useCallback(() => {
    // Server-side record: the refusal is also the server's to record, so the
    // decision is visible to every member and survives this browser.
    const server = serverProposalRef.current;
    if (server && proposal) {
      if (decidedRef.current === proposal.id) return;
      decidedRef.current = proposal.id;
      setProposal(null);
      void decideServerProposal(server.boardId, server.id, "reject").then(() => {
        serverProposalRef.current = null;
      });
      return;
    }
    // Idempotent reject: the record archives as rejected, not destroyed.
    if (!claimDecision("rejected")) return;
    setProposal(null);
  }, [claimDecision, proposal]);

  const undo = useCallback(() => {
    const { workspace: next, ops } = historyRef.current.undo();
    // History replays ops, and ops carry no coordinates — positions come only
    // from the layout pass. Relayout here or every node renders at (0,0)
    // after the first undo (found live: a 33-node board stacked to a point).
    const needsLayout = opsNeedLayout(ops);
    const positioned = needsLayout ? laidOut(next) : next;
    setWorkspace(positioned);
    setTick((t) => t + 1);
    if (ops.length > 0) {
      syncRef.current?.commit(ops, "undo");
      persist(positioned, chat, projectName);
      // Phase 2 (doc 18 Phase 4): the replayed board re-derives geometry, so
      // the ELK refinement is legitimate here too.
      if (needsLayout) {
        void refineLayout(positioned, { kind: "board" }, true);
      }
    }
  }, [chat, persist, projectName, refineLayout]);
  const redo = useCallback(() => {
    const { workspace: next, ops } = historyRef.current.redo();
    // Same as undo: the replayed workspace has no positions of its own.
    const needsLayout = opsNeedLayout(ops);
    const positioned = needsLayout ? laidOut(next) : next;
    setWorkspace(positioned);
    setTick((t) => t + 1);
    if (ops.length > 0) {
      syncRef.current?.commit(ops, "redo");
      persist(positioned, chat, projectName);
      if (needsLayout) {
        void refineLayout(positioned, { kind: "board" }, true);
      }
    }
  }, [chat, persist, projectName, refineLayout]);

  const restoreVersion = useCallback(
    (index: number) => {
      const { workspace: restored, ops } = historyRef.current.restoreTo(index);
      // Version restore replays history ops — same no-positions rule as undo.
      const needsLayout = opsNeedLayout(ops);
      const positioned = needsLayout ? laidOut(restored) : restored;
      setWorkspace(positioned);
      setTick((t) => t + 1);
      const conversation: ChatEntry[] = [
        ...chat,
        {
          role: "ai",
          text: `Restored an earlier version (${Object.keys(restored.nodes).length} nodes).`,
        },
      ];
      setChat(conversation);
      if (ops.length > 0) syncRef.current?.commit(ops, "restore");
      persist(positioned, conversation, projectName);
      // Same phase-2 rule as undo/redo: restore re-derives geometry.
      if (needsLayout) {
        void refineLayout(positioned, { kind: "board" }, true);
      }
    },
    [chat, persist, projectName, refineLayout],
  );

  const selectDiagram = useCallback(
    (kind: DiagramKind) => {
      if (readOnly) return;
      const ops: Operation[] = [{ op: "TRANSFORM_DIAGRAM", to: kind }];
      const next = applyOperations(workspace, ops);
      // The registry's human label: the chat and the history list are read by
      // people, who know a "State machine", not a "statemachine".
      const label = representationLabel(kind);
      const conversation: ChatEntry[] = [
        ...chat,
        { role: "ai", text: `Switched to ${label} view.` },
      ];
      setChat(conversation);
      commitAndShare(next, ops, `Transform to ${label}`, conversation, projectName);
    },
    [workspace, chat, commitAndShare, projectName, readOnly],
  );

  const applyManual = useCallback(
    (ops: Operation[], label: string): boolean => {
      if (ops.length === 0) return false;
      // A viewer's operations would be rejected by the server anyway; refusing
      // here keeps local state from diverging from the room in the meantime.
      // A commenter's comments, reactions and votes go through (docs/26 F8).
      if (readOnly && !(canComment && isConversationOnly(ops))) return false;
      // ADR 0047: a person's own statement is human-created; relabelling one
      // the AI suggested makes it human-edited.
      const stamped = stampTrust(withEditTrust(ops, workspace), "manual", workspace);
      const errors = validateOperations(workspace, stamped);
      if (errors.length > 0) return false;
      const next = applyOperations(workspace, stamped);
      // Manual edits do not add chat turns; commit to history + persist + share.
      commitAndShare(next, stamped, label, chat, projectName);
      return true;
    },
    [workspace, chat, commitAndShare, projectName, readOnly, canComment],
  );

  const setRegionKind = useCallback(
    (groupId: string, kind: DiagramKind | null) => {
      // Manual edit path: no chat turn, but the same validation + undo as any
      // other op. Reuses applyManual so a viewer can't flip a region either.
      applyManual(
        [{ op: "SET_GROUP_KIND", id: groupId, kind }],
        kind ? `Region → ${representationLabel(kind)}` : "Region → board layout",
      );
    },
    [applyManual],
  );

  const convertBoard = useCallback(
    (kind: DiagramKind) => {
      if (readOnly) return;
      // A fresh prefix per insert: the reducer rejects duplicate ids, and a
      // second "start a flowchart" after an undo must not collide with the first.
      const prefix = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
      const { ops, seeded } = convertBoardOps(workspace, kind, prefix);
      if (seeded) applyManual(ops, `Start a ${representationLabel(kind)}`);
      else selectDiagram(kind);
    },
    [workspace, readOnly, applyManual, selectDiagram],
  );

  const newProject = useCallback(() => {
    const id = newProjectId();
    // A collision-free default name: every "New workspace" used to save the
    // same hardcoded "Untitled workspace", so every card in the dashboard
    // carried an identical name across sessions.
    const name = uniqueProjectName();
    const fresh = new OperationHistory(createWorkspace(), "initial");
    // Write the record synchronously BEFORE the pointer moves: the autosave
    // races a reload, and the boot restore crashes on a pointer whose record
    // does not exist yet (`restored.workspace` of undefined) — the same
    // invariant startNewBoardFor already carries.
    saveProject({ id, name, workspace: fresh.current(), chat: [] });
    historyRef.current = fresh;
    setProjectId(id);
    setProjectName(name);
    setWorkspace(fresh.current());
    setChat([]);
    // The new project has no proposal record; leaving the old one in the
    // refs would write the previous board's proposal into this slot's first
    // autosave (cross-project leak).
    proposalRecordRef.current = undefined;
    proposalHistoryRef.current = [];
    decidedRef.current = null;
    setProposal(null);
    setView("canvas");
    setTick((t) => t + 1);
    setLastOpenProject(id);
    // A deliberate move to a local board ends the shared-board session —
    // transport included, not just the pointer: without the disconnect, a
    // local edit could still reach the previous room through commitAndShare.
    // Without this clear, the boot rejoin effect kept adopting the LAST
    // shared board on every reload — the user's "New workspace" was undone
    // by the next refresh (found live: a K8s board was silently replaced by
    // a shared board from an earlier session).
    setSharedBoardId(null);
    leaveSharedBoard();
  }, [leaveSharedBoard]);

  /**
   * Parallel diagrams: open a FRESH board and immediately send `prompt` to it,
   * leaving the current board exactly as it is. This is the one-click path for
   * the AI's "this looks like a new board" reply — the user described a
   * different system, and the product's answer is a new workspace, not a
   * merge into the diagram they were reading.
   *
   * Two invariants, both learned from the live test pass:
   *   1. A valid project record is written SYNCHRONOUSLY before anything
   *      else runs. The first cut relied on the autosave, which races: the
   *      last-open pointer moved to an id whose record did not exist yet, and
   *      a reload in that window crashed the boot restore on
   *      `restored.workspace`.
   *   2. `send` closes over the CURRENT workspace and chat, so calling it in
   *      the same tick would send the OLD board's context. The prompt is
   *      parked in a ref that an effect consumes after the fresh workspace
   *      state has landed.
   */
  const pendingNewBoardPrompt = useRef<string | null>(null);
  const startNewBoardFor = useCallback(
    (prompt: string) => {
      const id = newProjectId();
      const name = prompt.slice(0, 40).trim() || "New board";
      const fresh = createWorkspace();
      // Same synchronous write openProject's import path uses: the record
      // exists, well-formed, before the pointer moves to it.
      saveProject({ id, name, workspace: fresh, chat: [] });
      historyRef.current = new OperationHistory(fresh, "initial");
      setProjectId(id);
      setProjectName(name);
      setWorkspace(fresh);
      setChat([]);
      // Fresh project: no proposal record carries over.
      proposalRecordRef.current = undefined;
      proposalHistoryRef.current = [];
      decidedRef.current = null;
      setProposal(null);
      setView("canvas");
      setLastOpenProject(id);
      pendingNewBoardPrompt.current = prompt;
      setTick((t) => t + 1);
      // Same isolation as newProject: the generated board is local, so the
      // previous shared session (socket, role, ?board=) must not survive into it.
      setSharedBoardId(null);
      leaveSharedBoard();
    },
    [leaveSharedBoard],
  );

  useEffect(() => {
    const prompt = pendingNewBoardPrompt.current;
    if (!prompt) return;
    pendingNewBoardPrompt.current = null;
    // The fresh workspace is now current; send from THIS render's closures.
    void send(prompt);
    // `send` is stable per workspace state and runs once per parked prompt.
  }, [workspace, send]);

  /**
   * Load a board from an imported JSON file into a new project.
   *
   * The file is fully untrusted — no operation validator ever saw it — so it can
   * carry a shape `src`, `fill` or `path` that reaches an <img>, an iframe or the
   * SVG export. parseWorkspace is the one contract for that, and it already
   * defaults every collection a board from an older build may be missing, which
   * is why the hand-rolled repair spread that used to stand here is gone rather
   * than layered underneath it. A file that fails is refused outright: the user
   * chose it, so quietly opening an empty board would look like a successful
   * import of an empty board.
   */
  const importWorkspace = useCallback(
    (imported: unknown, name = "Imported board") => {
      const review = reviewWorkspace(imported, "That file");
      if (!review.workspace) {
        setChat((c) => [
          ...c,
          { role: "error", text: review.error ?? "That file isn't a valid Lucent board" },
        ]);
        return;
      }
      const safe = review.workspace;
      const id = newProjectId();
      historyRef.current = new OperationHistory(safe, "imported");
      setProjectId(id);
      setProjectName(name);
      setWorkspace(safe);
      setChat([]);
      // Imported boards carry no proposal state of their own.
      proposalRecordRef.current = undefined;
      proposalHistoryRef.current = [];
      decidedRef.current = null;
      setProposal(null);
      setView("canvas");
      setTick((t) => t + 1);
      saveProject({ id, name, workspace: safe, chat: [] });
      setLastOpenProject(id);
      // An import creates a fresh LOCAL project; the shared session of whatever
      // board was open before must not survive into it.
      setSharedBoardId(null);
      leaveSharedBoard();
    },
    [leaveSharedBoard],
  );

  const openProject = useCallback(
    (id: string) => {
      const data = loadProject(id);
      if (!data) return;
      // Same untrusted input as the reload path — localStorage is writable by any
      // XSS on this origin and holds boards written by older builds — but reported
      // rather than silently defaulted: the user picked this project by name, so a
      // blank canvas with no explanation would read as lost work. The board still
      // opens (empty) so they are not stranded on a project they cannot leave.
      const review = reviewWorkspace(data.workspace, "That saved board");
      const safe = review.workspace ?? createWorkspace();
      // An older build may have stored a project with no conversation at all.
      const conversation: ChatEntry[] = Array.isArray(data.chat) ? data.chat : [];
      historyRef.current = new OperationHistory(safe, "loaded");
      setProjectId(data.id);
      setProjectName(data.name);
      setWorkspace(safe);
      setChat(
        review.error ? [...conversation, { role: "error", text: review.error }] : conversation,
      );
      // Open THIS project's proposal state: a pending record reopens the panel;
      // a decided one keeps its place in the slot but stays inert, and its
      // history rides along.
      proposalRecordRef.current = data.proposal;
      proposalHistoryRef.current = data.proposalHistory ?? [];
      decidedRef.current = null;
      setProposal(data.proposal && proposalIsPending(data.proposal) ? data.proposal : null);
      setView("canvas");
      setTick((t) => t + 1);
      setLastOpenProject(data.id);
      // Same as newProject: opening a local project leaves the shared-board
      // session, or the next reload swaps the user back into the shared board.
      setSharedBoardId(null);
      leaveSharedBoard();
    },
    [leaveSharedBoard],
  );

  /**
   * Open a board that lives on the server, given its id. The dashboard's
   * server-backed list needs this: those boards have no local copy to load, so
   * `openProject` cannot reach them, and joining the realtime room is what makes
   * two people opening the same card collaborate rather than fork.
   *
   * The chat starts empty because the conversation is per-browser (it is not on
   * the server yet), and a previous project's transcript sitting under a board
   * someone else authored reads as history that never happened.
   */
  const openBoard = useCallback(
    async (id: string): Promise<boolean> => {
      const board = await fetchBoard(id);
      // 404 covers both "gone" and "not shared with you" - the server does not
      // distinguish them on purpose, and neither can we.
      if (!board) return false;
      adoptBoard(board);
      setChat([]);
      setProposal(null);
      setView("canvas");
      return true;
    },
    [adoptBoard],
  );

  const canvasPhase: CanvasPhase = useMemo(() => {
    if (proposal) return "proposing";
    if (listening) return "voice";
    if (busy) return "generating";
    // Empty means genuinely nothing on the board. Wireframes count as content:
    // a board whose only result is a wireframe used to report "empty", so
    // returning to the canvas showed the first-run hero and read as a brand-new
    // board even though the work was intact.
    if (
      Object.keys(workspace.nodes).length === 0 &&
      Object.keys(workspace.shapes).length === 0 &&
      Object.keys(workspace.wireframes).length === 0
    )
      return "empty";
    return "main";
  }, [proposal, listening, busy, workspace.nodes, workspace.shapes, workspace.wireframes]);

  const nameFor = useCallback(
    (userId: string): string => {
      // 1. The signed-in user is always known to themselves.
      const me = getSessionUser();
      if (me && me.id === userId) return me.name;
      // 2. Anyone currently in the room (live cursors) has a name from the
      //    server's welcome broadcast.
      for (const peer of peers) {
        if (peer.userId === userId) return peer.name;
      }
      // 3. Unknown authors fall back to the raw id rather than disappearing.
      return userId;
    },
    [peers],
  );

  const value: WorkspaceState = {
    view,
    setView,
    lens,
    setLens,
    projectId,
    projectName,
    setProjectName,
    workspace,
    chat,
    busy,
    streamChars,
    streamNodes,
    sketchOrder,
    cancelSketch,
    genPhase,
    cancelSend,
    listening,
    setListening,
    proposal,
    canvasPhase,
    history: historyRef.current,
    canUndo: historyRef.current.canUndo(),
    canRedo: historyRef.current.canRedo(),
    peers,
    setPresence,
    spotlight,
    setSpotlight,
    summon,
    lastSummon,
    syncStatus,
    syncRole,
    readOnly,
    canComment,
    boardId,
    startSharing,
    openBoard,
    send,
    proposeOps,
    ask,
    pillMode,
    setPillMode,
    onCitation,
    revealNodes,
    applyProposal,
    cancelProposal,
    undo,
    redo,
    restoreVersion,
    selectDiagram,
    convertBoard,
    setRegionKind,
    layoutStatus,
    retryLayout,
    nameFor,
    applyManual,
    newProject,
    startNewBoardFor,
    openProject,
    importWorkspace,
  };
  // reference tick so lint keeps the dependency; forces context identity refresh
  void tick;

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useWorkspace(): WorkspaceState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useWorkspace must be used within WorkspaceProvider");
  return ctx;
}

/**
 * The null-safe read for surfaces that can mount OUTSIDE the provider — the
 * settings modal (⌘, on the auth screen), org pages, anything reachable
 * before or after a workspace lifetime. Returns null instead of throwing so
 * those surfaces can degrade (a diagnostics report without the board
 * section) rather than crash; components inside the provider keep the
 * throwing `useWorkspace` so a wiring mistake still fails loudly.
 */
export function useWorkspaceOptional(): WorkspaceState | null {
  return useContext(Ctx);
}
