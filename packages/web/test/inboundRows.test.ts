import { describe, expect, it } from "vitest";
import {
  inboundChangeText,
  inboundRowActions,
  inboundRowIsWarning,
  pendingInboundCount,
} from "../src/views/inboundRows.js";
import type { InboundChangeView } from "../src/boards.js";

/** A minimal row factory — the tests fill only what each rule reads. */
function row(overrides: Partial<InboundChangeView>): InboundChangeView {
  return {
    id: "inb_1",
    provider: "linear",
    nodeId: "nd_1",
    nodeLabel: "Node",
    externalId: "LIN-1",
    field: "status",
    externalValue: "Done",
    mappedValue: "completed",
    status: "pending",
    source: "webhook",
    detectedAt: 1,
    boardValue: "open",
    resolved: false,
    ...overrides,
  };
}

describe("inboundRowActions — the two stage rules", () => {
  it("a translated pending row offers both Accept and Keep-ours", () => {
    expect(inboundRowActions(row({}))).toEqual({ canAccept: true, canDismiss: true });
  });

  it("THE NEVER-GUESSES RULE: a warning row (mappedValue null) is dismiss-only — Accept must not exist", () => {
    const warning = row({ externalValue: "In QA", mappedValue: null });
    expect(inboundRowIsWarning(warning)).toBe(true);
    expect(inboundRowActions(warning)).toEqual({ canAccept: false, canDismiss: true });
  });

  it("a decided row offers nothing", () => {
    for (const status of ["applied", "dismissed", "superseded"] as const) {
      expect(inboundRowActions(row({ status }))).toEqual({ canAccept: false, canDismiss: false });
    }
  });
});

describe("pendingInboundCount", () => {
  it("counts only pending rows", () => {
    const rows = [
      row({ id: "a" }),
      row({ id: "b", status: "applied" }),
      row({ id: "c" }),
      row({ id: "d", status: "dismissed" }),
    ];
    expect(pendingInboundCount(rows)).toBe(2);
  });
});

describe("inboundChangeText — what a change says (docs/26 A5)", () => {
  const change = (field: "status" | "assignee" | "dueDate", ext: string, mapped: string | null) =>
    inboundChangeText({ provider: "Linear", field, externalValue: ext, mappedValue: mapped });
  it("names the status, the owner and the date — and a cleared one", () => {
    expect(change("status", "In Progress", "in_progress")).toBe(
      "Linear says “In Progress” — mark it in progress",
    );
    expect(change("status", "In QA", null)).toBe("Linear says “In QA” — no matching status here");
    expect(change("assignee", "Bo", "Bo")).toBe("Linear gives it to Bo");
    expect(change("assignee", "", "")).toBe("Linear unassigned it");
    expect(change("dueDate", "2026-10-09", "2026-10-09")).toBe(
      "Linear moved its due date to 2026-10-09",
    );
    expect(change("dueDate", "", "")).toBe("Linear cleared its due date");
    expect(change("dueDate", "next sprint", null)).toContain("not a date Lucent can read");
  });
});
