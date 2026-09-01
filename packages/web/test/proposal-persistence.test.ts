import { describe, it, expect, beforeAll } from "vitest";

/**
 * Vitest runs the web suite in the node environment on purpose (see
 * vite.config.ts) — no DOM, so no localStorage. The persistence module
 * under test stores project records there, so this file installs an
 * in-memory localStorage shim BEFORE importing it. The shim implements the
 * surface persistence.ts touches: get/set/removeItem by exact key, and
 * enough Map-like behaviour that save/load round-trips behave like disk.
 */
beforeAll(() => {
  const backing = new Map<string, string>();
  const shim: Storage = {
    get length(): number {
      return backing.size;
    },
    clear: () => backing.clear(),
    getItem: (k) => (backing.has(k) ? backing.get(k)! : null),
    key: (i) => [...backing.keys()][i] ?? null,
    removeItem: (k) => void backing.delete(k),
    setItem: (k, v) => void backing.set(k, String(v)),
  };
  Object.defineProperty(globalThis, "localStorage", {
    value: shim,
    configurable: true,
    writable: true,
  });
});

// AFTER the shim: the module captures localStorage at import time.
const {
  PROPOSAL_HISTORY_CAP,
  archiveDecision,
  decideProposal,
  loadProject,
  newProposalId,
  openProposalIn,
  proposalIsPending,
  saveProject,
} = await import("../src/persistence.js");
import type { PersistedProposal } from "../src/persistence.js";
import { createWorkspace } from "@lucent/core";
import type { Operation } from "@lucent/core";

/**
 * Persisted proposals (2026-09, the "one obvious reliability gap"): a proposal
 * is a durable record on the project, with idempotent decisions and an audit
 * trail. Previously the batch lived only in React state — a refresh dropped
 * the AI's proposed operations while the chat reply describing them survived,
 * which read as Lucent losing the user's work.
 *
 * The pure layer is pinned here; the workspace wiring (refs, the decidedRef
 * idempotency guard, rehydrate-on-boot, project-switch clearing) is covered
 * by the live gate.
 */

const baseRecord = (
  overrides: Partial<PersistedProposal> = {},
): Omit<PersistedProposal, "status"> => ({
  id: newProposalId(),
  boardId: null,
  meetingId: null,
  operations: [{ op: "CREATE_NODE", id: "n1", nodeType: "step", label: "A" }] as Operation[],
  createdAt: 1_000,
  request: "build a flow",
  explanation: "Two steps and a connection.",
  ...overrides,
});

describe("proposal record lifecycle (pure layer)", () => {
  it("round-trips through saveProject/loadProject with its status and archive", () => {
    const ws = createWorkspace();
    const record = { ...baseRecord(), status: "pending" as const };
    saveProject({
      id: "p_test_roundtrip",
      name: "T",
      workspace: ws,
      chat: [],
      proposal: record,
      proposalHistory: [],
    });
    const loaded = loadProject("p_test_roundtrip");
    expect(loaded?.proposal).toEqual(record);
  });

  it("decideProposal is idempotent — a terminal record keeps its status", () => {
    const pending: PersistedProposal = { ...baseRecord(), status: "pending" };
    const approved = decideProposal(pending, "approved");
    expect(approved.status).toBe("approved");
    // The double click: deciding an already-decided record changes nothing.
    expect(decideProposal(approved, "rejected")).toBe(approved);
    expect(decideProposal(approved, "rejected").status).toBe("approved");
  });

  it("opening a new proposal supersedes a pending predecessor into the archive", () => {
    const first = openProposalIn(
      { proposal: undefined, proposalHistory: [] },
      baseRecord({ id: "prp_first" }),
    );
    expect(first.proposal.status).toBe("pending");
    expect(first.proposalHistory).toEqual([]);

    const second = openProposalIn(
      { proposal: first.proposal, proposalHistory: first.proposalHistory },
      baseRecord({ id: "prp_second" }),
    );
    expect(second.proposal.id).toBe("prp_second");
    expect(second.proposal.status).toBe("pending");
    // The unreviewed predecessor is superseded, not discarded.
    expect(second.proposalHistory).toEqual([{ ...first.proposal, status: "superseded" }]);
  });

  it("a decided record is untouched by the next open (no double-archiving)", () => {
    const opened = openProposalIn({ proposal: undefined, proposalHistory: [] }, baseRecord());
    const decided = archiveDecision(opened, "approved");
    const next = openProposalIn(decided, baseRecord({ id: "prp_next" }));
    // History holds exactly one entry for the decided record.
    const entries = next.proposalHistory.filter((p) => p.id === decided.proposal.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.status).toBe("approved");
  });

  it("archiving a rejection keeps the record as the audit trail", () => {
    const opened = openProposalIn({ proposal: undefined, proposalHistory: [] }, baseRecord());
    const rejected = archiveDecision(opened, "rejected");
    expect(rejected.proposal.status).toBe("rejected");
    expect(rejected.proposalHistory).toEqual([{ ...opened.proposal, status: "rejected" }]);
    // The rejected record still persists — reject archives, never destroys.
    expect(rejected.proposal.operations).toHaveLength(1);
  });

  it("archives the decided record once on repeated archive calls (idempotent)", () => {
    const opened = openProposalIn({ proposal: undefined, proposalHistory: [] }, baseRecord());
    const first = archiveDecision(opened, "approved");
    const again = archiveDecision(first, "approved");
    expect(again.proposalHistory.filter((p) => p.id === first.proposal.id)).toHaveLength(1);
  });

  it("the history is capped at the audit window", () => {
    let state: { proposal: PersistedProposal; proposalHistory: PersistedProposal[] } = {
      proposal: { ...baseRecord({ id: "prp_seed" }), status: "approved" },
      proposalHistory: [],
    };
    // Simulate cap+3 sequential decisions.
    for (let i = 0; i < PROPOSAL_HISTORY_CAP + 3; i++) {
      const opened = openProposalIn(state, baseRecord({ id: `prp_gen${i}`, createdAt: 2_000 + i }));
      state = archiveDecision(opened, i % 2 === 0 ? "approved" : "rejected");
    }
    expect(state.proposalHistory.length).toBeLessThanOrEqual(PROPOSAL_HISTORY_CAP);
    // The SURVIVING entries are the newest ones, in order.
    const createdAts = state.proposalHistory.map((p) => p.createdAt);
    expect(createdAts).toEqual([...createdAts].sort((a, b) => a - b));
    expect(state.proposalHistory.at(-1)!.createdAt).toBe(2_000 + PROPOSAL_HISTORY_CAP + 2);
  });

  it("proposalIsPending reads only pending records as open", () => {
    expect(proposalIsPending({ ...baseRecord(), status: "pending" })).toBe(true);
    expect(proposalIsPending({ ...baseRecord(), status: "approved" })).toBe(false);
    expect(proposalIsPending({ ...baseRecord(), status: "rejected" })).toBe(false);
    expect(proposalIsPending({ ...baseRecord(), status: "superseded" })).toBe(false);
    expect(proposalIsPending(undefined)).toBe(false);
  });

  it("new ids are unique and prefixed", () => {
    const a = newProposalId();
    const b = newProposalId();
    expect(a).toMatch(/^prp_/);
    expect(a).not.toBe(b);
  });
});

describe("loadProject back-compat (older saves)", () => {
  const ws = createWorkspace();

  it("a record without a status (an interim build) loads as pending", () => {
    const legacy = { ...baseRecord() } as unknown as Record<string, unknown>;
    saveProject({
      id: "p_test_legacy",
      name: "T",
      workspace: ws,
      chat: [],
      // Simulate the pre-status shape landing on disk.
      proposal: legacy as unknown as PersistedProposal,
    });
    const loaded = loadProject("p_test_legacy");
    expect(loaded?.proposal?.status).toBe("pending");
  });

  it("a malformed proposal record is dropped, not surfaced", () => {
    saveProject({
      id: "p_test_malformed",
      name: "T",
      workspace: ws,
      chat: [],
      proposal: { noOps: true } as unknown as PersistedProposal,
    });
    const loaded = loadProject("p_test_malformed");
    expect(loaded?.proposal).toBeUndefined();
    // The board itself still loads — a bad record must not take the project down.
    expect(loaded?.workspace).toBeDefined();
  });

  it("an older project without any proposal field loads unchanged", () => {
    saveProject({ id: "p_test_old", name: "T", workspace: ws, chat: [] });
    const loaded = loadProject("p_test_old");
    expect(loaded?.proposal).toBeUndefined();
    expect(loaded?.proposalHistory).toBeUndefined();
  });
});
