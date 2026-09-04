import { describe, expect, it } from "vitest";
import { applyOperations, createWorkspace, inverseOperations, type Operation } from "@lucent/core";
import {
  inboxItems,
  intelligenceSections,
  isSettled,
  KIND_GLYPH,
  mergeOps,
  mergePreview,
  suppressionKey,
  topicGroups,
} from "../src/intelligence.js";

/**
 * The Intelligence projection (Stage C6, ADR 0026). Pure, node-tested per the
 * web suite's convention — the view only renders what these functions
 * decide. The spec: Intelligence is a projection of the current semantic
 * workspace; it does not create new truth, mutate state without approval,
 * or replace History as the source for temporal analysis.
 */

function boardOf(ops: Operation[]) {
  return applyOperations(createWorkspace(), ops);
}

function statement(
  id: string,
  kind: Operation extends never ? never : any,
  fields: { status?: string; topic?: string; supersedes?: string[]; assignee?: string; meetingId?: string; turnRange?: [number, number] },
) {
  const ops: Operation[] = [{ op: "CREATE_NODE", id, nodeType: kind, label: id.replace(/-/g, " ") }];
  ops.push({
    op: "SET_STATEMENT",
    id,
    statement: {
      kind,
      status: (fields.status ?? "open") as any,
      ...(fields.topic ? { topic: fields.topic } : {}),
      ...(fields.supersedes?.length ? { supersedes: fields.supersedes } : {}),
      ...(fields.meetingId ? { provenance: { meetingId: fields.meetingId, ...(fields.turnRange ? { turnRange: fields.turnRange } : {}) } } : {}),
    },
  });
  if (fields.assignee) {
    ops.push({
      op: "SET_ISSUE",
      id,
      issue: {
        type: "task",
        status: "To Do",
        statusCategory: "todo",
        assignee: fields.assignee,
      },
    } as Operation);
  }
  return ops;
}

function fullBoard() {
  return boardOf([
    ...statement("launch-decision", "decision", { status: "resolved", topic: "launch", meetingId: "mtg_mon" }),
    ...statement("pricing-decision", "decision", { topic: "pricing", meetingId: "mtg_wed", turnRange: [2, 2] }),
    ...statement("university-proposal", "proposal", { topic: "targeting" }),
    ...statement("billing-question", "question", { topic: "pricing" }),
    ...statement("launch-brief", "action", { topic: "launch", assignee: "sarah", meetingId: "mtg_wed" }),
    ...statement("sso-requirement", "requirement", { status: "resolved", topic: "auth" }),
    ...statement("appstore-risk", "risk", { topic: "launch" }),
    ...statement("old-pricing", "decision", { status: "superseded", topic: "pricing", supersedes: [] }),
    ...statement("pricing-model-risk", "risk", { topic: "pricing-model" }),
  ]);
}

describe("intelligenceSections — the six-kind projection", () => {
  it("renders all six sections in the fixed order, open first, settled after", () => {
    const sections = intelligenceSections(fullBoard());
    expect(sections.map((s) => s.kind)).toEqual([
      "decision",
      "proposal",
      "question",
      "action",
      "requirement",
      "risk",
    ]);
    // Decision section: the open pricing-decision FIRST, the resolved
    // launch-decision and superseded old-pricing after (visible, dimmed).
    const decisions = sections[0]!;
    expect(decisions.rows.map((r) => r.id)).toEqual([
      "pricing-decision",
      "launch-decision",
      "old-pricing",
    ]);
    expect(decisions.rows[0]!.status).toBe("open");
    expect(decisions.rows[2]!.status).toBe("superseded");
  });

  it("counts per section are the row counts", () => {
    const sections = intelligenceSections(fullBoard());
    expect(sections.map((s) => s.rows.length)).toEqual([3, 1, 1, 1, 1, 2]);
  });

  it("rows carry their authored topic, supersedes, assignee bridge, and provenance", () => {
    const sections = intelligenceSections(fullBoard());
    const launchBrief = sections.find((s) => s.kind === "action")!.rows[0]!;
    expect(launchBrief.topic).toBe("launch");
    expect(launchBrief.assignee).toBe("sarah"); // the Board bridge, visible
    expect(launchBrief.provenance).toEqual({ meetingId: "mtg_wed" });
    const pricingDecision = sections[0]!.rows[0]!;
    expect(pricingDecision.provenance).toEqual({ meetingId: "mtg_wed", turnRange: [2, 2] });
  });

  it("a node without a statement never appears; a statement without provenance renders without ✦", () => {
    const ws = boardOf([
      { op: "CREATE_NODE", id: "plain", nodeType: "step", label: "Plain" },
      ...statement("bare", "risk", {}),
    ]);
    const sections = intelligenceSections(ws);
    const risks = sections.find((s) => s.kind === "risk")!;
    expect(risks.rows.map((r) => r.id)).toEqual(["bare"]);
    expect(risks.rows[0]!.provenance).toBeUndefined();
  });
});

describe("topicGroups — C5's equivalence, reused", () => {
  it("groups variant spellings under one header, authored keys as-authored", () => {
    const sections = intelligenceSections(fullBoard());
    const risks = sections.find((s) => s.kind === "risk")!.rows;
    const groups = topicGroups(risks);
    // appstore-risk (launch) and pricing-model-risk (pricing-model) are
    // distinct subjects — two groups; the pricing-model variant groups with
    // nothing here because the section has no pricing sibling.
    const headers = groups.map((g) => g.key);
    expect(headers).toContain("launch");
    expect(headers).toContain("pricing-model");
  });

  it("statements sharing a topic across sections group by identity", () => {
    const sections = intelligenceSections(fullBoard());
    const decisions = sections[0]!.rows;
    const groups = topicGroups(decisions);
    // pricing-decision, old-pricing (both 'pricing') + launch-decision
    // ('launch') — and the risk side's 'pricing-model' is NOT in this
    // section, so the groups here are pricing + launch.
    const pricing = groups.find((g) => g.key === "pricing")!;
    expect(pricing.authored).toEqual(["pricing"]);
    expect(pricing.rows.map((r) => r.id).sort()).toEqual(["old-pricing", "pricing-decision"]);
  });

  it("rows without a topic group last under (none)", () => {
    const groups = topicGroups([
      { kind: "question", id: "q1", label: "Q", status: "open" },
    ] as never);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.key).toBe("(none)");
    expect(groups[0]!.rows).toHaveLength(1);
  });
});

describe("the recommendation inbox", () => {
  it("surfaces the variant authored pair with evidence", () => {
    const items = inboxItems(fullBoard());
    expect(items).toHaveLength(1);
    const item = items[0]!;
    // 'pricing' (3 statements) beside 'pricing-model' (1) — the pair the
    // C5 detector finds, projected with its evidence.
    expect(item.dup).toBe("pricing-model");
    expect(item.existing).toBe("pricing");
    expect(item.dupStatements).toBe(1);
    expect(item.existingStatements).toBe(3);
    // Evidence: the pricing statements' meetings of origin — pricing-decision
    // from mtg_wed; the others carry no meeting provenance. (launch-decision
    // IS from mtg_mon but is the 'launch' topic, not this pair.)
    expect(item.meetings).toEqual(["mtg_wed"]);
  });

  it("the suppression key changes when either side changes", () => {
    const items = inboxItems(fullBoard());
    const key = suppressionKey(items[0]!);
    // Same pair, changed counts → a new question.
    const changed: typeof items[0] extends never ? never : ReturnType<typeof inboxItems>[0] = {
      ...items[0]!,
      dupStatements: 2,
    };
    expect(suppressionKey(changed)).not.toBe(key);
    expect(suppressionKey(items[0]!)).toBe(key);
  });

  it("a unified board produces no inbox items", () => {
    const ws = boardOf([...statement("d1", "decision", { topic: "pricing" })]);
    expect(inboxItems(ws)).toEqual([]);
  });

  it("mergePreview lists exactly the dup-side nodes; mergeOps is the same list as UPDATE_STATEMENT ops", () => {
    const items = inboxItems(fullBoard());
    const item = items[0]!;
    const preview = mergePreview(fullBoard(), item);
    // The preview and the ops derive from the same workspace — they cannot
    // disagree. The dup side is only pricing-model-risk here.
    expect(preview.changes).toEqual([
      { nodeId: "pricing-model-risk", from: "pricing-model", to: "pricing" },
    ]);
    expect(preview.statementCount).toBe(1);
    expect(mergeOps(item, fullBoard())).toEqual([
      { op: "UPDATE_STATEMENT", id: "pricing-model-risk", topic: "pricing" },
    ]);
  });

  it("a merged board recomputes to an empty inbox — the loop closes", () => {
    const items = inboxItems(fullBoard());
    const ops = mergeOps(items[0]!, fullBoard());
    const merged = applyOperations(fullBoard(), ops);
    expect(inboxItems(merged)).toEqual([]);
    // And the merge is undoable — the same inverse machinery any human
    // edit rides (the C5/C6 contract: same validator, same undo, same history).
    const inverse = inverseOperations(ops, fullBoard());
    const undone = applyOperations(merged, inverse);
    expect(inboxItems(undone).length).toBe(1);
  });
});

describe("presentation constants", () => {
  it("every kind has a glyph; settled is any non-open status", () => {
    expect(Object.keys(KIND_GLYPH).sort()).toEqual([
      "action",
      "decision",
      "proposal",
      "question",
      "requirement",
      "risk",
    ]);
    expect(isSettled("open")).toBe(false);
    expect(isSettled("resolved")).toBe(true);
    expect(isSettled("rejected")).toBe(true);
    expect(isSettled("superseded")).toBe(true);
  });
});
