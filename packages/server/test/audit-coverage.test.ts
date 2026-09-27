import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { MockImageProvider, MockProvider } from "@lucent/ai";
import { createWorkspace } from "@lucent/core";
import { createApp } from "../src/app.js";
import { InMemoryUserStore } from "../src/accounts.js";
import { InMemoryBoardStore } from "../src/boards.js";
import { InMemoryOrgStore } from "../src/orgs.js";
import { InMemoryOrgInviteStore } from "../src/invites.js";
import { InMemoryProposalStore } from "../src/proposals.js";
import { InMemorySessionStore } from "../src/sessions.js";
import { UsageTracker, limitsFromEnv } from "../src/usage.js";
import { Telemetry } from "../src/telemetry.js";
import { Limiter } from "../src/limiter.js";
import { InMemoryTicketStore } from "../src/realtimeTicket.js";
import { readConfig } from "../src/config.js";
import {
  InMemoryIntegrationActionStore,
  InMemoryIntegrationStore,
} from "../src/integrations/integrations.js";
import { InMemoryExecutionLedger } from "../src/integrations/ledger.js";
import { FakeProvider } from "../src/integrations/fake.js";
import type { MailMessage } from "../src/email/mailer.js";

/**
 * docs/26 F9: invites, role changes, share links, proposal decisions and
 * integration connects changed who could see or change an org's work
 * without leaving a line in its audit log. Each is driven through the real
 * routes here and must appear in GET /api/orgs/:id/audit, by the right actor,
 * with what changed. Emails end in ".test" so sharing needs no verification.
 */

const SECRET = "test-secret-at-least-16-chars";

async function harness() {
  const limits = limitsFromEnv();
  const mail: MailMessage[] = [];
  const { server, close } = createApp({
    config: readConfig({ LUCENT_REQUIRE_AUTH: "1" }),
    provider: new MockProvider(),
    imageProvider: new MockImageProvider(),
    userStore: new InMemoryUserStore(),
    boardStore: new InMemoryBoardStore(),
    orgStore: new InMemoryOrgStore(),
    inviteStore: new InMemoryOrgInviteStore(),
    proposals: new InMemoryProposalStore(),
    sessionStore: new InMemorySessionStore(),
    secret: SECRET,
    usage: new UsageTracker(limits),
    limits,
    telemetry: new Telemetry(),
    authLimiter: new Limiter(1000, 60_000),
    tickets: new InMemoryTicketStore(60_000),
    mailer: { send: async (m: MailMessage) => void mail.push(m) },
    integrations: {
      store: new InMemoryIntegrationStore(),
      providers: new Map([["fake", () => new FakeProvider()]]),
      actions: new InMemoryIntegrationActionStore(),
      ledger: new InMemoryExecutionLedger(),
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  const api = async (
    path: string,
    token: string,
    init: { method?: string; body?: unknown } = {},
  ) => {
    const res = await fetch(`${base}${path}`, {
      method: init.method ?? "GET",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : {} };
  };
  const signup = async (email: string) => {
    const res = await fetch(`${base}/api/auth/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "password123", name: email.split("@")[0] }),
    });
    const body = (await res.json()) as { token: string; user: { id: string } };
    return { token: body.token, id: body.user.id };
  };
  return { close, api, signup, mail };
}

type Entry = { action: string; actorId: string | null; metadata?: Record<string, unknown> };

describe("access changes are audited (docs/26 F9)", () => {
  let h: Awaited<ReturnType<typeof harness>> | undefined;
  afterEach(async () => {
    if (h) await h.close();
    h = undefined;
  });

  it("share links, joins, member changes, proposals, invites and integrations each leave a row", async () => {
    h = await harness();
    const owner = await h.signup("owner@audit.test");
    const guest = await h.signup("guest@audit.test");
    const orgId = `org_personal_${owner.id}`;

    const board = await h.api("/api/boards", owner.token, {
      method: "POST",
      body: { name: "Audited", workspace: createWorkspace() },
    });
    expect(board.status).toBe(201);
    const b = `/api/boards/${board.body.id as string}`;

    // Share link → join → role change → removal → revoke.
    const link = await h.api(`${b}/share`, owner.token, {
      method: "POST",
      body: { role: "commenter" },
    });
    expect(link.status).toBe(201);
    expect(
      (await h.api(`${b}/join`, guest.token, { method: "POST", body: { token: link.body.token } }))
        .status,
    ).toBe(200);
    expect(
      (
        await h.api(`${b}/members/${guest.id}`, owner.token, {
          method: "PATCH",
          body: { role: "editor" },
        })
      ).status,
    ).toBe(200);
    expect(
      (await h.api(`${b}/members/${guest.id}`, owner.token, { method: "DELETE" })).status,
    ).toBe(200);
    expect((await h.api(`${b}/share`, owner.token, { method: "DELETE" })).body.revoked).toBe(1);

    // A proposal approved, another rejected.
    const p1 = await h.api(`${b}/proposals`, owner.token, {
      method: "POST",
      body: {
        operations: [{ op: "CREATE_NODE", id: "n1", nodeType: "step", label: "One" }],
        request: "r",
      },
    });
    expect(
      (
        await h.api(`${b}/proposals/${p1.body.proposal.id}/approve`, owner.token, {
          method: "POST",
        })
      ).status,
    ).toBe(200);
    const p2 = await h.api(`${b}/proposals`, owner.token, {
      method: "POST",
      body: {
        operations: [{ op: "CREATE_NODE", id: "n2", nodeType: "step", label: "Two" }],
        request: "r",
      },
    });
    expect(
      (await h.api(`${b}/proposals/${p2.body.proposal.id}/reject`, owner.token, { method: "POST" }))
        .status,
    ).toBe(200);

    // An org invite created and accepted; another created and revoked.
    const invited = await h.signup("ed@audit.test");
    expect(
      (
        await h.api(`/api/orgs/${orgId}/invites`, owner.token, {
          method: "POST",
          body: { email: "ed@audit.test", role: "editor" },
        })
      ).status,
    ).toBe(204);
    const inviteMail = h.mail.find(
      (m) => m.to === "ed@audit.test" && /invite\?token=/.test(m.text),
    );
    const inviteToken = inviteMail?.text.match(/invite\?token=([\w-]+)/)?.[1];
    expect(inviteToken).toBeTruthy();
    expect(
      (
        await h.api("/api/invites/accept", invited.token, {
          method: "POST",
          body: { token: inviteToken },
        })
      ).status,
    ).toBe(200);
    await h.api(`/api/orgs/${orgId}/invites`, owner.token, {
      method: "POST",
      body: { email: "later@audit.test", role: "viewer" },
    });
    const pending = await h.api(`/api/orgs/${orgId}/invites`, owner.token);
    const laterId = (pending.body.invites as Array<{ id: string; email: string }>).find(
      (i) => i.email === "later@audit.test",
    )?.id;
    expect(laterId).toBeTruthy();
    expect(
      (await h.api(`/api/orgs/${orgId}/invites/${laterId}`, owner.token, { method: "DELETE" }))
        .status,
    ).toBe(204);

    // An integration connected and disconnected.
    expect(
      (
        await h.api(`/api/orgs/${orgId}/integrations/fake`, owner.token, {
          method: "PUT",
          body: { credentialRef: "R" },
        })
      ).status,
    ).toBe(201);
    expect(
      (await h.api(`/api/orgs/${orgId}/integrations/fake`, owner.token, { method: "DELETE" }))
        .status,
    ).toBe(200);

    const log = await h.api(`/api/orgs/${orgId}/audit?limit=100`, owner.token);
    expect(log.status).toBe(200);
    const entries = log.body.entries as Entry[];
    const find = (action: string) => entries.find((e) => e.action === action);

    expect(find("board.share_link.created")?.metadata).toMatchObject({ role: "commenter" });
    expect(find("board.share_link.created")?.metadata?.tokenPrefix).toHaveLength(6);
    expect(find("board.member.joined_via_link")).toMatchObject({
      actorId: guest.id,
      metadata: { role: "commenter" },
    });
    expect(find("board.member.role_changed")?.metadata).toMatchObject({
      userId: guest.id,
      from: "commenter",
      to: "editor",
    });
    expect(find("board.member.removed")?.metadata).toMatchObject({
      userId: guest.id,
      role: "editor",
    });
    expect(find("board.share_link.revoked")?.metadata).toMatchObject({ revoked: 1, scope: "all" });
    expect(find("board.proposal.approved")?.metadata).toMatchObject({ operations: 1, applied: 1 });
    expect(find("board.proposal.rejected")?.metadata).toMatchObject({ operations: 1 });
    // Newest first: two invites were created, so pick by who was invited.
    const invites = entries.filter((e) => e.action === "org.invite.created");
    expect(invites.map((e) => e.metadata)).toEqual(
      expect.arrayContaining([
        { email: "ed@audit.test", role: "editor" },
        { email: "later@audit.test", role: "viewer" },
      ]),
    );
    expect(find("org.member.joined_via_invite")).toMatchObject({
      actorId: invited.id,
      metadata: { role: "editor" },
    });
    expect(find("org.invite.revoked")).toBeDefined();
    expect(find("integration.connected")?.metadata).toMatchObject({ provider: "fake" });
    expect(find("integration.disconnected")?.metadata).toMatchObject({ provider: "fake" });
    // A capability never lands in the log whole.
    expect(JSON.stringify(entries)).not.toContain(link.body.token as string);
  });
});
