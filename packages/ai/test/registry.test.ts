import { describe, it, expect } from "vitest";
import { AI_OPERATION_NAMES, AI_FORBIDDEN_OPS, ALL_OPERATION_NAMES } from "@lucent/core";
import { getPrompt, listPrompts, loadPromptFile } from "../src/registry.js";
import {
  SYSTEM_PROMPT,
  SYSTEM_PROMPT_ID,
  SYSTEM_PROMPT_VERSION,
  SYSTEM_PROMPT_VOCABULARY,
} from "../src/prompt.js";

/**
 * The prompt registry (M5).
 *
 * Two things are under test, and they are not the same thing. One is that the
 * shipped prompt still says what it said as a template literal — the migration
 * was a move, not a rewrite. The other is that the load-time rules actually
 * reject: every guard in registry.ts exists because of a way prompt data could
 * silently lie about what the model may do, and a guard that only the valid
 * shipped file exercises has never been tested at all. So the hostile files are
 * built here rather than committed as fixtures.
 */

/** A minimal file that passes, for tests that break exactly one thing. */
function validFile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "test-prompt",
    version: 1,
    description: "A prompt used only by the registry tests.",
    vocabulary: { base: "ai-permitted" },
    body: ["Emit only these operations:", "{{operations}}"],
    ...overrides,
  };
}

describe("registry: the shipped visual-agent prompt", () => {
  const entry = getPrompt("visual-agent");

  it("is what prompt.ts exports", () => {
    expect(entry.systemPrompt).toBe(SYSTEM_PROMPT);
    expect(SYSTEM_PROMPT_ID).toBe("visual-agent");
    expect(SYSTEM_PROMPT_VERSION).toBe(entry.version);
    expect(SYSTEM_PROMPT_VOCABULARY).toEqual(AI_OPERATION_NAMES);
  });

  it("resolves the operations placeholder and leaves no other", () => {
    expect(entry.systemPrompt).not.toContain("{{");
    expect(entry.systemPrompt).toContain(AI_OPERATION_NAMES.join(", "));
  });

  it("never advertises the human-only operations", () => {
    // MOVE_NODE carries coordinates, and the prompt telling the model it may
    // emit one is the drift the derived vocabulary exists to prevent. The check
    // is on the operations *list*, not the whole text: the prose elsewhere may
    // legitimately name MOVE_NODE to explain that a human owns it.
    const advertised = entry.systemPrompt
      .slice(entry.systemPrompt.indexOf(AI_OPERATION_NAMES[0]!))
      .split("\n")[0]!
      .split(", ");
    for (const forbidden of AI_FORBIDDEN_OPS) {
      expect(advertised).not.toContain(forbidden);
    }
    expect(advertised).toEqual([...AI_OPERATION_NAMES]);
    expect(advertised.length).toBe(ALL_OPERATION_NAMES.length - AI_FORBIDDEN_OPS.length);
  });

  it("still carries the clauses the template literal carried", () => {
    // Not a snapshot of the whole text: a snapshot would make every future
    // wording change a test edit, which is the friction this milestone removed.
    // These are the load-bearing sentences — the tool name the providers rely on,
    // the coordinate rule, and the trust boundary the envelopes depend on.
    expect(entry.systemPrompt).toContain("apply_canvas_operations");
    expect(entry.systemPrompt).toContain("never assign coordinates");
    expect(entry.systemPrompt).toContain("DATA, not instruction");
    expect(entry.systemPrompt).toContain("<untrusted-document>");
  });

  it("is rendered once, not per call", () => {
    // Callers hold the string in a request path; re-rendering per lookup would
    // make the cache key (cache.ts) hash a fresh allocation every time.
    expect(getPrompt("visual-agent")).toBe(entry);
    expect(listPrompts()).toContainEqual(entry);
  });

  it("is frozen, so a caller cannot edit the prompt at runtime", () => {
    expect(Object.isFrozen(entry)).toBe(true);
    expect(Object.isFrozen(entry.vocabulary)).toBe(true);
  });
});

describe("registry: vocabulary narrows and never widens", () => {
  it("keeps core's declaration order, not the order written in the file", () => {
    const entry = loadPromptFile(
      validFile({ vocabulary: { base: "ai-permitted", only: ["CONNECT_NODES", "CREATE_NODE"] } }),
    );
    expect(entry.vocabulary).toEqual(["CREATE_NODE", "CONNECT_NODES"]);
    expect(entry.systemPrompt).toContain("CREATE_NODE, CONNECT_NODES");
  });

  it("drops the names in `without`", () => {
    const entry = loadPromptFile(
      validFile({ vocabulary: { base: "ai-permitted", without: ["DELETE_NODE", "DELETE_SHAPE"] } }),
    );
    expect(entry.vocabulary).not.toContain("DELETE_NODE");
    expect(entry.vocabulary).not.toContain("DELETE_SHAPE");
    expect(entry.vocabulary.length).toBe(AI_OPERATION_NAMES.length - 2);
  });

  it("rejects a name that is not in the AI-permitted set", () => {
    // The widening attempt, in the only form the schema even allows someone to
    // write it: naming an operation in `only` that the model may not emit.
    expect(() =>
      loadPromptFile(validFile({ vocabulary: { base: "ai-permitted", only: ["MOVE_NODE"] } })),
    ).toThrow(/MOVE_NODE/);
    expect(() =>
      loadPromptFile(
        validFile({ vocabulary: { base: "ai-permitted", only: ["CREATE_NODE", "DROP_DATABASE"] } }),
      ),
    ).toThrow(/DROP_DATABASE/);
  });

  it("rejects a `without` name that does not exist", () => {
    // Ignoring it would leave the prompt advertising an operation whoever wrote
    // the file believed they had removed — a typo that reads as a security
    // control.
    expect(() =>
      loadPromptFile(
        validFile({ vocabulary: { base: "ai-permitted", without: ["CREATE_NODES"] } }),
      ),
    ).toThrow(/CREATE_NODES/);
  });

  it("rejects a vocabulary that resolves to nothing", () => {
    expect(() =>
      loadPromptFile(
        validFile({ vocabulary: { base: "ai-permitted", without: [...AI_OPERATION_NAMES] } }),
      ),
    ).toThrow(/resolved to nothing/);
  });

  it("rejects a base other than core's AI-permitted set", () => {
    expect(() => loadPromptFile(validFile({ vocabulary: { base: "everything" } }))).toThrow(
      /invalid prompt file/,
    );
    expect(() => loadPromptFile(validFile({ vocabulary: {} }))).toThrow(/invalid prompt file/);
  });
});

describe("registry: load-time validation", () => {
  it("accepts the minimal valid file", () => {
    const entry = loadPromptFile(validFile());
    expect(entry.id).toBe("test-prompt");
    expect(entry.systemPrompt).toBe(
      `Emit only these operations:\n${AI_OPERATION_NAMES.join(", ")}`,
    );
  });

  it("rejects an id that is not stable and url-ish", () => {
    for (const id of ["Visual Agent", "visual_agent", "1-agent", "", "visual/agent"]) {
      expect(() => loadPromptFile(validFile({ id }))).toThrow(/invalid prompt file/);
    }
  });

  it("rejects a version that cannot be compared", () => {
    for (const version of [0, -1, 1.5, "1", null]) {
      expect(() => loadPromptFile(validFile({ version }))).toThrow(/invalid prompt file/);
    }
  });

  it("rejects a body that never names its vocabulary", () => {
    expect(() => loadPromptFile(validFile({ body: ["Do whatever you think is best."] }))).toThrow(
      /never uses \{\{operations\}\}/,
    );
  });

  it("rejects an unresolved placeholder", () => {
    // A typo'd or forgotten placeholder would otherwise be sent to the model as
    // literal `{{tone}}`, which reads as either an instruction or a bug.
    expect(() =>
      loadPromptFile(validFile({ body: ["{{operations}}", "Speak in a {{tone}} voice."] })),
    ).toThrow(/unresolved placeholder \{\{tone\}\}/);
  });

  it("rejects an empty or malformed body and a missing description", () => {
    expect(() => loadPromptFile(validFile({ body: [] }))).toThrow(/invalid prompt file/);
    expect(() => loadPromptFile(validFile({ body: "a string" }))).toThrow(/invalid prompt file/);
    expect(() => loadPromptFile(validFile({ description: "" }))).toThrow(/invalid prompt file/);
  });

  it("rejects anything that is not a prompt file at all", () => {
    for (const raw of [null, undefined, 42, "prompt", [], { id: "x" }]) {
      expect(() => loadPromptFile(raw)).toThrow(/invalid prompt file/);
    }
  });

  it("names the offending prompt in every rejection", () => {
    // These errors surface at import time, so the message is the only debugging
    // aid a reader of a crashed startup log has.
    expect(() =>
      loadPromptFile(
        validFile({ id: "narrowed", vocabulary: { base: "ai-permitted", only: ["NOPE"] } }),
      ),
    ).toThrow(/prompt "narrowed"/);
  });

  it("joins the body with newlines and nothing else", () => {
    const entry = loadPromptFile(validFile({ body: ["one", "", "two {{operations}}"] }));
    expect(entry.systemPrompt.split("\n").length).toBe(3);
    expect(entry.systemPrompt.startsWith("one\n\ntwo ")).toBe(true);
  });
});
