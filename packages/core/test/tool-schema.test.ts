import { describe, it, expect } from "vitest";
import {
  AI_FORBIDDEN_OPS,
  AI_OPERATION_NAMES,
  ALL_OPERATION_NAMES,
  anthropicToolDefinition,
  canvasToolDefinition,
  isHumanOnlyOperation,
  openAiToolDefinition,
  operationJsonSchema,
  safeParseOperations,
  TOOL_NAME,
  toolParametersJsonSchema,
} from "../src/index.js";

/**
 * The tool definition is generated from the operation union, so these tests are
 * the drift guard: if someone adds an operation to the schema, it must appear in
 * what the model is told without any second list being edited. The nine
 * previously-missing operations existed because the prompt hand-listed them.
 */

describe("operation name derivation", () => {
  it("derives every operation name from the schema itself", () => {
    // 21 today; asserting the exact set would just duplicate the schema, so
    // assert the properties that matter instead.
    expect(ALL_OPERATION_NAMES.length).toBeGreaterThan(15);
    expect(new Set(ALL_OPERATION_NAMES).size).toBe(ALL_OPERATION_NAMES.length);
    for (const name of ALL_OPERATION_NAMES) expect(name).toMatch(/^[A-Z_]+$/);
  });

  it("includes the shape operations that used to be invisible to the model", () => {
    for (const op of [
      "CREATE_SHAPE",
      "UPDATE_SHAPE",
      "DELETE_SHAPE",
      "CONNECT_SHAPES",
      "UPDATE_LINK",
      "DISCONNECT_SHAPES",
      "GROUP_SHAPES",
      "UNGROUP_SHAPES",
    ]) {
      expect(AI_OPERATION_NAMES, op).toContain(op);
    }
  });

  it("withholds only the human-only coordinate operation from the AI", () => {
    expect(AI_FORBIDDEN_OPS).toEqual(["MOVE_NODE"]);
    expect(AI_OPERATION_NAMES).not.toContain("MOVE_NODE");
    expect(ALL_OPERATION_NAMES).toContain("MOVE_NODE");
    expect(AI_OPERATION_NAMES.length).toBe(ALL_OPERATION_NAMES.length - 1);
    expect(isHumanOnlyOperation("MOVE_NODE")).toBe(true);
    expect(isHumanOnlyOperation("CREATE_NODE")).toBe(false);
  });
});

describe("tool definition", () => {
  const params = toolParametersJsonSchema();
  const serialized = JSON.stringify(params);

  it("advertises every AI-permitted operation", () => {
    const missing = AI_OPERATION_NAMES.filter((n) => !serialized.includes(`"${n}"`));
    expect(missing).toEqual([]);
  });

  it("never advertises a human-only operation", () => {
    for (const op of AI_FORBIDDEN_OPS) {
      expect(serialized).not.toContain(`"${op}"`);
    }
  });

  it("requires an operations array and offers an explanation field", () => {
    expect(params.type).toBe("object");
    const props = params.properties as Record<string, Record<string, unknown>>;
    expect(props.operations?.type).toBe("array");
    expect(props.explanation?.type).toBe("string");
    expect(params.required).toEqual(["operations"]);
  });

  it("omits a nested $schema key that some gateways reject", () => {
    expect(serialized).not.toContain('"$schema"');
  });

  it("describes wireframe structure recursively without pixel coordinates", () => {
    const opSchema = JSON.stringify(operationJsonSchema());
    expect(opSchema).toContain("CREATE_WIREFRAME");
    // Recursion is expressed via $ref rather than being inlined/truncated.
    expect(opSchema).toContain("$ref");
  });

  it("exposes matching OpenAI and Anthropic wire formats", () => {
    const openai = openAiToolDefinition();
    expect(openai.type).toBe("function");
    expect(openai.function.name).toBe(TOOL_NAME);

    const anthropic = anthropicToolDefinition();
    expect(anthropic.name).toBe(TOOL_NAME);
    expect(JSON.stringify(anthropic.input_schema)).toBe(JSON.stringify(openai.function.parameters));

    const neutral = canvasToolDefinition();
    expect(neutral.name).toBe(TOOL_NAME);
    expect(neutral.description.length).toBeGreaterThan(20);
  });
});

describe("schema still validates what the tool advertises", () => {
  it("accepts one operation of each AI-permitted kind", () => {
    // A representative payload per operation; if the schema gains a required
    // field this test fails loudly rather than the model discovering it.
    const samples: Record<string, unknown> = {
      CREATE_NODE: { op: "CREATE_NODE", id: "a", nodeType: "service", label: "A" },
      DELETE_NODE: { op: "DELETE_NODE", id: "a" },
      CHANGE_TEXT: { op: "CHANGE_TEXT", id: "a", text: "B" },
      CHANGE_NODE_TYPE: { op: "CHANGE_NODE_TYPE", id: "a", nodeType: "database" },
      SET_ISSUE: { op: "SET_ISSUE", id: "a", issue: { type: "story", status: "To Do" } },
      UPDATE_ISSUE: { op: "UPDATE_ISSUE", id: "a", status: "Done" },
      SET_STATEMENT: {
        op: "SET_STATEMENT",
        id: "a",
        statement: { kind: "decision", status: "resolved" },
      },
      UPDATE_STATEMENT: { op: "UPDATE_STATEMENT", id: "a", status: "rejected" },
      CONNECT_NODES: { op: "CONNECT_NODES", source: "a", target: "b", relationship: "calls" },
      DISCONNECT_NODES: { op: "DISCONNECT_NODES", source: "a", target: "b", relationship: "calls" },
      CREATE_GROUP: { op: "CREATE_GROUP", id: "g", label: "G", children: [] },
      DELETE_GROUP: { op: "DELETE_GROUP", id: "g" },
      SET_GROUP_KIND: { op: "SET_GROUP_KIND", id: "g", kind: "mindmap" },
      CREATE_DIAGRAM: { op: "CREATE_DIAGRAM", kind: "flowchart" },
      TRANSFORM_DIAGRAM: { op: "TRANSFORM_DIAGRAM", to: "mindmap" },
      SET_LAYOUT_INTENT: {
        op: "SET_LAYOUT_INTENT",
        direction: "horizontal",
        primaryFlow: ["a"],
        emphasis: ["a"],
      },
      CREATE_WIREFRAME: { op: "CREATE_WIREFRAME", id: "w", title: "W", root: { kind: "screen" } },
      DELETE_WIREFRAME: { op: "DELETE_WIREFRAME", id: "w" },
      CREATE_SHAPE: {
        op: "CREATE_SHAPE",
        id: "s",
        kind: "sticky",
        position: { x: 0, y: 0 },
        size: { width: 10, height: 10 },
      },
      UPDATE_SHAPE: { op: "UPDATE_SHAPE", id: "s", text: "hi" },
      DELETE_SHAPE: { op: "DELETE_SHAPE", id: "s" },
      CONNECT_SHAPES: { op: "CONNECT_SHAPES", id: "l", source: "s", target: "s2" },
      UPDATE_LINK: { op: "UPDATE_LINK", id: "l", label: "x" },
      DISCONNECT_SHAPES: { op: "DISCONNECT_SHAPES", id: "l" },
      GROUP_SHAPES: { op: "GROUP_SHAPES", groupId: "g1", ids: ["s", "s2"] },
      UNGROUP_SHAPES: { op: "UNGROUP_SHAPES", groupId: "g1" },
      ADD_VOTE: { op: "ADD_VOTE", id: "v1", targetId: "s" },
      REMOVE_VOTE: { op: "REMOVE_VOTE", id: "v1" },
      CLEAR_VOTES: { op: "CLEAR_VOTES" },
      ADD_REACTION: { op: "ADD_REACTION", id: "r1", targetId: "s", emoji: "👍" },
      REMOVE_REACTION: { op: "REMOVE_REACTION", id: "r1" },
      ADD_COMMENT: { op: "ADD_COMMENT", id: "c1", targetId: "s", body: "Looks off" },
      REPLY_COMMENT: { op: "REPLY_COMMENT", id: "c2", parentId: "c1", body: "Agreed" },
      RESOLVE_COMMENT: { op: "RESOLVE_COMMENT", id: "c1" },
      DELETE_COMMENT: { op: "DELETE_COMMENT", id: "c1" },
    };

    // Every advertised operation must have a sample here, so a new operation
    // can't silently skip coverage.
    expect(Object.keys(samples).sort()).toEqual([...AI_OPERATION_NAMES].sort());

    for (const [name, sample] of Object.entries(samples)) {
      const result = safeParseOperations([sample]);
      expect(result.success, `${name}: ${result.success ? "" : result.error.message}`).toBe(true);
    }
  });

  it("tolerates empty, omitted, and null relationship on CONNECT_NODES and DISCONNECT_NODES", () => {
    const emptyRel = safeParseOperations([
      { op: "CONNECT_NODES", source: "a", target: "b", relationship: "" },
      { op: "DISCONNECT_NODES", source: "a", target: "b", relationship: "" },
    ]);
    expect(emptyRel.success).toBe(true);
    if (emptyRel.success) {
      expect((emptyRel.data[0] as { relationship: string }).relationship).toBe("");
      expect((emptyRel.data[1] as { relationship: string }).relationship).toBe("");
    }

    const omittedRel = safeParseOperations([
      { op: "CONNECT_NODES", source: "a", target: "b" },
      { op: "DISCONNECT_NODES", source: "a", target: "b" },
    ]);
    expect(omittedRel.success).toBe(true);
    if (omittedRel.success) {
      expect((omittedRel.data[0] as { relationship: string }).relationship).toBe("");
      expect((omittedRel.data[1] as { relationship: string }).relationship).toBe("");
    }

    const nullRel = safeParseOperations([
      { op: "CONNECT_NODES", source: "a", target: "b", relationship: null },
      { op: "DISCONNECT_NODES", source: "a", target: "b", relationship: null },
    ]);
    expect(nullRel.success).toBe(true);
    if (nullRel.success) {
      expect((nullRel.data[0] as { relationship: string }).relationship).toBe("");
      expect((nullRel.data[1] as { relationship: string }).relationship).toBe("");
    }
  });
});
