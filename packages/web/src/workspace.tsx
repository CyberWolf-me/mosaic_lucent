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
import {
  OperationHistory,
  applyLayout,
  applyOperations,
  applyValidOperations,
  attachProvenance,
  computeLayout,
  createWorkspace,
  parseWorkspace,
  parseWorkspaceOrDefault,
  relayoutRegion,
  separateRegions,
  validateOperations,
  type DiagramKind,
  type Operation,
  type Workspace,
} from "@lucent/core";
import { streamGenerate } from "./api.js";
import { classifyTurn } from "./meetings.js";
import { BoardSync, type Peer } from "./boardSync.js";
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
import { loadOrgs } from "./orgs.js";
import { getSessionUser } from "./session.js";
import {
  archiveDecision,
  getSharedBoardId,
  loadLastOpenProject,
  loadProject,
  mirrorProjectId,
  newProjectId,
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

/**
 * Central workspace state: the real @lucent/core Workspace + History, the
 * conversation, and the pending AI proposal. Replaces the prototype's
 * window.__lucentGo globals with typed React context. All coordinates come from
 * computeLayout — the AI never sets them (docs/03, docs/11).
 */

export type View =
  | "dashboard"
  | "canvas"
  | "history"
  | "meeting"
  | "wireframe"
  | "sequence"
  | "er"
  | "board"
  | "document"
  | "admin"
  | "analytics";

/** Canvas sub-state is derived from the data, not stored separately. */
export type CanvasPhase = "empty" | "generating" | "main" | "proposing" | "voice";

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
}

export interface WorkspaceState {
  view: View;
  setView: (v: View) => void;

  projectId: string;
  projectName: string;
  setProjectName: (n: string) => void;

  workspace: Workspace;
  chat: ChatEntry[];

  busy: boolean;
  /** M5/E1: streamed-payload characters received so far while busy; 0 otherwise. */
  streamChars: number;
  listening: boolean;
  setListening: (v: boolean) => void;

  proposal: Proposal | null;
  canvasPhase: CanvasPhase;

  history: OperationHistory;
  canUndo: boolean;
  canRedo: boolean;

  /** Live collaborators on the current board (empty when offline/solo). */
  peers: Peer[];
  /** Report this user's cursor/selection to collaborators. */
  setPresence: (update: { cursor?: { x: number; y: number } | null; selection?: string[] }) => void;
  /** Realtime connection state, for the share dialog and a status dot. */
  syncStatus: SyncStatus;
  /** This user's role on the shared board, once connected. */
  syncRole: "owner" | "editor" | "viewer" | null;
  /**
   * True when this user may look but not touch: they joined someone else's
   * shared board as a viewer. The server already rejects their operations, so
   * without this the UI would offer edits that silently bounce. Every editing
   * entry point must check it — `applyManual` and `send` refuse outright, and
   * the views hide the affordances rather than letting them fail.
   */
  readOnly: boolean;
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

  send: (message: string, selection?: string[], attachments?: SendAttachments) => Promise<void>;
  /**
   * Ask Lucent (Stage C1): the read direction of the AI pill's Build/Ask
   * split. The question goes to POST /api/boards/:id/ask over the shared
   * board's history; the reply lands in the chat with citations attached.
   * Read-only: an ask never mutates the board, and a viewer may ask (asking
   * is reading — the same content the history view shows, answered by the
   * model instead of listed).
   */
  ask: (question: string) => Promise<void>;
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
  applyProposal: () => void;
  cancelProposal: () => void;
  undo: () => void;
  redo: () => void;
  restoreVersion: (index: number) => void;
  selectDiagram: (kind: DiagramKind) => void;
  /**
   * Change one region's diagram kind (a group with a kind), or clear it back
   * to the board-wide layout with `null`. The manual counterpart of the AI's
   * SET_GROUP_KIND — same op, same undo.
   */
  setRegionKind: (groupId: string, kind: DiagramKind | null) => void;
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

/** Operations beyond this count present as a reviewable proposal (docs/15). */
const PROPOSAL_THRESHOLD = 5;

function laidOut(ws: Workspace): Workspace {
  // No strategy is passed: computeLayout picks radial for mind maps and layered
  // otherwise, so switching representation actually changes the arrangement.
  return applyLayout(ws, computeLayout(ws, { direction: "vertical" }));
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
 */
function laidOutScoped(ws: Workspace, touched: ReadonlySet<string>): Workspace {
  if (touched.size === 0) return laidOut(ws);
  const groupIds = new Set<string>();
  for (const id of touched) {
    const g = ws.nodes[id]?.groupId ?? ws.groups[id]?.id;
    if (!g) return laidOut(ws); // unscoped: a batch touching loose nodes relayouts all
    groupIds.add(g);
  }
  if (groupIds.size !== 1) return laidOut(ws); // crosses regions: global pass
  const groupId = [...groupIds][0];
  if (!groupId) return laidOut(ws);
  const regionResult = relayoutRegion(ws, groupId);
  if (!regionResult) return laidOut(ws);
  let next = applyLayout(ws, regionResult);
  // Growth can extend the region into a right-hand neighbour; push only the
  // neighbours actually overlapped (never a global shuffle).
  const shifts = separateRegions(next, groupId);
  if (shifts) {
    for (const [id, placed] of Object.entries(shifts)) {
      const node = next.nodes[id];
      if (node) next = { ...next, nodes: { ...next.nodes, [id]: { ...node, ...placed } } };
    }
  }
  return next;
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

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  // Resume the project that was open before the reload. Doing this during the
  // initial state computation (rather than in an effect) avoids a flash of an
  // empty board and keeps History seeded with the restored workspace.
  const restored = useRef(loadLastOpenProject()).current;

  // The restored blob comes out of localStorage, so it gets the same parse as a
  // board fetched from the server. Silent here on purpose: this runs before any
  // chat surface exists to report into, and nobody asked for this board by name —
  // parseWorkspaceOrDefault warns the console and hands back an empty one.
  const historyRef = useRef(
    new OperationHistory(
      // A restored board may predate positions on this node (history replay,
      // an old save, a server fetch): lay it out once at boot so the canvas
      // never renders every card stacked at the origin.
      restored ? laidOut(withDefaults(restored.workspace)) : createWorkspace(),
      restored ? "loaded" : "initial",
    ),
  );
  const [view, setView] = useState<View>("canvas");
  const [projectId, setProjectId] = useState(restored?.id ?? newProjectId());
  const [projectName, setProjectName] = useState(restored?.name ?? "Untitled workspace");
  // Called, not passed: `useState` treats a bare function as a lazy initializer
  // and would invoke `current` detached from the instance — `this.workspace`
  // on undefined. The arrow keeps it bound and runs exactly once.
  const [workspace, setWorkspace] = useState<Workspace>(() => historyRef.current.current());
  const [chat, setChat] = useState<ChatEntry[]>(restored?.chat ?? []);
  const [busy, setBusy] = useState(false);
  /** M5/E1: characters of the streamed payload received so far (display only). */
  const [streamChars, setStreamChars] = useState(0);
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
  // Live collaborators. Populated only when a server-side board is open and the
  // realtime socket is connected; empty in the offline/solo localStorage flow.
  const [peers, setPeers] = useState<Peer[]>([]);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>("offline");
  const [syncRole, setSyncRole] = useState<"owner" | "editor" | "viewer" | null>(null);
  const [boardId, setBoardId] = useState<string | null>(null);
  // A viewer may read the board but not change it. Derived rather than stored so
  // it can never disagree with the role the server assigned.
  const readOnly = syncRole === "viewer";
  const syncRef = useRef<BoardSync | null>(null);
  // Set while applying a server broadcast, so the echo isn't re-sent as a new
  // local edit (which would loop the room).
  const applyingRemote = useRef(false);

  const setPresence = useCallback(
    (update: { cursor?: { x: number; y: number } | null; selection?: string[] }) => {
      syncRef.current?.setPresence(update);
    },
    [],
  );

  /**
   * Attach a realtime session to a server-side board. The server is
   * authoritative: its broadcasts replace local state, and local commits are
   * sent for sequencing rather than applied twice.
   */
  const connectSync = useCallback((id: string, initial: Workspace) => {
    syncRef.current?.disconnect();
    const sync = new BoardSync(id, initial, {
      onWorkspace: (ws) => {
        applyingRemote.current = true;
        // A remote broadcast is not a local commit: don't push it onto the
        // undo stack, otherwise undoing my own change would revert the peer's
        // edit and then a follow-up undo would put it back. The workspace
        // state catches up without history pollution (M0.4).
        historyRef.current.syncFromRemote(ws);
        setWorkspace(ws);
        setTick((t) => t + 1);
        applyingRemote.current = false;
      },
      onPeers: setPeers,
      onStatus: setSyncStatus,
      onRole: setSyncRole,
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
      const safe = withDefaults(board.workspace);
      historyRef.current = new OperationHistory(safe, "loaded shared board");
      setWorkspace(safe);
      setTick((t) => t + 1);
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
   * Apply a local batch and record it as one history entry. Inverse ops are
   * computed against the pre-batch workspace so undo is multiplayer-safe (M0.4).
   *
   * M2: the relayout is SCOPED — when the batch touched nodes all inside one
   * group, only that group re-flows at its current origin and the rest of the
   * board keeps its committed positions (the spatial-additivity invariant).
   */
  const commit = useCallback(
    (next: Workspace, ops: Operation[], label: string, conversation: ChatEntry[], name: string) => {
      const positioned = laidOutScoped(next, touchedIdsOf(ops));
      historyRef.current.commit(ops, label);
      setWorkspace(positioned);
      setTick((t) => t + 1);
      persist(positioned, conversation, name);
    },
    [persist],
  );

  /**
   * Commit local operations and, when sharing, send them to the room so peers
   * see them. Applying is still local-first for responsiveness; the server's echo
   * is deduped by sequence number inside BoardSync.
   */
  const commitAndShare = useCallback(
    (next: Workspace, ops: Operation[], label: string, conversation: ChatEntry[], name: string) => {
      commit(next, ops, label, conversation, name);
      if (!applyingRemote.current) syncRef.current?.commit(ops, label);
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

  const send = useCallback(
    async (message: string, selection?: string[], attachments?: SendAttachments) => {
      const text = message.trim();
      if (!text || busy) return;
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
        return;
      }
      const withUser: ChatEntry[] = [...chat, { role: "user", text }];
      setChat(withUser);
      setBusy(true);
      try {
        // `chat` (not withUser) is the prior conversation; the current message is
        // sent separately, so passing withUser would duplicate it.
        let streamed = 0;
        const result = await streamGenerate(
          text,
          workspace,
          (delta) => {
            streamed += delta.length;
            setStreamChars(streamed);
          },
          selection,
          chat,
          attachments,
        );
        setStreamChars(0);
        // Answer-only reply (a question about the board): no ops, just explain.
        // A "this belongs on its own board" reply (the prompt's parallel-diagram
        // rule) is the other case that arrives with no ops — the explanation says
        // the topic looks unrelated, and the entry is marked so the chat can
        // offer the one-click "build it on a new board".
        if (result.operations.length === 0) {
          const explanation = result.explanation ?? "(no answer)";
          const suggestsBoard =
            Object.keys(workspace.nodes).length > 0 &&
            /own board|separate board|new board/i.test(explanation);
          const conversation: ChatEntry[] = [
            ...withUser,
            {
              role: "ai",
              text: explanation,
              ...(suggestsBoard ? { suggestNewBoard: true, originPrompt: text } : {}),
            },
          ];
          setChat(conversation);
          // Zero-op replies are still turns the user asked for: a question
          // answered, a "this belongs on its own board" refusal. Without this
          // write they existed only in React state and vanished on reload —
          // the user's message and the answer simply disappeared (found live:
          // a "move the monitoring stack" answer was gone after a reload).
          persist(workspace, conversation, projectName);
          return;
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
          return;
        }
        const explanation = result.explanation ?? `Applied ${result.operations.length} operations.`;

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
                        .filter((k): k is NonNullable<ReturnType<typeof classifyTurn>> => Boolean(k)),
                    }
                  : {}),
              quote: provenance.turns.join(" ").slice(0, 240),
            })
          : result.operations;
        // The workspace after this batch, provenance riding the ops.
        const applyStamped = (): Workspace => applyOperations(workspace, enrichedOps);

        // Partial-application report (M1): the server may have skipped ops
        // that failed validation while applying the rest. Attach them to the
        // reply so the chat can show exactly what didn't land — the old
        // all-or-nothing path lost the whole generation over one bad op.
        const skippedNote = result.warnings?.length
          ? { skippedOps: result.warnings.map((w) => ({ op: w.op, reason: w.reason })) }
          : {};

        // Large batches on an existing diagram present as a proposal to review.
        const isLarge =
          result.operations.length > PROPOSAL_THRESHOLD && Object.keys(workspace.nodes).length > 0;

        if (isLarge) {
          const conversation: ChatEntry[] = [
            ...withUser,
            {
              role: "ai",
              text: `${explanation} — review ${result.operations.length} proposed changes.`,
              ...skippedNote,
            },
          ];
          setChat(conversation);
          setBusy(true);
          // Shared board (Stage B3): the record goes to the SERVER, which is
          // what makes a pending proposal visible to every member — the
          // localStorage path could never do that. The server supersedes any
          // pending predecessor; peers' panels open via proposal-created.
          const serverRecord = boardId
            ? await createServerProposal(boardId, {
                // Enriched ops (Stage C2): the client already carries the
                // evidence; the server's approve-time enrichment is
                // idempotent over these and backfills any older client's raw
                // ops. Either way the committed batch carries provenance.
                operations: enrichedOps,
                request: text,
                explanation,
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
          } else {
            // Local board (or the server create failed — the panel must still
            // open; the localStorage record is that path's durability).
            const opened = openProposalIn(
              {
                proposal: proposalRecordRef.current,
                proposalHistory: proposalHistoryRef.current,
              },
              {
                id: newProposalId(),
                boardId,
                meetingId: provenance?.meetingId ?? null,
                ...(provenance?.turns ? { turns: provenance.turns } : {}),
                ...(provenance?.turnRange ? { turnRange: provenance.turnRange } : {}),
                ...(provenance?.turnKinds?.length ? { turnKinds: provenance.turnKinds } : {}),
                operations: enrichedOps,
                createdAt: Date.now(),
                request: text,
                explanation,
              },
            );
            proposalRecordRef.current = opened.proposal;
            proposalHistoryRef.current = opened.proposalHistory;
            decidedRef.current = null; // the new record is undecided
            setProposal(opened.proposal);
          }
          // The ops themselves apply only on approval, but the request and
          // the review-gate reply are durable from this moment on.
          persist(workspace, conversation, projectName);
        } else {
          const next = applyStamped();
          const conversation: ChatEntry[] = [
            ...withUser,
            { role: "ai", text: explanation, ...skippedNote },
          ];
          setChat(conversation);
          // The enriched ops, not the raw model batch — the stamp rides into
          // history and the room with them (Stage C2, ADR 0022).
          commitAndShare(next, enrichedOps, explanation, conversation, projectName);
        }
      } catch (err) {
        const conversation: ChatEntry[] = [
          ...withUser,
          { role: "error", text: (err as Error).message },
        ];
        setChat(conversation);
        // A network failure mid-stream used to swallow the user's message
        // entirely — on reload the board looked like the request never
        // happened. Keep the failed attempt visible.
        persist(workspace, conversation, projectName);
      } finally {
        setBusy(false);
      }
    },
    [busy, chat, workspace, commitAndShare, projectName, readOnly, persist, boardId],
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
    async (question: string) => {
      const text = question.trim();
      if (!text || busy) return;
      if (!boardId) {
        const conversation: ChatEntry[] = [
          ...chat,
          { role: "user", text },
          {
            role: "error",
            text: "Ask works on shared boards — their history lives on the server. Share this board first, then ask.",
          },
        ];
        setChat(conversation);
        persist(workspace, conversation, projectName);
        return;
      }
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
          .map((c) => ({ role: c.role === "user" ? ("user" as const) : ("ai" as const), text: c.text }));
        const result = await askLucent(boardId, text, turns);
        if ("error" in result) {
          const conversation: ChatEntry[] = [
            ...withUser,
            { role: "error", text: result.error },
          ];
          setChat(conversation);
          persist(workspace, conversation, projectName);
          return;
        }
        const conversation: ChatEntry[] = [
          ...withUser,
          {
            role: "ai",
            text: result.answer,
            ...(result.citations.length
              ? { citations: result.citations.map(({ kind, id, label, detail, why, turnRange }) => ({
                  kind,
                  id,
                  label,
                  ...(detail ? { detail } : {}),
                  ...(why ? { why } : {}),
                  ...(turnRange ? { turnRange } : {}),
                })) }
              : {}),
            ...(result.hasMore ? { historyTruncated: true } : {}),
          },
        ];
        setChat(conversation);
        persist(workspace, conversation, projectName);
      } catch (err) {
        const conversation: ChatEntry[] = [
          ...withUser,
          { role: "error", text: (err as Error).message },
        ];
        setChat(conversation);
        persist(workspace, conversation, projectName);
      } finally {
        setBusy(false);
      }
    },
    [busy, boardId, chat, workspace, persist, projectName],
  );

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
    (citation: { kind: "node" | "meeting" | "revision"; id: string; turnRange?: [number, number] }) => {
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
    const candidateOps = evidence ? attachProvenance(proposal.operations, evidence) : proposal.operations;
    const partial = applyValidOperations(workspace, candidateOps);
    const appliedOps = partial.applied.length > 0 ? partial.applied : candidateOps;
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
    const positioned = laidOut(next);
    setWorkspace(positioned);
    setTick((t) => t + 1);
    if (ops.length > 0) {
      syncRef.current?.commit(ops, "undo");
      persist(positioned, chat, projectName);
    }
  }, [chat, persist, projectName]);
  const redo = useCallback(() => {
    const { workspace: next, ops } = historyRef.current.redo();
    // Same as undo: the replayed workspace has no positions of its own.
    const positioned = laidOut(next);
    setWorkspace(positioned);
    setTick((t) => t + 1);
    if (ops.length > 0) {
      syncRef.current?.commit(ops, "redo");
      persist(positioned, chat, projectName);
    }
  }, [chat, persist, projectName]);

  const restoreVersion = useCallback(
    (index: number) => {
      const { workspace: restored, ops } = historyRef.current.restoreTo(index);
      // Version restore replays history ops — same no-positions rule as undo.
      const positioned = laidOut(restored);
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
    },
    [chat, persist, projectName],
  );

  const selectDiagram = useCallback(
    (kind: DiagramKind) => {
      if (readOnly) return;
      const ops: Operation[] = [{ op: "TRANSFORM_DIAGRAM", to: kind }];
      const next = applyOperations(workspace, ops);
      const conversation: ChatEntry[] = [
        ...chat,
        { role: "ai", text: `Switched to ${kind} view.` },
      ];
      setChat(conversation);
      commitAndShare(next, ops, `Transform to ${kind}`, conversation, projectName);
    },
    [workspace, chat, commitAndShare, projectName, readOnly],
  );

  const applyManual = useCallback(
    (ops: Operation[], label: string): boolean => {
      if (ops.length === 0) return false;
      // A viewer's operations would be rejected by the server anyway; refusing
      // here keeps local state from diverging from the room in the meantime.
      if (readOnly) return false;
      const errors = validateOperations(workspace, ops);
      if (errors.length > 0) return false;
      const next = applyOperations(workspace, ops);
      // Manual edits do not add chat turns; commit to history + persist + share.
      commitAndShare(next, ops, label, chat, projectName);
      return true;
    },
    [workspace, chat, commitAndShare, projectName, readOnly],
  );

  const setRegionKind = useCallback(
    (groupId: string, kind: DiagramKind | null) => {
      // Manual edit path: no chat turn, but the same validation + undo as any
      // other op. Reuses applyManual so a viewer can't flip a region either.
      applyManual(
        [{ op: "SET_GROUP_KIND", id: groupId, kind }],
        kind ? `Region → ${kind}` : "Region → board layout",
      );
    },
    [applyManual],
  );

  const newProject = useCallback(() => {
    const id = newProjectId();
    const fresh = new OperationHistory(createWorkspace(), "initial");
    // Write the record synchronously BEFORE the pointer moves: the autosave
    // races a reload, and the boot restore crashes on a pointer whose record
    // does not exist yet (`restored.workspace` of undefined) — the same
    // invariant startNewBoardFor already carries.
    saveProject({ id, name: "Untitled workspace", workspace: fresh.current(), chat: [] });
    historyRef.current = fresh;
    setProjectId(id);
    setProjectName("Untitled workspace");
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
    // A deliberate move to a local board ends the shared-board session.
    // Without this clear, the boot rejoin effect kept adopting the LAST
    // shared board on every reload — the user's "New workspace" was undone
    // by the next refresh (found live: a K8s board was silently replaced by
    // a shared board from an earlier session).
    setSharedBoardId(null);
    setBoardId(null);
  }, []);

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
  const startNewBoardFor = useCallback((prompt: string) => {
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
  }, []);

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
  const importWorkspace = useCallback((imported: unknown, name = "Imported board") => {
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
  }, []);

  const openProject = useCallback((id: string) => {
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
    setChat(review.error ? [...conversation, { role: "error", text: review.error }] : conversation);
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
    setBoardId(null);
  }, []);

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
    projectId,
    projectName,
    setProjectName,
    workspace,
    chat,
    busy,
    streamChars,
    listening,
    setListening,
    proposal,
    canvasPhase,
    history: historyRef.current,
    canUndo: historyRef.current.canUndo(),
    canRedo: historyRef.current.canRedo(),
    peers,
    setPresence,
    syncStatus,
    syncRole,
    readOnly,
    boardId,
    startSharing,
    openBoard,
    send,
    ask,
    pillMode,
    setPillMode,
    onCitation,
    applyProposal,
    cancelProposal,
    undo,
    redo,
    restoreVersion,
    selectDiagram,
    setRegionKind,
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
