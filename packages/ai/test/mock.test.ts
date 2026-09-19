import { describe, it, expect } from "vitest";
import { applyOperations, createWorkspace, validateOperations } from "@lucent/core";
import { MockProvider, summarizeWorkspace } from "../src/index.js";
import { parseModelJson } from "../src/providers/anthropic.js";

describe("MockProvider", () => {
  it("produces a valid e-commerce graph that the reducer accepts", async () => {
    const provider = new MockProvider();
    const ws = createWorkspace();
    const { operations } = await provider.generateOperations({
      message: "I'm building an e-commerce platform",
      summary: summarizeWorkspace(ws),
    });
    expect(validateOperations(ws, operations)).toHaveLength(0);
    const next = applyOperations(ws, operations);
    expect(next.nodes.checkout).toBeDefined();
    expect(next.nodes.stripe).toBeDefined();
  });

  it("supports the add-authentication follow-up against existing state", async () => {
    const provider = new MockProvider();
    let ws = createWorkspace();
    ws = applyOperations(
      ws,
      (
        await provider.generateOperations({
          message: "e-commerce store",
          summary: summarizeWorkspace(ws),
        })
      ).operations,
    );
    const followup = await provider.generateOperations({
      message: "add authentication",
      summary: summarizeWorkspace(ws),
    });
    expect(validateOperations(ws, followup.operations)).toHaveLength(0);
    ws = applyOperations(ws, followup.operations);
    expect(ws.nodes.auth?.label).toBe("Authentication");
  });

  it("answers a question with no operations (Phase C answer channel)", async () => {
    const provider = new MockProvider();
    const ws = applyOperations(createWorkspace(), [
      { op: "CREATE_NODE", id: "a", nodeType: "service", label: "Payment" },
    ]);
    const res = await provider.generateOperations({
      message: "What is on this board?",
      summary: summarizeWorkspace(ws),
    });
    expect(res.operations).toHaveLength(0);
    expect(res.explanation).toMatch(/Payment|nodes/);
  });

  it("includes the selection in the built prompt", async () => {
    const ws = applyOperations(createWorkspace(), [
      { op: "CREATE_NODE", id: "checkout", nodeType: "screen", label: "Checkout" },
    ]);
    const { buildUserPrompt } = await import("../src/prompt.js");
    const prompt = buildUserPrompt({
      message: "explain this",
      summary: summarizeWorkspace(ws, ["checkout"]),
    });
    expect(prompt).toContain("Selected");
    expect(prompt).toContain("checkout");
  });
});

describe("parseModelJson", () => {
  it("extracts operations from a model text response", () => {
    const text = `Here you go:
{ "operations": [ { "op": "CREATE_NODE", "id": "a", "nodeType": "t", "label": "A" } ], "explanation": "ok" }`;
    const result = parseModelJson(text);
    expect(result.operations).toHaveLength(1);
    expect(result.explanation).toBe("ok");
  });

  it("throws on invalid operations", () => {
    const text = `{ "operations": [ { "op": "NOPE" } ] }`;
    expect(() => parseModelJson(text)).toThrow(/invalid operations/);
  });
});

describe("MockProvider statement semantics (Stage C2)", () => {
  it("'we decided $15/month' creates a decision born resolved, superseding the $20 proposal", async () => {
    const provider = new MockProvider();
    // The board the message describes: the $20 proposal already exists (the
    // supersession target the decision names).
    const ws = applyOperations(createWorkspace(), [
      { op: "CREATE_NODE", id: "pricing-proposal", nodeType: "idea", label: "Proposal: $20/month" },
      {
        op: "SET_STATEMENT",
        id: "pricing-proposal",
        statement: { kind: "proposal", status: "open", topic: "pricing" },
      },
    ]);
    const { operations } = await provider.generateOperations({
      message:
        "From the meeting: Sarah: 'We decided to price it at $15/month.' The board currently shows a node proposing $20/month (id pricing-proposal).",
      summary: summarizeWorkspace(ws),
    });
    expect(validateOperations(ws, operations)).toHaveLength(0);
    const statement = operations.find((o) => o.op === "SET_STATEMENT");
    expect(statement).toMatchObject({
      op: "SET_STATEMENT",
      id: "pricing-decision",
      statement: {
        kind: "decision",
        status: "resolved",
        topic: "pricing",
        supersedes: ["pricing-proposal"],
      },
    });
    // And applying the batch visibly supersedes the old proposal.
    const next = applyOperations(ws, operations);
    expect(next.nodes["pricing-proposal"]?.statement?.status).toBe("superseded");
  });

  it("a rejection flips the existing proposal's statement to rejected", async () => {
    const provider = new MockProvider();
    const ws = applyOperations(createWorkspace(), [
      {
        op: "CREATE_NODE",
        id: "usage-pricing",
        nodeType: "idea",
        label: "Proposal: usage-based pricing",
      },
      {
        op: "SET_STATEMENT",
        id: "usage-pricing",
        statement: { kind: "proposal", status: "open", topic: "pricing" },
      },
    ]);
    const { operations } = await provider.generateOperations({
      message: "From the meeting: Lena: 'No, we're not doing usage-based pricing.'",
      summary: summarizeWorkspace(ws),
    });
    expect(validateOperations(ws, operations)).toHaveLength(0);
    expect(operations).toContainEqual({
      op: "UPDATE_STATEMENT",
      id: "usage-pricing",
      status: "rejected",
    });
  });

  it("a hedged suggestion is a proposal statement, open and unowned", async () => {
    const provider = new MockProvider();
    const ws = createWorkspace();
    const { operations } = await provider.generateOperations({
      message:
        "From a brainstorm: Jin: 'We should probably ask Sarah about pricing at some point.'",
      summary: summarizeWorkspace(ws),
    });
    expect(validateOperations(ws, operations)).toHaveLength(0);
    expect(operations).toContainEqual({
      op: "SET_STATEMENT",
      id: "ask-sarah-idea",
      statement: { kind: "proposal", status: "open", topic: "pricing" },
    });
    // And the proposal-never-a-decision rule: no resolved status anywhere.
    expect(
      operations.some((o) => o.op === "SET_STATEMENT" && o.statement?.status === "resolved"),
    ).toBe(false);
  });

  it("a commitment carries an action statement alongside its owner", async () => {
    const provider = new MockProvider();
    const ws = createWorkspace();
    const { operations } = await provider.generateOperations({
      message: "From a brainstorm: David: 'I'll prepare the launch brief by Friday.'",
      summary: summarizeWorkspace(ws),
    });
    expect(operations).toContainEqual({
      op: "SET_STATEMENT",
      id: "launch-brief",
      statement: { kind: "action", status: "open", topic: "launch" },
    });
  });
});

describe("MockProvider plan tree (Stages D2/E1/E3)", () => {
  it("the plan grows the task tree: workstream groups, region nesting, drives edges — all valid", async () => {
    const provider = new MockProvider();
    // The D2 acceptance fixture's statement shape: a decision,
    // requirements, risks (existing actions/proposals/questions omitted
    // for focus — the plan preserves or ignores them).
    const ws = applyOperations(createWorkspace(), [
      { op: "CREATE_NODE", id: "dec-0", nodeType: "decision", label: "Phased rollout" },
      { op: "SET_STATEMENT", id: "dec-0", statement: { kind: "decision", status: "resolved" } },
      { op: "CREATE_NODE", id: "req-0", nodeType: "requirement", label: "Support SSO" },
      { op: "SET_STATEMENT", id: "req-0", statement: { kind: "requirement", status: "open" } },
      { op: "CREATE_NODE", id: "req-1", nodeType: "requirement", label: "Add audit log" },
      { op: "SET_STATEMENT", id: "req-1", statement: { kind: "requirement", status: "open" } },
      { op: "CREATE_NODE", id: "rsk-0", nodeType: "risk", label: "Migration data loss" },
      { op: "SET_STATEMENT", id: "rsk-0", statement: { kind: "risk", status: "open" } },
      { op: "CREATE_NODE", id: "rsk-1", nodeType: "risk", label: "Cost overrun" },
      { op: "SET_STATEMENT", id: "rsk-1", statement: { kind: "risk", status: "open" } },
    ] as never);
    const { operations } = await provider.generateOperations({
      message: "Create the work from these decisions.",
      summary: summarizeWorkspace(ws),
    });
    // The batch validates against the seeded board — the tree is real
    // state, not a draft.
    expect(validateOperations(ws, operations)).toHaveLength(0);
    const after = applyOperations(ws, operations);
    // The workstream groups: kindless containers, one per stream, every
    // derived action in exactly one.
    const research = after.groups["plan-ws-research"];
    const design = after.groups["plan-ws-design"];
    const engineering = after.groups["plan-ws-engineering"];
    const qa = after.groups["plan-ws-qa"];
    expect(research).toMatchObject({ label: "Research" });
    expect(design).toMatchObject({ label: "Design" });
    expect(engineering).toMatchObject({ label: "Engineering" });
    expect(qa).toMatchObject({ label: "QA" });
    expect(research!.kind).toBeUndefined(); // kindless: a container, not a lens
    const workstreamIds = [
      ...research!.children,
      ...design!.children,
      ...engineering!.children,
      ...qa!.children,
    ];
    expect(workstreamIds).toHaveLength(4);
    expect(new Set(workstreamIds).size).toBe(4); // each action in exactly one stream
    // The plan region keeps ALL derived nodes (plus the decisions), so the
    // workstreams nest inside it (bounds over its own children list).
    const region = after.groups["plan-region"]!;
    expect(region.children).toEqual(expect.arrayContaining(workstreamIds));
    expect(region.children).toContain("dec-0");
    expect(region.kind).toBe("process");
    // Each node's groupId lands on its workstream (the reducer's
    // last-write-wins: the region is emitted before the workstreams).
    for (const id of workstreamIds) {
      expect(after.nodes[id]!.groupId).toMatch(/^plan-ws-/);
    }
    // The E1 drives edges ride along: one per derived action.
    const drives = Object.values(after.edges).filter((e) => e.relationship === "drives");
    expect(drives).toHaveLength(4);
    for (const edge of drives) {
      expect(edge.source).toBe("dec-0");
      expect(edge.target).toMatch(/-action$/);
    }
  });

  it("a board with no derived work grows no workstream groups", async () => {
    const provider = new MockProvider();
    const ws = applyOperations(createWorkspace(), [
      { op: "CREATE_NODE", id: "dec-0", nodeType: "decision", label: "Phased rollout" },
      { op: "SET_STATEMENT", id: "dec-0", statement: { kind: "decision", status: "resolved" } },
    ] as never);
    const { operations } = await provider.generateOperations({
      message: "Create the work from these decisions.",
      summary: summarizeWorkspace(ws),
    });
    expect(validateOperations(ws, operations)).toHaveLength(0);
    const after = applyOperations(ws, operations);
    expect(Object.keys(after.groups).filter((id) => id.startsWith("plan-ws-"))).toEqual([]);
    expect(Object.values(after.edges).filter((e) => e.relationship === "drives")).toEqual([]);
  });
});
