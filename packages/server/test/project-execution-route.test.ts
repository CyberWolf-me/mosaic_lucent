import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { MockProvider, MockImageProvider } from "@lucent/ai";
import { applyOperations, createWorkspace, stampAuthorship, type Operation } from "@lucent/core";
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
 * The project dashboard over HTTP (docs/26 §8, A5): progress and blocker
 * stories across the project's boards — only the boards the caller can read,
 * with the meetings its stories cite named.
 */

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function start() {
  const limits = limitsFromEnv();
  const meetings = new InMemoryMeetingStore();
  const app = createApp({
    config: { ...readConfig({ LUCENT_REQUIRE_AUTH: "1" }), requireAuth: true },
    provider: new MockProvider(),
    imageProvider: new MockImageProvider(),
    userStore: new InMemoryUserStore(),
    boardStore: new InMemoryBoardStore(),
    secret: "test-secret-at-least-16-chars",
    usage: new UsageTracker(limits),
    limits,
    telemetry: new Telemetry(),
    authLimiter: new Limiter(1000, 60_000),
    tickets: new InMemoryTicketStore(60_000),
    sessionStore: new InMemorySessionStore(),
    meetings,
  });
  close = app.close;
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const api = async (path: string, init: RequestInit & { token?: string } = {}) => {
    const headers: Record<string, string> = {};
    if (init.token) headers.authorization = `Bearer ${init.token}`;
    if (init.body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(`${base}${path}`, { ...init, headers });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
  };
  const signup = async (email: string) => {
    const { body } = await api("/api/auth/signup", {
      method: "POST",
      body: JSON.stringify({ email, password: "password123", name: email.split("@")[0] }),
    });
    return {
      token: body.token as string,
      id: body.user.id as string,
      org: `org_personal_${body.user.id}`,
    };
  };
  return { api, signup, meetings };
}

describe("GET /api/orgs/:id/projects/:pid/execution", () => {
  it("tells a project's blockers as stories, naming the meeting behind each decision", async () => {
    const { api, signup, meetings } = await start();
    const owner = await signup("exec@example.com");
    const stranger = await signup("nobody@example.com");
    const created = await api("/api/boards", {
      method: "POST",
      token: owner.token,
      body: JSON.stringify({ name: "Plan", workspace: createWorkspace() }),
    });
    const boardId = created.body.id as string;
    const meeting = await meetings.insert({
      boardId,
      orgId: owner.org,
      startedAt: Date.UTC(2026, 8, 22),
      turns: [{ speaker: "Ada", at: Date.UTC(2026, 8, 22, 10), text: "We go annual." }],
      createdBy: owner.id,
      createdAt: 1,
      title: "Pricing review",
    });
    const ws = applyOperations(
      createWorkspace(),
      stampAuthorship(
        [
          {
            op: "CREATE_NODE",
            id: "annual",
            nodeType: "process",
            label: "Offer annual plans",
            provenance: { meetingId: meeting.id, turnRange: [0, 0] },
          },
          {
            op: "SET_STATEMENT",
            id: "annual",
            statement: { kind: "decision", status: "resolved" },
          },
          { op: "CREATE_NODE", id: "billing", nodeType: "process", label: "Change billing" },
          { op: "SET_STATEMENT", id: "billing", statement: { kind: "action", status: "open" } },
          {
            op: "SET_ISSUE",
            id: "billing",
            issue: { type: "task", status: "blocked", assignee: "Bo" },
          },
          { op: "CONNECT_NODES", source: "annual", target: "billing", relationship: "drives" },
        ] as Operation[],
        owner.id,
      ),
    );
    await api("/api/boards", {
      method: "POST",
      token: owner.token,
      body: JSON.stringify({ id: boardId, name: "Plan", workspace: ws }),
    });
    const project = await api(`/api/orgs/${owner.org}/projects`, {
      method: "POST",
      token: owner.token,
      body: JSON.stringify({ name: "Annual", boardIds: [boardId] }),
    });

    const dash = await api(`/api/orgs/${owner.org}/projects/${project.body.id}/execution`, {
      token: owner.token,
    });
    expect(dash.status).toBe(200);
    expect(dash.body.execution.rollup).toMatchObject({ total: 1, blocked: 1, percent: 0 });
    expect(dash.body.execution.blockers[0]).toMatchObject({
      boardName: "Plan",
      target: { id: "billing", owner: "Bo" },
      decisions: [{ id: "annual", evidence: { meetingId: meeting.id } }],
    });
    expect(dash.body.meetings[meeting.id]).toMatchObject({ title: "Pricing review", boardId });

    const theirs = await api(`/api/orgs/${owner.org}/projects/${project.body.id}/execution`, {
      token: stranger.token,
    });
    expect(theirs.status).toBe(404);
  });
});
