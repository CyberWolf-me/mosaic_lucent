import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { MockImageProvider } from "@lucent/ai";
import type { GenerateRequest, GenerateResult, LLMProvider } from "@lucent/ai";
import { applyOperations, createWorkspace } from "@lucent/core";
import type { Operation, Workspace } from "@lucent/core";
import { createApp } from "../src/app.js";
import { InMemoryUserStore } from "../src/accounts.js";
import { InMemoryBoardStore } from "../src/boards.js";
import { InMemorySessionStore } from "../src/sessions.js";
import { UsageTracker, limitsFromEnv } from "../src/usage.js";
import { Telemetry } from "../src/telemetry.js";
import { Limiter } from "../src/limiter.js";
import { InMemoryTicketStore } from "../src/realtimeTicket.js";
import { readConfig } from "../src/config.js";
import { InMemoryMeetingStore } from "../src/meetings.js";

/**
 * The web never sends a top-level `boardId` — it names its board in
 * `run.boardId` (for run-tracking). This proves workspace memory still reaches
 * that path (docs/23 Phase 1): the digest is built server-side from the STORED
 * board the run names, so it rides the model request even though the client
 * summary is empty and the generation is "advisory".
 */

const SECRET = "test-secret-at-least-16-chars";
const EMPTY_SUMMARY = { diagramKind: "flowchart", nodes: [], edges: [] };

/** A provider that records the request it was handed and applies nothing. */
function capturingProvider(): { provider: LLMProvider; seen: { request?: GenerateRequest } } {
  const seen: { request?: GenerateRequest } = {};
  const provider = {
    name: "capture",
    async generateOperations(request: GenerateRequest): Promise<GenerateResult> {
      seen.request = request;
      return { operations: [] };
    },
    async generateAnswer() {
      throw new Error("not used");
    },
    async generateExternalPlan() {
      throw new Error("not used");
    },
  } as unknown as LLMProvider;
  return { provider, seen };
}

function decisionWorkspace(): Workspace {
  const ops: Operation[] = [
    { op: "CREATE_NODE", id: "oauth", nodeType: "decision", label: "Use OAuth for login" },
    { op: "SET_STATEMENT", id: "oauth", statement: { kind: "decision", status: "resolved" } },
  ];
  return applyOperations(createWorkspace(), ops);
}

interface Harness {
  close: () => Promise<void>;
  seen: { request?: GenerateRequest };
  base: string;
  api: (
    path: string,
    init?: RequestInit & { token?: string },
  ) => Promise<{ status: number; body: any }>;
  signup: (email: string) => Promise<{ token: string; id: string }>;
  save: (token: string, name: string, workspace: Workspace) => Promise<string>;
}

async function harness(): Promise<Harness> {
  const limits = limitsFromEnv();
  const config = { ...readConfig({ LUCENT_REQUIRE_AUTH: "1" }), requireAuth: true };
  const { provider, seen } = capturingProvider();
  const { server, close } = createApp({
    config,
    provider,
    imageProvider: new MockImageProvider(),
    userStore: new InMemoryUserStore(),
    boardStore: new InMemoryBoardStore(),
    secret: SECRET,
    usage: new UsageTracker(limits),
    limits,
    telemetry: new Telemetry(),
    authLimiter: new Limiter(1000, 60_000),
    tickets: new InMemoryTicketStore(60_000),
    sessionStore: new InMemorySessionStore(),
    meetings: new InMemoryMeetingStore(),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  const api: Harness["api"] = async (path, init = {}) => {
    const { token, ...rest } = init;
    const headers: Record<string, string> = {};
    if (token) headers.authorization = `Bearer ${token}`;
    if (rest.body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(`${base}${path}`, { ...rest, headers });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  const signup: Harness["signup"] = async (email) => {
    const { status, body } = await api("/api/auth/signup", {
      method: "POST",
      body: JSON.stringify({ email, password: "password123", name: email.split("@")[0] }),
    });
    expect(status).toBe(201);
    return { token: body.token, id: body.user.id };
  };
  const save: Harness["save"] = async (token, name, workspace) => {
    const { status, body } = await api("/api/boards", {
      method: "POST",
      token,
      body: JSON.stringify({ name, workspace }),
    });
    expect(status).toBe(201);
    return body.id as string;
  };
  return { close, seen, base, api, signup, save };
}

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

describe("workspace memory on the advisory web path (run.boardId)", () => {
  it("builds the digest from the stored board the run names, with no top-level boardId", async () => {
    h = await harness();
    const { token } = await h.signup("web@example.com");
    const boardId = await h.save(token, "Checkout", decisionWorkspace());

    // Exactly what the web sends: an (empty) summary + run.boardId, NO top-level
    // boardId. Memory must still arrive — from the stored board, not the summary.
    const { status } = await h.api("/api/generate", {
      method: "POST",
      token,
      body: JSON.stringify({
        message: "add the login step",
        summary: EMPTY_SUMMARY,
        run: { boardId, surface: "canvas" },
      }),
    });
    expect(status).toBe(200);
    expect(h.seen.request?.memory).toBeDefined();
    expect(h.seen.request?.memory).toContain("Settled decisions");
    expect(h.seen.request?.memory).toContain("Use OAuth for login");
  });

  it("sends no memory when the run names no board", async () => {
    h = await harness();
    const { token } = await h.signup("web2@example.com");
    const { status } = await h.api("/api/generate", {
      method: "POST",
      token,
      body: JSON.stringify({ message: "draw something", summary: EMPTY_SUMMARY }),
    });
    expect(status).toBe(200);
    expect(h.seen.request?.memory).toBeUndefined();
  });

  // Phase 2: the meeting/voice extraction loop runs through the SAME call with
  // run.surface="meeting" and run.boardId set — so it inherits memory with no
  // extra wiring. This exercises the STREAM route the extraction actually uses.
  it("reaches the streaming route the meeting extraction uses", async () => {
    h = await harness();
    const { token } = await h.signup("meeting@example.com");
    const boardId = await h.save(token, "Checkout", decisionWorkspace());

    const res = await fetch(`${h.base}/api/generate/stream`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        message: "capture the decision",
        summary: EMPTY_SUMMARY,
        run: { boardId, surface: "meeting" },
      }),
    });
    expect(res.status).toBe(200);
    await res.text(); // drain the SSE so the handler runs to completion
    expect(h.seen.request?.memory).toContain("Use OAuth for login");
  });
});
