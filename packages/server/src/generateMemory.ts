import type { BoardStore, StoredBoard } from "./boards.js";
import type { Role } from "./identity.js";
import type { ProjectStore } from "./projects.js";
import type { StatementIndexer } from "./statementIndex.js";
import { buildCrossBoardMemory, buildMemoryDigest, type SiblingMemory } from "./generateContext.js";

/**
 * Server-side assembly of the `<workspace-memory>` digest for a generation
 * (docs/23) — the "workspace remembers" north star on the WRITE path.
 *
 * This is where the ACCESS and CLASSIFICATION gates live; `generateContext.ts`
 * only shapes the vetted result into text. It runs for the board the request is
 * about (the one the client names in `run.boardId`, or a top-level `boardId`),
 * NOT off the authoritative-validation gate — so it reaches the advisory web
 * path, which is the primary surface.
 *
 * Tenant isolation is the first concern. A project "grants nothing" (projects.ts):
 * every sibling board is re-checked through the SAME gates scoped Ask uses
 * (routes/scopedAsk.ts) before a single statement of it is rendered —
 *   1. the caller holds a role on B (readability of the board we're on),
 *   2. B itself is allowed to reach the AI boundary (else no memory at all),
 *   3. each sibling is in B's org AND in `readableBoards(user, B.org)`,
 *   4. each sibling passes `outboundRefusal(…, "ai")`,
 *   5. the index is queried for ONLY the surviving ids — never trusting a row's
 *      own `orgId` for authorization.
 */
export interface GenerationMemoryDeps {
  boardStore: Pick<BoardStore, "get" | "memberRole">;
  intelligence: Pick<StatementIndexer, "freshen" | "store">;
  projects: Pick<ProjectStore, "forBoard">;
  /** Org-scoped: never returns another tenant's boards (app.ts readableBoards). */
  readableBoards: (userId: string, orgId: string) => Promise<{ boards: StoredBoard[] }>;
  /** Non-null means the board may NOT cross this boundary (classification.ts). */
  outboundRefusal: (
    board: StoredBoard,
    boundary: "ai",
    options?: { provider?: { name: string } },
  ) => Promise<unknown>;
  orgRoleFor: (userId: string, orgId: string) => Promise<Role | undefined>;
}

/** Siblings resolved before classification filtering — bounds per-request I/O
 * well under the indexer's own freshen budget (50). */
const SIBLING_RESOLVE_CAP = 12;

/**
 * Build the memory digest for board `boardId` on behalf of `userId`, or
 * undefined when there is nothing to say or the caller may not read it. The
 * provider is the RESOLVED one that will serve the call (its identity decides
 * the classification outcome for a BYO cloud key).
 */
export async function assembleGenerationMemory(
  deps: GenerationMemoryDeps,
  userId: string,
  boardId: string,
  provider: { name: string },
): Promise<string | undefined> {
  const board = await deps.boardStore.get(boardId);
  if (!board) return undefined;
  // Readability: the caller must hold a role on B (owner, board grant, or org).
  const role = await deps.boardStore.memberRole(board.id, userId, (uid) =>
    deps.orgRoleFor(uid, board.orgId),
  );
  if (!role) return undefined;
  // Fail closed: if B itself may not reach the AI boundary, surface no memory.
  if (await deps.outboundRefusal(board, "ai", { provider })) return undefined;

  const own = buildMemoryDigest(board.workspace, board.name);
  const cross = await crossBoardMemory(deps, userId, board, provider);
  const parts = [own, cross].filter((s): s is string => Boolean(s));
  return parts.length ? parts.join("\n\n") : undefined;
}

/** Settled decisions/requirements from PROJECT SIBLINGS the caller may read. */
async function crossBoardMemory(
  deps: GenerationMemoryDeps,
  userId: string,
  board: StoredBoard,
  provider: { name: string },
): Promise<string | null> {
  // Projects B belongs to, in B's own org only — a project carries an orgId but
  // confers no access; the org match is asserted here, exactly as resolveScope
  // does, and never read from an index row.
  const projects = (await deps.projects.forBoard(board.id)).filter((p) => p.orgId === board.orgId);
  if (projects.length === 0) return null;
  const siblingIds = new Set<string>();
  for (const p of projects) for (const id of p.boardIds) if (id !== board.id) siblingIds.add(id);
  if (siblingIds.size === 0) return null;

  // Intersect with what the caller can actually READ (org-scoped gate), same
  // org as B, bounded. readableBoards never returns another tenant's boards.
  const { boards: readable } = await deps.readableBoards(userId, board.orgId);
  const candidates = readable
    .filter((b) => siblingIds.has(b.id) && b.orgId === board.orgId)
    .slice(0, SIBLING_RESOLVE_CAP);

  // Classification: drop any sibling the AI boundary refuses (restricted tier,
  // an org floor raising to it, or org ai:disabled), on the resolved provider.
  const allowed: StoredBoard[] = [];
  for (const b of candidates) {
    if (!(await deps.outboundRefusal(b, "ai", { provider }))) allowed.push(b);
  }
  if (allowed.length === 0) return null;

  // Query the index for ONLY the vetted ids; authorization came from the live
  // board records above, never from a row's own orgId.
  await deps.intelligence.freshen(allowed);
  const rows = await deps.intelligence.store.query(
    allowed.map((b) => b.id),
    {
      kinds: ["decision", "requirement"] as const,
      statuses: ["open", "resolved"] as const,
    },
  );
  const grouped: SiblingMemory[] = allowed
    .map((b) => ({
      boardName: b.name,
      // Only human-vetted statements: an unreviewed AI suggestion on another
      // board is not settled truth to carry into this one.
      statements: rows
        .filter((r) => r.boardId === b.id && r.trust !== "ai-suggested")
        .map((r) => ({
          kind: r.kind,
          label: r.label,
          status: r.status,
          ...(r.topic ? { topic: r.topic } : {}),
          id: `${b.id}:${r.id}`,
        })),
    }))
    .filter((g) => g.statements.length > 0);
  return buildCrossBoardMemory(grouped);
}
