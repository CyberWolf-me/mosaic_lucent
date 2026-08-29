import { describe, it, expect } from "vitest";
import {
  InMemoryAccountDeletionStore,
  InMemorySessionStore,
  InMemoryUserStore,
  DELETE_GRACE_MS,
  handleAccountExport,
  handleCancelDeletion,
  handleScheduleDeletion,
  handleSignup,
  handleUpdateProfile,
  runScheduledDeletions,
  type AuthContext,
} from "../src/accounts.js";
import { InMemoryBoardStore } from "../src/boards.js";
import { createWorkspace } from "@lucent/core";

/**
 * Account lifecycle (M1.7):
 *   - PATCH /api/auth/profile updates the name and returns the new public user.
 *   - GET /api/account/export returns the user + memberships + owned boards.
 *   - POST /api/account/delete schedules a 7-day deletion and revokes sessions.
 *   - POST /api/account/delete/cancel clears the pending deletion.
 *   - runScheduledDeletions wipes matured entries on boot.
 */

const SECRET = "test-secret-at-least-16-chars";

interface Harness {
  ctx: AuthContext;
  userStore: InMemoryUserStore;
  boardStore: InMemoryBoardStore;
  cookie: string;
}

async function harness(): Promise<Harness> {
  const userStore = new InMemoryUserStore();
  const boardStore = new InMemoryBoardStore();
  const sessions = new InMemorySessionStore();
  const deletionStore = new InMemoryAccountDeletionStore();
  const ctx: AuthContext = {
    userStore,
    secret: SECRET,
    sessionStore: sessions,
    sessionCookie: {
      name: "lucent_session",
      cookieOptions: {
        httpOnly: true,
        sameSite: "Lax",
        secure: false,
        path: "/",
        maxAgeMs: 60_000,
      },
    },
    deletionStore,
  };
  const signup = await handleSignup(ctx, {
    email: "u@example.com",
    password: "password123",
    name: "U",
  });
  const cookie = (signup.headers?.["set-cookie"] ?? "").split(";")[0] ?? "";
  return { ctx, userStore, boardStore, cookie };
}

describe("M1.7 profile", () => {
  it("updates the user's name", async () => {
    const h = await harness();
    const result = await handleUpdateProfile(h.ctx, { name: "Updated Name" }, h.cookie, null);
    expect(result.status).toBe(200);
    expect((result.body as { user: { name: string } }).user.name).toBe("Updated Name");
    // The store row reflects the change.
    const after = await h.userStore.findByEmail("u@example.com");
    expect(after?.name).toBe("Updated Name");
  });

  it("rejects an empty or over-long name", async () => {
    const h = await harness();
    expect((await handleUpdateProfile(h.ctx, { name: "" }, h.cookie, null)).status).toBe(400);
    expect(
      (await handleUpdateProfile(h.ctx, { name: "x".repeat(101) }, h.cookie, null)).status,
    ).toBe(400);
  });

  it("requires an authenticated session", async () => {
    const h = await harness();
    expect((await handleUpdateProfile(h.ctx, { name: "Nope" }, null, null)).status).toBe(401);
  });
});

describe("M1.7 account export", () => {
  it("returns the public user, memberships, and owned boards", async () => {
    const h = await harness();
    // Add a board to the store so the export surfaces it.
    await h.boardStore.put({
      id: "brd_test",
      orgId: "org_test",
      ownerId: (await h.userStore.findByEmail("u@example.com"))!.id,
      name: "Test Board",
      workspace: createWorkspace(),
      createdAt: 1,
      updatedAt: 2,
    });
    const result = await handleAccountExport(
      h.ctx,
      async (_userId) => {
        const boards = await h.boardStore.listForOrg("org_test");
        return boards.map((b) => ({
          id: b.id,
          name: b.name,
          workspace: b.workspace,
          createdAt: b.createdAt,
          updatedAt: b.updatedAt,
        }));
      },
      h.cookie,
      null,
    );
    expect(result.status).toBe(200);
    const body = result.body as {
      user: { id: string };
      memberships: unknown[];
      boards: Array<{ id: string }>;
    };
    expect(body.user.id).toBeTruthy();
    expect(body.memberships.length).toBeGreaterThan(0);
    expect(body.boards.map((b) => b.id)).toContain("brd_test");
  });
});

describe("M1.7 deletion scheduling", () => {
  it("schedules a deletion 7 days out and returns executesAt", async () => {
    const h = await harness();
    const before = Date.now();
    const result = await handleScheduleDeletion(h.ctx, h.cookie, null);
    expect(result.status).toBe(200);
    const body = result.body as { executesAt: number; graceMs: number };
    expect(body.graceMs).toBe(DELETE_GRACE_MS);
    expect(body.executesAt).toBeGreaterThanOrEqual(before + DELETE_GRACE_MS - 1000);
  });

  it("revokes every session at scheduling time so the account can't be used during the grace window", async () => {
    const h = await harness();
    // Mint a second session for the same user.
    const user = (await h.userStore.findByEmail("u@example.com"))!;
    const sessions = h.ctx.sessionStore as InMemorySessionStore;
    const second = await sessions.create({
      userId: user.id,
      tokenVersion: user.tokenVersion,
      now: Date.now(),
    });
    expect(second).toBeDefined();

    await handleScheduleDeletion(h.ctx, h.cookie, null);
    // The pre-grace cookie should no longer authenticate.
    const verify = await h.ctx.sessionStore!.find(h.cookie.split("=")[1] ?? "", Date.now());
    // The session was revoked by the schedule handler's revokeAllForUser.
    expect(verify).toBeUndefined();
    expect(await h.ctx.sessionStore!.find(second!.id, Date.now())).toBeUndefined();
  });

  it("cancelling clears the deletion", async () => {
    const h = await harness();
    // Schedule revokes every session; to cancel the user has to re-authenticate.
    const scheduled = await handleScheduleDeletion(h.ctx, h.cookie, null);
    expect(scheduled.status).toBe(200);
    // The original cookie is now dead; a fresh login re-issues a bearer.
    const fresh = await import("../src/accounts.js").then((m) =>
      m.handleLogin(h.ctx, { email: "u@example.com", password: "password123" }),
    );
    expect(fresh.status).toBe(200);
    const bearer = (fresh.body as { token: string }).token;
    const cancel = await handleCancelDeletion(h.ctx, null, bearer);
    expect(cancel.status).toBe(200);
    const userId = (await h.userStore.findByEmail("u@example.com"))!.id;
    const after = await h.ctx.deletionStore!.find(userId);
    expect(after?.cancelledAt).not.toBeNull();
  });
});

describe("M1.7 deletion execution", () => {
  it("runScheduledDeletions wipes users whose grace has expired", async () => {
    const h = await harness();
    const userId = (await h.userStore.findByEmail("u@example.com"))!.id;
    // Schedule a deletion that matured yesterday.
    await h.ctx.deletionStore!.schedule(
      userId,
      Date.now() - 8 * 24 * 60 * 60 * 1000,
      Date.now() - 60_000,
    );
    const wiped = await runScheduledDeletions(h.ctx);
    expect(wiped).toContain(userId);
    const after = await h.userStore.findById(userId);
    expect(after).toBeUndefined();
    // The row in the deletion store is also removed.
    expect(await h.ctx.deletionStore!.find(userId)).toBeUndefined();
  });

  it("scheduled-but-not-yet-matured users are not wiped", async () => {
    const h = await harness();
    const userId = (await h.userStore.findByEmail("u@example.com"))!.id;
    await h.ctx.deletionStore!.schedule(userId, Date.now(), Date.now() + 60_000);
    const wiped = await runScheduledDeletions(h.ctx);
    expect(wiped).toEqual([]);
    expect(await h.userStore.findById(userId)).toBeDefined();
  });

  it("cancelled deletions are skipped", async () => {
    const h = await harness();
    const userId = (await h.userStore.findByEmail("u@example.com"))!.id;
    await h.ctx.deletionStore!.schedule(userId, Date.now() - 60_000, Date.now() - 1000);
    await h.ctx.deletionStore!.cancel(userId, Date.now());
    const wiped = await runScheduledDeletions(h.ctx);
    expect(wiped).toEqual([]);
    expect(await h.userStore.findById(userId)).toBeDefined();
  });
});
