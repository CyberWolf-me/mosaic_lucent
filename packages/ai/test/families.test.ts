import { describe, expect, it } from "vitest";
import {
  aiCreatableKinds,
  applyOperations,
  createWorkspace,
  getRepresentation,
  listRepresentations,
  regionKinds,
  representationCatalogPrompt,
  validateOperations,
  type DiagramKind,
  type Operation,
  type Workspace,
} from "@lucent/core";
import { loadPromptFile } from "../src/registry.js";
import { buildUserPrompt, SYSTEM_PROMPT, SYSTEM_PROMPT_VERSION } from "../src/prompt.js";
import { summarizeWorkspace } from "../src/provider.js";
import { MockProvider } from "../src/providers/mock.js";

/**
 * V4: the AI layer knows every family, from one place.
 *
 * The family list used to be written out by hand in the system prompt (eleven
 * kinds, while core registered eighteen) and a second copy was injected into
 * every user turn's <board-context>. Both are now the registry's: the system
 * prompt carries `{{families}}`, rendered once at load, and the per-request
 * data region carries none of it. The mock builds every family the same way
 * the prompt tells a real model to — a starter on an empty board, a region
 * beside other content when the family can be one, an honest answer when not.
 */

function validFile(body: string[]): Record<string, unknown> {
  return {
    id: "test-prompt",
    version: 1,
    description: "A prompt used only by the families tests.",
    vocabulary: { base: "ai-permitted" },
    body,
  };
}

describe("the system prompt carries the registry's family catalog", () => {
  it("lists every creatable family with its summary and every construction rule", () => {
    for (const spec of listRepresentations().filter((r) => r.aiCreatable)) {
      expect(SYSTEM_PROMPT, spec.kind).toContain(`- ${spec.kind} — ${spec.summary}`);
      for (const rule of spec.guidance) {
        expect(SYSTEM_PROMPT, `${spec.kind} guidance`).toContain(`    ${rule}`);
      }
    }
    expect(SYSTEM_PROMPT).toContain(representationCatalogPrompt());
  });

  it("says which families may be regions, from the registry flag", () => {
    const creatable = listRepresentations().filter((r) => r.aiCreatable);
    const regions = creatable.filter((r) => r.regionable).map((r) => r.kind);
    const wholeBoard = creatable.filter((r) => !r.regionable).map((r) => r.kind);
    expect(regions).toEqual(regionKinds().filter((k) => aiCreatableKinds().includes(k)));
    expect(SYSTEM_PROMPT).toContain(`A region's kind is one of: ${regions.join(", ")}.`);
    expect(SYSTEM_PROMPT).toContain(`${wholeBoard.join(", ")}. Their geometry`);
    // The ones the brief names, so a registry flip is a visible test change.
    for (const kind of ["matrix", "timeline", "storymap", "sequence", "er"]) {
      expect(wholeBoard).toContain(kind);
    }
    // The plan paragraph's region kinds must themselves be regionable.
    expect(SYSTEM_PROMPT).toContain('CREATE_GROUP (kind "process" or');
    expect(regions).toEqual(expect.arrayContaining(["process", "decisiontree"]));
  });

  it("teaches tables and charts as shapes with their data fields", () => {
    expect(SYSTEM_PROMPT).toContain('CREATE_SHAPE kind "table" with `table`');
    expect(SYSTEM_PROMPT).toContain('CREATE_SHAPE kind "chart" with `chart`');
    expect(SYSTEM_PROMPT).toContain("table.columns is a list of { header }");
    expect(SYSTEM_PROMPT).toContain("{ name, values }");
    // The replace-whole semantics of UPDATE_SHAPE, and what the model does
    // when the summary says rows are hidden.
    expect(SYSTEM_PROMPT).toContain("it REPLACES the grid");
    expect(SYSTEM_PROMPT).toContain("when it says rows are hidden");
  });

  it("is version 17 and leaves no placeholder unresolved", () => {
    expect(SYSTEM_PROMPT_VERSION).toBe(17);
    expect(SYSTEM_PROMPT).not.toMatch(/\{\{[^}\n]{1,40}\}\}/);
    // The hand-written list it replaced is gone, not duplicated.
    expect(SYSTEM_PROMPT).not.toContain("Diagram kinds and what each is for");
  });

  it("carries the edit-first-but-clarify rule (v17, docs/26 locked philosophy)", () => {
    // Explicit → act; ambiguous → ask instead of guessing (no ops).
    expect(SYSTEM_PROMPT).toMatch(/WHEN TO ACT vs WHEN TO CLARIFY/i);
    expect(SYSTEM_PROMPT).toMatch(/fix the architecture/i);
    expect(SYSTEM_PROMPT).toMatch(/emit no operations/i);
    expect(SYSTEM_PROMPT).toMatch(/clarifying question/i);
  });
});

describe("registry: generated placeholders", () => {
  it("renders {{families}} from the registry when a prompt asks for it", () => {
    const entry = loadPromptFile(validFile(["{{operations}}", "", "{{families}}"]));
    expect(entry.systemPrompt).toContain(representationCatalogPrompt());
  });

  it("renders the region lists", () => {
    const entry = loadPromptFile(
      validFile(["{{operations}}", "R: {{region-kinds}}", "W: {{whole-board-kinds}}"]),
    );
    const creatable = listRepresentations().filter((r) => r.aiCreatable);
    expect(entry.systemPrompt).toContain(
      `R: ${creatable
        .filter((r) => r.regionable)
        .map((r) => r.kind)
        .join(", ")}`,
    );
    expect(entry.systemPrompt).toContain(
      `W: ${creatable
        .filter((r) => !r.regionable)
        .map((r) => r.kind)
        .join(", ")}`,
    );
  });

  it("keeps {{families}} optional", () => {
    const entry = loadPromptFile(validFile(["Emit only these:", "{{operations}}"]));
    expect(entry.systemPrompt).not.toContain("Diagram families");
  });

  it("still rejects an unknown placeholder beside the known ones", () => {
    expect(() =>
      loadPromptFile(validFile(["{{operations}}", "{{families}}", "Speak in a {{tone}} voice."])),
    ).toThrow(/unresolved placeholder \{\{tone\}\}/);
    expect(() => loadPromptFile(validFile(["{{operations}}", "{{family}}"]))).toThrow(
      /unresolved placeholder \{\{family\}\}/,
    );
  });

  it("still requires {{operations}} even when a generated section is present", () => {
    expect(() => loadPromptFile(validFile(["{{families}}"]))).toThrow(
      /never uses \{\{operations\}\}/,
    );
  });
});

describe("the user turn carries no catalog", () => {
  it("keeps the diagram kind line and nothing of the family menu", () => {
    const ws = applyOperations(createWorkspace(), [
      { op: "CREATE_DIAGRAM", kind: "statemachine" },
      { op: "CREATE_NODE", id: "draft", nodeType: "state", label: "Draft" },
    ]);
    const prompt = buildUserPrompt({
      message: "add a published state",
      summary: summarizeWorkspace(ws),
    });
    expect(prompt).toContain("Current diagram kind: statemachine");
    expect(prompt).not.toContain("Diagram families you can create");
    for (const spec of listRepresentations()) {
      expect(prompt, spec.kind).not.toContain(`- ${spec.kind} — `);
      expect(prompt, spec.kind).not.toContain(spec.summary);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* MockProvider builds every family                                            */
/* -------------------------------------------------------------------------- */

const provider = new MockProvider();

async function ask(ws: Workspace, message: string) {
  return provider.generateOperations({ message, summary: summarizeWorkspace(ws) });
}

/** A board with content, of a kind other than the one under test. */
function contentBoard(notKind: DiagramKind): Workspace {
  const kind: DiagramKind = notKind === "flowchart" ? "architecture" : "flowchart";
  return applyOperations(createWorkspace(), [
    { op: "CREATE_DIAGRAM", kind },
    { op: "CREATE_NODE", id: "checkout", nodeType: "step", label: "Checkout" },
    { op: "CREATE_NODE", id: "payments", nodeType: "service", label: "Payments" },
    { op: "CONNECT_NODES", source: "checkout", target: "payments", relationship: "pays" },
  ]);
}

/**
 * A request for every family, generated from the registry label so a newly
 * registered family is exercised with no edit here. "Architecture" alone is
 * too generic to name its family (see the mock's GENERIC_LABELS), so it is
 * asked for as a diagram.
 */
function requestFor(kind: DiagramKind): string {
  const label = getRepresentation(kind).label;
  return kind === "architecture" ? "Sketch an architecture diagram" : `Sketch: ${label}`;
}

describe("MockProvider builds every family", () => {
  it.each(aiCreatableKinds())("%s: the registry starter on an empty board", async (kind) => {
    const ws = createWorkspace();
    const { operations } = await ask(ws, requestFor(kind));
    expect(operations[0]).toEqual({ op: "CREATE_DIAGRAM", kind });
    expect(operations.filter((o) => o.op === "CREATE_NODE").length).toBeGreaterThan(1);
    expect(validateOperations(ws, operations)).toEqual([]);
    expect(applyOperations(ws, operations).diagramKind).toBe(kind);
  });

  it.each(regionKinds())("%s: a region beside existing content", async (kind) => {
    const ws = contentBoard(kind);
    const { operations, explanation } = await ask(ws, requestFor(kind));
    expect(validateOperations(ws, operations)).toEqual([]);
    // Never re-kinds or rewrites the board it was added to.
    expect(operations.some((o) => o.op === "CREATE_DIAGRAM" || o.op === "TRANSFORM_DIAGRAM")).toBe(
      false,
    );
    expect(operations.some((o) => o.op === "DELETE_NODE")).toBe(false);
    const group = operations[0] as Extract<Operation, { op: "CREATE_GROUP" }>;
    expect(group).toMatchObject({ op: "CREATE_GROUP", kind });
    // Every member sits in the region itself: that is what makes it a region.
    const created = operations.filter(
      (o): o is Extract<Operation, { op: "CREATE_NODE" }> => o.op === "CREATE_NODE",
    );
    expect(created.length).toBeGreaterThan(1);
    for (const node of created) expect(node.groupId).toBe(group.id);
    const after = applyOperations(ws, operations);
    expect(after.diagramKind).toBe(ws.diagramKind);
    expect(after.groups[group.id]?.kind).toBe(kind);
    expect(explanation).toContain("region");
  });

  const wholeBoardOnly = aiCreatableKinds().filter((k) => !getRepresentation(k).regionable);

  it.each(wholeBoardOnly)("%s: an honest answer beside existing content", async (kind) => {
    const ws = contentBoard(kind);
    const { operations, explanation } = await ask(ws, requestFor(kind));
    expect(operations).toEqual([]);
    expect(explanation).toMatch(/own board/);
    expect(explanation).toMatch(/whole board/);
  });

  it.each([
    ["Draw a state machine for the order lifecycle", "statemachine"],
    ["sequence diagram of the login handshake", "sequence"],
    ["ER diagram for a blog", "er"],
    ["an entity relationship model of the library tables", "er"],
    ["C4 container view of the payments service", "c4"],
    ["network diagram of production", "network"],
    ["map our AWS infrastructure", "network"],
    ["dependency graph of the release tasks", "dependency"],
    ["BPMN for expense approval", "bpmn"],
    ["a timeline of the launch", "timeline"],
    ["roadmap for Q3", "timeline"],
    ["a 2x2 of effort vs impact", "matrix"],
    ["prioritization matrix for the backlog", "matrix"],
    ["SWOT for the launch", "matrix"],
    ["class diagram for the order domain", "class"],
    ["UML for the billing module", "class"],
    ["user story map for checkout", "storymap"],
    ["story map for onboarding", "storymap"],
    ["swimlanes for expense approval", "process"],
    ["an organizational chart for sales", "orgchart"],
    ["decision tree for choosing a plan", "decisiontree"],
    ["a flow chart for password reset", "flowchart"],
  ] as const)("%s → %s", async (message, kind) => {
    const { operations } = await ask(createWorkspace(), message);
    expect(operations[0]).toEqual({ op: "CREATE_DIAGRAM", kind });
  });

  it("the earliest family named wins", async () => {
    const { operations } = await ask(
      createWorkspace(),
      "a state machine for the checkout flowchart",
    );
    expect(operations[0]).toEqual({ op: "CREATE_DIAGRAM", kind: "statemachine" });
  });

  it("a second insert of the same family gets fresh ids", async () => {
    let ws = createWorkspace();
    ws = applyOperations(ws, (await ask(ws, "state machine for orders")).operations);
    const again = await ask(ws, "state machine for refunds");
    // Same kind as the board: the starter's content joins it, no CREATE_DIAGRAM.
    expect(again.operations.some((o) => o.op === "CREATE_DIAGRAM")).toBe(false);
    expect(validateOperations(ws, again.operations)).toEqual([]);
    const ids = again.operations.flatMap((o) => (o.op === "CREATE_NODE" ? [o.id] : []));
    for (const id of ids) expect(ws.nodes[id]).toBeUndefined();
  });

  it("a region added twice does not collide either", async () => {
    let ws = contentBoard("c4");
    ws = applyOperations(ws, (await ask(ws, "also add a C4 model for payments")).operations);
    const second = await ask(ws, "also add a C4 model for billing");
    expect(validateOperations(ws, second.operations)).toEqual([]);
    expect(second.operations[0]).toMatchObject({ op: "CREATE_GROUP", id: "c4-2-region" });
  });
});

describe("MockProvider region retarget and whole-board convert", () => {
  const regionBoard = () =>
    applyOperations(createWorkspace(), [
      { op: "CREATE_DIAGRAM", kind: "flowchart" },
      { op: "CREATE_NODE", id: "hub", nodeType: "idea", label: "Pricing" },
      { op: "CREATE_GROUP", id: "pricing", label: "Pricing", children: ["hub"], kind: "mindmap" },
    ]);

  it.each(regionKinds())("retargets a region to %s", async (kind) => {
    const target = kind === "architecture" ? "architecture" : getRepresentation(kind).label;
    const ws = regionBoard();
    const { operations } = await ask(ws, `Change the pricing section to a ${target}`);
    expect(operations).toEqual([{ op: "SET_GROUP_KIND", id: "pricing", kind }]);
    expect(validateOperations(ws, operations)).toEqual([]);
  });

  it("turn … into works as well as change … to", async () => {
    const { operations } = await ask(
      regionBoard(),
      "Turn the pricing section into a state machine",
    );
    expect(operations).toEqual([{ op: "SET_GROUP_KIND", id: "pricing", kind: "statemachine" }]);
  });

  it("refuses to make a region of a whole-board-only family", async () => {
    const { operations, explanation } = await ask(
      regionBoard(),
      "Change the pricing section to a timeline",
    );
    expect(operations).toEqual([]);
    expect(explanation).toMatch(/whole board/);
  });

  it("converts the whole board when the request names no region", async () => {
    const ws = contentBoard("timeline");
    const { operations } = await ask(ws, "turn this into a timeline");
    expect(operations).toEqual([{ op: "TRANSFORM_DIAGRAM", to: "timeline" }]);
    expect(validateOperations(ws, operations)).toEqual([]);
  });

  it("does not read a family named mid-sentence as a conversion target", async () => {
    const ws = contentBoard("flowchart");
    const { operations } = await ask(ws, "change the label to 'Order flow chart'");
    expect(operations.some((o) => o.op === "TRANSFORM_DIAGRAM")).toBe(false);
  });
});
