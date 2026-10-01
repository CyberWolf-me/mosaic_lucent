import { describe, it, expect } from "vitest";
import { applyOperations, createWorkspace } from "@lucent/core";
import type { Operation } from "@lucent/core";
import { buildCrossBoardMemory, buildMemoryDigest } from "../src/generateContext.js";

/**
 * The generation-side memory projection (docs/23 doctrine): a derived,
 * never-stored digest of what a board already established, so a follow-up
 * generation resolves references and supersedes instead of re-deciding.
 */

/** A board carrying a spread of statements, including a supersession chain. */
function memoryBoard() {
  const ops: Operation[] = [
    { op: "CREATE_NODE", id: "oauth", nodeType: "decision", label: "Use OAuth for login" },
    {
      op: "SET_STATEMENT",
      id: "oauth",
      statement: { kind: "decision", status: "resolved", topic: "authentication" },
    },
    { op: "CREATE_NODE", id: "sso-req", nodeType: "requirement", label: "Must support SSO" },
    {
      op: "SET_STATEMENT",
      id: "sso-req",
      statement: { kind: "requirement", status: "open", topic: "auth" },
    },
    { op: "CREATE_NODE", id: "pay-q", nodeType: "question", label: "Which payment provider?" },
    {
      op: "SET_STATEMENT",
      id: "pay-q",
      statement: { kind: "question", status: "open", topic: "billing" },
    },
    { op: "CREATE_NODE", id: "pci-risk", nodeType: "risk", label: "PCI compliance scope" },
    {
      op: "SET_STATEMENT",
      id: "pci-risk",
      statement: { kind: "risk", status: "open", topic: "billing" },
    },
    { op: "CREATE_NODE", id: "pw-old", nodeType: "decision", label: "Use passwords" },
    {
      op: "SET_STATEMENT",
      id: "pw-old",
      statement: { kind: "decision", status: "resolved", topic: "authentication" },
    },
    { op: "CREATE_NODE", id: "oauth-new", nodeType: "decision", label: "Move auth to OAuth" },
    {
      op: "SET_STATEMENT",
      id: "oauth-new",
      statement: {
        kind: "decision",
        status: "resolved",
        topic: "authentication",
        supersedes: ["pw-old"],
      },
    },
  ];
  return applyOperations(createWorkspace(), ops);
}

describe("buildMemoryDigest", () => {
  it("returns null for a board with no statements", () => {
    const ws = applyOperations(createWorkspace(), [
      { op: "CREATE_NODE", id: "a", nodeType: "step", label: "Just a step" },
    ]);
    expect(buildMemoryDigest(ws, "Empty")).toBeNull();
  });

  it("groups live statements by kind and status", () => {
    const digest = buildMemoryDigest(memoryBoard(), "Checkout")!;
    expect(digest).toContain('Project memory for "Checkout"');
    expect(digest).toContain("Settled decisions");
    expect(digest).toContain("Use OAuth for login");
    expect(digest).toContain("Move auth to OAuth");
    expect(digest).toContain("Requirements");
    expect(digest).toContain("Must support SSO");
    expect(digest).toContain("Open questions");
    expect(digest).toContain("Which payment provider?");
    expect(digest).toContain("Known risks");
    expect(digest).toContain("PCI compliance scope");
  });

  it("surfaces the supersession chain and keeps the superseded one out of 'settled'", () => {
    const digest = buildMemoryDigest(memoryBoard(), "Checkout")!;
    // The chain is rendered as evolution...
    expect(digest).toContain("How decisions changed");
    expect(digest).toMatch(/Move auth to OAuth \(oauth-new\) replaced: Use passwords \(pw-old\)/);
    // ...and the superseded decision is history, never listed as settled truth.
    const settled = digest.slice(
      digest.indexOf("Settled decisions"),
      digest.indexOf("Requirements"),
    );
    expect(settled).not.toContain("pw-old");
  });

  it("builds a topic glossary that merges morphological variants (auth ↔ authentication)", () => {
    const digest = buildMemoryDigest(memoryBoard(), "Checkout")!;
    expect(digest).toContain("Topics (resolve a named part of the project");
    // 'authentication' and 'auth' are variants — one group listing both ids.
    const topics = digest.slice(digest.indexOf("Topics"));
    expect(topics).toMatch(/oauth/);
    expect(topics).toContain("billing");
    expect(topics).toContain("pay-q");
  });
});

describe("buildCrossBoardMemory", () => {
  it("returns null when no sibling has statements", () => {
    expect(buildCrossBoardMemory([])).toBeNull();
    expect(buildCrossBoardMemory([{ boardName: "Billing", statements: [] }])).toBeNull();
  });

  it("groups surviving statements by board under a 'sibling boards' header", () => {
    const text = buildCrossBoardMemory([
      {
        boardName: "Billing",
        statements: [
          { kind: "decision", label: "Use Stripe", status: "resolved", topic: "pay", id: "S:s1" },
        ],
      },
    ])!;
    expect(text).toContain("From sibling boards in this project");
    expect(text).toContain("Billing:");
    expect(text).toContain("[decision] Use Stripe · pay (S:s1)");
  });

  it("caps the total statements rendered across boards", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      kind: "decision",
      label: `D${i}`,
      status: "resolved",
      id: `S:${i}`,
    }));
    const text = buildCrossBoardMemory([{ boardName: "Big", statements: many }])!;
    // CROSS_BOARD_LIMITS.perBoard caps a single board at 6 lines.
    expect(text.match(/\[decision\]/g)?.length).toBeLessThanOrEqual(6);
  });
});
