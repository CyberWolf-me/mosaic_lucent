import {
  boardToMermaid,
  isHumanOnlyOperation,
  repairOperations,
  stampAuthorship,
  validateOperations,
  type Operation,
  type Workspace,
} from "@lucent/core";
import { mermaidImportOps, summarizeBoard, type ToolResult } from "./tools.js";

/**
 * RemoteBoardSession (E3 / R1): the same three-tool MCP surface as
 * `BoardSession`, backed by a real Lucent server over HTTP instead of a
 * process-local workspace.
 *
 * Why this exists: the in-memory session means an agent using MCP edits a
 * sandbox that shares nothing with your boards. This session makes
 * `get_board` read the server's truth and `apply_canvas_operations` land on
 * the server's board — the "agent access" promise of the product, honored
 * through the same bearer-auth path the server documents for programmatic
 * clients (the CSRF guard deliberately does not fire for bearer-only
 * callers; see the comment in `createApp`'s `requireCsrf`).
 *
 * The pipeline is deliberately the local session's pipeline plus a network
 * hop in the middle, in this order:
 *
 *   filter human-only → stamp (caller's id arrives already-stamped from the
 *   server's own pipeline; locally we stamp ASSISTANT_AUTHOR because the
 *   session has no user identity — the server re-stamps with the token's
 *   user on receipt) → repair → **validate locally** → POST → the server
 *   validates again against the stored board.
 *
 * Local pre-validation is the plan's explicit requirement: a malformed
 * batch is named precisely ("Rejected 2 invalid operation(s): …") before
 * any network call, instead of surfacing as an opaque 422 after one. The
 * server's re-validation is not redundancy — the board may have moved since
 * our last `get_board` — it is the authority; ours is the fast, precise
 * failure.
 *
 * Failure mapping is the contract the dispatcher already knows:
 * `errorResult` with the same sentence shapes `BoardSession` emits, so an
 * agent's prompts never see a formatting change between the two sessions.
 */

export interface RemoteSessionOptions {
  /** Server base, e.g. `http://127.0.0.1:4387`. No trailing slash. */
  baseUrl: string;
  /** Bearer token — the session token from the server's signup/login body. */
  token: string;
  /** The board this session operates on. All three tools are scoped to it. */
  boardId: string;
  /** Test seam; defaults to global fetch (Node 18+). */
  fetchImpl?: typeof fetch;
}

/** Read `LUCENT_MCP_URL` / `LUCENT_MCP_TOKEN` / `LUCENT_MCP_BOARD`. Returns null when unset — the caller falls back to the in-memory session. */
export function remoteConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): RemoteSessionOptions | null {
  const baseUrl = env.LUCENT_MCP_URL?.trim().replace(/\/+$/, "");
  const token = env.LUCENT_MCP_TOKEN?.trim();
  const boardId = env.LUCENT_MCP_BOARD?.trim();
  if (!baseUrl || !token || !boardId) return null;
  return { baseUrl, token, boardId };
}

export class RemoteBoardSession {
  private readonly opts: Required<Pick<RemoteSessionOptions, "baseUrl" | "token" | "boardId">> & {
    fetchImpl: typeof fetch;
  };
  /** The last-seen workspace, for local pre-validation. Never authoritative. */
  private cached: Workspace | null = null;

  constructor(options: RemoteSessionOptions) {
    this.opts = {
      baseUrl: options.baseUrl.replace(/\/+$/, ""),
      token: options.token,
      boardId: options.boardId,
      fetchImpl: options.fetchImpl ?? fetch,
    };
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    switch (name) {
      case "apply_canvas_operations":
        return this.applyOps(args);
      case "get_board":
        return this.getBoard();
      case "list_external_links":
        return this.listExternalLinks();
      case "import_mermaid":
        return this.importMermaid(args);
      case "export_mermaid":
        return this.exportMermaid();
      case "reset_board":
        // No server route destroys a board's contents, and inventing one
        // for parity with the local session would be a footgun an agent can
        // fire by naming a tool. The honest answer is the error.
        return this.notSupported("reset_board");
      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  }

  private async getBoard(): Promise<ToolResult> {
    const res = await this.request("GET", `/api/boards/${this.opts.boardId}`);
    if (res.status === 401 || res.status === 403) {
      // A 403 here can be a governance refusal (the board is `restricted` and
      // forbids agent reads), not a bad token. Surface the server's reason so
      // the human learns the real answer instead of rotating credentials
      // against a policy that will not move.
      const detail = (await res.json().catch(() => null)) as { error?: string } | null;
      if (res.status === 403 && detail?.error) {
        return this.failure(`Board read refused (403): ${detail.error}`);
      }
      return this.failure(
        `Authentication for board ${this.opts.boardId} was refused (${res.status}). Check LUCENT_MCP_TOKEN.`,
      );
    }
    if (res.status === 404) {
      return this.failure(
        `Board ${this.opts.boardId} not found (or the token's user has no access). Check LUCENT_MCP_BOARD.`,
      );
    }
    if (!res.ok) {
      return this.failure(`Board fetch failed (${res.status}).`);
    }
    const board = (await res.json()) as { workspace: Workspace };
    this.cached = board.workspace;
    return {
      content: [{ type: "text", text: JSON.stringify(summarizeBoard(board.workspace), null, 2) }],
    };
  }

  /**
   * Stage D7: the link summary projection (ADR 0032's named D7 deliverable).
   * Read-only — the viewer-floor links route plus the inbound queue, so an
   * agent can SEE what is linked and what awaits a human, but deciding an
   * inbound change is a human act (the symmetric human gate; no tool will
   * exist for it).
   */
  private async listExternalLinks(): Promise<ToolResult> {
    const links = await this.request("GET", `/api/boards/${this.opts.boardId}/integrations/links`);
    if (!links.ok) {
      return this.failure(`External links fetch failed (${links.status}).`);
    }
    const linksBody = (await links.json()) as {
      links?: Array<Record<string, unknown>>;
    };
    const inbound = await this.request(
      "GET",
      `/api/boards/${this.opts.boardId}/integrations/inbound`,
    );
    if (!inbound.ok) {
      return this.failure(`Inbound queue fetch failed (${inbound.status}).`);
    }
    const inboundBody = (await inbound.json()) as {
      inbound?: Array<Record<string, unknown>>;
    };
    const pendingOnly = (inboundBody.inbound ?? []).filter((r) => r["status"] === "pending");
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              links: linksBody.links ?? [],
              pendingInboundChanges: pendingOnly,
              note: "inbound changes are decided by a human in the Lucent UI; this projection is read-only",
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  /**
   * docs/27 D2: Mermaid in. Whether the diagram becomes the board or a region
   * depends on what the board holds, so read it first (which also primes the
   * local pre-validation), then apply through the one pipeline.
   */
  private async importMermaid(args: Record<string, unknown>): Promise<ToolResult> {
    if (!this.cached) {
      const read = await this.getBoard();
      if (read.isError) return read;
    }
    const plan = mermaidImportOps(this.cached!, args.mermaid);
    if ("error" in plan) return this.failure(plan.error);
    return this.applyOps({ operations: plan.ops });
  }

  private async exportMermaid(): Promise<ToolResult> {
    const read = await this.getBoard();
    if (read.isError) return read;
    return { content: [{ type: "text", text: boardToMermaid(this.cached!) }] };
  }

  private async applyOps(args: Record<string, unknown>): Promise<ToolResult> {
    if (!Array.isArray(args.operations)) {
      return this.failure("`operations` must be an array.");
    }
    // Same defensive shape-filter the local session applies: an op must be
    // an object with a string `.op`, and human-only ops are silently dropped
    // rather than rejected (the agent cannot send them; a human can).
    const candidate = args.operations.filter(
      (op): op is Operation =>
        typeof op === "object" &&
        op !== null &&
        "op" in op &&
        typeof (op as { op: unknown }).op === "string",
    );
    const filtered = candidate.filter((op) => !isHumanOnlyOperation(op.op));
    if (filtered.length === 0) {
      return this.failure(
        "No applicable operations in the batch (all were human-only or malformed).",
      );
    }

    // Local pre-validation against the last-seen workspace. When we have
    // never fetched the board there is nothing to validate against — the
    // server's check is the only one, and it will be run regardless.
    if (this.cached) {
      const stamped = stampAuthorship(filtered, "assistant");
      const repaired = repairOperations(stamped);
      const errors = validateOperations(this.cached, repaired);
      if (errors.length > 0) {
        const detail = errors.map((e) => `- ${e.message}`).join("\n");
        return this.failure(`Rejected ${errors.length} invalid operation(s):\n${detail}`);
      }
    }

    const res = await this.request("POST", `/api/boards/${this.opts.boardId}/ops`, {
      ops: filtered,
      label: "mcp agent",
    });
    if (res.status === 422) {
      // The server's validation against the *stored* board: same sentence
      // shape as the local session so an agent's prompts behave identically.
      const body = (await res.json()) as { errors?: Array<{ message?: string }> };
      const detail = (body.errors ?? []).map((e) => `- ${e.message ?? "invalid"}`).join("\n");
      return this.failure(
        `Rejected ${(body.errors ?? []).length} invalid operation(s):\n${detail}`,
      );
    }
    if (res.status === 409) {
      // Stale cache: the board moved. Refetch and tell the agent to retry —
      // the next attempt will pre-validate against the fresh state.
      this.cached = null;
      const body = (await res.json()) as { head?: number };
      return this.failure(
        `The board changed since it was last read (head is now ${body.head ?? "unknown"}). Call get_board, then retry.`,
      );
    }
    if (res.status === 404) {
      return this.failure(
        `Board ${this.opts.boardId} not found (or no access). Check LUCENT_MCP_BOARD.`,
      );
    }
    if (res.status === 401 || res.status === 403) {
      // Same reasoning as `getBoard`: a 403 may be a classification refusal.
      const detail = (await res.json().catch(() => null)) as { error?: string } | null;
      if (res.status === 403 && detail?.error) {
        return this.failure(`Apply refused (403): ${detail.error}`);
      }
      return this.failure(`Authentication refused (${res.status}). Check LUCENT_MCP_TOKEN.`);
    }
    if (!res.ok) {
      return this.failure(`Apply failed (${res.status}).`);
    }

    const outcome = (await res.json()) as { applied?: number; seq?: number };
    // The board moved under us: drop the cache so the next apply
    // re-validates against fresh state (or 409s like above).
    this.cached = null;
    return {
      content: [
        {
          type: "text",
          text: `Applied ${outcome.applied ?? filtered.length} operation(s) to board ${this.opts.boardId} (seq ${outcome.seq ?? "?"}).`,
        },
      ],
    };
  }

  private async request(method: "GET" | "POST", path: string, body?: unknown): Promise<Response> {
    return this.opts.fetchImpl(`${this.opts.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.opts.token}`,
        // The agent marker the server's classification `agent` boundary reads
        // (docs/23 S1): MCP traffic is a third-party model touching the board,
        // which is exactly what a `restricted` board refuses. The header is
        // cooperative, not cryptographic — the boundary governs the agent
        // surface the org chose to install, not a human's own reads.
        "x-lucent-client": "mcp",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }

  private failure(message: string): ToolResult {
    return { content: [{ type: "text", text: message }], isError: true };
  }

  private notSupported(name: string): ToolResult {
    return {
      content: [
        {
          type: "text",
          text: `"${name}" is not available against a live server board — it would destroy board state. The in-memory session (no LUCENT_MCP_URL set) supports it.`,
        },
      ],
      isError: true,
    };
  }
}
