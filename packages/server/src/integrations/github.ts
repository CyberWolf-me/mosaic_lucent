import type {
  CreateTaskInput,
  ExternalTask,
  ExecutionProvider,
  UpdateTaskInput,
} from "./provider.js";
import type { ExecutionStatus } from "@lucent/core";

/**
 * The GitHub Issues adapter (Stage D8, ADR 0034) — the second real
 * ExecutionProvider, and the proof that the "one provider implementation +
 * one factory entry + one provider-specific configuration schema" formula
 * holds: no route, queue, ledger, or decide-path change was needed.
 *
 * THE WIRE (REST v3, pinned by scripted tests — never a live account):
 * one base URL (api.github.com, or config.baseUrl for GitHub Enterprise),
 * `Authorization: Bearer <PAT>` + `X-GitHub-Api-Version` + the mandatory
 * `User-Agent` (the repo's own oauth.ts documents: no UA, no service).
 *
 * THE TWO RECORDED DIVERGENCES (ADR 0034's refined doctrine — the provider
 * represents the fields it can FAITHFULLY, and warns about the rest; never
 * a silent drop):
 * - dueDate has no native GitHub field. capabilityWarnings says so; the
 *   executor never sends one.
 * - Status is LOSSY outbound: GitHub has open/closed only, so every
 *   non-completed Lucent word collapses to "open" and cancelled becomes
 *   closed:not_planned. The preview warns; the approve gate requires the
 *   ack. Inbound is faithful: state+state_reason compose the external word
 *   ("closed:not_planned") that mapStatus translates.
 *
 * THE RECOVERY CONTRACT (ADR 0034, hardened): recoverCreate searches
 * `repo:owner/name` + the marker token with a small poll budget before
 * declaring not-found (the eventual-index window); 0 → retry the create,
 * 1 → recover, >1 → the honest ambiguous failure — never a guess.
 *
 * THE ASSIGNEE LADDER — only reliable strategies (ADR 0034): exact login
 * (verified through the user search) > unique partial (login/name).
 * EMAIL IS DELIBERATELY NOT OFFERED: a PAT's user-search scope cannot
 * reliably resolve an email to a login, and a best-effort guess is what
 * the never-guess rule forbids. Unresolvable → the capability warning +
 * quiet omission.
 */

const RETRY_BASE_MS = 250;
const RETRY_MAX_MS = 4_000;
const DEFAULT_RECOVER_POLL_MS = [500, 1_000, 2_000];

/** GitHub's repo config: exact `owner/repo` — validated so `../` and
 * malformed names never reach URL construction (the SSRF-adjacent
 * boundary ADR 0034 requires at connect time). Dots are legal in owner
 * and repo names, so the pattern alone cannot refuse `../` — the
 * segments are checked explicitly for path-traversal dot segments. */
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function validGitHubRepo(repo: string): boolean {
  if (!REPO_PATTERN.test(repo)) return false;
  const [owner, name] = repo.split("/");
  for (const segment of [owner!, name!]) {
    if (segment === "." || segment === "..") return false;
  }
  return true;
}

export interface GitHubProviderOptions {
  /** A PAT with repo scope — resolved through the connection's env ref. */
  token: string;
  /** owner/repo — the one provider-specific config field. */
  repo: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /** The recovery poll cadence before declaring not-found (tests inject
   * a short one; the default is 500ms/1s/2s — the eventual-index window). */
  recoverPollMs?: number[];
}

export class GithubError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "GithubError";
  }
}

/** The marker, stamped into the body — the recoverCreate search key. */
function markerFor(input: CreateTaskInput | { title: string; idempotencyKey?: string }): string {
  return `lucent-action:${input.idempotencyKey ?? input.title.slice(0, 40)}`;
}

/** A GitHub issue as the wire returns it (the fields Lucent reads). */
interface GithubIssue {
  number: number;
  title: string;
  body: string | null;
  state: string;
  state_reason: string | null;
  html_url: string;
  assignees?: Array<{ login: string }>;
}

export class GithubProvider implements ExecutionProvider {
  readonly name = "github";
  private readonly token: string;
  private readonly repo: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly recoverPollMs: number[];
  /** The assignable-users index (lowercased login → login), fetched once
   * per instance — the assignee ladder's single wire cost. */
  private assigneeIndex: Map<string, string> | null = null;
  private assigneeIndexPromise: Promise<void> | null = null;
  /** Resolved answers by request key (lowercased) — the ladder's cache. */
  private readonly assigneeCache = new Map<string, string | null>();

  constructor(options: GitHubProviderOptions) {
    if (!validGitHubRepo(options.repo)) {
      throw new GithubError(
        `repo must be "owner/repo" (got "${options.repo}")`,
        0,
        false,
      );
    }
    this.token = options.token;
    this.repo = options.repo;
    this.baseUrl = (options.baseUrl ?? "https://api.github.com").replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    this.random = options.random ?? Math.random;
    this.recoverPollMs = options.recoverPollMs ?? DEFAULT_RECOVER_POLL_MS;
  }

  private async rest<T>(path: string, init?: RequestInit): Promise<T> {
    let lastError: GithubError | null = null;
    for (let attempt = 0; attempt < this.maxAttempts; attempt += 1) {
      if (attempt > 0) {
        const backoff = Math.min(RETRY_BASE_MS * 2 ** attempt, RETRY_MAX_MS);
        await this.sleep(Math.floor(backoff / 2 + this.random() * (backoff / 2)));
      }
      try {
        const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
          ...init,
          headers: {
            // GitHub's documented scheme (Bearer — the OPPOSITE of
            // Linear's raw key, commented so nobody "fixes" it).
            authorization: `Bearer ${this.token}`,
            accept: "application/vnd.github+json",
            "content-type": "application/json",
            "x-github-api-version": "2022-11-28",
            // GitHub refuses requests without a UA outright.
            "user-agent": "lucent-integration",
            ...init?.headers,
          },
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (res.status === 429 || res.status >= 500) {
          lastError = new GithubError(`github responded ${res.status}`, res.status, true);
          continue;
        }
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { message?: string };
          throw new GithubError(
            body.message ? `github responded ${res.status}: ${body.message}` : `github responded ${res.status}`,
            res.status,
            false,
          );
        }
        return (await res.json()) as T;
      } catch (err) {
        if (err instanceof GithubError && !err.retryable) throw err;
        lastError = new GithubError((err as Error).message, 0, true);
      }
    }
    throw lastError ?? new GithubError("github call failed", 0, false);
  }

  private issuePath(number?: number): string {
    return `/repos/${this.repo}/issues${number !== undefined ? `/${number}` : ""}`;
  }

  private toExternal(issue: GithubIssue): ExternalTask {
    return {
      provider: "github",
      externalId: String(issue.number),
      title: issue.title,
      status: this.composeWord(issue.state, issue.state_reason),
      ...(issue.assignees?.[0] ? { assignee: issue.assignees[0].login } : {}),
      url: issue.html_url,
    };
  }

  /** state + state_reason compose the external word — the exact observation
   * the inbound queue stores ("closed:not_planned"), which mapStatus then
   * translates. D7's externalValue/mappedValue separation. */
  private composeWord(state: string, stateReason: string | null): string {
    if (state === "closed" && stateReason) return `closed:${stateReason}`;
    return state;
  }

  async createTask(input: CreateTaskInput): Promise<ExternalTask> {
    const assignees = input.assignee !== undefined ? await this.resolveAssignee(input.assignee) : null;
    const issue = await this.rest<GithubIssue>(this.issuePath(), {
      method: "POST",
      body: JSON.stringify({
        title: input.title,
        // The marker rides the body — the recovery search key.
        body: `${input.description ?? ""}\n\n<!-- ${markerFor(input)} -->`.trim(),
        ...(assignees ? { assignees: [assignees] } : {}),
      }),
    });
    return this.toExternal(issue);
  }

  async updateTask(externalId: string, input: UpdateTaskInput): Promise<ExternalTask> {
    const number = Number(externalId);
    if (!Number.isInteger(number)) {
      throw new GithubError(`external id "${externalId}" is not a GitHub issue number`, 0, false);
    }
    const assignees = input.assignee !== undefined ? await this.resolveAssignee(input.assignee) : null;
    // The close word splits across the wire's two fields: state ("closed")
    // + state_reason ("completed"/"not_planned") — GitHub rejects a
    // state_reason on an open issue, so it rides only on close.
    const externalWord = input.status !== undefined ? this.toExternalStatus(input.status) : undefined;
    const [wireState, wireReason] = externalWord !== undefined && externalWord.startsWith("closed:")
      ? [externalWord.split(":")[0]!, externalWord.split(":")[1]!]
      : externalWord !== undefined
        ? [externalWord, undefined]
        : [undefined, undefined];
    const issue = await this.rest<GithubIssue>(this.issuePath(number), {
      method: "PATCH",
      body: JSON.stringify({
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.description !== undefined
          ? { body: `${input.description}\n\n<!-- ${markerFor({ title: input.title ?? externalId })} -->`.trim() }
          : {}),
        ...(assignees ? { assignees: [assignees] } : {}),
        ...(wireState !== undefined ? { state: wireState } : {}),
        ...(wireReason !== undefined ? { state_reason: wireReason } : {}),
      }),
    });
    return this.toExternal(issue);
  }

  async getTask(externalId: string): Promise<ExternalTask> {
    const number = Number(externalId);
    if (!Number.isInteger(number)) {
      throw new GithubError(`external id "${externalId}" is not a GitHub issue number`, 0, false);
    }
    const issue = await this.rest<GithubIssue>(this.issuePath(number));
    return this.toExternal(issue);
  }

  async searchTasks(query: string): Promise<ExternalTask[]> {
    // The search endpoint takes the query in the URL (scoped to this repo).
    const data = await this.rest<{ items?: GithubIssue[] }>(
      `/search/issues?q=${encodeURIComponent(`${query} repo:${this.repo}`)}&per_page=25`,
    );
    return (data.items ?? []).map((issue) => this.toExternal(issue));
  }

  /**
   * THE HARDENED RECOVERY (ADR 0034): search with a poll budget before
   * declaring not-found (a just-created issue may not be indexed yet);
   * 0 → undefined (retry the create), 1 → recover, >1 → the honest
   * ambiguous failure — the marker is unique per connection, so more
   * than one hit is a corruption state, never a choice to make.
   */
  async recoverCreate(marker: string): Promise<ExternalTask | undefined> {
    let found: ExternalTask[] = [];
    for (const wait of [0, ...this.recoverPollMs]) {
      if (wait > 0) await this.sleep(wait);
      found = await this.searchTasks(`"${marker}"`);
      if (found.length > 0) break;
    }
    if (found.length === 0) return undefined;
    if (found.length > 1) {
      throw new GithubError(
        `ambiguous recovery: ${found.length} issues carry the marker`,
        0,
        false,
      );
    }
    return found[0];
  }

  /**
   * mapStatus — GitHub's honest vocabulary (the never-guesses rule).
   * The composed words carry the state_reason; anything else is undefined.
   */
  mapStatus(externalStatus: string): ExecutionStatus | undefined {
    switch (externalStatus.trim().toLowerCase()) {
      case "open":
        return "open";
      case "closed":
      case "closed:completed":
        return "completed";
      case "closed:not_planned":
        return "cancelled";
      default:
        return undefined;
    }
  }

  /**
   * toExternalStatus — the RECORDED LOSSY direction: GitHub has no
   * in_progress/blocked, so every non-completed Lucent word becomes
   * "open". The preview warns; the record carries the warning.
   */
  toExternalStatus(lucentStatus: string): string {
    switch (lucentStatus) {
      case "completed":
        return "closed:completed";
      case "cancelled":
        return "closed:not_planned";
      default:
        // open/assigned/in_progress/blocked — all collapse to GitHub "open".
        return "open";
    }
  }

  /**
   * THE CAPABILITY-HONESTY SEAM (ADR 0034): what this item CANNOT be
   * faithfully. The propose route stores these on the item; approve
   * refuses until the human acks them.
   */
  capabilityWarnings(input: {
    title: string;
    assignee?: string;
    dueDate?: string;
    status?: string;
  }): Array<{ field: string; reason: string }> {
    const warnings: Array<{ field: string; reason: string }> = [];
    if (input.dueDate !== undefined) {
      warnings.push({
        field: "dueDate",
        reason: `GitHub has no due-date field; ${input.dueDate} will not be synced`,
      });
    }
    if (input.status !== undefined && input.status !== "open" && input.status !== "completed" && input.status !== "cancelled") {
      warnings.push({
        field: "status",
        reason: `"${input.status}" is represented as open on GitHub`,
      });
    }
    if (input.assignee !== undefined) {
      // The synchronous warning fires when the ladder has ALREADY resolved
      // this assignee to null (a prior execution's attempt): the omission
      // is then a known fact, warnable before execution. An unresolvable
      // name never seen before defers to the execution-time resolution —
      // its warning, if any, rides the item's next propose.
      const cached = this.assigneeCache.get(this.assigneeKey(input.assignee));
      if (cached === null) {
        warnings.push({
          field: "assignee",
          reason: `"${input.assignee}" cannot be resolved on GitHub; it will be omitted`,
        });
      }
    }
    return warnings;
  }

  private assigneeKey(assignee: string): string {
    return assignee.trim().toLowerCase();
  }

  /**
   * The reliable-only ladder: exact login > unique partial (login/name),
   * resolved through the repo's assignable-users list. EMAIL IS NOT
   * OFFERED — a PAT's search scope cannot reliably map email → login;
   * guessing is what the never-guess rule forbids. One fetch per
   * instance, then every key (already requested or yet to be) resolves
   * against the cached index — the Linear states-cache pattern.
   */
  private async resolveAssignee(assignee: string): Promise<string | null> {
    const key = this.assigneeKey(assignee);
    await this.ensureAssigneeIndex();
    const resolved = this.matchAssignee(key);
    this.assigneeCache.set(key, resolved);
    return resolved;
  }

  private async ensureAssigneeIndex(): Promise<void> {
    if (this.assigneeIndex) return;
    if (!this.assigneeIndexPromise) {
      this.assigneeIndexPromise = (async () => {
        const users = await this.rest<Array<{ login: string }>>(
          `/repos/${this.repo}/assignees?per_page=100`,
        );
        this.assigneeIndex = new Map(users.map((u) => [u.login.toLowerCase(), u.login]));
      })().finally(() => {
        this.assigneeIndexPromise = null;
      });
    }
    await this.assigneeIndexPromise;
  }

  private matchAssignee(key: string): string | null {
    const index = this.assigneeIndex;
    if (!index) return null;
    const exact = index.get(key);
    if (exact) return exact;
    const partial = [...index.keys()].filter((login) => login.startsWith(key));
    if (partial.length === 1) return index.get(partial[0]!)!;
    return null;
  }
}

/**
 * The factory (the one map entry): resolves the credential REFERENCE
 * through the environment (the env-ref temporariness clause, ADR 0032/34)
 * and reads the connection's provider config. `repo` is REQUIRED and
 * validated at connect time (the honest 400, the teamId precedent) —
 * malformed names never reach URL construction.
 */
export function githubConnectionFactory(): (
  connection: { credentialRef: string; config?: Record<string, string> },
) => ExecutionProvider {
  return (connection) => {
    const token = process.env[connection.credentialRef];
    if (!token) {
      throw new GithubError(
        `credential ref "${connection.credentialRef}" is not set in the environment`,
        0,
        false,
      );
    }
    const repo = connection.config?.repo;
    if (!repo) {
      throw new GithubError("the github connection is missing config.repo", 0, false);
    }
    if (!validGitHubRepo(repo)) {
      throw new GithubError(`config.repo must be "owner/repo" (got "${repo}")`, 0, false);
    }
    return new GithubProvider({
      token,
      repo,
      ...(connection.config?.baseUrl ? { baseUrl: connection.config.baseUrl } : {}),
    });
  };
}
