import { applyOperations, createWorkspace } from "@lucent/core";
import { summarizeWorkspace } from "./provider.js";
import type { GoldenCase } from "./evals.js";

/**
 * The golden cases themselves. Built on the seeded intents `MockProvider`
 * scripts (docs/07's example session), so the offline gate in
 * `test/golden-evals.test.ts` exercises the same flow a real provider would:
 * describe → operations → validate. Expectations are shapes, not transcripts
 * (see evals.ts on why).
 */

const empty = summarizeWorkspace(createWorkspace());

/** A small existing flow the refinement cases edit. */
const seeded = summarizeWorkspace(
  applyOperations(createWorkspace(), [
    { op: "CREATE_DIAGRAM", kind: "flowchart" },
    { op: "CREATE_NODE", id: "checkout", nodeType: "screen", label: "Checkout" },
    { op: "CREATE_NODE", id: "payments", nodeType: "service", label: "Payments" },
    { op: "CONNECT_NODES", source: "checkout", target: "payments", relationship: "pays" },
  ]),
);

export const GOLDEN_SET: readonly GoldenCase[] = [
  {
    id: "ecommerce-seed",
    // The MVP example session: a full e-commerce flow from one ask (docs/07).
    message: "Design an e-commerce online store flow",
    summary: empty,
    minOperations: 6,
    expectOperations: [
      { op: "CREATE_DIAGRAM", kind: "flowchart" },
      { op: "CREATE_NODE", id: "customer", nodeType: "actor" },
      { op: "CONNECT_NODES", source: "customer", target: "products" },
      { op: "CONNECT_NODES", source: "cart", target: "checkout" },
    ],
    explanationIncludes: "e-commerce",
  },
  {
    id: "add-authentication",
    // The refinement follow-up from docs/07: new node + a guard edge.
    message: "Add authentication before payment",
    summary: seeded,
    expectOperations: [
      { op: "CREATE_NODE", id: "auth", nodeType: "service" },
      { op: "CONNECT_NODES", source: "auth", target: "checkout" },
    ],
    forbidOperations: [{ op: "DELETE_NODE", id: "checkout" }],
  },
  {
    id: "oauth-refinement",
    // An edit that only rewrites text: no structural ops.
    message: "Use Google OAuth for the authentication",
    summary: summarizeWorkspace(
      applyOperations(createWorkspace(), [
        { op: "CREATE_NODE", id: "auth", nodeType: "service", label: "Authentication" },
      ]),
    ),
    expectOperations: [{ op: "CHANGE_TEXT", id: "auth", text: "Google OAuth" }],
    minOperations: 1,
  },
  {
    id: "question-answering",
    // A question is answered in prose; emitting ops here would be the bug.
    message: "What does this board show?",
    summary: seeded,
    minOperations: 0,
    forbidOperations: [
      { op: "CREATE_NODE", id: "x" },
      { op: "DELETE_NODE", id: "checkout" },
    ],
    explanationIncludes: "checkout",
  },
  {
    id: "empty-board-question",
    message: "Explain what I should do next",
    summary: empty,
    minOperations: 0,
    explanationIncludes: "empty",
  },
  {
    id: "no-human-only-ops",
    // A node reposition is a human op (docs/03): the model is asked to move
    // something, and must NOT emit MOVE_NODE — coordinates come from layout.
    message: "Move the payments box somewhere better",
    summary: seeded,
    minOperations: 0,
    forbidOperations: [{ op: "MOVE_NODE", id: "payments" }],
  },

  {
    id: "parallel-diagram-refusal",
    // Found by the live test pass: a request about an UNRELATED system must
    // not be merged into a populated board. The prompt's new rule says answer
    // with no ops and point at a new board, so the client can offer the
    // one-click action. Zero ops IS the correct answer here.
    message: "Build a marketing analytics pipeline with event tracking",
    summary: seeded,
    minOperations: 0,
    forbidOperations: [{ op: "CREATE_NODE" }],
    explanationIncludes: "own board",
  },
  {
    id: "unrelated-on-empty-board-builds",
    // The same words on an EMPTY board are just the next thing to build: a
    // connected seed flow, not a refusal. A populated-board-only rule would
    // strand a fresh user whose first diagram happens to name a system in
    // the match list.
    message: "Build a marketing analytics pipeline with event tracking",
    summary: empty,
    minOperations: 5,
    expectOperations: [
      { op: "CONNECT_NODES", relationship: "starts" },
      { op: "CONNECT_NODES", relationship: "yields" },
    ],
    forbidOperations: [{ op: "DELETE_NODE" }],
  },

  {
    id: "parallel-diagram-refusal",
    // Found by the live test pass: a request about an UNRELATED system must
    // not be merged into a populated board. The prompt's new rule says answer
    // with no ops and point at a new board, so the client can offer the
    // one-click action. Zero ops IS the correct answer here.
    message: "Build a marketing analytics pipeline with event tracking",
    summary: seeded,
    minOperations: 0,
    forbidOperations: [{ op: "CREATE_NODE" }],
    explanationIncludes: "own board",
  },
  {
    id: "unrelated-on-empty-board-builds",
    // The same words on an EMPTY board are just the next thing to build: a
    // connected seed flow, not a refusal. A populated-board-only rule would
    // strand a fresh user whose first diagram happens to name a system in
    // the match list.
    message: "Build a marketing analytics pipeline with event tracking",
    summary: empty,
    minOperations: 5,
    expectOperations: [
      { op: "CONNECT_NODES", relationship: "starts" },
      { op: "CONNECT_NODES", relationship: "yields" },
    ],
    forbidOperations: [{ op: "DELETE_NODE" }],
  },

  {
    id: "region-adds-second-kind",
    // The region rule: "also add a mind map for X" builds a second diagram
    // KIND on the same board via a kind-carrying group — it must NOT
    // transform the board's existing kind or delete existing nodes.
    message: "Also add a mind map for the pricing ideas on this board",
    summary: seeded,
    minOperations: 5,
    expectOperations: [
      { op: "CREATE_GROUP", kind: "mindmap" },
      { op: "CREATE_NODE", nodeType: "topic" },
      { op: "CONNECT_NODES", relationship: "branch" },
    ],
    forbidOperations: [{ op: "TRANSFORM_DIAGRAM" }, { op: "DELETE_NODE", id: "checkout" }],
  },
  {
    id: "region-retarget-changes-one-region",
    // "change the X section to a Y" flips one region's kind only — the
    // board kind and every other region are untouched.
    message: "Change the pricing section to an org chart",
    summary: summarizeWorkspace(
      applyOperations(createWorkspace(), [
        { op: "CREATE_DIAGRAM", kind: "flowchart" },
        { op: "CREATE_NODE", id: "checkout", nodeType: "screen", label: "Checkout" },
        {
          op: "CREATE_GROUP",
          id: "pricing",
          label: "Pricing",
          children: ["checkout"],
          kind: "mindmap",
        },
      ]),
    ),
    expectOperations: [{ op: "SET_GROUP_KIND", id: "pricing", kind: "orgchart" }],
    forbidOperations: [{ op: "TRANSFORM_DIAGRAM" }, { op: "DELETE_NODE", id: "checkout" }],
  },
];
