import type { Workspace } from "./model.js";

/**
 * Undo/redo via full snapshots. The workspace model is small and pure, so
 * snapshotting is simpler and less bug-prone than inverse-operation tracking,
 * and it gives "restore snapshot" for free (docs/16). Can be swapped for a
 * command-diff stack later if memory becomes a concern.
 */

export interface HistoryEntry {
  workspace: Workspace;
  /** Human-readable label, e.g. "AI added OAuth". */
  label: string;
  timestamp: number;
}

export class History {
  private past: HistoryEntry[] = [];
  private future: HistoryEntry[] = [];
  private present: HistoryEntry;

  constructor(initial: Workspace, label = "initial") {
    this.present = { workspace: initial, label, timestamp: Date.now() };
  }

  get current(): Workspace {
    return this.present.workspace;
  }

  /** Record a new state, clearing the redo stack. */
  commit(workspace: Workspace, label: string): void {
    this.past.push(this.present);
    this.present = { workspace, label, timestamp: Date.now() };
    this.future = [];
  }

  canUndo(): boolean {
    return this.past.length > 0;
  }

  canRedo(): boolean {
    return this.future.length > 0;
  }

  undo(): Workspace {
    const previous = this.past.pop();
    if (!previous) return this.present.workspace;
    this.future.unshift(this.present);
    this.present = previous;
    return this.present.workspace;
  }

  redo(): Workspace {
    const next = this.future.shift();
    if (!next) return this.present.workspace;
    this.past.push(this.present);
    this.present = next;
    return this.present.workspace;
  }

  /** Timeline of labels for the history panel (oldest to newest). */
  timeline(): HistoryEntry[] {
    return [...this.past, this.present];
  }

  /**
   * Restore the state at a timeline index (as returned by `timeline()`) by
   * recording it as a new present entry. This is non-destructive — the prior
   * timeline is preserved in the undo stack — so "restore version" stays
   * reversible like the rest of history (docs/03 version history).
   */
  restoreTo(index: number, label?: string): Workspace {
    const entries = this.timeline();
    const target = entries[index];
    if (!target) return this.present.workspace;
    this.past.push(this.present);
    this.present = {
      workspace: target.workspace,
      label: label ?? `Restore "${target.label}"`,
      timestamp: Date.now(),
    };
    this.future = [];
    return this.present.workspace;
  }
}
