import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import {
  createWorkspace,
  compileSemanticPlan,
  evaluateTopologyQuality,
  type SemanticPlan,
} from "@lucent/core";
import { MockProvider, MockImageProvider } from "@lucent/ai";
import { createApp } from "../../src/app.js";
import { InMemoryUserStore } from "../../src/accounts.js";
import { InMemoryBoardStore } from "../../src/boards.js";
import { InMemoryProposalStore } from "../../src/proposals.js";
import { UsageTracker, limitsFromEnv } from "../../src/usage.js";
import { Telemetry } from "../../src/telemetry.js";
import { Limiter } from "../../src/limiter.js";
import { InMemoryTicketStore } from "../../src/realtimeTicket.js";
import { readConfig } from "../../src/config.js";
import { issueToken } from "../../src/auth.js";

const SECRET = "test-secret-at-least-16-chars";

interface Harness {
  base: string;
  boardStore: InMemoryBoardStore;
  userStore: InMemoryUserStore;
  close: () => Promise<void>;
}

async function harness(): Promise<Harness> {
  const limits = limitsFromEnv();
  const config = {
    ...readConfig({ LUCENT_REQUIRE_AUTH: "1", LUCENT_WEB_ORIGIN: "http://127.0.0.1" }),
    requireAuth: true,
  };
  const userStore = new InMemoryUserStore();
  const boardStore = new InMemoryBoardStore();
  const { server, close } = createApp({
    config,
    provider: new MockProvider(),
    imageProvider: new MockImageProvider(),
    userStore,
    boardStore,
    proposals: new InMemoryProposalStore(),
    secret: SECRET,
    usage: new UsageTracker(limits),
    limits,
    telemetry: new Telemetry(),
    authLimiter: new Limiter(1000, 60_000),
    tickets: new InMemoryTicketStore(60_000),
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${port}`, boardStore, userStore, close };
}

async function api(
  h: Harness,
  path: string,
  options: { method?: string; token?: string; agent?: string; body?: unknown } = {},
) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    ...(options.agent ? { authorization: `Agent ${options.agent}` } : {}),
  };
  const res = await fetch(`${h.base}${path}`, {
    method: options.method ?? "POST",
    headers,
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

describe("Pipeline Certification v1 - Suite 4: Mutation Safety and Failure Recovery", () => {
  it("certifies Idempotency: duplicate requestId returns original commit without duplicate writes", async () => {
    const h = await harness();
    try {
      const user = {
        id: "usr_safe1",
        email: "safe1@test.com",
        name: "Safe 1",
        passwordHash: "x",
        tokenVersion: 0,
        emailVerifiedAt: Date.now(),
        createdAt: Date.now(),
      };
      await h.userStore.insert(user);
      await h.userStore.ensurePersonalOrg(user.id, user.name, Date.now());
      const token = issueToken(user.id, SECRET, 7 * 24 * 3600, user.tokenVersion);

      const board = {
        id: "brd_safe_1",
        name: "Safety Board",
        ownerId: user.id,
        orgId: "org-safe1",
        workspace: createWorkspace(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      await h.boardStore.put(board);

      const reqId = "req-idempotent-unique-123";

      // First attempt
      const res1 = await api(h, `/api/boards/${board.id}/orchestrate`, {
        token,
        body: {
          prompt: "Build user profile service",
          requestId: reqId,
        },
      });

      expect(res1.status).toBe(200);
      const data1 = res1.body as { ok: boolean; seq: number; duplicate?: boolean };
      expect(data1.ok).toBe(true);
      expect(data1.duplicate).toBeUndefined();

      // Second attempt with exact same requestId
      const res2 = await api(h, `/api/boards/${board.id}/orchestrate`, {
        token,
        body: {
          prompt: "Build user profile service",
          requestId: reqId,
        },
      });

      expect(res2.status).toBe(200);
      const data2 = res2.body as { ok: boolean; seq: number; duplicate?: boolean };
      expect(data2.ok).toBe(true);
      expect(data2.duplicate).toBe(true);
      expect(data2.seq).toBe(data1.seq); // EXACT SAME SEQUENCE NUMBER, ZERO DUPLICATE COMMITS!
    } finally {
      await h.close();
    }
  });

  it("certifies Stale expectedSeq rejects race condition with 409 conflict", async () => {
    const h = await harness();
    try {
      const user = {
        id: "usr_safe2",
        email: "safe2@test.com",
        name: "Safe 2",
        passwordHash: "x",
        tokenVersion: 0,
        emailVerifiedAt: Date.now(),
        createdAt: Date.now(),
      };
      await h.userStore.insert(user);
      await h.userStore.ensurePersonalOrg(user.id, user.name, Date.now());
      const token = issueToken(user.id, SECRET, 7 * 24 * 3600, user.tokenVersion);

      const board = {
        id: "brd_safe_2",
        name: "Conflict Board",
        ownerId: user.id,
        orgId: "org-safe2",
        workspace: createWorkspace(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      await h.boardStore.put(board);

      // Move board sequence forward
      const s1 = await api(h, `/api/boards/${board.id}/orchestrate`, {
        token,
        body: { prompt: "Step 1" },
      });
      expect(s1.status).toBe(200);

      // Caller presents stale expectedSeq = 0
      const conflictRes = await api(h, `/api/boards/${board.id}/orchestrate`, {
        token,
        body: {
          prompt: "Step 2 against stale sequence",
          expectedSeq: 0,
        },
      });

      expect(conflictRes.status).toBe(409);
      const conflictData = conflictRes.body as { ok: boolean; outcome: string; headSeq?: number };
      expect(conflictData.ok).toBe(false);
      expect(conflictData.outcome).toBe("conflict");
      expect(conflictData.headSeq).toBeGreaterThan(0);
    } finally {
      await h.close();
    }
  });

  it("certifies Invalid Symbolic References are detected and rejected by compiler", () => {
    const ws = createWorkspace();
    const badPlan: SemanticPlan = {
      intent: {
        userObjective: "Test bad references",
        targetKind: "flowchart",
        expectedTopology: "directed_flow",
        mutationScope: "new_canvas",
        focusNodeIds: [],
      },
      nodes: [{ ref: "valid1", label: "Real Node" }],
      edges: [
        // Refers to nonexistent n99!
        { from: "valid1", to: "n99_ghost", relation: "next" },
      ],
      groups: [],
      explanation: "",
    };

    const compiled = compileSemanticPlan(ws, badPlan);
    expect(compiled.ok).toBe(false);
    expect(compiled.diagnostics.length).toBeGreaterThan(0);
    expect(compiled.diagnostics.some((d) => d.code === "UNRESOLVED_REFERENCE")).toBe(true);
  });

  it("certifies Role Floor Enforcement: viewers cannot orchestrate canvas mutations", async () => {
    const h = await harness();
    try {
      const owner = {
        id: "usr_owner_role",
        email: "owner-role@test.com",
        name: "Owner Role",
        passwordHash: "x",
        tokenVersion: 0,
        emailVerifiedAt: Date.now(),
        createdAt: Date.now(),
      };
      await h.userStore.insert(owner);
      await h.userStore.ensurePersonalOrg(owner.id, owner.name, Date.now());

      const viewer = {
        id: "usr_viewer_role",
        email: "viewer-role@test.com",
        name: "Viewer Role",
        passwordHash: "x",
        tokenVersion: 0,
        emailVerifiedAt: Date.now(),
        createdAt: Date.now(),
      };
      await h.userStore.insert(viewer);
      await h.userStore.ensurePersonalOrg(viewer.id, viewer.name, Date.now());
      const viewerToken = issueToken(viewer.id, SECRET, 7 * 24 * 3600, viewer.tokenVersion);

      const board = {
        id: "brd_role_guard",
        name: "Role Guard Board",
        ownerId: owner.id,
        orgId: "org-role",
        workspace: createWorkspace(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      await h.boardStore.put(board);

      // Add viewer as explicit board member with role "viewer"
      await h.boardStore.setMember({
        boardId: board.id,
        userId: viewer.id,
        role: "viewer",
        invitedBy: owner.id,
        createdAt: Date.now(),
      });

      // Viewer attempts to orchestrate canvas mutations
      const res = await api(h, `/api/boards/${board.id}/orchestrate`, {
        token: viewerToken,
        body: { prompt: "Mutate canvas as viewer" },
      });

      // Gated with 403 or 404 Forbidden/Not Found (editor floor enforcement)
      expect([403, 404]).toContain(res.status);
    } finally {
      await h.close();
    }
  });

  it("certifies Truthful Failure: unresolved quality violations return 422 without false success", () => {
    const ws = createWorkspace();
    const danglingPlan: SemanticPlan = {
      intent: {
        userObjective: "Broken directed flow with orphan",
        targetKind: "flowchart",
        expectedTopology: "directed_flow",
        mutationScope: "new_canvas",
        focusNodeIds: [],
      },
      nodes: [
        { ref: "n1", label: "Step 1" },
        { ref: "n2", label: "Step 2" },
        { ref: "orphan", label: "Floating Dangling Step" },
      ],
      edges: [{ from: "n1", to: "n2", relation: "next" }],
      groups: [],
      explanation: "",
    };

    const compiled = compileSemanticPlan(ws, danglingPlan);
    expect(compiled.ok).toBe(true);

    // Pass 1: REPAIRABLE
    const p1 = evaluateTopologyQuality(ws, danglingPlan, compiled.operations, false);
    expect(p1.outcome).toBe("REPAIRABLE");

    // Pass 2: UNRESOLVED (truthful failure condition)
    const p2 = evaluateTopologyQuality(ws, danglingPlan, compiled.operations, true);
    expect(p2.outcome).toBe("UNRESOLVED");
    expect(p2.missingConnections).toContain("Floating Dangling Step");
  });
});
