import type { Operation } from "./operations.js";
import type { Workspace } from "./model.js";
import { applyOperations } from "./reducer.js";
import { inverseOperations } from "./inverse.js";

/**
 * Operation-based history: the multiplayer-safe replacement for snapshot undo
 * (docs/03 — every AI action reversible).
 *
 * The snapshot History stored a whole workspace per edit, which in multiplayer
 * means undoing your own change reverts everyone else's work. This class stores
 * the *inverse operations* of each commit instead. Undo applies only those
 * inverses, so it touches just what that edit touched.
 *
 * Same surface as the old History plus two extras a multiplayer undo needs:
 * `undo()` and `redo()` return the ops they applied, so the caller can forward
 * them to the server and a peer sees the change; `restoreTo(index)` walks the
 * right number of undo/redo steps so it stays reversible too.
 */
export interface OpHistoryEntry {
  ops: Operation[];
  inverses: Operation[];
  label: string;
}

export class OperationHistory {
  private workspace: Workspace;
  /** Inverse batches per commit, oldest first. */
  private readonly undoStack: OpHistoryEntry[] = [];
  private readonly redoStack: OpHistoryEntry[] = [];
  private initial: Workspace;

  constructor(
    initial: Workspace,
    public label = "initial",
  ) {
    this.workspace = initial;
    this.initial = initial;
  }

  current(): Workspace {
    return this.workspace;
  }

  /**
   * Apply a batch as one commit. Returns the new workspace. The inverses are
   * computed against the pre-commit state and applied in reverse order on undo,
   * so a multi-op batch (e.g. an AI response) undoes atomically.
   */
  commit(ops: Operation[], label = ""): Workspace {
    if (ops.length === 0) return this.workspace;
    const inverses = inverseOperations(ops, this.workspace);
    this.workspace = applyOperations(this.workspace, ops);
    this.undoStack.push({ ops, inverses, label });
    // A new commit invalidates the redo branch.
    this.redoStack.length = 0;
    return this.workspace;
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /**
   * Undo the most recent commit. Returns the inverse operations applied, so a
   * multiplayer caller can forward them to the server; otherwise peers miss the
   * revert. Empty array when there is nothing to undo.
   */
  undo(): { workspace: Workspace; ops: Operation[] } {
    const entry = this.undoStack.pop();
    if (!entry) return { workspace: this.workspace, ops: [] };
    this.workspace = applyOperations(this.workspace, entry.inverses);
    this.redoStack.push(entry);
    return { workspace: this.workspace, ops: entry.inverses };
  }

  /** Redo the next branch. Returns the operations applied so peers see them. */
  redo(): { workspace: Workspace; ops: Operation[] } {
    const entry = this.redoStack.pop();
    if (!entry) return { workspace: this.workspace, ops: [] };
    this.workspace = applyOperations(this.workspace, entry.ops);
    this.undoStack.push(entry);
    return { workspace: this.workspace, ops: entry.ops };
  }

  /** Reset to another board (project switch). Clears all history. */
  reset(workspace: Workspace, label = "initial"): void {
    this.workspace = workspace;
    this.initial = workspace;
    this.label = label;
    this.undoStack.length = 0;
    this.redoStack.length = 0;
  }

  /**
   * Replace the current workspace without touching the stacks. Used when a
   * remote broadcast arrives: the catchup is *the* authoritative state, but
   * the local undo branch should not be polluted by another user's edits.
   */
  syncFromRemote(workspace: Workspace): void {
    this.workspace = workspace;
  }

  /**
   * The full timeline, reconstructed by replaying commits over the initial state.
   * Lighter than snapshots: memory holds operations, not board copies. Newest last,
   * matching the old History.timeline() contract.
   */
  timeline(): Array<{ workspace: Workspace; label: string; timestamp: number }> {
    const out: Array<{ workspace: Workspace; label: string; timestamp: number }> = [
      { workspace: this.initial, label: "initial", timestamp: 0 },
    ];
    let state = this.initial;
    for (const entry of this.undoStack) {
      state = applyOperations(state, entry.ops);
      out.push({ workspace: state, label: entry.label || "edit", timestamp: 0 });
    }
    return out;
  }

  /**
   * Move the cursor to the timeline entry at `index` by undoing/redoing the
   * difference. Returns the ops applied (forward when restoring forward through
   * the redo stack, inverses when restoring backward through the undo stack),
   * so a multiplayer caller can keep peers in sync. Out-of-range indices are a
   * no-op.
   *
   * The returned array is in *application* order — newest commit's inverses
   * first, because that is the order a multi-step undo has to run in. It used to
   * collect with `unshift`, which reversed it into ascending-commit order: the
   * local workspace was right and the ops handed to `commit(...)` were the same
   * set in the opposite order. Whenever two steps' inverses don't commute that
   * silently forks the board. A restore across a delete-then-recreate of one node
   * arrives at the peer as create-then-delete, which the validator rejects
   * ("already exists") and, unvalidated, leaves the node deleted; two moves of one
   * node arrive reversed and land it at the wrong coordinates with no error at
   * all. Appending keeps "replay these in order" true for the peer, which is the
   * only contract a returned op list can have.
   */
  restoreTo(index: number): { workspace: Workspace; ops: Operation[] } {
    const total = this.undoStack.length;
    if (index < 0 || index > total || !Number.isInteger(index)) {
      return { workspace: this.workspace, ops: [] };
    }
    if (index === total) return { workspace: this.workspace, ops: [] };
    const collected: Operation[] = [];
    let workspace = this.workspace;
    if (index < total) {
      // Walk back from the current top to the target.
      const steps = total - index;
      for (let i = 0; i < steps; i += 1) {
        const entry = this.undoStack.pop()!;
        workspace = applyOperations(workspace, entry.inverses);
        collected.push(...entry.inverses);
        this.redoStack.push(entry);
      }
    } else {
      // Walking forward: index is past the current position, but index is bounded
      // by `total` above, so this branch is unreachable.
      const steps = index - total;
      for (let i = 0; i < steps; i += 1) {
        const entry = this.redoStack.pop()!;
        workspace = applyOperations(workspace, entry.ops);
        collected.push(...entry.ops);
        this.undoStack.push(entry);
      }
    }
    this.workspace = workspace;
    return { workspace, ops: collected };
  }
}
