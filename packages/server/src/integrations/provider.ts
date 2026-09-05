import type { ExecutionStatus } from "@lucent/core";

/**
 * The ExecutionProvider abstraction (Stage D4, ADR 0030): ONE interface every
 * external execution system implements — Linear first (D6), GitHub/Jira/
 * Figma/Slack later (D8) — proven against a FakeProvider before any real
 * provider exists.
 *
 * The interface lives in @lucent/server, mirroring the LLMProvider precedent:
 * the harness (interface + fake) in one package, implementations selected
 * and injected server-side. The core Action model NEVER learns a
 * provider-shaped thing — mapStatus maps INTO core's ExecutionStatus
 * vocabulary (the D1 canonical set), and the link registry lives in the
 * IntegrationStore, not on the node. That is the acceptance gate's literal
 * wording: Action → ExecutionProvider → FakeProvider works without the core
 * Action model knowing anything about Linear.
 *
 * The methods are the owner's milestone spec verbatim, with the shapes the
 * spec named: createTask/updateTask/getTask/searchTasks, mapStatus, and the
 * optional subscription D7's sync will drive. subscribeToChanges is
 * DECLARED, not plumbed — no server routes consume it until D7 ships the
 * webhook receiver (the Stripe-signature precedent).
 */

/**
 * The normalized external task: the one shape every provider returns, the
 * shape the link registry stores alongside the nodeId it belongs to.
 */
export interface ExternalTask {
  provider: string;
  externalId: string;
  title: string;
  /** The PROVIDER's status word (mapStatus maps it into the D1 vocabulary). */
  status: string;
  assignee?: string;
  dueDate?: string;
  url?: string;
}

/** What a sync derives from an action node to create a task with. */
export interface CreateTaskInput {
  title: string;
  description?: string;
  assignee?: string;
  dueDate?: string;
  /** The D1 canonical status the task should start in. */
  status?: string;
}

/** A later edit to an existing external task (all fields optional). */
export interface UpdateTaskInput {
  title?: string;
  description?: string;
  assignee?: string;
  dueDate?: string;
  status?: string;
}

/**
 * An inbound change (D7): the provider reports one of its tasks moved.
 * Carried through subscribeToChanges; the webhook receiver will turn
 * provider callbacks into these.
 */
export interface ExternalTaskChange {
  provider: string;
  externalId: string;
  status: string;
  at: number;
}

export interface ExecutionProvider {
  readonly name: string;
  createTask(input: CreateTaskInput): Promise<ExternalTask>;
  updateTask(externalId: string, input: UpdateTaskInput): Promise<ExternalTask>;
  getTask(externalId: string): Promise<ExternalTask>;
  searchTasks(query: string): Promise<ExternalTask[]>;
  /**
   * Map the provider's status word into Lucent's canonical execution
   * vocabulary (open/assigned/in_progress/blocked/completed/cancelled).
   * Providers own their external words; Lucent's vocabulary stays one set —
   * the ADR 0027 doctrine, applied at the adapter boundary.
   */
  mapStatus(externalStatus: string): ExecutionStatus;
  /**
   * D7's inbound sync seam — DECLARED in D4, plumbed when webhooks ship.
   * Returns an unsubscribe function. The FakeProvider implements it as an
   * in-memory bus so tests exercise the shape without network anything.
   */
  subscribeToChanges?(listener: (change: ExternalTaskChange) => void): () => void;
}
