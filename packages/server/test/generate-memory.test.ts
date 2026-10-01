import { describe, it, expect } from "vitest";
import { applyOperations, createWorkspace } from "@lucent/core";
import type { Operation, StatementRow } from "@lucent/core";
import type { StoredBoard } from "../src/boards.js";
import type { StoredProject } from "../src/projects.js";
import type { Role } from "../src/identity.js";
import { InMemoryStatementIndexStore } from "../src/statementIndex.js";
import { assembleGenerationMemory, type GenerationMemoryDeps } from "../src/generateMemory.js";

/**
 * The access + classification gates for cross-board memory (docs/23 Phase 1).
 * Tenant isolation is the #1 risk, so each leak vector gets its own case: a
 * sibling the caller can't read, a cross-org sibling, an AI-forbidden sibling,
 * and an unreviewed-AI statement must never reach the prompt.
 */

const PROVIDER = { name: "mock" };

function decisionWorkspace(id: string, label: string) {
  const ops: Operation[] = [
    { op: "CREATE_NODE", id, nodeType: "decision", label },
    { op: "SET_STATEMENT", id, statement: { kind: "decision", status: "resolved", topic: "auth" } },
  ];
  return applyOperations(createWorkspace(), ops);
}

function board(
  id: string,
  orgId: string,
  name: string,
  workspace = createWorkspace(),
): StoredBoard {
  return { id, orgId, ownerId: "owner", name, workspace, createdAt: 0, updatedAt: 0 };
}

function row(id: string, label: string, trust?: StatementRow["trust"]): StatementRow {
  return { kind: "decision", id, label, status: "resolved", ...(trust ? { trust } : {}) };
}

/** Build deps with explicit, per-test control over every gate. */
function deps(opts: {
  boards: StoredBoard[];
  roles?: Record<string, Role>;
  readable?: string[];
  refused?: string[];
  projects?: StoredProject[];
  index?: Record<string, StatementRow[]>;
}): GenerationMemoryDeps {
  const byId = new Map(opts.boards.map((b) => [b.id, b] as const));
  const store = new InMemoryStatementIndexStore();
  for (const [boardId, rows] of Object.entries(opts.index ?? {})) {
    const b = byId.get(boardId);
    void store.replaceBoard(boardId, b?.orgId ?? "org", rows, 1);
  }
  return {
    boardStore: {
      get: async (id: string) => byId.get(id),
      memberRole: async (boardId: string) => opts.roles?.[boardId],
    },
    intelligence: { freshen: async () => ({ reindexed: 0, stale: 0 }), store },
    projects: {
      forBoard: async (boardId: string) =>
        (opts.projects ?? []).filter((p) => p.boardIds.includes(boardId)),
    },
    readableBoards: async () => ({
      boards: opts.boards.filter((b) => (opts.readable ?? []).includes(b.id)),
    }),
    outboundRefusal: async (b: StoredBoard) => ((opts.refused ?? []).includes(b.id) ? {} : null),
    orgRoleFor: async () => undefined,
  };
}

function project(id: string, orgId: string, boardIds: string[]): StoredProject {
  return {
    id,
    orgId,
    name: id,
    objective: "",
    status: "active",
    leadId: "owner",
    members: [],
    createdBy: "owner",
    createdAt: 0,
    updatedAt: 0,
    archivedAt: null,
    boardIds,
  };
}

describe("assembleGenerationMemory — own board", () => {
  it("returns the board's own settled decisions when the caller can read it", async () => {
    const b = board("B", "org", "Checkout", decisionWorkspace("d1", "Use OAuth for login"));
    const d = deps({ boards: [b], roles: { B: "editor" }, readable: ["B"] });
    const memory = await assembleGenerationMemory(d, "u1", "B", PROVIDER);
    expect(memory).toContain("Settled decisions");
    expect(memory).toContain("Use OAuth for login");
    expect(memory).not.toContain("From sibling boards");
  });

  it("returns undefined when the caller holds no role on the board", async () => {
    const b = board("B", "org", "Checkout", decisionWorkspace("d1", "Use OAuth"));
    const d = deps({ boards: [b], roles: {}, readable: ["B"] });
    expect(await assembleGenerationMemory(d, "u1", "B", PROVIDER)).toBeUndefined();
  });

  it("returns undefined (fail-closed) when the board itself is AI-forbidden", async () => {
    const b = board("B", "org", "Checkout", decisionWorkspace("d1", "Use OAuth"));
    const d = deps({ boards: [b], roles: { B: "editor" }, readable: ["B"], refused: ["B"] });
    expect(await assembleGenerationMemory(d, "u1", "B", PROVIDER)).toBeUndefined();
  });
});

describe("assembleGenerationMemory — project siblings", () => {
  const B = () => board("B", "org", "Checkout"); // empty workspace, so only cross-board shows
  const S = () => board("S", "org", "Billing");

  it("includes a readable sibling's settled decisions", async () => {
    const d = deps({
      boards: [B(), S()],
      roles: { B: "editor" },
      readable: ["B", "S"],
      projects: [project("P", "org", ["B", "S"])],
      index: { S: [row("s1", "Use Stripe")] },
    });
    const memory = await assembleGenerationMemory(d, "u1", "B", PROVIDER);
    expect(memory).toContain("From sibling boards");
    expect(memory).toContain("Billing");
    expect(memory).toContain("Use Stripe");
    expect(memory).toContain("(S:s1)"); // qualified id — clearly not a local node
  });

  it("excludes a sibling the caller cannot read", async () => {
    const d = deps({
      boards: [board("B", "org", "Checkout", decisionWorkspace("d1", "Own")), S()],
      roles: { B: "editor" },
      readable: ["B"], // S is a project sibling but NOT readable
      projects: [project("P", "org", ["B", "S"])],
      index: { S: [row("s1", "Use Stripe")] },
    });
    const memory = await assembleGenerationMemory(d, "u1", "B", PROVIDER);
    expect(memory).not.toContain("Use Stripe");
    expect(memory).not.toContain("From sibling boards");
  });
});

describe("assembleGenerationMemory — leak gates", () => {
  it("excludes a cross-org sibling even if it is in the project and 'readable'", async () => {
    const d = deps({
      boards: [
        board("B", "org", "Checkout", decisionWorkspace("d1", "Own")),
        board("S", "other", "Billing"),
      ],
      roles: { B: "editor" },
      readable: ["B", "S"],
      projects: [project("P", "org", ["B", "S"])],
      index: { S: [row("s1", "Use Stripe")] },
    });
    const memory = await assembleGenerationMemory(d, "u1", "B", PROVIDER);
    expect(memory).not.toContain("Use Stripe");
  });

  it("excludes an AI-forbidden sibling", async () => {
    const d = deps({
      boards: [
        board("B", "org", "Checkout", decisionWorkspace("d1", "Own")),
        board("S", "org", "Billing"),
      ],
      roles: { B: "editor" },
      readable: ["B", "S"],
      refused: ["S"],
      projects: [project("P", "org", ["B", "S"])],
      index: { S: [row("s1", "Use Stripe")] },
    });
    const memory = await assembleGenerationMemory(d, "u1", "B", PROVIDER);
    expect(memory).not.toContain("Use Stripe");
  });

  it("excludes an unreviewed AI suggestion but keeps a human-vetted statement", async () => {
    const d = deps({
      boards: [board("B", "org", "Checkout"), board("S", "org", "Billing")],
      roles: { B: "editor" },
      readable: ["B", "S"],
      projects: [project("P", "org", ["B", "S"])],
      index: { S: [row("s1", "Approved choice"), row("s2", "Draft idea", "ai-suggested")] },
    });
    const memory = await assembleGenerationMemory(d, "u1", "B", PROVIDER);
    expect(memory).toContain("Approved choice");
    expect(memory).not.toContain("Draft idea");
  });
});
