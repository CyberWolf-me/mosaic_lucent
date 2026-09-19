import { describe, expect, it } from "vitest";
import type { Operation } from "../src/model.js";
import { applyOperations } from "../src/reducer.js";
import { createWorkspace } from "../src/model.js";
import {
  canonicalizeTopic,
  existingTopics,
  foldStatementTopics,
  possibleDuplicateTopics,
  topicsAreVariants,
} from "../src/topicFold.js";

/**
 * Topic entity resolution (Stage C5, ADR 0025). The contract, as tests:
 *
 * - THE SAFE LIST folds (rule 1): prices/price/pricing-model → pricing,
 *   only against an existing key and only when unambiguous.
 * - THE KEEP-APART LIST never folds (rule 3's deterministic boundary):
 *   monetization ≠ pricing, customer-acquisition ≠ user-acquisition.
 * - HUMAN OPS never enter the fold (rule 2) — pinned at every call site in
 *   the server/web batches; here the fold's own guarantees are pinned.
 * - THE DETECTOR pairs authored variants with evidence (rules 3+4) and
 *   produces nothing for unified or unrelated boards.
 *
 * Everything deterministic: the same ops and the same board fold the same
 * way, in any op order.
 */

function set(...ops: Operation[]): Operation[] {
  return ops;
}

function setStatement(id: string, topic: string): Operation {
  return {
    op: "SET_STATEMENT",
    id,
    statement: { kind: "decision", status: "open", topic },
  };
}

function updateTopic(id: string, topic: string | null): Operation {
  return { op: "UPDATE_STATEMENT", id, ...(topic === null ? { topic: null } : { topic }) };
}

describe("canonicalizeTopic", () => {
  it("folds case, separators, plurals, and caps the segment count", () => {
    expect(canonicalizeTopic("Pricing Model")).toBe("pricing-model");
    expect(canonicalizeTopic("Prices")).toBe("price");
    expect(canonicalizeTopic("  LAUNCH DATES  ")).toBe("launch-date");
    // Legacy free-form topics normalize the same way — never throws.
    expect(canonicalizeTopic("Not Kebab!")).toBe("not-kebab");
  });

  it("an empty or separator-only topic is the empty key", () => {
    expect(canonicalizeTopic("")).toBe("");
    expect(canonicalizeTopic("  ---  ")).toBe("");
  });
});

describe("topicsAreVariants — the safe list and the keep-apart list", () => {
  it("the owner's safe list: exact, subset, and stem equivalences", () => {
    expect(topicsAreVariants("pricing", "pricing")).toBe(true);
    expect(topicsAreVariants("pricing-model", "pricing")).toBe(true); // subset
    expect(topicsAreVariants("price", "pricing")).toBe(true); // stem
    expect(topicsAreVariants("prices", "price")).toBe(true); // plural
    expect(topicsAreVariants("prices", "pricing")).toBe(true); // both folds
    expect(topicsAreVariants("launch-date", "launch")).toBe(true); // the honest generalization
  });

  it("the keep-apart list: never merge the merely similar", () => {
    expect(topicsAreVariants("monetization", "pricing")).toBe(false);
    expect(topicsAreVariants("customer-acquisition", "user-acquisition")).toBe(false);
    expect(topicsAreVariants("revenue-model", "business-model")).toBe(false);
    expect(topicsAreVariants("pricing", "monetization")).toBe(false);
  });

  it("empty keys match nothing", () => {
    expect(topicsAreVariants("", "pricing")).toBe(false);
    expect(topicsAreVariants("pricing", "")).toBe(false);
  });
});

describe("foldStatementTopics — the op boundary", () => {
  it("the safe list converges on the board's existing authored key", () => {
    const existing = ["pricing"];
    expect(foldStatementTopics(set(setStatement("a", "price")), existing)).toEqual([
      setStatement("a", "pricing"),
    ]);
    expect(foldStatementTopics(set(setStatement("a", "pricing-model")), existing)).toEqual([
      setStatement("a", "pricing"),
    ]);
    expect(foldStatementTopics(set(setStatement("a", "Prices")), existing)).toEqual([
      setStatement("a", "pricing"),
    ]);
  });

  it("an exact match is never rewritten — idempotent on the folded form", () => {
    const existing = ["pricing"];
    const exact = set(setStatement("a", "pricing"));
    expect(foldStatementTopics(exact, existing)).toEqual(exact);
    const folded = set(setStatement("a", "pricing"));
    expect(foldStatementTopics(folded, existing)).toEqual(folded);
  });

  it("a novel topic is untouched — the fold never mints", () => {
    const existing = ["pricing"];
    const novel = set(setStatement("a", "onboarding"));
    expect(foldStatementTopics(novel, existing)).toEqual(novel);
  });

  it("the ambiguity guard: multiple candidate keys leave the op alone", () => {
    // "pricing-model" variant-matches both "pricing" and "model-pricing":
    // no unambiguous target, so the op keeps its own key. Never merge the
    // merely similar — mechanically.
    const existing = ["pricing", "model-pricing"];
    const op = set(setStatement("a", "pricing-model"));
    expect(foldStatementTopics(op, existing)).toEqual(op);
  });

  it("UPDATE_STATEMENT topic patches fold; clears pass through", () => {
    const existing = ["pricing"];
    expect(foldStatementTopics(set(updateTopic("a", "prices")), existing)).toEqual([
      updateTopic("a", "pricing"),
    ]);
    const clear = set(updateTopic("a", null));
    expect(foldStatementTopics(clear, existing)).toEqual(clear);
  });

  it("batch-internal collisions converge on the shortest representative", () => {
    // Three novel variant keys in one batch: the group closes transitively
    // (a~b, b~c ⇒ one group) and converges on the SHORTEST key (then
    // lexicographic), regardless of op order — "prices" (6) beats
    // "pricing" (7) and "pricing-model" (13).
    const batch = set(
      setStatement("a", "pricing-model"),
      setStatement("b", "pricing"),
      setStatement("c", "prices"),
    );
    const folded = foldStatementTopics(batch, []);
    for (const op of folded) {
      expect(op.op === "SET_STATEMENT" ? op.statement?.topic : undefined).toBe("prices");
    }
    // Order-stable: the reverse batch folds to the same representative.
    const reversed = foldStatementTopics([...batch].reverse(), []);
    expect(
      reversed.every((op) => op.op !== "SET_STATEMENT" || op.statement?.topic === "prices"),
    ).toBe(true);
  });

  it("an existing board key preempts a batch's own representative", () => {
    // The board already says "price" — the batch's "pricing" and
    // "pricing-model" converge on the BOARD's key, not on the batch's
    // shortest. Convergence to what the board uses, never to a preference.
    const batch = set(setStatement("a", "pricing"), setStatement("b", "pricing-model"));
    const folded = foldStatementTopics(batch, ["price"]);
    for (const op of folded) {
      expect(op.op === "SET_STATEMENT" ? op.statement?.topic : undefined).toBe("price");
    }
  });

  it("non-statement ops pass through untouched", () => {
    const existing = ["pricing"];
    const batch: Operation[] = [
      { op: "CREATE_NODE", id: "n1", nodeType: "step", label: "Step" },
      setStatement("n1", "price"),
    ];
    const folded = foldStatementTopics(batch, existing);
    expect(folded[0]).toEqual(batch[0]);
    expect(folded[1]).toEqual(setStatement("n1", "pricing"));
  });

  it("SET_STATEMENT null (a clear) is not a topic to fold", () => {
    const clear: Operation[] = [{ op: "SET_STATEMENT", id: "a", statement: null }];
    expect(foldStatementTopics(clear, ["pricing"])).toEqual(clear);
  });
});

describe("the workspace-derived surfaces", () => {
  function boardWith(...statements: Array<{ id: string; topic?: string; meetingId?: string }>) {
    const ops: Operation[] = [];
    for (const s of statements) {
      ops.push({ op: "CREATE_NODE", id: s.id, nodeType: "decision", label: `L ${s.id}` });
      ops.push({
        op: "SET_STATEMENT",
        id: s.id,
        statement: {
          kind: "decision",
          status: "open",
          ...(s.topic ? { topic: s.topic } : {}),
          ...(s.meetingId ? { provenance: { meetingId: s.meetingId, turnRange: [0, 0] } } : {}),
        },
      });
    }
    return applyOperations(createWorkspace(), ops);
  }

  it("existingTopics lists authored keys in first-seen order", () => {
    const ws = boardWith(
      { id: "a", topic: "pricing" },
      { id: "b", topic: "onboarding" },
      { id: "c", topic: "pricing" },
    );
    expect(existingTopics(ws)).toEqual(["pricing", "onboarding"]);
  });

  it("possibleDuplicateTopics pairs variant authored keys with evidence", () => {
    // The human's "Pricing Model" beside "Pricing" — rule 3's challenge.
    const ws = boardWith(
      { id: "a", topic: "pricing", meetingId: "mtg_mon" },
      { id: "b", topic: "pricing", meetingId: "mtg_wed" },
      { id: "c", topic: "pricing" },
      { id: "d", topic: "pricing-model", meetingId: "mtg_wed" },
      { id: "e", topic: "onboarding" },
    );
    const dupes = possibleDuplicateTopics(ws);
    expect(dupes).toHaveLength(1);
    const [dup, existing] = dupes[0]!.targets;
    // The dup is the longer key; the existing is what an accepted merge
    // converges on.
    expect(dup.topic).toBe("pricing-model");
    expect(existing.topic).toBe("pricing");
    expect(dup.statements).toBe(1);
    expect(existing.statements).toBe(3);
    // Evidence (rule 4): the meetings each side came from.
    expect(dup.meetings).toEqual(["mtg_wed"]);
    expect([...existing.meetings].sort()).toEqual(["mtg_mon", "mtg_wed"]);
    expect(dupes[0]!.type).toBe("merge-topic");
    expect(dupes[0]!.canonical).toBe("pricing");
    expect(dupes[0]!.id).toBe("merge-topic:pricing|pricing-model");
  });

  it("a unified or unrelated board produces nothing", () => {
    // Unified: one authored key, however many statements.
    expect(
      possibleDuplicateTopics(
        boardWith({ id: "a", topic: "pricing" }, { id: "b", topic: "pricing" }),
      ),
    ).toEqual([]);
    // Unrelated: variant logic doesn't reach semantic aliasing.
    expect(
      possibleDuplicateTopics(
        boardWith({ id: "a", topic: "monetization" }, { id: "b", topic: "pricing" }),
      ),
    ).toEqual([]);
  });

  it("a pair fires once — three-way variants pair the closest, not every combination", () => {
    const ws = boardWith(
      { id: "a", topic: "pricing" },
      { id: "b", topic: "pricing-model" },
      { id: "c", topic: "prices" },
    );
    const dupes = possibleDuplicateTopics(ws);
    // Each key joins at most one pair: no recommendation spam.
    const topics = dupes.flatMap((d) => d.targets.map((t) => t.topic));
    expect(new Set(topics).size).toBe(topics.length);
  });
});
