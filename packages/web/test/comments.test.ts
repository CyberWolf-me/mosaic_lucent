import { describe, it, expect } from "vitest";
import { applyOperations, createWorkspace, type Operation } from "@lucent/core";
import {
  ME,
  addCommentOps,
  commentAnchorLabel,
  commentThreads,
  deleteCommentOps,
  knownMentionNames,
  mentionSegments,
  openThreadCount,
  replyCommentOps,
  resolveCommentOps,
} from "../src/board/comments.js";

/**
 * The web layer owns id minting, empty-input guards, and mention rendering.
 * Mentions are rendered as segments, never as HTML, so a comment body cannot
 * inject markup.
 */

function board() {
  return applyOperations(createWorkspace(), [
    { op: "CREATE_NODE", id: "n1", nodeType: "service", label: "Checkout" },
    {
      op: "CREATE_SHAPE",
      id: "s1",
      kind: "sticky",
      position: { x: 0, y: 0 },
      size: { width: 150, height: 110 },
      text: "Payment idea\nsecond line",
    },
  ]);
}

const apply = (ws: ReturnType<typeof board>, ops: Operation[]) => applyOperations(ws, ops);

describe("addCommentOps", () => {
  it("creates a thread anchored to the target", () => {
    const ws = apply(board(), addCommentOps("n1", "Is this async?"));
    const threads = commentThreads(ws, "n1");
    expect(threads).toHaveLength(1);
    expect(threads[0]?.root.body).toBe("Is this async?");
    expect(threads[0]?.root.by).toBe(ME);
  });

  it("trims the body and ignores an empty one", () => {
    expect(addCommentOps("n1", "   ")).toEqual([]);
    const ws = apply(board(), addCommentOps("n1", "  spaced  "));
    expect(commentThreads(ws, "n1")[0]?.root.body).toBe("spaced");
  });

  it("mints unique ids across comments", () => {
    let ws = board();
    ws = apply(ws, addCommentOps("n1", "one"));
    ws = apply(ws, addCommentOps("n1", "two"));
    expect(Object.keys(ws.comments)).toHaveLength(2);
  });
});

describe("replyCommentOps", () => {
  it("attaches a reply to its thread", () => {
    let ws = apply(board(), addCommentOps("n1", "root"));
    const rootId = commentThreads(ws, "n1")[0]!.root.id;
    ws = apply(ws, replyCommentOps(rootId, "reply"));
    expect(commentThreads(ws, "n1")[0]?.replies.map((r) => r.body)).toEqual(["reply"]);
  });

  it("ignores an empty reply", () => {
    expect(replyCommentOps("c1", "  ")).toEqual([]);
  });
});

describe("resolve and delete", () => {
  it("resolves and reopens a thread", () => {
    let ws = apply(board(), addCommentOps("n1", "fix"));
    const id = commentThreads(ws, "n1")[0]!.root.id;
    ws = apply(ws, resolveCommentOps(id, true));
    expect(openThreadCount(ws)).toBe(0);
    ws = apply(ws, resolveCommentOps(id, false));
    expect(openThreadCount(ws)).toBe(1);
  });

  it("deletes a thread", () => {
    let ws = apply(board(), addCommentOps("n1", "fix"));
    const id = commentThreads(ws, "n1")[0]!.root.id;
    ws = apply(ws, deleteCommentOps(id));
    expect(commentThreads(ws, "n1")).toEqual([]);
  });
});

describe("openThreadCount", () => {
  it("counts unresolved threads across the whole board", () => {
    let ws = board();
    ws = apply(ws, addCommentOps("n1", "a"));
    ws = apply(ws, addCommentOps("s1", "b"));
    expect(openThreadCount(ws)).toBe(2);
    expect(openThreadCount(createWorkspace())).toBe(0);
  });
});

describe("mentionSegments", () => {
  it("splits a body into text and mention segments", () => {
    expect(mentionSegments("hey @ana look")).toEqual([
      { text: "hey ", mention: false },
      { text: "@ana", mention: true },
      { text: " look", mention: false },
    ]);
  });

  it("handles a body that is only a mention", () => {
    expect(mentionSegments("@ana")).toEqual([{ text: "@ana", mention: true }]);
  });

  it("handles a body with no mentions", () => {
    expect(mentionSegments("plain text")).toEqual([{ text: "plain text", mention: false }]);
  });

  it("handles several mentions in a row", () => {
    const segs = mentionSegments("@ana @bo done");
    expect(segs.filter((s) => s.mention).map((s) => s.text)).toEqual(["@ana", "@bo"]);
  });

  it("keeps markup as inert text rather than a rendered tag", () => {
    // Segments are rendered as React text nodes, so this can never become HTML.
    const segs = mentionSegments("<b>bold</b> @ana");
    expect(segs[0]?.text).toContain("<b>");
    expect(segs.some((s) => s.mention)).toBe(true);
  });

  it("reassembles into the original body", () => {
    const body = "cc @ana and @bo.smith about the @thing";
    expect(
      mentionSegments(body)
        .map((s) => s.text)
        .join(""),
    ).toBe(body);
  });
});

describe("labels and known names", () => {
  it("resolves a node label and a sticky's first line", () => {
    expect(commentAnchorLabel(board(), "n1")).toBe("Checkout");
    expect(commentAnchorLabel(board(), "s1")).toBe("Payment idea");
  });

  it("falls back to the id for an unknown target", () => {
    expect(commentAnchorLabel(board(), "mystery")).toBe("mystery");
  });

  it("collects mention names already used on the board", () => {
    let ws = board();
    ws = apply(ws, addCommentOps("n1", "cc @ana"));
    ws = apply(ws, addCommentOps("s1", "cc @bo and @ana"));
    expect(knownMentionNames(ws)).toEqual(["ana", "bo"]);
  });
});
