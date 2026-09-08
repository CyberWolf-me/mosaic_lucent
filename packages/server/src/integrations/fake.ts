import type { ExecutionStatus } from "@lucent/core";
import type {
  CreateTaskInput,
  ExternalTask,
  ExternalTaskChange,
  ExecutionProvider,
  UpdateTaskInput,
} from "./provider.js";

/**
 * The FakeProvider (Stage D4, ADR 0030): the proof of the adapter
 * architecture before any real provider exists. Deliberately NOT a stub —
 * it behaves like a real system (deterministic ids, updatable tasks, a
 * searchable store, an inbound change bus) so D5's idempotency and D7's
 * sync work exercise something honest rather than a `resolve({})`.
 *
 * Deterministic by design: `fake-1`, `fake-2`, … in call order, so the
 * acceptance suite can assert exact ids and the offline gates stay stable.
 * Every mutation is recorded (`calls`) so tests assert WHAT the platform
 * asked the provider to do, not just what came back.
 */
export interface RecordedCall {
  method: "createTask" | "updateTask" | "getTask" | "searchTasks";
  externalId?: string;
  input?: CreateTaskInput | UpdateTaskInput | string;
  at: number;
}

export class FakeProvider implements ExecutionProvider {
  readonly name = "fake";

  private nextId = 1;
  private readonly tasks = new Map<string, ExternalTask>();
  /** Stage D5: idempotencyKey → the task it created, exactly once. */
  private readonly byKey = new Map<string, ExternalTask>();
  readonly calls: RecordedCall[] = [];
  private readonly listeners = new Set<(change: ExternalTaskChange) => void>();
  /** Stage D5 test hooks: queued faults. failNext first, then hang. */
  private failQueue: Array<{ method: RecordedCall["method"]; error: Error }> = [];
  private hangQueue = 0;

  /** The fake's external vocabulary — deliberately different words, so
   * mapStatus is exercised as a real translation, not a passthrough. */
  static readonly EXTERNAL_STATUSES = ["todo", "active", "blocked", "done", "canceled"] as const;

  /** Test hook: the next call(s) to this method reject (one-shot each). */
  failNext(method: RecordedCall["method"], error = new Error("fake network failure")): void {
    this.failQueue.push({ method, error });
  }

  /** Test hook: the next call to this method never settles (the timeout arm). */
  hangNext(): void {
    this.hangQueue += 1;
  }

  createTask(input: CreateTaskInput): Promise<ExternalTask> {
    this.calls.push({ method: "createTask", input, at: Date.now() });
    // Stage D5: a repeated idempotency key returns the SAME task — the
    // retry-after-timeout contract, honored (Linear's real behavior).
    if (input.idempotencyKey !== undefined) {
      const existing = this.byKey.get(input.idempotencyKey);
      if (existing) return Promise.resolve(existing);
    }
    const fault = this.failQueue.shift();
    if (fault && fault.method === "createTask") return Promise.reject(fault.error);
    if (this.hangQueue > 0) {
      this.hangQueue -= 1;
      return new Promise<ExternalTask>(() => {
        // Deliberately never settles: the caller's AbortSignal.timeout is
        // the thing under test.
      });
    }
    const externalId = `fake-${this.nextId}`;
    this.nextId += 1;
    const task: ExternalTask = {
      provider: this.name,
      externalId,
      title: input.title,
      status: input.status !== undefined ? this.toExternal(input.status) : "todo",
      ...(input.assignee ? { assignee: input.assignee } : {}),
      ...(input.dueDate ? { dueDate: input.dueDate } : {}),
      url: `https://fake.example.com/task/${externalId}`,
    };
    this.tasks.set(externalId, task);
    if (input.idempotencyKey !== undefined) this.byKey.set(input.idempotencyKey, task);
    return Promise.resolve(task);
  }

  updateTask(externalId: string, input: UpdateTaskInput): Promise<ExternalTask> {
    this.calls.push({ method: "updateTask", externalId, input, at: Date.now() });
    const fault = this.failQueue.shift();
    if (fault && fault.method === "updateTask") return Promise.reject(fault.error);
    const task = this.tasks.get(externalId);
    if (!task) {
      return Promise.reject(new Error(`fake task "${externalId}" does not exist`));
    }
    const updated: ExternalTask = {
      ...task,
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.status !== undefined ? { status: this.toExternal(input.status) } : {}),
      ...(input.assignee !== undefined ? { assignee: input.assignee } : {}),
      ...(input.dueDate !== undefined ? { dueDate: input.dueDate } : {}),
    };
    this.tasks.set(externalId, updated);
    return Promise.resolve(updated);
  }

  getTask(externalId: string): Promise<ExternalTask> {
    this.calls.push({ method: "getTask", externalId, at: Date.now() });
    const fault = this.failQueue.shift();
    if (fault && fault.method === "getTask") return Promise.reject(fault.error);
    const task = this.tasks.get(externalId);
    if (!task) {
      return Promise.reject(new Error(`fake task "${externalId}" does not exist`));
    }
    return Promise.resolve(task);
  }

  searchTasks(query: string): Promise<ExternalTask[]> {
    this.calls.push({ method: "searchTasks", input: query, at: Date.now() });
    const needle = query.toLowerCase();
    return Promise.resolve(
      [...this.tasks.values()].filter((t) =>
        t.title.toLowerCase().includes(needle) || t.externalId.includes(needle),
      ),
    );
  }

  /** The D1 vocabulary translated into the fake's external words. An
   * UNKNOWN word returns undefined — never a guess (ADR 0032's rule). */
  mapStatus(externalStatus: string): ExecutionStatus | undefined {
    switch (externalStatus) {
      case "active":
        return "in_progress";
      case "blocked":
        return "blocked";
      case "done":
        return "completed";
      case "canceled":
        return "cancelled";
      case "todo":
        return "open";
      default:
        return undefined;
    }
  }

  /** The reverse direction (used when creating: the D1 word goes out). */
  toExternal(lucentStatus: string): string {
    switch (lucentStatus) {
      case "assigned":
        return "todo";
      case "in_progress":
        return "active";
      case "blocked":
        return "blocked";
      case "completed":
        return "done";
      case "cancelled":
        return "canceled";
      case "open":
      default:
        return "todo";
    }
  }

  /**
   * The D6 recovery seam, live in the fake: find a task whose title or
   * description carries the Lucent marker. The fake stores tasks whole, so
   * the scan is direct; Linear's real implementation queries
   * description-contains. The byKey map is the SECOND path (D10): the sync
   * and approve routes recover with the FULL ANCHORED comment
   * (<!-- lucent-action:key --> — the closing delimiter prevents prefix
   * collisions) — the key inside is what the fake indexed the create
   * under, so a re-created node's recovery resolves through it exactly
   * the way a real provider's description search does.
   */
  async recoverCreate(marker: string): Promise<ExternalTask | undefined> {
    for (const task of this.tasks.values()) {
      if (task.title.includes(marker)) return task;
    }
    const inner = marker.replace(/^<!--\s*lucent-action:/, "").replace(/\s*-->$/, "");
    const keyed = this.byKey.get(inner);
    if (keyed) return keyed;
    return undefined;
  }

  /**
   * The declared D7 seam, live in the fake: an in-memory change bus. Tests
   * (and later the webhook receiver) drive `emitChange` and listeners hear
   * the normalized ExternalTaskChange.
   */
  subscribeToChanges(listener: (change: ExternalTaskChange) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Test hook: pretend the external system moved a task. */
  emitChange(externalId: string, status: string): void {
    const change: ExternalTaskChange = {
      provider: this.name,
      externalId,
      status,
      at: Date.now(),
    };
    for (const listener of this.listeners) listener(change);
  }

  /** Test hook: how many tasks the fake holds. */
  get taskCount(): number {
    return this.tasks.size;
  }
}
