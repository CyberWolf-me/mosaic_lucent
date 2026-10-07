import type {
  DiagramKind,
  Operation,
  RepresentationLens,
  Workspace,
  ClarificationChoice,
} from "@lucent/core";
import type { ChatEntry, ProposalStatus } from "./persistence.js";
import type { Peer, Spotlight, Viewport } from "./boardSync.js";
import type { BoardRole } from "./boards.js";
import type { OperationHistory } from "@lucent/core";

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
export const LEGACY_LENS_VIEWS: Partial<Record<View, CanvasLens>> = {
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

/** Realtime link state. "offline" covers both signed-out and disconnected. */
export type SyncStatus = "offline" | "connecting" | "online";

/**
 * A review-gate proposal. One shape for the live state AND the persisted
 * record.
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
  /** Provenance to stamp on whatever this request creates (M2). */
  provenance?: {
    meetingId: string;
    turns: string[];
    turnRange?: [number, number];
    turnKinds?: string[];
  };
  /** Stage D2: plan derived from named statements. */
  plan?: { statementIds: string[] };
  /** Where the person asked, when it wasn't typed on the canvas. */
  surface?: "voice";
  /** Forces result to proposal. */
  propose?: boolean;
}

/** UX-2: user-facing generation phases. */
export type GenPhase = "understanding" | "constructing" | "validating" | "applying";

/**
 * What a `send` actually did (P1-MT-002) — the honest terminal states the
 * pipeline can reach.
 */
export type SendOutcome =
  | { outcome: "applied"; ops: number; reply: string }
  | { outcome: "proposed"; ops: number; reply: string }
  | { outcome: "answered"; text: string; reply: string }
  | { outcome: "rejected" }
  | { outcome: "failed"; error: string }
  | { outcome: "busy" }
  | { outcome: "refused" }
  | { outcome: "cancelled" };

export interface WorkspaceState {
  view: View;
  setView: (v: View) => void;
  lens: CanvasLens;
  setLens: (l: CanvasLens) => void;

  projectId: string;
  projectName: string;
  setProjectName: (n: string) => void;

  workspace: Workspace;
  chat: ChatEntry[];
  rules: string;
  setRules: (rules: string) => void;

  busy: boolean;
  streamChars: number;
  streamNodes: string[];
  sketchOrder: Record<string, number> | null;
  cancelSketch: () => void;
  genPhase: GenPhase | null;
  cancelSend: () => void;
  listening: boolean;
  setListening: (v: boolean) => void;

  proposal: Proposal | null;
  canvasPhase: CanvasPhase;

  history: OperationHistory;
  canUndo: boolean;
  canRedo: boolean;

  peers: Peer[];
  setPresence: (update: {
    cursor?: { x: number; y: number } | null;
    selection?: string[];
    viewport?: Viewport | null;
  }) => void;
  spotlight: Spotlight | null;
  setSpotlight: (on: boolean) => void;
  summon: (viewport: Viewport) => void;
  lastSummon: { from: Spotlight; viewport: Viewport; at: number } | null;
  syncStatus: SyncStatus;
  syncRole: BoardRole | null;
  readOnly: boolean;
  canComment: boolean;
  boardId: string | null;
  startSharing: () => Promise<string | null>;
  startSharingDetailed: () => Promise<{ ok: true; boardId: string } | { ok: false; error: string }>;
  openBoard: (id: string) => Promise<boolean>;

  send: (
    message: string,
    selection?: string[],
    attachments?: SendAttachments,
  ) => Promise<SendOutcome>;
  ask: (question: string) => Promise<string | null>;
  pillMode: "build" | "ask";
  setPillMode: (mode: "build" | "ask") => void;
  onCitation: (citation: {
    kind: "node" | "meeting" | "revision";
    id: string;
    turnRange?: [number, number];
  }) => void;
  revealNodes: (ids: string[]) => void;
  proposeOps: (operations: Operation[], request: string, explanation: string) => Promise<boolean>;
  applyProposal: () => void;
  cancelProposal: () => void;
  undo: () => void;
  redo: () => void;
  restoreVersion: (index: number) => void;
  selectDiagram: (kind: DiagramKind) => void;
  convertBoard: (kind: DiagramKind) => void;
  setRegionKind: (groupId: string, kind: DiagramKind | null) => void;
  layoutStatus: { phase: "idle" } | { phase: "refining" } | { phase: "degraded" };
  retryLayout: () => void;
  applyManual: (ops: Operation[], label: string) => boolean;

  startNewBoardFor: (prompt: string) => void;
  nameFor: (userId: string) => string;

  newProject: () => void;
  openProject: (id: string) => void;
  importWorkspace: (imported: unknown, name?: string) => void;
  clarification: ClarificationChoice | null;
  clearClarification: () => void;
  streamThinking: string;
}
