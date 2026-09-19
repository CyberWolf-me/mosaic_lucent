import type {
  CreateTaskInput,
  ExternalTask,
  ExecutionProvider,
  UpdateTaskInput,
} from "./provider.js";
import type { ExecutionStatus } from "@lucent/core";
import { assertSafeOutboundUrl } from "./outboundUrl.js";

/**
 * The Jira adapter (Stage D8, ADR 0034) — the third real ExecutionProvider,
 * and the proof of the review's correction: Jira's provider-specific
 * configuration SCHEMA is three fields (site + projectKey + issueType),
 * which is why the ADR says "one provider-specific configuration schema",
 * not "one config field".
 *
 * THE WIRE (REST v3, pinned by scripted tests — never a live account):
 * Basic auth (email:api_token), the per-org `site` base URL (validated
 * SSRF-safe at factory time — a user-configured outbound destination is
 * the classic SSRF boundary; the policy lives in outboundUrl.ts and
 * ADR 0034), `projectKey` scopes every query, `issueType` defaults "Task".
 *
 * THE THREE RECORDED JIRA DIVERGENCES:
 * - Descriptions are ADF (Atlassian Document Format): the marker rides in
 *   an ADF text node, not a markdown comment — the recovery search key
 *   must be quoted JQL text.
 * - STATUS MOVES ONLY THROUGH TRANSITIONS: a direct status PUT does not
 *   exist in Jira. updateTask lists the issue's available transitions,
 *   maps each `to.name` through mapStatus (the provider's OWN status
 *   knowledge), and posts the one matching transition. 0 matches → the
 *   honest "no transition to <status> available" error; >1 → the honest
 *   ambiguous failure — the assignee-resolution philosophy applied to
 *   state machines. NEVER a first-match guess.
 * - Company-managed custom statuses ("In QA", "In Review") are
 *   DELIBERATELY unmapped: mapStatus returns undefined for everything
 *   but the well-known defaults. A future status-configuration mechanism
 *   is the honest answer to "why doesn't Lucent understand our QA status"
 *   — never hardcoding fifty states.
 *
 * THE RECOVERY CONTRACT: the same hardened 0/1/>1 + poll as GitHub
 * (ADR 0034), scoped by JQL `text ~ "marker" AND project = KEY`.
 *
 * INBOUND IS NOT BUILT: Atlassian's webhook authentication is the
 * Connect framework's JWT/QSH scheme (its own project) — the webhook
 * route answers the honest 404 for jira, and the sweeper's getTask
 * refetch path is the interim inbound (the D7 doctrine).
 */

const RETRY_BASE_MS = 250;
const RETRY_MAX_MS = 4_000;
const DEFAULT_RECOVER_POLL_MS = [500, 1_000, 2_000];

/** Jira project keys: uppercase letters + digits, the classic shape. */
const PROJECT_KEY_PATTERN = /^[A-Z][A-Z0-9]{1,9}$/;

export function validJiraProjectKey(key: string): boolean {
  return PROJECT_KEY_PATTERN.test(key);
}

export interface JiraProviderOptions {
  /** email:api-token Basic auth (the token resolved through the env ref). */
  email: string;
  apiToken: string;
  /** The per-org site base URL (https, SSRF-validated at factory time). */
  site: string;
  projectKey: string;
  issueType?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  recoverPollMs?: number[];
}

export class JiraError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "JiraError";
  }
}

function markerFor(input: CreateTaskInput | { title: string; idempotencyKey?: string }): string {
  return `lucent-action:${input.idempotencyKey ?? input.title.slice(0, 40)}`;
}

/** A Jira issue as the wire returns it (the fields Lucent reads). */
interface JiraIssue {
  key: string;
  fields: {
    summary: string;
    description?: unknown; // ADF
    status?: { name?: string };
    assignee?: { accountId?: string; emailAddress?: string; displayName?: string } | null;
    duedate?: string | null;
  };
}

/** The ADF document shape Lucent builds (a one-paragraph text) and reads
 * (a text node scan — the marker may sit anywhere in the doc). */
function adfWithMarker(text: string, marker: string): unknown {
  return {
    type: "doc",
    version: 1,
    content: [
      {
        type: "paragraph",
        content: [
          { type: "text", text: text ? `${text}\n\n` : "" },
          { type: "text", text: `<!-- ${marker} -->` },
        ],
      },
    ],
  };
}

/** Extract the plain text out of an ADF doc (the marker search + the
 * description round-trip both need it). */
function _adfText(doc: unknown): string {
  if (typeof doc !== "object" || doc === null) return "";
  const out: string[] = [];
  const walk = (node: Record<string, unknown>): void => {
    if (typeof node["text"] === "string") out.push(node["text"]);
    if (Array.isArray(node["content"])) {
      for (const child of node["content"]) {
        if (typeof child === "object" && child !== null) walk(child as Record<string, unknown>);
      }
    }
  };
  walk(doc as Record<string, unknown>);
  return out.join("\n");
}

export class JiraProvider implements ExecutionProvider {
  readonly name = "jira";
  private readonly auth: string;
  private readonly site: string;
  private readonly projectKey: string;
  private readonly issueType: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly recoverPollMs: number[];
  /** The assignable-users index (exact email/name → accountId), one
   * fetch per instance — the assignee ladder's single wire cost. */
  private assigneeIndex: Map<string, { accountId: string; label: string }> | null = null;
  private assigneeIndexPromise: Promise<void> | null = null;

  constructor(options: JiraProviderOptions) {
    this.auth = Buffer.from(`${options.email}:${options.apiToken}`).toString("base64");
    // The factory validated the site; a direct constructor use validates
    // too (the boundary is authoritative both ways).
    this.site = assertSafeOutboundUrl(options.site, "jira site").origin;
    if (!validJiraProjectKey(options.projectKey)) {
      throw new JiraError(
        `projectKey must be uppercase letters/digits (got "${options.projectKey}")`,
        0,
        false,
      );
    }
    this.projectKey = options.projectKey;
    this.issueType = options.issueType ?? "Task";
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    this.random = options.random ?? Math.random;
    this.recoverPollMs = options.recoverPollMs ?? DEFAULT_RECOVER_POLL_MS;
  }

  private async rest<T>(path: string, init?: RequestInit): Promise<T> {
    let lastError: JiraError | null = null;
    for (let attempt = 0; attempt < this.maxAttempts; attempt += 1) {
      if (attempt > 0) {
        const backoff = Math.min(RETRY_BASE_MS * 2 ** attempt, RETRY_MAX_MS);
        await this.sleep(Math.floor(backoff / 2 + this.random() * (backoff / 2)));
      }
      try {
        const res = await this.fetchImpl(`${this.site}/rest/api/3${path}`, {
          ...init,
          headers: {
            authorization: `Basic ${this.auth}`,
            accept: "application/json",
            ...(init?.body !== undefined ? { "content-type": "application/json" } : {}),
            ...init?.headers,
          },
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (res.status === 429 || res.status >= 500) {
          lastError = new JiraError(`jira responded ${res.status}`, res.status, true);
          continue;
        }
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            errorMessages?: string[];
          };
          const detail = body.errorMessages?.join("; ") ?? "";
          throw new JiraError(
            detail ? `jira responded ${res.status}: ${detail}` : `jira responded ${res.status}`,
            res.status,
            false,
          );
        }
        if (res.status === 204) return undefined as T;
        return (await res.json()) as T;
      } catch (err) {
        if (err instanceof JiraError && !err.retryable) throw err;
        lastError = new JiraError((err as Error).message, 0, true);
      }
    }
    throw lastError ?? new JiraError("jira call failed", 0, false);
  }

  private toExternal(issue: JiraIssue): ExternalTask {
    return {
      provider: "jira",
      externalId: issue.key,
      title: issue.fields.summary,
      status: issue.fields.status?.name ?? "",
      ...(issue.fields.assignee?.displayName
        ? { assignee: issue.fields.assignee.displayName }
        : {}),
      ...(issue.fields.duedate ? { dueDate: issue.fields.duedate } : {}),
      url: `${this.site}/browse/${issue.key}`,
    };
  }

  async createTask(input: CreateTaskInput): Promise<ExternalTask> {
    const assignee =
      input.assignee !== undefined ? await this.resolveAssignee(input.assignee) : null;
    const issue = await this.rest<{ key: string }>("/issue", {
      method: "POST",
      body: JSON.stringify({
        fields: {
          project: { key: this.projectKey },
          summary: input.title,
          ...(input.description !== undefined || input.idempotencyKey !== undefined
            ? {
                description: adfWithMarker(input.description ?? "", markerFor(input)),
              }
            : {}),
          issuetype: { name: this.issueType },
          ...(assignee ? { assignee: { accountId: assignee.accountId } } : {}),
          ...(input.dueDate !== undefined ? { duedate: input.dueDate } : {}),
        },
      }),
    });
    // Jira answers the create with the key; read the full issue for the
    // status word (the honest external value, not an assumed default).
    return this.getTask(issue.key);
  }

  async updateTask(externalId: string, input: UpdateTaskInput): Promise<ExternalTask> {
    // The fields PUT directly: title/summary, description, assignee,
    // duedate. STATUS DOES NOT — Jira only moves status through
    // transitions (the recorded divergence).
    const assignee =
      input.assignee !== undefined ? await this.resolveAssignee(input.assignee) : null;
    await this.rest("/issue/" + encodeURIComponent(externalId), {
      method: "PUT",
      body: JSON.stringify({
        fields: {
          ...(input.title !== undefined ? { summary: input.title } : {}),
          ...(input.description !== undefined
            ? {
                description: adfWithMarker(
                  input.description,
                  markerFor({ title: input.title ?? externalId }),
                ),
              }
            : {}),
          ...(assignee ? { assignee: { accountId: assignee.accountId } } : {}),
          ...(input.dueDate !== undefined ? { duedate: input.dueDate } : {}),
        },
      }),
    });
    if (input.status !== undefined) {
      await this.transition(externalId, input.status);
    }
    return this.getTask(externalId);
  }

  /**
   * THE TRANSITIONS CONTRACT (ADR 0034): list the issue's available
   * transitions, map each `to.name` through the provider's OWN status
   * knowledge, and post the single one that lands on the target.
   * 0 → the honest error; 1 → post it; >1 → the honest ambiguous failure.
   * NEVER the first match — a guess between two "Done" transitions is a
   * guess about someone's workflow.
   */
  private async transition(externalId: string, lucentStatus: string): Promise<void> {
    const target = this.toExternalStatus(lucentStatus);
    const data = await this.rest<{
      transitions?: Array<{ id: string; name: string; to?: { name?: string } }>;
    }>(`/issue/${encodeURIComponent(externalId)}/transitions`);
    const matching = (data.transitions ?? []).filter((t) => (t.to?.name ?? "").trim() === target);
    if (matching.length === 0) {
      throw new JiraError(`no transition to "${target}" is available for ${externalId}`, 0, false);
    }
    if (matching.length > 1) {
      throw new JiraError(
        `ambiguous transition: ${matching.length} candidates lead to "${target}" for ${externalId}`,
        0,
        false,
      );
    }
    await this.rest(`/issue/${encodeURIComponent(externalId)}/transitions`, {
      method: "POST",
      body: JSON.stringify({ transition: { id: matching[0]!.id } }),
    });
  }

  async getTask(externalId: string): Promise<ExternalTask> {
    const issue = await this.rest<JiraIssue>(
      `/issue/${encodeURIComponent(externalId)}?fields=summary,description,status,assignee,duedate`,
    );
    return this.toExternal(issue);
  }

  async searchTasks(query: string): Promise<ExternalTask[]> {
    // JQL text search, scoped to the project.
    const jql = `text ~ "${query.replace(/"/g, "")}" AND project = ${this.projectKey}`;
    const data = await this.rest<{ issues?: JiraIssue[] }>(
      `/search/jql?jql=${encodeURIComponent(jql)}&maxResults=25`,
    );
    return (data.issues ?? []).map((issue) => this.toExternal(issue));
  }

  /**
   * THE HARDENED RECOVERY (ADR 0034, same contract as GitHub): poll the
   * scoped search before declaring not-found; 0 → retry the create,
   * 1 → recover, >1 → the honest ambiguous failure.
   */
  async recoverCreate(marker: string): Promise<ExternalTask | undefined> {
    let found: ExternalTask[] = [];
    for (const wait of [0, ...this.recoverPollMs]) {
      if (wait > 0) await this.sleep(wait);
      found = await this.searchTasks(marker);
      if (found.length > 0) break;
    }
    if (found.length === 0) return undefined;
    if (found.length > 1) {
      throw new JiraError(`ambiguous recovery: ${found.length} issues carry the marker`, 0, false);
    }
    return found[0];
  }

  /**
   * mapStatus — conservative by design (the review's #12/#16): the three
   * well-known Jira defaults ONLY. Every company-managed custom status
   * ("In QA", "In Review", "Awaiting Approval") → undefined, the
   * never-guesses rule's showcase.
   */
  mapStatus(externalStatus: string): ExecutionStatus | undefined {
    switch (externalStatus.trim().toLowerCase()) {
      case "to do":
      case "todo":
      case "backlog":
        return "open";
      case "in progress":
        return "in_progress";
      case "done":
        return "completed";
      default:
        return undefined;
    }
  }

  /** The reverse map over the same well-known defaults. */
  toExternalStatus(lucentStatus: string): string {
    switch (lucentStatus) {
      case "open":
      case "assigned":
        return "To Do";
      case "in_progress":
        return "In Progress";
      case "completed":
        return "Done";
      default:
        // blocked/cancelled have no well-known Jira counterpart — the
        // capability warning says so BEFORE execution; the honest error
        // answers a call that gets this far anyway.
        throw new JiraError(
          `Lucent status "${lucentStatus}" has no well-known Jira counterpart`,
          0,
          false,
        );
    }
  }

  /**
   * THE CAPABILITY-HONESTY SEAM: a Lucent status with no well-known Jira
   * word (blocked, cancelled) warns here; the transitions contract then
   * enforces it at execution if the warning was acked and the call made.
   */
  capabilityWarnings(input: {
    title: string;
    assignee?: string;
    dueDate?: string;
    status?: string;
  }): Array<{ field: string; reason: string }> {
    const warnings: Array<{ field: string; reason: string }> = [];
    if (
      input.status !== undefined &&
      input.status !== "open" &&
      input.status !== "assigned" &&
      input.status !== "in_progress" &&
      input.status !== "completed"
    ) {
      warnings.push({
        field: "status",
        reason: `"${input.status}" has no well-known Jira status; the transition may be unavailable`,
      });
    }
    return warnings;
  }

  /**
   * The assignee ladder: exact email > exact display name > unique partial
   * — all three reliable against the v3 user search, resolving to
   * accountId. Cached per instance. AMBIGUOUS throws the honest error
   * (never a guess); NOT-FOUND returns null → the create/update omits the
   * assignee quietly — the same contract as GitHub's ladder (ADR 0034:
   * unresolvable is a warning-and-omit, not a failed item).
   */
  private async resolveAssignee(
    assignee: string,
  ): Promise<{ accountId: string; label: string } | null> {
    const key = assignee.trim().toLowerCase();
    await this.ensureAssigneeIndex();
    const index = this.assigneeIndex!;
    const exact = index.get(key);
    if (exact) return exact;
    const partial = [...index.keys()].filter((k) => k.includes(key) || key.includes(k));
    if (partial.length === 1) return index.get(partial[0]!)!;
    if (partial.length > 1) {
      throw new JiraError(`unable to uniquely resolve assignee "${assignee}"`, 0, false);
    }
    return null;
  }

  private async ensureAssigneeIndex(): Promise<void> {
    if (this.assigneeIndex) return;
    if (!this.assigneeIndexPromise) {
      this.assigneeIndexPromise = (async () => {
        const users = await this.rest<
          Array<{ accountId: string; emailAddress?: string; displayName?: string }>
        >(`/user/assignable/search?project=${encodeURIComponent(this.projectKey)}&maxResults=100`);
        const index = new Map<string, { accountId: string; label: string }>();
        for (const user of users) {
          const entry = { accountId: user.accountId, label: user.displayName ?? user.accountId };
          if (user.emailAddress) index.set(user.emailAddress.toLowerCase(), entry);
          if (user.displayName) index.set(user.displayName.toLowerCase(), entry);
        }
        this.assigneeIndex = index;
      })().finally(() => {
        this.assigneeIndexPromise = null;
      });
    }
    await this.assigneeIndexPromise;
  }
}

/**
 * The factory: the provider-specific configuration SCHEMA is
 * site + projectKey + issueType (default "Task"). The site is validated
 * SSRF-safe at CONNECT time (the honest 400; ADR 0034's policy).
 */
export function jiraConnectionFactory(): (connection: {
  credentialRef: string;
  config?: Record<string, string>;
}) => ExecutionProvider {
  return (connection) => {
    const credential = process.env[connection.credentialRef];
    if (!credential) {
      throw new JiraError(
        `credential ref "${connection.credentialRef}" is not set in the environment (expected "email:api_token")`,
        0,
        false,
      );
    }
    const [email, apiToken] = credential.split(":");
    if (!email || !apiToken) {
      throw new JiraError(
        `credential ref "${connection.credentialRef}" must be "email:api_token"`,
        0,
        false,
      );
    }
    const site = connection.config?.site;
    if (!site) {
      throw new JiraError("the jira connection is missing config.site", 0, false);
    }
    const projectKey = connection.config?.projectKey;
    if (!projectKey) {
      throw new JiraError("the jira connection is missing config.projectKey", 0, false);
    }
    if (!validJiraProjectKey(projectKey)) {
      throw new JiraError(
        `config.projectKey must be uppercase letters/digits (got "${projectKey}")`,
        0,
        false,
      );
    }
    return new JiraProvider({
      email,
      apiToken,
      site,
      projectKey,
      ...(connection.config?.issueType ? { issueType: connection.config.issueType } : {}),
    });
  };
}
