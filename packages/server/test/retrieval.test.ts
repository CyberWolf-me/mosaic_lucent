import { describe, expect, it } from "vitest";
import type { LoggedOpEntry } from "../src/boards.js";
import { createWorkspace, type Node, type Operation } from "@lucent/core";
import type { MeetingTranscript } from "../src/meetings.js";
import {
  buildSearchCorpus,
  normalizeText,
  retrieve,
  SEARCH_LIMITS,
  type SearchCorpus,
} from "../src/retrieval.js";

/**
 * The weighted lexical retriever (Stage C4, ADR 0024). Pure module, pure
 * tests: every behavior the two consumers (search route, ask route) depend
 * on is pinned here — the token folds, the field weights, the deterministic
 * order, and the two properties that make it safe to hand to either: it can
 * only ever see what its caller put in the corpus, and an unclassified turn
 * is findable (the C1 promise that search is where those sentences live).
 */

function op(id: string, label: string): Operation {
  return { op: "CREATE_NODE", id, nodeType: "step", label };
}

function logEntry(seq: number, label: string, at = 1_000 + seq): LoggedOpEntry {
  return {
    seq,
    ops: [op(`n${seq}`, `Node ${seq}`)],
    by: "user-1",
    label,
    at,
    actor: { actorType: "user", actorId: "user-1", initiatedBy: "user-1" },
  };
}

function meeting(
  id: string,
  turns: MeetingTranscript["turns"],
  startedAt = 1_000,
): MeetingTranscript {
  return {
    id,
    boardId: "b1",
    orgId: "org1",
    startedAt,
    endedAt: startedAt + 60_000,
    turns,
    createdBy: null,
    createdAt: startedAt,
  };
}

/** A workspace whose node map is exactly the given nodes. */
function workspaceOf(...nodes: Partial<Node>[]): ReturnType<typeof createWorkspace> {
  const ws = createWorkspace();
  for (const n of nodes) {
    ws.nodes[n.id!] = {
      id: n.id!,
      nodeType: n.nodeType ?? "step",
      label: n.label ?? n.id!,
      ...(n.statement ? { statement: n.statement } : {}),
      ...(n.provenance ? { provenance: n.provenance } : {}),
    };
  }
  return ws;
}

/** Minimal corpus fixtures — one of each kind, the common case. */
function baseCorpus(): SearchCorpus {
  return buildSearchCorpus({
    workspace: workspaceOf(
      {
        id: "pricing-node",
        nodeType: "decision",
        label: "Pricing decision $15",
        statement: { kind: "decision", status: "resolved", topic: "pricing" },
        provenance: { meetingId: "mtg-a", quote: "maybe $20 for the pro tier" },
      },
      { id: "auth-node", nodeType: "service", label: "Auth service" },
    ),
    meetings: [
      meeting("mtg-a", [
        { speaker: "Maya", at: 1_000, text: "Maybe $20 for the pro tier" },
        { speaker: "Tom", at: 2_000, text: "Sounds good, let's ship it", kind: "decision" },
      ]),
    ],
    log: [logEntry(7, "pricing corrections"), logEntry(6, "auth refactor")],
    actorNames: new Map([["user-1", "Maya"]]),
  });
}

describe("normalizeText", () => {
  it("folds case, accents, and treats punctuation as a separator", () => {
    expect(normalizeText("Café Prícing!")).toBe("cafe pricing");
    // $15 reads as the token "15" — currency survives as its number.
    expect(normalizeText("$15")).toBe("15");
    expect(normalizeText("user's flow")).toBe("user s flow");
  });

  it("collapses repeated separators and trims", () => {
    expect(normalizeText("  --a--  ")).toBe("a");
    expect(normalizeText("")).toBe("");
  });
});

describe("token matching", () => {
  const corpus = baseCorpus();

  it("plural folds: prices matches price on both sides", () => {
    const hits = retrieve("prices", corpus, 10);
    expect(hits.some((h) => h.kind === "node" && h.id === "pricing-node")).toBe(true);
  });

  it("prefix match: pri hits pricing", () => {
    const hits = retrieve("pri", corpus, 10);
    expect(hits.some((h) => h.kind === "node" && h.id === "pricing-node")).toBe(true);
  });

  it("shared stem: price matches pricing (no prefix relation)", () => {
    const hits = retrieve("price changes", corpus, 10);
    // "price" matches "pricing" via the shared-stem rule; "changes" adds
    // nothing. The node must rank at all.
    expect(hits.some((h) => h.kind === "node" && h.id === "pricing-node")).toBe(true);
  });

  it("digits match as tokens: 20 finds the turn and the quote", () => {
    const hits = retrieve("20", corpus, 10);
    const turn = hits.find((h) => h.kind === "turn");
    expect(turn).toBeDefined();
    if (turn?.kind !== "turn") return;
    expect(turn.meetingId).toBe("mtg-a");
    expect(turn.turnIndex).toBe(0);
    expect(turn.snippet.toLowerCase()).toContain("20");
    // The provenance quote carries the same words at weight 2.
    const node = hits.find((h) => h.kind === "node" && h.id === "pricing-node");
    expect(node?.matched).toContain("20");
  });

  it("a one-character token is noise and matches nothing", () => {
    expect(retrieve("a", corpus, 10)).toEqual([]);
  });

  it("an unmatched query returns no hits", () => {
    expect(retrieve("zebra unicorn", corpus, 10)).toEqual([]);
  });
});

describe("field weights", () => {
  it("a label match outranks a turn-text match for the same token", () => {
    const corpus = buildSearchCorpus({
      workspace: workspaceOf({ id: "n1", label: "Pricing" }),
      meetings: [meeting("m1", [{ speaker: "A", at: 1, text: "pricing pricing pricing" }])],
      log: [],
    });
    // The turn matches one token (weight 1); the node label matches one
    // token (weight 5). Node first.
    const hits = retrieve("pricing", corpus, 10);
    expect(hits[0]?.kind).toBe("node");
  });

  it("statement kind/status is searchable: decisions finds the decision", () => {
    const hits = retrieve("decisions", corpusFor("decisions"), 10);
    expect(hits[0]?.kind).toBe("node");
    if (hits[0]?.kind !== "node") return;
    expect(hits[0].statement?.kind).toBe("decision");
  });

  function corpusFor(query: string): SearchCorpus {
    void query;
    return baseCorpus();
  }

  it("open questions are findable by status", () => {
    const corpus = buildSearchCorpus({
      workspace: workspaceOf({
        id: "q1",
        label: "Roadmap",
        statement: { kind: "question", status: "open", topic: "roadmap" },
      }),
      meetings: [],
      log: [],
    });
    const hits = retrieve("open questions", corpus, 10);
    expect(hits[0]?.kind).toBe("node");
    if (hits[0]?.kind !== "node") return;
    expect(hits[0].statement?.status).toBe("open");
  });

  it("nodeType is searchable at the same weight as kind/status", () => {
    const corpus = buildSearchCorpus({
      workspace: workspaceOf({ id: "n1", label: "Kubernetes", nodeType: "service" }),
      meetings: [],
      log: [],
    });
    const hits = retrieve("service", corpus, 10);
    expect(hits[0]?.kind).toBe("node");
  });

  it("the provenance quote is searchable at weight 2", () => {
    const corpus = baseCorpus();
    const hits = retrieve("pro tier", corpus, 10);
    // "pro" and "tier" both live in the quote (2 each = 4). The label
    // "Pricing decision $15" matches neither, so the node still surfaces —
    // via the quote alone.
    const node = hits.find((h) => h.kind === "node" && h.id === "pricing-node");
    expect(node).toBeDefined();
    if (node?.kind !== "node") return;
    expect(node.matched.sort()).toEqual(["pro", "tier"]);
  });
});

describe("ranking and caps", () => {
  it("equal scores tie-break node → turn → revision, then by id", () => {
    // A genuine tie: two label matches (5 each) beat everything else; the
    // turn matches two query tokens at weight 1 (score 2) and the revision
    // label matches one at weight 2 (score 2) — turn ranks above revision
    // at equal score by the kind order.
    const corpus = buildSearchCorpus({
      workspace: workspaceOf({ id: "n-b", label: "Alpha" }, { id: "n-a", label: "Alpha" }),
      meetings: [meeting("m1", [{ speaker: "A", at: 1, text: "alpha beta" }])],
      log: [logEntry(1, "alpha revision")],
    });
    const hits = retrieve("alpha beta", corpus, 10);
    expect(hits.map((h) => h.kind)).toEqual(["node", "node", "turn", "revision"]);
    if (hits[0]?.kind === "node" && hits[1]?.kind === "node") {
      expect(hits[0].id).toBe("n-a");
      expect(hits[1].id).toBe("n-b");
    }
  });

  it("caps at the requested limit and at resultsMax", () => {
    const corpus = buildSearchCorpus({
      workspace: workspaceOf(
        ...Array.from({ length: 30 }, (_, i) => ({ id: `n${i}`, label: `Alpha ${i}` })),
      ),
      meetings: [],
      log: [],
    });
    expect(retrieve("alpha", corpus, 5)).toHaveLength(5);
    expect(retrieve("alpha", corpus, 100)).toHaveLength(SEARCH_LIMITS.resultsMax);
  });

  it("matched reports the query tokens that fired, as typed", () => {
    const hits = retrieve("pricing prices", baseCorpus(), 10);
    // "prices" folds to "price" and "pricing" stays "pricing" — distinct
    // folded forms, so both are query tokens; both fire on the node, and
    // matched reports them as typed (the UI shows these).
    const node = hits.find((h) => h.kind === "node" && h.id === "pricing-node");
    expect(node?.matched).toEqual(["pricing", "prices"]);
  });

  it("a plural repetition collapses to one token and does not double-score", () => {
    const one = retrieve("price", baseCorpus(), 10).find((h) => h.kind === "node");
    const two = retrieve("price prices", baseCorpus(), 10).find((h) => h.kind === "node");
    expect(one?.score).toBe(two?.score);
  });

  it("an empty query returns nothing", () => {
    expect(retrieve("", baseCorpus())).toEqual([]);
    expect(retrieve("   ", baseCorpus())).toEqual([]);
  });

  it("a repeated word does not double-score", () => {
    const one = retrieve("pricing", baseCorpus(), 10).find((h) => h.kind === "node");
    const two = retrieve("pricing pricing pricing", baseCorpus(), 10).find(
      (h) => h.kind === "node",
    );
    expect(one?.score).toBe(two?.score);
  });
});

describe("the corpus the digest never shows", () => {
  it("unclassified turns are searchable — C1's promise", () => {
    const corpus = buildSearchCorpus({
      workspace: workspaceOf(),
      meetings: [
        meeting("m1", [
          { speaker: "Maya", at: 1_000, text: "maybe $20 for the pro tier" },
          { speaker: "Tom", at: 2_000, text: "agreed", kind: "decision" },
        ]),
      ],
      log: [],
    });
    const hits = retrieve("pro tier", corpus, 10);
    expect(hits).toHaveLength(1);
    if (hits[0]?.kind !== "turn") return;
    expect(hits[0].turnIndex).toBe(0); // the UNCLASSIFIED turn
  });

  it("turn snippets are anchored on the match, not the opening words", () => {
    const long = `So anyway, before we get into the agenda, I wanted to circle back on the pricing question from last week because several customers pushed back on the $20 number and honestly I think we should reconsider the whole tier structure before launch.`;
    const corpus = buildSearchCorpus({
      workspace: workspaceOf(),
      meetings: [meeting("m1", [{ speaker: "Maya", at: 1_000, text: long }])],
      log: [],
    });
    const hits = retrieve("reconsider", corpus, 10);
    expect(hits).toHaveLength(1);
    if (hits[0]?.kind !== "turn") return;
    expect(hits[0].snippet).toContain("reconsider");
    expect(hits[0].snippet.startsWith("So anyway")).toBe(false);
    expect(hits[0].snippet.length).toBeLessThanOrEqual(SEARCH_LIMITS.snippet + 2);
  });

  it("turns carry their stable index across the transcript", () => {
    const corpus = buildSearchCorpus({
      workspace: workspaceOf(),
      meetings: [
        meeting("m1", [
          { speaker: "A", at: 1, text: "first" },
          { speaker: "B", at: 2, text: "second" },
          { speaker: "C", at: 3, text: "third pricing" },
        ]),
      ],
      log: [],
    });
    const hits = retrieve("pricing", corpus, 10);
    if (hits[0]?.kind !== "turn") throw new Error("expected a turn hit");
    expect(hits[0].turnIndex).toBe(2);
  });
});

describe("the corpus contract", () => {
  it("the corpus contains only what the caller windowed in", () => {
    // The security property, stated as a test: whatever the caller does not
    // pass cannot appear in results. The corpus builder has no store access
    // to violate this with — this pins the shape that makes it true.
    const corpus = buildSearchCorpus({
      workspace: workspaceOf({ id: "n1", label: "Pricing" }),
      meetings: [],
      log: [logEntry(1, "pricing change")],
    });
    const hits = retrieve("pricing", corpus, 10);
    expect(hits.map((h) => h.kind).sort()).toEqual(["node", "revision"]);
    // Nothing else exists in the corpus — no meetings store, no hidden log.
    expect(retrieve("auth", corpus, 10)).toEqual([]);
  });

  it("revision hits carry the actor name when the caller supplied names", () => {
    const hits = retrieve("corrections", baseCorpus(), 10);
    const revision = hits.find((h) => h.kind === "revision");
    expect(revision).toBeDefined();
    if (revision?.kind !== "revision") return;
    expect(revision.seq).toBe(7);
    expect(revision.actorName).toBe("Maya");
  });

  it("an AI actor revision renders as Lucent", () => {
    const entry = logEntry(3, "pricing extraction");
    entry.actor = { actorType: "ai", actorId: "lucent", initiatedBy: "user-1" };
    const corpus = buildSearchCorpus({
      workspace: workspaceOf(),
      meetings: [],
      log: [entry],
    });
    const hits = retrieve("extraction", corpus, 10);
    if (hits[0]?.kind !== "revision") throw new Error("expected a revision hit");
    expect(hits[0].actorName).toBe("Lucent");
  });
});
