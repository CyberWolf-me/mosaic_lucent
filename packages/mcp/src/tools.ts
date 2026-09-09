import {
  applyOperations,
  createWorkspace,
  validateOperations,
  repairOperations,
  isHumanOnlyOperation,
  stampAuthorship,
  ASSISTANT_AUTHOR,
  canvasToolDefinition,
  boardColumns,
  decisionDriveGraph,
  derivedExecution,
  type Operation,
  type Workspace,
} from "@lucent/core";

/**
 * MCP tool surface for Lucent, framework-free so it can be driven over stdio
 * (main.ts) or unit-tested directly.
 *
 * The whole point: an agent (Claude, Cursor, an IDE) builds and edits a real
 * Lucent board through the SAME validated operation contract the app uses. The
 * board lives here in memory; the agent emits `apply_canvas_operations` and gets
 * back validation errors or the new board summary. There is no second schema —
 * the tool definition is derived from core's Zod union, so what the agent may
 * send can never drift from what the validator accepts.
 */

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** The tools this server advertises. */
export function listTools(): McpTool[] {
  const canvas = canvasToolDefinition();
  return [
    {
      name: canvas.name,
      description: canvas.description,
      inputSchema: canvas.parameters,
    },
    {
      name: "get_board",
      description:
        "Return a compact summary of the current Lucent board: diagram kind, " +
        "nodes (with any issue fields), edges, and groups. Call this before " +
        "editing so ids and current state are known.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "list_external_links",
      description:
        "List the board's external task links (which node maps to which issue " +
        "in a connected system, e.g. Linear), plus any queued inbound status " +
        "changes awaiting a human accept. Read-only; deciding inbound changes " +
        "is a human act.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "reset_board",
      description: "Clear the board to an empty workspace. Destructive and not undoable here.",
      inputSchema: {
        type: "object",
        properties: {
          diagramKind: {
            type: "string",
            enum: [
              "flowchart",
              "architecture",
              "mindmap",
              "journey",
              "decisiontree",
              "process",
              "orgchart",
            ],
          },
        },
        additionalProperties: false,
      },
    },
  ];
}

export interface ToolResult {
  /** Human/agent-readable text blocks, MCP-style. */
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

function text(s: string): ToolResult {
  return { content: [{ type: "text", text: s }] };
}
function errorResult(s: string): ToolResult {
  return { content: [{ type: "text", text: s }], isError: true };
}

/** Compact, agent-friendly view of the board. */
export function summarizeBoard(ws: Workspace): Record<string, unknown> {
  const cols = boardColumns(ws);
  // Stage D3: the derived execution state, computed once per summary —
  // blockedBy/atRiskBy per executable node (computed truth, never stored).
  const derived = derivedExecution(ws, Date.now());
  const derivedFor = (id: string) => derived.get(id);
  // Stage E1: the decision→action causality — a decision's summary row
  // names the actions it drives, an action's names the decisions behind
  // it. Computed per read, same stance as the derived map.
  const driveGraph = decisionDriveGraph(ws);
  const decisionsBehind = new Map<string, string[]>();
  for (const [decisionId, actionIds] of driveGraph) {
    for (const actionId of actionIds) {
      const list = decisionsBehind.get(actionId) ?? [];
      list.push(decisionId);
      decisionsBehind.set(actionId, list);
    }
  }
  return {
    diagramKind: ws.diagramKind,
    nodeCount: Object.keys(ws.nodes).length,
    edgeCount: Object.keys(ws.edges).length,
    nodes: Object.values(ws.nodes).map((n) => ({
      id: n.id,
      type: n.nodeType,
      label: n.label,
      ...(n.groupId ? { groupId: n.groupId } : {}),
      ...(n.issue
        ? {
            issue: {
              type: n.issue.type,
              status: n.issue.status,
              assignee: n.issue.assignee,
              // Stage D1: the execution fields, capped for the summary —
              // an agent that can see the deadline can reason about it.
              ...(n.issue.dueDate ? { dueDate: n.issue.dueDate } : {}),
              ...(n.issue.description
                ? { description: n.issue.description.slice(0, 200) }
                : {}),
            },
          }
        : {}),
      // Stage C2: the semantic layer — what the node IS. An agent that can
      // see a decided thing as decided can supersede it instead of re-opening
      // a settled question.
      ...(n.statement
        ? {
            statement: {
              kind: n.statement.kind,
              status: n.statement.status,
              ...(n.statement.topic ? { topic: n.statement.topic } : {}),
              ...(n.statement.supersedes?.length
                ? { supersedes: n.statement.supersedes }
                : {}),
            },
          }
        : {}),
      // Stage D2: either evidence kind reaches the agent — meeting origin
      // when it exists, plan sources when that is what the node carries.
      ...(n.provenance?.meetingId ? { fromMeeting: n.provenance.meetingId } : {}),
      ...(n.provenance?.createdFrom?.length
        ? { fromStatements: n.provenance.createdFrom }
        : {}),
      // Stage D3: the derived execution truth — computed per read, so an
      // agent can answer "what's blocking this?" from structure, not labels.
      ...(derivedFor(n.id)?.blockedBy.length
        ? { derivedBlockers: derivedFor(n.id)!.blockedBy }
        : {}),
      ...(derivedFor(n.id)?.atRiskBy.length
        ? { derivedRisks: derivedFor(n.id)!.atRiskBy }
        : {}),
      // Stage E1: the drives causality — "what work came from this
      // decision?" and the reverse, straight from the edges.
      ...(n.statement?.kind === "decision" && driveGraph.get(n.id)?.length
        ? { drivesActions: driveGraph.get(n.id)! }
        : {}),
      ...(decisionsBehind.get(n.id)?.length
        ? { drivenByDecisions: decisionsBehind.get(n.id)! }
        : {}),
    })),
    edges: Object.values(ws.edges).map((e) => ({
      source: e.source,
      target: e.target,
      relationship: e.relationship,
    })),
    groups: Object.values(ws.groups).map((g) => ({
      id: g.id,
      label: g.label,
      members: g.children.length,
    })),
    board: {
      todo: cols.todo.length,
      inProgress: cols.in_progress.length,
      done: cols.done.length,
    },
  };
}

/**
 * Stateful board the tools operate on. One per session; the CLI keeps a single
 * instance for the life of the process.
 */
export class BoardSession {
  private ws: Workspace;

  constructor(initial?: Workspace) {
    this.ws = initial ?? createWorkspace();
  }

  get workspace(): Workspace {
    return this.ws;
  }

  callTool(name: string, args: Record<string, unknown>): ToolResult {
    switch (name) {
      case "apply_canvas_operations":
        return this.applyOps(args);
      case "get_board":
        return text(JSON.stringify(summarizeBoard(this.ws), null, 2));
      case "list_external_links":
        // The local session holds no link registry (links are server-side
        // state; the workspace blob carries zero provider strings by
        // design). The honest structured answer, the reset_board
        // notSupported precedent.
        return text(JSON.stringify({ links: [], note: "no link registry in the local session" }, null, 2));
      case "reset_board": {
        const kind = typeof args.diagramKind === "string" ? args.diagramKind : undefined;
        this.ws = createWorkspace(
          kind ? { diagramKind: kind as Workspace["diagramKind"] } : undefined,
        );
        return text("Board reset.");
      }
      default:
        return errorResult(`Unknown tool "${name}".`);
    }
  }

  private applyOps(args: Record<string, unknown>): ToolResult {
    const raw = args.operations;
    if (!Array.isArray(raw)) {
      return errorResult(
        "`operations` must be an array. Send an empty array to answer without changes.",
      );
    }
    // Strip coordinate-bearing/human-only ops defensively, exactly like the HTTP
    // path, then repair likely-misordered batches before validating.
    const candidate = raw.filter(
      (op): op is Operation =>
        op !== null &&
        typeof op === "object" &&
        typeof (op as { op?: unknown }).op === "string" &&
        !isHumanOnlyOperation((op as { op: string }).op),
    );
    let operations: Operation[];
    try {
      operations = repairOperations(candidate);
    } catch (err) {
      return errorResult(`Could not parse operations: ${(err as Error).message}`);
    }
    // Stamp authorship before validating (M0.4), the same way room.ts and
    // generate.ts do. This path shipped without it: an ADD_COMMENT from an agent
    // reached the reducer with no `by`, and the reducer's old `"me"` fallback
    // made it look like a signed-in person had written it. There is no human
    // identity to use here — MCP is an agent over stdio, with no session or
    // cookie in the protocol — so the author is the assistant, the same id
    // `handleGenerate` falls back to when no user is authenticated. Stamping
    // rather than trusting the agent's own `by` also stops it addressing a
    // comment or a vote as somebody else.
    operations = stampAuthorship(operations, ASSISTANT_AUTHOR);
    const errors = validateOperations(this.ws, operations);
    if (errors.length > 0) {
      return errorResult(
        `Rejected ${errors.length} invalid operation(s):\n` +
          errors.map((e) => `- ${e.message}`).join("\n"),
      );
    }
    this.ws = applyOperations(this.ws, operations);
    const explanation = typeof args.explanation === "string" ? args.explanation : "";
    return text(
      `Applied ${operations.length} operation(s).${explanation ? ` ${explanation}` : ""}\n\n` +
        JSON.stringify(summarizeBoard(this.ws), null, 2),
    );
  }
}
