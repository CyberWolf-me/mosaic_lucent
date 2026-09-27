import type { ExecutionStatus } from "@lucent/core";
import { assertSafeOutboundUrl } from "./outboundUrl.js";
import type {
  CreateTaskInput,
  ExternalTask,
  ExecutionProvider,
  UpdateTaskInput,
} from "./provider.js";

/**
 * The Linear adapter (Stage D6, ADR 0032) — the first real ExecutionProvider.
 *
 * THE WIRE: Linear is one GraphQL endpoint (`POST /graphql`) with the raw
 * API key in `Authorization` — NO Bearer prefix, the divergence from Stripe
 * (`Bearer sk_…`) and OpenAI-compat (`Bearer …`) documented here so nobody
 * "fixes" it. Responses come back as `{ data, errors }`; Linear has no
 * Stripe-style idempotency-key header, so THE EFFECT CONTRACT rests on the
 * D6 recovery seam (ADR 0032's corrected framing: at-least-once delivery +
 * provider-specific reconciliation):
 *
 *   uncertain timeout → recoverCreate(marker) → found? link : retry
 *
 * The marker (`<!-- lucent-action:act_… -->`) is stamped into the
 * description by createTask and searched by recoverCreate — a stable,
 * non-user-editable key living in the task representation itself.
 *
 * THE CACHES (the review's batch-cost rule): workflowStates (Lucent's word →
 * Linear's state UUID, fetched once per provider instance) and the assignee
 * resolution (free text → user UUID, deterministic: exact email > exact
 * normalized name > unique partial > AMBIGUOUS error — never a guess).
 *
 * IDS: `ExternalTask.externalId` is the IDENTIFIER (`LIN-482` — what the
 * owner's acceptance names and the UI renders); updateTask resolves it to
 * the UUID Linear's mutations want, one extra query per call — the honest
 * cost of a human-readable public id.
 *
 * Testing seam: `fetchImpl` (the StripeClient/AnthropicProvider precedent)
 * — the wire contract is pinned by scripted-GraphQL tests, never a live
 * account.
 */

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 250;
const RETRY_MAX_MS = 4_000;

/** The one error type: `retryable` computed once, here — callers never re-derive. */
export class LinearError extends Error {
  readonly status: number;
  readonly retryable: boolean;

  constructor(message: string, status: number, retryable: boolean) {
    super(message);
    this.name = "LinearError";
    this.status = status;
    this.retryable = retryable;
  }
}

export interface LinearProviderOptions {
  apiKey?: string;
  /** docs/26 A5: an OAuth connection's access token, sent as a Bearer. */
  accessToken?: string;
  /** The Linear team issues are created in — connection.config.teamId. */
  teamId: string;
  baseUrl?: string;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

/** A Linear issue as the GraphQL shapes come back (the fields we read). */
interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description?: string;
  state?: { name: string } | null;
  assignee?: { name: string; email?: string } | null;
  dueDate?: string | null;
  url: string;
}

export class LinearProvider implements ExecutionProvider {
  readonly name = "linear";

  private readonly authorization: string;
  private readonly teamId: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;

  /** Lucent word → Linear WorkflowState UUID, fetched once. */
  private statesByWord: Map<string, string> | null = null;
  private statesPromise: Promise<Map<string, string>> | null = null;
  /** Free-text assignee → user UUID (the deterministic resolution, cached). */
  private readonly assigneeCache = new Map<string, string>();
  /** identifier (LIN-482) → UUID, cached after the first resolution. */
  private readonly idByIdentifier = new Map<string, string>();

  constructor(options: LinearProviderOptions) {
    if (!options.apiKey && !options.accessToken) {
      throw new Error("LinearProvider requires an apiKey or an OAuth access token");
    }
    if (!options.teamId) {
      throw new Error("LinearProvider requires a teamId (connection.config.teamId)");
    }
    // Linear's documented schemes: a personal API key RAW, an OAuth access
    // token as a Bearer.
    this.authorization = options.accessToken ? `Bearer ${options.accessToken}` : options.apiKey!;
    this.teamId = options.teamId;
    this.baseUrl = options.baseUrl ?? "https://api.linear.app/graphql";
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    this.random = options.random ?? Math.random;
  }

  /** The one HTTP helper: POST the GraphQL document, retry per the ladder. */
  private async gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    let lastError: LinearError | null = null;
    for (let attempt = 0; attempt < this.maxAttempts; attempt += 1) {
      if (attempt > 0) {
        const backoff = Math.min(RETRY_BASE_MS * 2 ** attempt, RETRY_MAX_MS);
        await this.sleep(Math.floor(backoff / 2 + this.random() * (backoff / 2)));
      }
      try {
        const res = await this.fetchImpl(this.baseUrl, {
          method: "POST",
          headers: {
            authorization: this.authorization,
            "content-type": "application/json",
          },
          body: JSON.stringify({ query, variables }),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (res.status === 429 || res.status >= 500) {
          lastError = new LinearError(`linear responded ${res.status}`, res.status, true);
          continue;
        }
        if (!res.ok) {
          throw new LinearError(`linear responded ${res.status}`, res.status, false);
        }
        const body = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
        if (body.errors?.length) {
          throw new LinearError(
            `linear graphql errors: ${body.errors.map((e) => e.message).join("; ")}`,
            res.status,
            false,
          );
        }
        return body.data as T;
      } catch (err) {
        if (err instanceof LinearError && !err.retryable) throw err;
        // DNS, TLS, socket, the abort, or the retryable status above.
        lastError = new LinearError((err as Error).message, 0, true);
      }
    }
    throw lastError ?? new LinearError("linear call failed", 0, false);
  }

  /** The workflow states, fetched once and cached (one query per batch). */
  private async states(): Promise<Map<string, string>> {
    if (this.statesByWord) return this.statesByWord;
    if (!this.statesPromise) {
      this.statesPromise = this.gql<{
        workflowStates: { nodes: Array<{ id: string; name: string }> };
      }>(
        `query($teamId: String!) { workflowStates(filter: { team: { id: { eq: $teamId } } }, first: 50) { nodes { id name } } }`,
        { teamId: this.teamId },
      ).then((data) => {
        const map = new Map<string, string>();
        for (const node of data.workflowStates.nodes) {
          map.set(node.name.toLowerCase(), node.id);
        }
        this.statesByWord = map;
        return map;
      });
    }
    return this.statesPromise;
  }

  /**
   * The deterministic assignee resolution: exact email > exact normalized
   * name > unique partial > AMBIGUOUS (an honest error, never a guess —
   * the review's rule). Cached per provider instance.
   */
  private async resolveAssignee(assignee: string): Promise<string | undefined> {
    const cached = this.assigneeCache.get(assignee);
    if (cached !== undefined) return cached;
    const needle = assignee.trim().toLowerCase();
    const data = await this.gql<{
      users: { nodes: Array<{ id: string; name: string; email?: string }> };
    }>(`query { users(first: 50) { nodes { id name email } } }`, {});
    const nodes = data.users.nodes;
    const byEmail = nodes.find((u) => u.email?.toLowerCase() === needle);
    const byName = nodes.find((u) => u.name.trim().toLowerCase() === needle);
    const partials = nodes.filter((u) => u.name.trim().toLowerCase().includes(needle));
    let resolved: string | undefined;
    if (byEmail) {
      resolved = byEmail.id;
    } else if (byName) {
      resolved = byName.id;
    } else if (partials.length === 1) {
      resolved = partials[0]!.id;
    } else if (partials.length > 1) {
      throw new LinearError(
        `unable to uniquely resolve assignee "${assignee}" (${partials.length} matches)`,
        0,
        false,
      );
    }
    if (resolved) this.assigneeCache.set(assignee, resolved);
    return resolved;
  }

  /** The Lucent marker, stamped into the description. */
  private markerFor(input: CreateTaskInput): string {
    return `<!-- lucent-action:${input.idempotencyKey ?? input.title.slice(0, 40)} -->`;
  }

  private toExternal(issue: LinearIssue): ExternalTask {
    return {
      provider: this.name,
      externalId: issue.identifier,
      title: issue.title,
      status: issue.state?.name ?? "Todo",
      ...(issue.assignee?.name ? { assignee: issue.assignee.name } : {}),
      ...(issue.dueDate ? { dueDate: issue.dueDate.slice(0, 10) } : {}),
      url: issue.url,
    };
  }

  async createTask(input: CreateTaskInput): Promise<ExternalTask> {
    const marker = this.markerFor(input);
    const description = `${input.description ?? input.title}\n\n${marker}`;
    const variables: Record<string, unknown> = {
      teamId: this.teamId,
      title: input.title,
      description,
      ...(input.dueDate ? { dueDate: input.dueDate } : {}),
    };
    if (input.assignee) {
      const assigneeId = await this.resolveAssignee(input.assignee);
      if (assigneeId) variables.assigneeId = assigneeId;
    }
    if (input.status) {
      const stateId = (await this.states()).get(this.toExternalWord(input.status));
      if (stateId) variables.stateId = stateId;
    }
    const data = await this.gql<{ issueCreate: { success: boolean; issue: LinearIssue } }>(
      `mutation CreateIssue($teamId: String!, $title: String!, $description: String!, $dueDate: Date, $assigneeId: String, $stateId: String) {
         issueCreate(input: { teamId: $teamId, title: $title, description: $description, dueDate: $dueDate, assigneeId: $assigneeId, stateId: $stateId }) {
           success
           issue { id identifier title description state { name } assignee { name email } dueDate url }
         }
       }`,
      variables,
    );
    if (!data.issueCreate.success || !data.issueCreate.issue) {
      throw new LinearError("linear issueCreate reported failure", 0, false);
    }
    const issue = data.issueCreate.issue;
    this.idByIdentifier.set(issue.identifier, issue.id);
    return this.toExternal(issue);
  }

  async updateTask(externalId: string, input: UpdateTaskInput): Promise<ExternalTask> {
    // The identifier (LIN-482) is the public id; the mutation wants the UUID.
    let uuid = this.idByIdentifier.get(externalId);
    if (!uuid) {
      const found = await this.getTask(externalId);
      uuid = this.idByIdentifier.get(found.externalId);
      if (!uuid) throw new LinearError(`cannot resolve issue "${externalId}"`, 0, false);
    }
    const variables: Record<string, unknown> = { id: uuid };
    if (input.title !== undefined) variables.title = input.title;
    if (input.description !== undefined) variables.description = input.description;
    if (input.dueDate !== undefined) variables.dueDate = input.dueDate;
    if (input.assignee !== undefined) {
      const assigneeId = await this.resolveAssignee(input.assignee);
      if (assigneeId) variables.assigneeId = assigneeId;
    }
    if (input.status !== undefined) {
      const stateId = (await this.states()).get(this.toExternalWord(input.status));
      if (stateId) variables.stateId = stateId;
    }
    const data = await this.gql<{ issueUpdate: { success: boolean; issue: LinearIssue } }>(
      `mutation UpdateIssue($id: String!, $title: String, $description: String, $dueDate: Date, $assigneeId: String, $stateId: String) {
         issueUpdate(id: $id, input: { title: $title, description: $description, dueDate: $dueDate, assigneeId: $assigneeId, stateId: $stateId }) {
           success
           issue { id identifier title description state { name } assignee { name email } dueDate url }
         }
       }`,
      variables,
    );
    if (!data.issueUpdate.success || !data.issueUpdate.issue) {
      throw new LinearError("linear issueUpdate reported failure", 0, false);
    }
    return this.toExternal(data.issueUpdate.issue);
  }

  async getTask(externalId: string): Promise<ExternalTask> {
    const data = await this.gql<{ issue: LinearIssue | null }>(
      `query($identifier: String!) { issue(id: $identifier) { id identifier title description state { name } assignee { name email } dueDate url } }`,
      { identifier: externalId },
    );
    if (!data.issue) {
      throw new LinearError(`linear issue "${externalId}" does not exist`, 0, false);
    }
    this.idByIdentifier.set(data.issue.identifier, data.issue.id);
    return this.toExternal(data.issue);
  }

  async searchTasks(query: string): Promise<ExternalTask[]> {
    const data = await this.gql<{ issues: { nodes: LinearIssue[] } }>(
      `query($search: String!) { issues(filter: { or: [{ title: { contains: $search } }, { description: { contains: $search } }] }, first: 25) { nodes { id identifier title description state { name } assignee { name email } dueDate url } } }`,
      { search: query },
    );
    for (const issue of data.issues.nodes) {
      this.idByIdentifier.set(issue.identifier, issue.id);
    }
    return data.issues.nodes.map((issue) => this.toExternal(issue));
  }

  /**
   * THE RECOVERY: find the issue whose description carries the marker —
   * the create landed despite the lost response. Found → the executor
   * links THIS issue (0 duplicates); not found → the retry re-creates.
   */
  async recoverCreate(marker: string): Promise<ExternalTask | undefined> {
    const found = await this.searchTasks(marker);
    return found[0] ?? undefined;
  }

  /**
   * Linear's WorkflowState NAMES → the D1 vocabulary. UNKNOWN → undefined
   * (never a guess — "In QA" is not "open", ADR 0032's rule; the surface
   * preserves Lucent's state and warns).
   */
  mapStatus(externalStatus: string): ExecutionStatus | undefined {
    switch (externalStatus.trim().toLowerCase()) {
      case "todo":
      case "backlog":
        return "open";
      case "in progress":
        return "in_progress";
      case "blocked":
        return "blocked";
      case "done":
      case "completed":
        return "completed";
      case "canceled":
      case "cancelled":
        return "cancelled";
      default:
        return undefined;
    }
  }

  /** The reverse direction: Lucent's word → Linear's WorkflowState NAME. */
  toExternalStatus(lucentStatus: string): string {
    switch (lucentStatus) {
      case "in_progress":
        return "In Progress";
      case "blocked":
        return "Blocked";
      case "completed":
        return "Done";
      case "cancelled":
        return "Canceled";
      case "open":
      case "assigned":
      default:
        return "Todo";
    }
  }

  private toExternalWord(lucentStatus: string): string {
    return this.toExternalStatus(lucentStatus).toLowerCase();
  }
}

/**
 * The Linear factory (the map's value): resolves the connection's
 * credentialRef through the environment — ADR 0032's TEMPORARY single-
 * deployment mechanism, replaceable in D6+/E — and reads the connection's
 * config (teamId is REQUIRED; the honest 400 at connect time, not a
 * runtime surprise).
 */
export function linearConnectionFactory(): (connection: {
  credentialRef: string;
  config?: Record<string, string>;
  oauth?: { accessToken: string };
}) => ExecutionProvider {
  return (connection) => {
    // docs/26 A5: a connection made through OAuth brings its token.
    const apiKey = connection.oauth ? undefined : process.env[connection.credentialRef];
    if (!apiKey && !connection.oauth) {
      throw new LinearError(
        `credential ref "${connection.credentialRef}" is not set in the environment`,
        0,
        false,
      );
    }
    const teamId = connection.config?.teamId;
    if (!teamId) {
      throw new LinearError("the linear connection is missing config.teamId", 0, false);
    }
    return new LinearProvider({
      ...(connection.oauth ? { accessToken: connection.oauth.accessToken } : { apiKey: apiKey! }),
      teamId,
      // A connection-scoped wire override for testing and self-hosted
      // proxies; unset means the public api.linear.app endpoint. Validated
      // SSRF-safe at connect time and refused in production unless the
      // operator explicitly opts in — otherwise any org owner could point
      // the server (carrying the credential) at an attacker host.
      ...(connection.config?.baseUrl
        ? { baseUrl: resolveCustomBaseUrl(connection.config.baseUrl, "linear") }
        : {}),
    });
  };
}

/**
 * Shared custom-URL gate: SSRF-safe always, production-opt-in only.
 * Tests construct providers directly with any baseUrl; only the
 * connection-config path (owner-controlled) passes through here.
 */
export function resolveCustomBaseUrl(candidate: string, what: string): string {
  const checked = assertSafeOutboundUrl(candidate, `${what} config.baseUrl`);
  if (
    process.env["NODE_ENV"] === "production" &&
    process.env["LUCENT_ALLOW_CUSTOM_INTEGRATION_URL"] !== "1"
  ) {
    throw new LinearError(
      `${what} config.baseUrl is disabled in production (set LUCENT_ALLOW_CUSTOM_INTEGRATION_URL=1 to allow self-hosted proxies)`,
      0,
      false,
    );
  }
  return checked.toString().replace(/\/$/, "");
}
