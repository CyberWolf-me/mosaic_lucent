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
  /**
   * The exactly-once key (Stage D5, ADR 0031): the route threads
   * `ext_<nodeId>_<recordId>` per node so a timed-out create retried with
   * the same key returns the SAME external task — the ledger dedupes
   * attempts, the key dedupes effects (the Stripe client precedent: "the
   * request may never have reached the provider, and if it did the
   * idempotency key covers us"). Providers that support idempotent
   * creates honor it; those that cannot ignore it and accept the retry
   * contract's window.
   */
  idempotencyKey?: string;
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
   *
   * Stage D6's correction (the review's rule): NEVER GUESS. An unknown
   * external status (a custom workflow state, "In QA", "Deployed") returns
   * undefined — the surfaces preserve Lucent's current state and surface a
   * warning, the same discipline as citation validation: untrusted input
   * drops with a visible reason, never a silent overwrite. mapStatus
   * returning a value is a claim the provider KNOWS the word.
   */
  mapStatus(externalStatus: string): ExecutionStatus | undefined;
  /**
   * The reverse direction (Stage D6): Lucent's canonical word → the
   * provider's external status NAME. Implementations resolve names to the
   * provider's own state ids at call time (Linear's WorkflowState UUIDs,
   * fetched once and cached per provider instance — one query per batch,
   * not per item).
   */
  toExternalStatus?(lucentStatus: string): string;
  /**
   * THE AMBIGUOUS-CREATE RECOVERY (Stage D6, ADR 0032's effect contract):
   * after an uncertain timeout the executor calls recoverCreate with the
   * stable Lucent marker stamped into the task's description; the provider
   * searches its own store — found means the create LANDED (link it, 0
   * duplicates), not found means it never arrived (retry the create).
   * Providers with native idempotency keys may leave this unimplemented;
   * Linear-style providers MUST implement it — that is what makes
   * "at-least-once delivery + provider-specific reconciliation" the real
   * contract instead of a hope.
   */
  recoverCreate?(marker: string): Promise<ExternalTask | undefined>;
  /**
   * D7's inbound sync seam — DECLARED in D4, plumbed when webhooks ship.
   * Returns an unsubscribe function. The FakeProvider implements it as an
   * in-memory bus so tests exercise the shape without network anything.
   */
  subscribeToChanges?(listener: (change: ExternalTaskChange) => void): () => void;
  /**
   * THE CAPABILITY-HONESTY SEAM (Stage D8, ADR 0034): what this create/update
   * CANNOT represent faithfully. The propose route calls it per item and
   * stores the warnings on the action record; the preview shows them; the
   * approve route refuses a warning-carrying record unless the caller
   * acknowledged them — the human gate covers capability loss, not just
   * effect scope. Nothing drops silently.
   *
   * Providers with fully faithful fields (Linear, the FakeProvider) leave
   * this unimplemented. A provider like GitHub warns: dueDate has no native
   * field; every non-open Lucent status collapses to GitHub "open"; an
   * unresolvable assignee is omitted, not guessed.
   */
  capabilityWarnings?(input: {
    title: string;
    assignee?: string;
    dueDate?: string;
    status?: string;
  }): Array<{ field: string; reason: string }>;
}

/**
 * The provider factory (Stage D6): the map holds FACTORIES, not instances,
 * because a Linear credential is per-ORG (the connection's credentialRef)
 * while the map is process-global. The route resolves the connection
 * (existence/active guards are its 404/409 answers), then invokes the
 * factory with it; the factory resolves credentialRef → the actual key and
 * reads the connection's provider config (e.g. Linear's teamId). The ADR
 * 0030 interface stays frozen — this changes only who constructs the
 * provider, never what the provider is.
 */
export type ExecutionProviderFactory = (connection: {
  credentialRef: string;
  config?: Record<string, string>;
  /** docs/26 A5: an OAuth connection's (fresh) access token, resolved first. */
  oauth?: { accessToken: string };
}) => ExecutionProvider;
