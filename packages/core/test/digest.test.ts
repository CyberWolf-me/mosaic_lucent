import { describe, it, expect } from "vitest";
import { applyOperations, createWorkspace, generateBoardDigest, type Operation } from "../src/index.js";

describe("generateBoardDigest", () => {
  it("generates an executive markdown digest for an empty board", () => {
    const ws = createWorkspace();
    const digest = generateBoardDigest(ws, "Blank Canvas");
    expect(digest).toContain("# Blank Canvas");
    expect(digest).toContain("> **Type:** flowchart");
    expect(digest).toContain("## Governance & Health Summary");
    expect(digest).toContain("```mermaid");
  });

  it("includes decisions, actions, and risks in structured markdown tables", () => {
    let ws = createWorkspace();
    const ops: Operation[] = [
      {
        op: "CREATE_NODE",
        id: "d1",
        nodeType: "decision",
        label: "Adopt PostgreSQL",
      },
      {
        op: "SET_STATEMENT",
        id: "d1",
        statement: { kind: "decision", status: "resolved", topic: "database" },
      },
      {
        op: "CREATE_NODE",
        id: "a1",
        nodeType: "action",
        label: "Configure connection pooling",
      },
      {
        op: "SET_STATEMENT",
        id: "a1",
        statement: { kind: "action", status: "open" },
      },
      {
        op: "SET_ISSUE",
        id: "a1",
        issue: {
          type: "task",
          status: "in_progress",
          statusCategory: "in_progress",
          assignee: "Alice",
          dueDate: "2026-10-15",
        },
      },
      {
        op: "CREATE_NODE",
        id: "r1",
        nodeType: "risk",
        label: "Memory pressure under 10k RPS",
      },
      {
        op: "SET_STATEMENT",
        id: "r1",
        statement: { kind: "risk", status: "open", topic: "perf" },
      },
      {
        op: "CREATE_NODE",
        id: "q1",
        nodeType: "question",
        label: "Which cloud region?",
      },
      {
        op: "SET_STATEMENT",
        id: "q1",
        statement: { kind: "question", status: "open" },
      },
      {
        op: "CONNECT_NODES",
        source: "d1",
        target: "a1",
        relationship: "requires",
      },
    ];

    ws = applyOperations(ws, ops);
    const digest = generateBoardDigest(ws, "Core Infrastructure Review");

    expect(digest).toContain("# Core Infrastructure Review");
    expect(digest).toContain("## Decisions Register");
    expect(digest).toContain("| Adopt PostgreSQL | `database` | ✅ Decided | — |");

    expect(digest).toContain("## Action Backlog");
    expect(digest).toContain("| Configure connection pooling | **@Alice** | 2026-10-15 | in_progress | — |");

    expect(digest).toContain("## Risks & Questions");
    expect(digest).toContain("### Identified Risks");
    expect(digest).toContain("Memory pressure under 10k RPS");
    expect(digest).toContain("### Open Questions");
    expect(digest).toContain("Which cloud region?");

    expect(digest).toContain("## Architecture & Flow");
    expect(digest).toContain("flowchart TD");
    expect(digest).toContain("d1 -->|requires| a1");
  });

  it("respects selective option toggles", () => {
    let ws = createWorkspace();
    ws = applyOperations(ws, [
      {
        op: "CREATE_NODE",
        id: "d1",
        nodeType: "decision",
        label: "Use Vitest",
      },
      {
        op: "SET_STATEMENT",
        id: "d1",
        statement: { kind: "decision", status: "resolved" },
      },
    ]);

    const withoutMermaid = generateBoardDigest(ws, "Test Board", { includeMermaid: false });
    expect(withoutMermaid).not.toContain("```mermaid");
    expect(withoutMermaid).toContain("## Decisions Register");

    const withoutMetrics = generateBoardDigest(ws, "Test Board", { includeMetrics: false });
    expect(withoutMetrics).not.toContain("## Governance & Health Summary");
  });
});
