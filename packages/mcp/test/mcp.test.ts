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
