import { describe, it, expect } from "vitest";
import { REQUEST_LIMITS, summarizeWorkspace } from "@lucent/ai";
import { applyOperations, createWorkspace } from "@lucent/core";
import type { Operation } from "@lucent/core";
import { handleGenerate } from "../src/generate.js";

/**
 * Size caps on POST /api/generate (M5).
 *
 * The request schema capped individual strings but no array, and the array
 * limits lived only in the client-side summariser — so a hand-built POST could
 * carry any number of nodes, comments, or votes straight into the prompt builder
 * and the workspace rebuild. Each case here is one array or string that was
 * previously unbounded.
 */

/** Provider stub: the caps must reject before any provider work happens. */
const provider = {
  name: "fixed",
  async generateOperations() {
    return { operations: [] as Operation[] };
  },
  // Stage C1 made generateAnswer part of the interface; unreachable here.
  async generateAnswer() {
    throw new Error("fixed provider cannot answer questions");
  },
};

const base = { diagramKind: "flowchart" as const, nodes: [], edges: [] };

function req(summary: unknown, extra: Record<string, unknown> = {}) {
  return { message: "tidy the board", summary, ...extra };
}

function rows<T>(n: number, build: (i: number) => T): T[] {
  return Array.from({ length: n }, (_, i) => build(i));
}

const node = (i: number) => ({ id: `n${i}`, nodeType: "step", label: `Step ${i}` });
const shape = (i: number) => ({ id: `s${i}`, kind: "sticky", text: `Note ${i}` });

/** Every capped array, with a row builder, so one loop covers all of them. */
const arrays: Array<[string, number, (i: number) => unknown]> = [
  ["nodes", REQUEST_LIMITS.nodes, node],
  ["edges", REQUEST_LIMITS.edges, (i) => ({ source: "n0", target: `n${i}`, relationship: "next" })],
  ["groups", REQUEST_LIMITS.groups, (i) => ({ id: `g${i}`, label: `G${i}`, children: [] })],
  ["shapes", REQUEST_LIMITS.shapes, shape],
  [
    "shapeLinks",
    REQUEST_LIMITS.shapeLinks,
    (i) => ({ id: `l${i}`, source: "s0", target: `s${i}` }),
  ],
  [
    "wireframes",
    REQUEST_LIMITS.wireframes,
    (i) => ({ id: `w${i}`, title: `W${i}`, viewport: "desktop" }),
  ],
  ["votes", REQUEST_LIMITS.votes, (i) => ({ targetId: `n${i}`, votes: 1 })],
  ["reactions", REQUEST_LIMITS.reactions, (i) => ({ targetId: `n${i}`, emoji: "👍", count: 1 })],
  [
    "comments",
    REQUEST_LIMITS.comments,
    (i) => ({ id: `c${i}`, targetId: "n0", body: "hm", by: "usr_a", replies: 0 }),
  ],
  ["selection", REQUEST_LIMITS.selection, (i) => `n${i}`],
];

describe("array caps", () => {
  it.each(arrays)(
    "rejects %s one row over the cap with the handler's 400",
    async (key, cap, build) => {
      const result = await handleGenerate(provider, req({ ...base, [key]: rows(cap + 1, build) }));
      expect(result.status).toBe(400);
      expect((result.body as { error: string }).error).toBe("invalid request");
    },
  );

  it.each(arrays)("accepts %s exactly at the cap", async (key, cap, build) => {
    const result = await handleGenerate(provider, req({ ...base, [key]: rows(cap, build) }));
    expect(result.status).toBe(200);
  });

  it("caps the children of a single group", async () => {
    const over = {
      ...base,
      groups: [
        { id: "g0", label: "G", children: rows(REQUEST_LIMITS.groupChildren + 1, (i) => `n${i}`) },
      ],
    };
    expect((await handleGenerate(provider, req(over))).status).toBe(400);
  });
});

describe("string caps", () => {
  const cases: Array<[string, unknown]> = [
    ["node id", { ...base, nodes: [{ ...node(0), id: "n".repeat(REQUEST_LIMITS.idChars + 1) }] }],
    [
      "node label",
      { ...base, nodes: [{ ...node(0), label: "L".repeat(REQUEST_LIMITS.textChars + 1) }] },
    ],
    [
      "shape text",
      { ...base, shapes: [{ ...shape(0), text: "t".repeat(REQUEST_LIMITS.shapeTextChars + 1) }] },
    ],
    [
      "comment body",
      {
        ...base,
        comments: [
          {
            id: "c0",
            targetId: "n0",
            body: "b".repeat(REQUEST_LIMITS.commentChars + 1),
            by: "usr_a",
            replies: 0,
          },
        ],
      },
    ],
    [
      "relationship",
      {
        ...base,
        edges: [
          { source: "a", target: "b", relationship: "r".repeat(REQUEST_LIMITS.textChars + 1) },
        ],
      },
    ],
  ];

  it.each(cases)("rejects an over-long %s", async (_label, summary) => {
    expect((await handleGenerate(provider, req(summary))).status).toBe(400);
  });

  it("rejects an over-long user message", async () => {
    const result = await handleGenerate(provider, {
      message: "m".repeat(REQUEST_LIMITS.messageChars + 1),
      summary: base,
    });
    expect(result.status).toBe(400);
  });
});

describe("history and attachment caps", () => {
  const turn = { role: "user" as const, text: "make it simpler" };

  it("rejects more turns than the summariser ever sends", async () => {
    // Was 20 turns of 4,000 characters while the client sent 8 of 600 — the exact
    // drift that having one set of numbers is meant to prevent.
    const over = rows(REQUEST_LIMITS.historyTurns + 1, () => turn);
    expect((await handleGenerate(provider, req(base, { history: over }))).status).toBe(400);
    const atCap = rows(REQUEST_LIMITS.historyTurns, () => turn);
    expect((await handleGenerate(provider, req(base, { history: atCap }))).status).toBe(200);
  });

  it("rejects an over-long turn", async () => {
    const history = [{ role: "user", text: "x".repeat(REQUEST_LIMITS.historyChars + 1) }];
    expect((await handleGenerate(provider, req(base, { history }))).status).toBe(400);
  });

  it("rejects too many documents, an over-long document, and an over-long name", async () => {
    const doc = { name: "spec.md", text: "hello" };
    const tooMany = rows(REQUEST_LIMITS.documents + 1, () => doc);
    expect((await handleGenerate(provider, req(base, { documents: tooMany }))).status).toBe(400);
    const tooLong = [{ name: "spec.md", text: "x".repeat(REQUEST_LIMITS.documentChars + 1) }];
    expect((await handleGenerate(provider, req(base, { documents: tooLong }))).status).toBe(400);
    const badName = [{ name: "n".repeat(REQUEST_LIMITS.documentNameChars + 1), text: "hi" }];
    expect((await handleGenerate(provider, req(base, { documents: badName }))).status).toBe(400);
    expect((await handleGenerate(provider, req(base, { documents: [doc] }))).status).toBe(200);
  });

  it("rejects too many images", async () => {
    const image = { data: "iVBORw0KGgo=", mediaType: "image/png" };
    const images = rows(REQUEST_LIMITS.images + 1, () => image);
    expect((await handleGenerate(provider, req(base, { images }))).status).toBe(400);
  });
});

describe("the annotation rebuild is bounded", () => {
  it("survives a fully amplified vote and reaction summary", async () => {
    // Each row claims 100,000 votes. The rows are capped, but rebuilding one
    // ADD_VOTE per claimed vote is O(n²) inside the reducer: this request would
    // previously have rebuilt 64,000 records (320 rows x the old per-row clamp of
    // 200) and blocked the event loop for tens of seconds.
    const summary = {
      ...base,
      nodes: rows(REQUEST_LIMITS.nodes, node),
      shapes: rows(REQUEST_LIMITS.shapes, shape),
      votes: [
        ...rows(REQUEST_LIMITS.nodes, (i) => ({ targetId: `n${i}`, votes: 100_000 })),
        ...rows(REQUEST_LIMITS.shapes, (i) => ({ targetId: `s${i}`, votes: 100_000 })),
      ],
      reactions: rows(REQUEST_LIMITS.nodes, (i) => ({
        targetId: `n${i}`,
        emoji: "👍",
        count: 100_000,
      })),
    };
    const started = Date.now();
    const result = await handleGenerate(provider, req(summary));
    expect(result.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(3_000);
  });
});

describe("client and server agree on the numbers", () => {
  it("accepts whatever the summariser produces from an over-sized board", async () => {
    // The anti-drift test: REQUEST_LIMITS is derived from SUMMARY_LIMITS, so a
    // summary of a board far past every cap must still parse.
    //
    // The fixture has to exceed *every* collection for that to mean anything.
    // The first version of this test overflowed only nodes, edges, shapes and
    // comments, which is exactly why it stayed green while groups, wireframes,
    // votes, reactions and selection were capped on the server and never sliced
    // by the summariser - a marquee-select of a large board was a 400.
    const emoji = ["👍", "🎉", "🔥", "👀"];
    const ops: Operation[] = [];
    for (let i = 0; i < 260; i += 1) {
      ops.push({ op: "CREATE_NODE", id: `n${i}`, nodeType: "step", label: `Step ${i}` });
      if (i > 0)
        ops.push({
          op: "CONNECT_NODES",
          source: `n${i - 1}`,
          target: `n${i}`,
          relationship: "next",
        });
      ops.push({
        op: "ADD_COMMENT",
        id: `c${i}`,
        targetId: `n${i}`,
        body: "needs an owner",
        by: "usr_a",
      });
    }
    for (let i = 0; i < 150; i += 1) {
      ops.push({
        op: "CREATE_SHAPE",
        id: `s${i}`,
        kind: "sticky",
        position: { x: i, y: i },
        size: { width: 150, height: 110 },
        text: `Note ${i} `.repeat(40),
      });
    }
    // One group holding every node, then the rest empty: the point is a single
    // group whose child list is past groupChildren, not group membership.
    const nodeIds = rows(260, (i) => `n${i}`);
    for (let i = 0; i < 210; i += 1)
      ops.push({
        op: "CREATE_GROUP",
        id: `g${i}`,
        label: `G${i}`,
        children: i === 0 ? nodeIds : [],
      });
    for (let i = 0; i < 130; i += 1)
      ops.push({
        op: "CREATE_WIREFRAME",
        id: `w${i}`,
        title: `W${i}`,
        viewport: "desktop",
        root: { kind: "screen" },
      });
    // A vote on every object, and four distinct reactions on most of them.
    const targets = [...nodeIds, ...rows(150, (i) => `s${i}`)];
    const reacted = targets.slice(0, 330);
    targets.forEach((targetId, i) =>
      ops.push({ op: "ADD_VOTE", id: `v${i}`, targetId, by: "usr_a" }),
    );
    reacted.forEach((targetId, i) =>
      emoji.forEach((e, j) =>
        ops.push({ op: "ADD_REACTION", id: `r${i}_${j}`, targetId, emoji: e, by: "usr_a" }),
      ),
    );

    const workspace = applyOperations(createWorkspace(), ops);
    const selection = targets.slice(0, REQUEST_LIMITS.selection + 40);

    // The fixture only tests the caps while it is bigger than all of them, so
    // raising a cap without growing the fixture has to fail here rather than
    // quietly stop covering that collection.
    expect(Object.keys(workspace.groups).length).toBeGreaterThan(REQUEST_LIMITS.groups);
    expect(Object.keys(workspace.wireframes).length).toBeGreaterThan(REQUEST_LIMITS.wireframes);
    expect(nodeIds.length).toBeGreaterThan(REQUEST_LIMITS.groupChildren);
    expect(targets.length).toBeGreaterThan(REQUEST_LIMITS.votes);
    expect(reacted.length * emoji.length).toBeGreaterThan(REQUEST_LIMITS.reactions);
    expect(selection.length).toBeGreaterThan(REQUEST_LIMITS.selection);

    const summary = summarizeWorkspace(workspace, selection);

    // Every collection the schema caps, at or under its cap.
    expect(summary.nodes.length).toBeLessThanOrEqual(REQUEST_LIMITS.nodes);
    expect(summary.edges.length).toBeLessThanOrEqual(REQUEST_LIMITS.edges);
    expect(summary.groups?.length ?? 0).toBeLessThanOrEqual(REQUEST_LIMITS.groups);
    expect(summary.groups?.[0]?.children.length ?? 0).toBeLessThanOrEqual(
      REQUEST_LIMITS.groupChildren,
    );
    expect(summary.shapes?.length ?? 0).toBeLessThanOrEqual(REQUEST_LIMITS.shapes);
    expect(summary.shapeLinks?.length ?? 0).toBeLessThanOrEqual(REQUEST_LIMITS.shapeLinks);
    expect(summary.wireframes?.length ?? 0).toBeLessThanOrEqual(REQUEST_LIMITS.wireframes);
    expect(summary.votes?.length ?? 0).toBeLessThanOrEqual(REQUEST_LIMITS.votes);
    expect(summary.reactions?.length ?? 0).toBeLessThanOrEqual(REQUEST_LIMITS.reactions);
    expect(summary.comments?.length ?? 0).toBeLessThanOrEqual(REQUEST_LIMITS.comments);
    expect(summary.selection?.length ?? 0).toBeLessThanOrEqual(REQUEST_LIMITS.selection);

    // And the whole thing parses, which is the property that actually matters.
    const result = await handleGenerate(provider, req(summary));
    expect(result.status).toBe(200);
  }, 20_000);
});
