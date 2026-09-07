import { describe, it, expect } from "vitest";
import { applyOperations, createWorkspace } from "@lucent/core";
import type { Workspace } from "@lucent/core";
import { summarizeWorkspace, type LLMProvider } from "@lucent/ai";
import { InMemoryBoardStore, emptyWorkspace, newBoardId } from "../src/boards.js";
import { handleGenerate } from "../src/generate.js";

/**
 * Authoritative validation (Step 2). Until boards live server-side, validation
 * runs against whatever state the client reports — advisory only. With a stored
 * board the server validates against real state and can genuinely reject an
 * operation referencing something that no longer exists.
 */

async function storedBoard(workspace: Workspace) {
  const store = new InMemoryBoardStore();
  const board = {
    id: newBoardId(),
    orgId: "org_test",
    ownerId: "usr_1",
    name: "Test",
    workspace,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await store.put(board);
  return { store, board };
}

describe("InMemoryBoardStore", () => {
  it("round-trips a board", async () => {
    const store = new InMemoryBoardStore();
    const board = {
      id: newBoardId(),
      orgId: "org_a",
      ownerId: "u1",
      name: "N",
      workspace: createWorkspace(),
      createdAt: 1,
      updatedAt: 2,
    };
    await store.put(board);
    expect((await store.get(board.id))?.name).toBe("N");
    expect(await store.listForOrg("org_a")).toHaveLength(1);
    expect(await store.listForOrg("org_b")).toHaveLength(0);
    await store.delete(board.id);
    expect(await store.get(board.id)).toBeUndefined();
  });

  it("creates a valid empty workspace", () => {
    expect(emptyWorkspace("X").nodes).toEqual({});
    expect(emptyWorkspace("X").name).toBe("X");
  });

  it("round-trips the op log", async () => {
    const store = new InMemoryBoardStore();
    const board = {
      id: "brd_x",
      orgId: "org_a",
      ownerId: "u",
      name: "n",
      workspace: createWorkspace(),
      createdAt: 0,
      updatedAt: 0,
    };
    await store.put(board);
    await store.appendOp({
      boardId: "brd_x",
      ops: [{ op: "CREATE_NODE", id: "a", nodeType: "step", label: "A" }],
      by: "u",
      label: "x",
      at: 1,
    });
    await store.appendOp({
      boardId: "brd_x",
      ops: [{ op: "CHANGE_TEXT", id: "a", text: "A!" }],
      by: "u",
      label: "y",
      at: 2,
    });
    const log = await store.loadLog("brd_x");
    expect(log.map((e) => e.seq)).toEqual([1, 2]);
    expect((log[1]?.ops[0] as { text?: string }).text).toBe("A!");
  });
});

describe("authoritative validation", () => {
  it("validates against the stored board when one is supplied", async () => {
    // Stored state has checkout → pay. The client's summary claims neither
    // exists; the model output references `pay`, which is real on the server.
    const ws = applyOperations(createWorkspace(), [
      { op: "CREATE_NODE", id: "checkout", nodeType: "screen", label: "Checkout" },
      { op: "CREATE_NODE", id: "pay", nodeType: "service", label: "Payment" },
      { op: "CONNECT_NODES", source: "checkout", target: "pay", relationship: "calls" },
    ]);
    const { store, board } = await storedBoard(ws);

    const provider: LLMProvider = {
      name: "fixed",
      async generateOperations() {
        return { operations: [{ op: "CHANGE_TEXT", id: "pay", text: "Stripe" }] };
      },
      // Stage C1: answering is not under test here; reaching it would be a bug.
      async generateAnswer() {
        throw new Error("fixed provider cannot answer questions");
      },
      // Stage D9 made generateExternalPlan part of the interface; the
      // selector is not under test here.
      async generateExternalPlan() {
        throw new Error("this stub cannot select external actions");
      },
    };
    // The summary lies (says the board is empty), but the stored board wins.
    const result = await handleGenerate(
      provider,
      {
        message: "rename payment",
        summary: summarizeWorkspace(createWorkspace()),
        boardId: board.id,
      },
      "usr_1",
      { boardId: board.id, store },
    );
    expect(result.status).toBe(200);
    expect((result.body as { operations: unknown[] }).operations.length).toBe(1);
  });

  it("rejects an operation that is invalid against real stored state", async () => {
    // Stored state does NOT contain `ghost`. The client's summary falsely claims it.
    const ws = applyOperations(createWorkspace(), [
      { op: "CREATE_NODE", id: "real", nodeType: "step", label: "Real" },
    ]);
    const { store, board } = await storedBoard(ws);

    const provider: LLMProvider = {
      name: "fixed",
      async generateOperations() {
        return {
          operations: [{ op: "CHANGE_TEXT", id: "ghost", text: "nope" }],
        };
      },
      // Stage C1: answering is not under test here; reaching it would be a bug.
      async generateAnswer() {
        throw new Error("fixed provider cannot answer questions");
      },
      // Stage D9 made generateExternalPlan part of the interface; the
      // selector is not under test here.
      async generateExternalPlan() {
        throw new Error("this stub cannot select external actions");
      },
    };
    const result = await handleGenerate(
      provider,
      {
        message: "edit ghost",
        summary: summarizeWorkspace(
          applyOperations(createWorkspace(), [
            { op: "CREATE_NODE", id: "ghost", nodeType: "step", label: "Ghost" },
          ]),
        ),
        boardId: board.id,
      },
      "usr_1",
      { boardId: board.id, store },
    );
    // Advisory validation (summary-only) would accept this. Authority rejects it.
    expect(result.status).toBe(422);
  });

  it("persists merged state so later requests see earlier changes", async () => {
    const ws = applyOperations(createWorkspace(), [
      { op: "CREATE_NODE", id: "a", nodeType: "step", label: "A" },
    ]);
    const { store, board } = await storedBoard(ws);

    const providerFor = (op: import("@lucent/core").Operation) => ({
      name: "fixed",
      async generateOperations() {
        return { operations: [op] };
      },
      // Stage C1: answering is not under test here; reaching it would be a bug.
      async generateAnswer() {
        throw new Error("fixed provider cannot answer questions");
      },
      // Stage D9 made generateExternalPlan part of the interface; the
      // selector is not under test here.
      async generateExternalPlan() {
        throw new Error("this stub cannot select external actions");
      },
    });

    await handleGenerate(
      providerFor({ op: "CREATE_NODE", id: "b", nodeType: "step", label: "B" }),
      { message: "add b", summary: summarizeWorkspace(ws), boardId: board.id },
      "usr_1",
      { boardId: board.id, store },
    );

    // Second request sees the stored board including node b — proving the merge persisted.
    const second = await handleGenerate(
      providerFor({ op: "CONNECT_NODES", source: "a", target: "b", relationship: "next" }),
      { message: "connect", summary: summarizeWorkspace(ws), boardId: board.id },
      "usr_1",
      { boardId: board.id, store },
    );
    expect(second.status).toBe(200);
    expect((second.body as { boardVersion?: number }).boardVersion).toBeDefined();

    const updated = (await store.get(board.id))!;
    expect(Object.keys(updated.workspace.nodes).sort()).toEqual(["a", "b"]);
    expect(Object.keys(updated.workspace.edges)).toHaveLength(1);
  });

  it("falls back to advisory (summary) validation without a stored board", async () => {
    const provider: LLMProvider = {
      name: "fixed",
      async generateOperations() {
        return { operations: [{ op: "CHANGE_TEXT", id: "only-in-summary", text: "x" }] };
      },
      // Stage C1: answering is not under test here; reaching it would be a bug.
      async generateAnswer() {
        throw new Error("fixed provider cannot answer questions");
      },
      // Stage D9 made generateExternalPlan part of the interface; the
      // selector is not under test here.
      async generateExternalPlan() {
        throw new Error("this stub cannot select external actions");
      },
    };
    const result = await handleGenerate(
      provider,
      {
        message: "edit",
        summary: summarizeWorkspace(
          applyOperations(createWorkspace(), [
            { op: "CREATE_NODE", id: "only-in-summary", nodeType: "step", label: "S" },
          ]),
        ),
      },
      "usr_1",
    );
    expect(result.status).toBe(200);
  });

  it("ignores a boardId owned by someone else rather than leaking their state", async () => {
    const ws = applyOperations(createWorkspace(), [
      { op: "CREATE_NODE", id: "secret", nodeType: "step", label: "Secret" },
    ]);
    const { store, board } = await storedBoard(ws);

    // The model tries to edit the secret node; the requester doesn't own the board.
    const provider: LLMProvider = {
      name: "fixed",
      async generateOperations() {
        return { operations: [{ op: "CHANGE_TEXT", id: "secret", text: "stolen" }] };
      },
      // Stage C1: answering is not under test here; reaching it would be a bug.
      async generateAnswer() {
        throw new Error("fixed provider cannot answer questions");
      },
      // Stage D9 made generateExternalPlan part of the interface; the
      // selector is not under test here.
      async generateExternalPlan() {
        throw new Error("this stub cannot select external actions");
      },
    };
    const summaryWithGhost = summarizeWorkspace(
      applyOperations(createWorkspace(), [
        { op: "CREATE_NODE", id: "secret", nodeType: "step", label: "Ghost claim" },
      ]),
    );
    const result = await handleGenerate(
      provider,
      { message: "steal", summary: summaryWithGhost, boardId: board.id },
      "usr_attacker",
      { boardId: board.id, store },
    );
    // Not authoritative for them: falls back to their own (false) summary, which
    // happens to validate — but crucially the stored board was never touched.
    expect((await store.get(board.id))!.workspace.nodes.secret?.label).toBe("Secret");
    void result;
  });
});
