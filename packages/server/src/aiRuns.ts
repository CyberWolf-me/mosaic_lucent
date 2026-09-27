import { createHash, randomBytes } from "node:crypto";

/**
 * AI run records (docs/26 J6, ADR 0047): one per model call or agent write
 * that touches a board or answers from one — which model, what context, who
 * started it, what came of it, who approved. Governance, not billing: the
 * usage meter keeps quantities; this keeps accountability.
 *
 * A run is written where the provider is known (the server's generate, Ask,
 * notes, recap) or where an agent's output arrives (the voice agent's and the
 * MCP client's writes). It learns its outcome later: the op-log seqs its
 * output became, and who approved them.
 */

export const AI_SURFACES = ["canvas", "meeting", "voice", "mcp", "ask", "notes", "recap"] as const;
export type AiSurface = (typeof AI_SURFACES)[number];

export interface AiRun {
  id: string;
  orgId: string;
  boardId: string | null;
  /** The person who started it; null for the system's own runs. */
  initiatedBy: string | null;
  surface: AiSurface;
  provider: string;
  model: string | null;
  /** What the model was shown: "board", "meeting", "workspace", "notes". */
  contextScope: string;
  tools: string[];
  /** sha256 of the output (operations, or the answer), for tamper-evidence. */
  outputHash: string | null;
  opCount: number;
  proposalId: string | null;
  /** The op-log entries the output became. */
  opSeqs: number[];
  approvedBy: string | null;
  createdAt: number;
  decidedAt: number | null;
}

export type NewAiRun = Omit<AiRun, "id" | "proposalId" | "opSeqs" | "approvedBy" | "decidedAt"> &
  Partial<Pick<AiRun, "proposalId" | "opSeqs" | "approvedBy" | "decidedAt">>;

export interface AiRunStore {
  record(run: NewAiRun): Promise<AiRun>;
  get(id: string): Promise<AiRun | undefined>;
  /** The run's output landed as op-log `seq`, approved by `approvedBy` (null: nobody). */
  linkCommit(id: string, seq: number, approvedBy: string | null, at: number): Promise<void>;
  /** The run's output became a proposal awaiting review. */
  linkProposal(id: string, proposalId: string): Promise<void>;
  /** Newest first. `boardIds` narrows to runs on those boards. */
  forOrg(
    orgId: string,
    options?: { boardIds?: readonly string[]; surface?: AiSurface; limit?: number },
  ): Promise<AiRun[]>;
}

export const AI_RUN_LIST_LIMIT = 200;

export function newRunId(): string {
  return "run_" + Date.now().toString(36) + randomBytes(4).toString("hex");
}

/** A stable hash of what the model produced. */
export function outputHash(output: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(output ?? null))
    .digest("hex");
}

export class InMemoryAiRunStore implements AiRunStore {
  private readonly runs = new Map<string, AiRun>();

  async record(run: NewAiRun): Promise<AiRun> {
    const stored: AiRun = {
      proposalId: null,
      opSeqs: [],
      approvedBy: null,
      decidedAt: null,
      ...run,
      id: newRunId(),
    };
    this.runs.set(stored.id, stored);
    return { ...stored, opSeqs: [...stored.opSeqs] };
  }

  async get(id: string) {
    const run = this.runs.get(id);
    return run ? { ...run, opSeqs: [...run.opSeqs] } : undefined;
  }

  async linkCommit(id: string, seq: number, approvedBy: string | null, at: number) {
    const run = this.runs.get(id);
    if (!run) return;
    this.runs.set(id, {
      ...run,
      opSeqs: run.opSeqs.includes(seq) ? run.opSeqs : [...run.opSeqs, seq],
      approvedBy: approvedBy ?? run.approvedBy,
      decidedAt: at,
    });
  }

  async linkProposal(id: string, proposalId: string) {
    const run = this.runs.get(id);
    if (run) this.runs.set(id, { ...run, proposalId });
  }

  async forOrg(
    orgId: string,
    options: { boardIds?: readonly string[]; surface?: AiSurface; limit?: number } = {},
  ) {
    const boards = options.boardIds ? new Set(options.boardIds) : null;
    return [...this.runs.values()]
      .filter(
        (r) =>
          r.orgId === orgId &&
          (!boards || (r.boardId !== null && boards.has(r.boardId))) &&
          (!options.surface || r.surface === options.surface),
      )
      .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1))
      .slice(0, Math.min(options.limit ?? AI_RUN_LIST_LIMIT, AI_RUN_LIST_LIMIT))
      .map((r) => ({ ...r, opSeqs: [...r.opSeqs] }));
  }
}
