import { describe, expect, it } from "vitest";
import type { ExecutionStatus } from "@lucent/core";
import {
  JiraProvider,
  jiraConnectionFactory,
  validJiraProjectKey,
} from "../src/integrations/jira.js";
import { isSafeOutboundUrl } from "../src/integrations/outboundUrl.js";

/**
 * The Jira adapter's wire contract, asserted against a scripted REST v3
 * responder — never a live account. Pins the three D8 divergences exactly
 * where they live: Basic auth + the per-org site, ADF descriptions with
 * the marker in a text node, THE TRANSITIONS CONTRACT (status moves only
 * through a listed transition; 0/1/>1 each answer honestly), the
 * conservative mapStatus (custom statuses never guess), and the hardened
 * recovery. The SSRF policy (outboundUrl) is pinned beside it.
 */

function responder(
  route: (init: {
    method: string;
    path: string;
    body?: Record<string, unknown>;
  }) => Response | null,
) {
  const seen: Array<{
    method: string;
    path: string;
    body?: Record<string, unknown>;
    headers: Record<string, string>;
  }> = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(_url));
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : undefined;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k.toLowerCase()] = v));
    seen.push({ method, path: url.pathname + url.search, body, headers });
    const answer = route({ method, path: url.pathname, body });
    if (answer) return answer;
    return new Response(
      JSON.stringify({ errorMessages: [`no route for ${method} ${url.pathname}`] }),
      { status: 404 },
    );
  }) as typeof fetch;
  return { fetchImpl, seen };
}

function issueJson(
  over: Partial<{
    key: string;
    summary: string;
    status: string;
    accountId: string;
    duedate: string | null;
  }> = {},
): { key: string; fields: Record<string, unknown> } {
  return {
    key: over.key ?? "LAUNCH-482",
    fields: {
      summary: over.summary ?? "Issue",
      description: { type: "doc", version: 1, content: [] },
      status: { name: over.status ?? "To Do" },
      assignee: over.accountId
        ? {
            accountId: over.accountId,
            displayName: "Sarah Chen",
            emailAddress: "sarah@example.com",
          }
        : null,
      duedate: over.duedate ?? null,
    },
  };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status });
}

function provider(over: Partial<ConstructorParameters<typeof JiraProvider>[0]> = {}) {
  return new JiraProvider({
    email: "dev@example.com",
    apiToken: "token",
    site: "https://acme.atlassian.net",
    projectKey: "LAUNCH",
    maxAttempts: 1,
    timeoutMs: 2_000,
    recoverPollMs: [1, 1, 1],
    ...over,
  });
}

describe("the wire contract", () => {
  it("Basic auth + the per-org site; the create posts ADF with the marker and reads the key back", async () => {
    const { fetchImpl, seen } = responder(({ method, path }) => {
      if (method === "POST" && path === "/rest/api/3/issue") return json({ key: "LAUNCH-1" });
      // The read-back echoes the duedate the create sent (what Jira would
      // have stored), so the ExternalTask carries it.
      if (path === "/rest/api/3/issue/LAUNCH-1")
        return json(issueJson({ key: "LAUNCH-1", status: "To Do", duedate: "2026-09-20" }));
      return null;
    });
    const p = provider({ fetchImpl });
    const task = await p.createTask({
      title: "Prepare brief",
      dueDate: "2026-09-20",
      idempotencyKey: "ext_n1",
    });
    expect(task).toMatchObject({
      provider: "jira",
      externalId: "LAUNCH-1",
      status: "To Do",
      dueDate: "2026-09-20",
    });
    const create = seen[0]!;
    expect(create.headers["authorization"]).toBe(
      `Basic ${Buffer.from("dev@example.com:token").toString("base64")}`,
    );
    const fields = create.body!.fields as Record<string, unknown>;
    expect(fields.project).toEqual({ key: "LAUNCH" });
    expect(fields.issuetype).toEqual({ name: "Task" });
    // The ADF document carries the marker in a text node.
    const adfTexts = JSON.stringify(fields.description);
    expect(adfTexts).toContain("lucent-action:ext_n1");
    expect(fields.duedate).toBe("2026-09-20");
  });

  it("updateTask PUTs the fields, then moves status ONLY through the matching transition", async () => {
    const { fetchImpl, seen } = responder(({ method, path, body }) => {
      if (method === "PUT" && path === "/rest/api/3/issue/LAUNCH-1")
        return new Response(null, { status: 204 });
      if (path === "/rest/api/3/issue/LAUNCH-1/transitions") {
        if (method === "GET") {
          return json({
            transitions: [
              { id: "11", name: "Start", to: { name: "In Progress" } },
              { id: "31", name: "Finish", to: { name: "Done" } },
            ],
          });
        }
        // The POST: only the transition whose id was chosen.
        expect(body?.transition).toEqual({ id: "31" });
        return new Response(null, { status: 204 });
      }
      if (path === "/rest/api/3/issue/LAUNCH-1")
        return json(issueJson({ key: "LAUNCH-1", status: "Done" }));
      return null;
    });
    const p = provider({ fetchImpl });
    const task = await p.updateTask("LAUNCH-1", { title: "New title", status: "completed" });
    expect(task.status).toBe("Done");
    const put = seen.find((w) => w.method === "PUT" && !w.path.includes("transitions"))!;
    expect(put.body?.fields).toMatchObject({ summary: "New title" });
  });
});

describe("the transitions contract — 0/1/>1, never the first match", () => {
  it("no matching transition → the honest error naming the target", async () => {
    const { fetchImpl } = responder(({ method, path }) => {
      if (method === "PUT" && path === "/rest/api/3/issue/LAUNCH-1") {
        return new Response(null, { status: 204 });
      }
      if (path === "/rest/api/3/issue/LAUNCH-1/transitions") {
        return json({ transitions: [{ id: "11", to: { name: "In Progress" } }] });
      }
      return null;
    });
    const p = provider({ fetchImpl });
    await expect(p.updateTask("LAUNCH-1", { status: "completed" })).rejects.toThrow(
      /no transition to "Done" is available/,
    );
  });

  it("two transitions both landing on the target → the ambiguous failure, no guess", async () => {
    const { fetchImpl } = responder(({ method, path }) => {
      if (method === "PUT" && path === "/rest/api/3/issue/LAUNCH-1") {
        return new Response(null, { status: 204 });
      }
      if (path === "/rest/api/3/issue/LAUNCH-1/transitions") {
        return json({
          transitions: [
            { id: "31", to: { name: "Done" } },
            { id: "41", to: { name: "Done" } },
          ],
        });
      }
      return null;
    });
    const p = provider({ fetchImpl });
    await expect(p.updateTask("LAUNCH-1", { status: "completed" })).rejects.toThrow(
      /ambiguous transition: 2 candidates lead to "Done"/,
    );
  });
});

describe("mapStatus — conservative by design (the never-guesses showcase)", () => {
  const p = provider();
  it("translates the well-known defaults only", () => {
    const cases: Array<[string, ExecutionStatus | undefined]> = [
      ["To Do", "open"],
      ["Todo", "open"],
      ["Backlog", "open"],
      ["In Progress", "in_progress"],
      ["Done", "completed"],
      // Company-managed custom statuses — deliberately undefined.
      ["In QA", undefined],
      ["In Review", undefined],
      ["Awaiting Approval", undefined],
    ];
    for (const [word, want] of cases) expect(p.mapStatus(word)).toBe(want);
  });
  it("toExternalStatus covers the defaults; blocked/cancelled throw the honest error", () => {
    expect(p.toExternalStatus("open")).toBe("To Do");
    expect(p.toExternalStatus("in_progress")).toBe("In Progress");
    expect(p.toExternalStatus("completed")).toBe("Done");
    expect(() => p.toExternalStatus("blocked")).toThrow(/no well-known Jira counterpart/);
  });
  it("capabilityWarnings flags a status with no Jira counterpart BEFORE execution", () => {
    expect(p.capabilityWarnings!({ title: "T", status: "blocked" })).toEqual([
      { field: "status", reason: expect.stringContaining("blocked") },
    ]);
    expect(p.capabilityWarnings!({ title: "T", status: "completed" })).toEqual([]);
  });
});

describe("the assignee ladder — email > name > unique partial, resolving to accountId", () => {
  function ladder(
    users: Array<{ accountId: string; emailAddress?: string; displayName?: string }>,
  ) {
    const { fetchImpl, seen } = responder(({ path }) => {
      if (path === "/rest/api/3/user/assignable/search") return json(users);
      return null;
    });
    return { p: provider({ fetchImpl }), seen };
  }

  it("exact email wins; display name and unique partial resolve; ambiguous throws", async () => {
    const { p, seen } = ladder([
      { accountId: "a1", emailAddress: "sarah@example.com", displayName: "Sarah Chen" },
      { accountId: "a2", displayName: "Sarah Liu" },
    ]);
    expect(await p["resolveAssignee"]("sarah@example.com")).toMatchObject({ accountId: "a1" });
    expect(await p["resolveAssignee"]("Sarah Chen")).toMatchObject({ accountId: "a1" });
    expect(await p["resolveAssignee"]("Sarah Liu")).toMatchObject({ accountId: "a2" });
    // Ambiguous: "sarah" matches both.
    await expect(p["resolveAssignee"]("sarah")).rejects.toThrow(
      /uniquely resolve assignee "sarah"/,
    );
    // One search per instance.
    expect(seen.filter((c) => c.path.includes("assignable")).length).toBe(1);
    // Not-found returns null → the create/update omits the assignee quietly
    // (ADR 0034's ladder contract: unresolvable warns + omits, never a
    // failed item — same as GitHub's).
    expect(await p["resolveAssignee"]("ghost")).toBeNull();
  });
});

describe("recoverCreate — the hardened contract, JQL-scoped", () => {
  it("polls before not-found; 1 recovers; >1 fails honestly", async () => {
    let searches = 0;
    const sleeps: number[] = [];
    const { fetchImpl } = responder(({ path }) => {
      if (path === "/rest/api/3/search/jql") {
        searches += 1;
        if (searches === 1) return json({ issues: [] });
        if (searches === 2) return json({ issues: [issueJson({ key: "LAUNCH-9" })] });
        return json({ issues: [issueJson({ key: "LAUNCH-9" }), issueJson({ key: "LAUNCH-10" })] });
      }
      return null;
    });
    const p = provider({
      fetchImpl,
      recoverPollMs: [5],
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    const found = await p.recoverCreate("lucent-action:ext_n1");
    expect(found).toMatchObject({ externalId: "LAUNCH-9" });
    expect(sleeps).toEqual([5]);
    await expect(p.recoverCreate("lucent-action:ext_n1")).rejects.toThrow(/ambiguous recovery: 2/);
  });

  it("0 hits after the full budget → undefined; the JQL scopes to the project", async () => {
    const { fetchImpl, seen } = responder(({ path }) => {
      if (path === "/rest/api/3/search/jql") return json({ issues: [] });
      return null;
    });
    const p = provider({ fetchImpl, recoverPollMs: [1, 1] });
    expect(await p.recoverCreate("lucent-action:ext_n1")).toBeUndefined();
    const jqlCall = seen[0]!;
    expect(jqlCall.path).toContain(
      encodeURIComponent('text ~ "lucent-action:ext_n1" AND project = LAUNCH'),
    );
  });
});

describe("the SSRF-safe site policy (ADR 0034)", () => {
  it("accepts a real https site; refuses http, localhost, private IPs, and userinfo", () => {
    expect(isSafeOutboundUrl("https://acme.atlassian.net")).toMatchObject({ ok: true });
    expect(isSafeOutboundUrl("http://acme.atlassian.net")).toMatchObject({ ok: false });
    expect(isSafeOutboundUrl("https://localhost")).toMatchObject({ ok: false });
    expect(isSafeOutboundUrl("https://127.0.0.1")).toMatchObject({ ok: false });
    expect(isSafeOutboundUrl("https://10.1.2.3")).toMatchObject({ ok: false });
    expect(isSafeOutboundUrl("https://192.168.0.1")).toMatchObject({ ok: false });
    expect(isSafeOutboundUrl("https://172.16.0.1")).toMatchObject({ ok: false });
    expect(isSafeOutboundUrl("https://[::1]")).toMatchObject({ ok: false });
    expect(isSafeOutboundUrl("https://[::]")).toMatchObject({ ok: false });
    expect(isSafeOutboundUrl("https://[::ffff:127.0.0.1]")).toMatchObject({ ok: false });
    expect(isSafeOutboundUrl("https://[::ffff:169.254.169.254]")).toMatchObject({ ok: false });
    expect(isSafeOutboundUrl("https://user:pass@acme.atlassian.net")).toMatchObject({ ok: false });
    expect(isSafeOutboundUrl("not a url")).toMatchObject({ ok: false });
  });

  it("the constructor enforces the policy too (the boundary is authoritative both ways)", () => {
    expect(() => provider({ site: "https://localhost" })).toThrow(
      /localhost is not an allowed outbound target/,
    );
    expect(() => provider({ site: "http://acme.atlassian.net" })).toThrow(/only https/);
  });

  it("the factory refuses: unset/malformed credential, unsafe site, missing/bad projectKey", () => {
    const factory = jiraConnectionFactory();
    delete process.env.JIRA_TEST_CRED;
    expect(() =>
      factory({
        credentialRef: "JIRA_TEST_CRED",
        config: { site: "https://acme.atlassian.net", projectKey: "LAUNCH" },
      }),
    ).toThrow(/not set in the environment/);
    process.env.JIRA_TEST_CRED = "only-email";
    expect(() =>
      factory({
        credentialRef: "JIRA_TEST_CRED",
        config: { site: "https://acme.atlassian.net", projectKey: "LAUNCH" },
      }),
    ).toThrow(/email:api_token/);
    process.env.JIRA_TEST_CRED = "dev@example.com:token";
    expect(() =>
      factory({ credentialRef: "JIRA_TEST_CRED", config: { projectKey: "LAUNCH" } }),
    ).toThrow(/missing config\.site/);
    expect(() =>
      factory({
        credentialRef: "JIRA_TEST_CRED",
        config: { site: "https://192.168.0.9", projectKey: "LAUNCH" },
      }),
    ).toThrow(/not allowed outbound/);
    expect(() =>
      factory({ credentialRef: "JIRA_TEST_CRED", config: { site: "https://acme.atlassian.net" } }),
    ).toThrow(/missing config\.projectKey/);
    expect(() =>
      factory({
        credentialRef: "JIRA_TEST_CRED",
        config: { site: "https://acme.atlassian.net", projectKey: "launch" },
      }),
    ).toThrow(/uppercase/);
    delete process.env.JIRA_TEST_CRED;
  });

  it("validJiraProjectKey accepts the classic shape", () => {
    expect(validJiraProjectKey("LAUNCH")).toBe(true);
    expect(validJiraProjectKey("PROJ1")).toBe(true);
    expect(validJiraProjectKey("launch")).toBe(false);
    expect(validJiraProjectKey("L")).toBe(false);
    expect(validJiraProjectKey("TOO LONG A KEY")).toBe(false);
  });
});
