import { describe, it, expect } from "vitest";
import { BoardSession, listTools, summarizeBoard, createDispatcher } from "../src/index.js";
import { ASSISTANT_AUTHOR, UNKNOWN_AUTHOR } from "@lucent/core";

describe("MCP tool surface", () => {
  it("advertises the canvas tool plus board helpers", () => {
    const names = listTools().map((t) => t.name);
    expect(names).toContain("apply_canvas_operations");
    expect(names).toContain("get_board");
    expect(names).toContain("reset_board");
  });

  it("derives the canvas tool's schema from core (has operations array)", () => {
    const canvas = listTools().find((t) => t.name === "apply_canvas_operations")!;
    const props = (canvas.inputSchema as any).properties;
    expect(props.operations).toBeDefined();
    expect(props.operations.type).toBe("array");
  });
});

describe("Mermaid over MCP (docs/27 D2)", () => {
  it("advertises import_mermaid and export_mermaid", () => {
    const names = listTools().map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["import_mermaid", "export_mermaid"]));
  });

  it("an empty board becomes the diagram; a second import lands as a region", () => {
    const s = new BoardSession();
    const first = s.callTool("import_mermaid", {
      mermaid: "```mermaid\nflowchart LR\n  A[Cart] --> B{Paid?} -->|yes| C[Ship]\n```",
    });
    expect(first.isError).toBeUndefined();
    expect(s.workspace.diagramKind).toBe("process");
    expect(Object.keys(s.workspace.nodes)).toHaveLength(3);

    const second = s.callTool("import_mermaid", {
      mermaid: "mindmap\n  root((Launch))\n    Blog\n    Press",
    });
    expect(second.isError).toBeUndefined();
    expect(s.workspace.diagramKind).toBe("process");
    const region = Object.values(s.workspace.groups).find((g) => g.kind === "mindmap");
    expect(region?.label).toBe("Imported mind map");
    expect(Object.values(s.workspace.nodes).filter((n) => n.groupId === region?.id)).toHaveLength(
      3,
    );

    expect(s.callTool("export_mermaid", {}).content[0]!.text).toMatch(/^flowchart LR/);
  });

  it("refuses text that isn't Mermaid, saying what would work", () => {
    const res = new BoardSession().callTool("import_mermaid", { mermaid: "A then B" });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("stateDiagram-v2");
  });
});

describe("BoardSession", () => {
  it("applies valid operations and reflects them in the summary", () => {
    const s = new BoardSession();
    const res = s.callTool("apply_canvas_operations", {
      operations: [
        { op: "CREATE_NODE", id: "a", nodeType: "service", label: "A" },
        { op: "CREATE_NODE", id: "b", nodeType: "service", label: "B" },
        { op: "CONNECT_NODES", source: "a", target: "b", relationship: "calls" },
      ],
    });
    expect(res.isError).toBeFalsy();
    expect(Object.keys(s.workspace.nodes)).toEqual(["a", "b"]);
  });

  it("rejects an operation that references a missing node, with a message", () => {
    const s = new BoardSession();
    const res = s.callTool("apply_canvas_operations", {
      operations: [{ op: "CONNECT_NODES", source: "ghost", target: "nope", relationship: "x" }],
    });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/does not exist/);
  });

  it("strips human-only MOVE_NODE rather than applying coordinates", () => {
    const s = new BoardSession();
    s.callTool("apply_canvas_operations", {
      operations: [{ op: "CREATE_NODE", id: "a", nodeType: "service", label: "A" }],
    });
    const res = s.callTool("apply_canvas_operations", {
      operations: [{ op: "MOVE_NODE", id: "a", position: { x: 5, y: 5 } }],
    });
    // Filtered out → nothing applied, no pinned position.
    expect(res.isError).toBeFalsy();
    expect(s.workspace.nodes.a!.position).toBeUndefined();
  });

  it("accepts issue operations (Jira surface)", () => {
    const s = new BoardSession();
    s.callTool("apply_canvas_operations", {
      operations: [{ op: "CREATE_NODE", id: "s1", nodeType: "task", label: "Login" }],
    });
    s.callTool("apply_canvas_operations", {
      operations: [{ op: "SET_ISSUE", id: "s1", issue: { type: "story", status: "In Progress" } }],
    });
    expect(s.workspace.nodes.s1!.issue!.statusCategory).toBe("in_progress");
    const summary = summarizeBoard(s.workspace);
    expect((summary.board as any).inProgress).toBe(1);
  });

  it("get_board returns JSON with node/edge counts", () => {
    const s = new BoardSession();
    s.callTool("apply_canvas_operations", {
      operations: [{ op: "CREATE_NODE", id: "a", nodeType: "service", label: "A" }],
    });
    const res = s.callTool("get_board", {});
    const parsed = JSON.parse(res.content[0]!.text);
    expect(parsed.nodeCount).toBe(1);
  });

  it("reset_board clears everything", () => {
    const s = new BoardSession();
    s.callTool("apply_canvas_operations", {
      operations: [{ op: "CREATE_NODE", id: "a", nodeType: "service", label: "A" }],
    });
    s.callTool("reset_board", {});
    expect(Object.keys(s.workspace.nodes)).toHaveLength(0);
  });

  it("errors on a non-array operations argument", () => {
    const s = new BoardSession();
    const res = s.callTool("apply_canvas_operations", { operations: "nope" });
    expect(res.isError).toBe(true);
  });
});

describe("JSON-RPC dispatcher", () => {
  it("handles initialize", async () => {
    const d = createDispatcher();
    const r = (await d({ jsonrpc: "2.0", id: 1, method: "initialize" })) as any;
    expect(r.result.serverInfo.name).toBe("lucent-mcp");
    expect(r.result.protocolVersion).toBeTruthy();
  });
  it("lists tools", async () => {
    const d = createDispatcher();
    const r = (await d({ jsonrpc: "2.0", id: 2, method: "tools/list" })) as any;
    expect(r.result.tools.length).toBeGreaterThanOrEqual(3);
  });
  it("routes tools/call to the session", async () => {
    const d = createDispatcher();
    const r = (await d({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "apply_canvas_operations",
        arguments: {
          operations: [{ op: "CREATE_NODE", id: "a", nodeType: "service", label: "A" }],
        },
      },
    })) as any;
    expect(r.result.content[0].text).toMatch(/Applied 1 operation/);
  });
  it("returns nothing for the initialized notification", async () => {
    const d = createDispatcher();
    expect(await d({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
  });
  it("returns method-not-found for an unknown method", async () => {
    const d = createDispatcher();
    const r = (await d({ jsonrpc: "2.0", id: 9, method: "bogus" })) as any;
    expect(r.error.code).toBe(-32601);
  });
});

describe("BoardSession authorship (M0.4)", () => {
  /**
   * This path shipped without stamping: an agent's ADD_COMMENT reached the
   * reducer with no `by`, and the old `"me"` fallback made it look like a person
   * had written it. MCP has no human identity to borrow — it is an agent over
   * stdio, with no session or cookie in the protocol — so the author is the
   * assistant, the same id `/api/generate` falls back to for an unauthenticated
   * request.
   */
  function seeded(): BoardSession {
    const s = new BoardSession();
    s.callTool("apply_canvas_operations", {
      operations: [{ op: "CREATE_NODE", id: "a", nodeType: "service", label: "A" }],
    });
    return s;
  }

  it("attributes a comment, vote and reaction to the assistant", () => {
    const s = seeded();
    const res = s.callTool("apply_canvas_operations", {
      operations: [
        { op: "ADD_COMMENT", id: "c1", targetId: "a", body: "needs a cache" },
        { op: "REPLY_COMMENT", id: "r1", parentId: "c1", body: "agreed" },
        { op: "ADD_VOTE", id: "v1", targetId: "a" },
        { op: "ADD_REACTION", id: "x1", targetId: "a", emoji: "👍" },
      ],
    });
    expect(res.isError).toBeFalsy();
    expect(s.workspace.comments.c1!.by).toBe(ASSISTANT_AUTHOR);
    expect(s.workspace.comments.r1!.by).toBe(ASSISTANT_AUTHOR);
    expect(s.workspace.votes.v1!.by).toBe(ASSISTANT_AUTHOR);
    expect(s.workspace.reactions.x1!.by).toBe(ASSISTANT_AUTHOR);
    // Never the retired placeholder, and never "author unknown" either: this
    // path knows exactly who wrote the comment.
    expect(JSON.stringify(s.workspace)).not.toContain('"me"');
    expect(JSON.stringify(s.workspace)).not.toContain(`"${UNKNOWN_AUTHOR}"`);
  });

  it("overwrites an author the agent supplied for itself", () => {
    // The tool input is no more trustworthy than a websocket frame. If a `by`
    // survived, an agent could post a comment as a named colleague.
    const s = seeded();
    s.callTool("apply_canvas_operations", {
      operations: [{ op: "ADD_COMMENT", id: "c1", targetId: "a", body: "hi", by: "usr_victim" }],
    });
    expect(s.workspace.comments.c1!.by).toBe(ASSISTANT_AUTHOR);
  });

  it("fills createdAt so a stamped comment sorts in a thread", () => {
    const s = seeded();
    s.callTool("apply_canvas_operations", {
      operations: [{ op: "ADD_COMMENT", id: "c1", targetId: "a", body: "hi" }],
    });
    expect(typeof s.workspace.comments.c1!.createdAt).toBe("number");
    expect(s.workspace.comments.c1!.createdAt).toBeGreaterThan(0);
  });

  it("stamps before validating, so the validator's author rule never fires here", () => {
    // Ordering matters: `validateOperations` refuses an authored op with no `by`,
    // so stamping after validation would reject every annotation an agent sends.
    const s = seeded();
    const res = s.callTool("apply_canvas_operations", {
      operations: [{ op: "ADD_VOTE", id: "v1", targetId: "a" }],
    });
    expect(res.isError).toBeFalsy();
    expect(res.content[0]!.text).not.toMatch(/no author/);
    expect(s.workspace.votes.v1!.by).toBe(ASSISTANT_AUTHOR);
  });
});

describe("get_board provenance (Stage D2)", () => {
  it("exposes either evidence kind — meeting origin or plan sources", () => {
    const s = new BoardSession();
    s.callTool("apply_canvas_operations", {
      operations: [
        {
          op: "CREATE_NODE",
          id: "from-meeting",
          nodeType: "action",
          label: "Meeting item",
          provenance: { meetingId: "mtg_1", turnRange: [0, 1] },
        },
        {
          op: "CREATE_NODE",
          id: "from-plan",
          nodeType: "action",
          label: "Plan item",
          provenance: { createdFrom: ["decision-1", "risk-2"] },
        },
      ],
    });
    const res = s.callTool("get_board", {});
    const summary = JSON.parse(res.content[0]!.text as string);
    const meeting = summary.nodes.find((n: any) => n.id === "from-meeting");
    const plan = summary.nodes.find((n: any) => n.id === "from-plan");
    // Meeting evidence: the origin id, not the plan link.
    expect(meeting.fromMeeting).toBe("mtg_1");
    expect(meeting.fromStatements).toBeUndefined();
    // Plan evidence: the sources, no meeting claim (honest — none exists).
    expect(plan.fromStatements).toEqual(["decision-1", "risk-2"]);
    expect(plan.fromMeeting).toBeUndefined();
  });
});

describe("get_board derived execution (Stage D3)", () => {
  it("exposes derivedBlockers/derivedRisks computed from the dependency graph", () => {
    const s = new BoardSession();
    s.callTool("apply_canvas_operations", {
      operations: [
        { op: "CREATE_NODE", id: "design", nodeType: "action", label: "Design approval" },
        { op: "SET_STATEMENT", id: "design", statement: { kind: "action", status: "open" } },
        {
          op: "SET_ISSUE",
          id: "design",
          issue: { type: "task", status: "blocked", dueDate: "2020-01-01" },
        },
        { op: "CREATE_NODE", id: "implementation", nodeType: "action", label: "Implementation" },
        {
          op: "SET_STATEMENT",
          id: "implementation",
          statement: { kind: "action", status: "open" },
        },
        { op: "SET_ISSUE", id: "implementation", issue: { type: "task", status: "open" } },
        {
          op: "CONNECT_NODES",
          source: "implementation",
          target: "design",
          relationship: "depends_on",
        },
      ],
    });
    const res = s.callTool("get_board", {});
    const summary = JSON.parse(res.content[0]!.text as string);
    const design = summary.nodes.find((n: any) => n.id === "design");
    const implementation = summary.nodes.find((n: any) => n.id === "implementation");
    // The blocker source itself: no derived state.
    expect(design.derivedBlockers).toBeUndefined();
    // The dependent: derived blockers + risks (blocked AND overdue upstream).
    expect(implementation.derivedBlockers).toEqual(["design"]);
    expect(implementation.derivedRisks).toEqual(["design"]);
  });
});

describe("Visual PR for coding agents (create_proposal and get_proposal_diff)", () => {
  it("computes proposal diff without mutating current board", () => {
    const s = new BoardSession();
    s.callTool("apply_canvas_operations", {
      operations: [{ op: "CREATE_NODE", id: "auth", nodeType: "service", label: "Auth Gateway" }],
    });

    const diffRes = s.callTool("get_proposal_diff", {
      title: "Add Caching Layer",
      operations: [
        { op: "CREATE_NODE", id: "cache", nodeType: "database", label: "Redis Cache" },
        { op: "CONNECT_NODES", source: "auth", target: "cache", relationship: "caches" },
      ],
    });

    expect(diffRes.isError).toBeFalsy();
    expect(diffRes.content[0]!.text).toContain("Visual Architecture Proposal: Add Caching Layer");
    expect(diffRes.content[0]!.text).toContain("+ [database] Redis Cache");
    expect(diffRes.content[0]!.text).toContain("+ Auth Gateway --[caches]--> Redis Cache");

    // Board remains untouched
    expect(Object.keys(s.workspace.nodes)).toEqual(["auth"]);
  });

  it("stages a proposal via create_proposal with validation and generated ID", () => {
    const s = new BoardSession();
    const createRes = s.callTool("create_proposal", {
      title: "Introduce Microservices Architecture",
      explanation: "Decompose monolithic core into services",
      operations: [
        { op: "CREATE_NODE", id: "svc1", nodeType: "service", label: "Orders Service" },
        { op: "CREATE_NODE", id: "svc2", nodeType: "service", label: "Payments Service" },
        { op: "CONNECT_NODES", source: "svc1", target: "svc2", relationship: "calls" },
      ],
    });

    expect(createRes.isError).toBeFalsy();
    expect(createRes.content[0]!.text).toContain("Created visual proposal **prp_");
    expect(createRes.content[0]!.text).toContain("Introduce Microservices Architecture");
    expect(createRes.content[0]!.text).toContain("Pending human review");

    // Rejects invalid proposal that references missing node
    const invalidRes = s.callTool("create_proposal", {
      title: "Broken Proposal",
      operations: [
        { op: "CONNECT_NODES", source: "missing_1", target: "missing_2", relationship: "calls" },
      ],
    });
    expect(invalidRes.isError).toBe(true);
    expect(invalidRes.content[0]!.text).toContain("Proposal rejected due to validation errors");
  });
});

