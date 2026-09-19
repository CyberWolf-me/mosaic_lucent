import { describe, expect, it } from "vitest";
import type { ExecutionStatus } from "@lucent/core";
import {
  GithubError,
  GithubProvider,
  githubConnectionFactory,
  validGitHubRepo,
} from "../src/integrations/github.js";

/**
 * The GitHub adapter's wire contract, asserted against a scripted REST
 * responder — never a live account (the StripeClient/Anthropic/Linear
 * fetchImpl precedent). Pins the D8 divergences exactly where they live:
 * Bearer + UA + api-version headers, number-as-externalId, the lossy
 * status map (with the capability warnings that make the loss honest),
 * the reliable-only assignee ladder (no email rung — documented), and
 * the hardened recovery contract (poll before not-found; >1 fails).
 */

/** Records every wire call; dispatches on method+path. */
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
    // Headers through the Headers case-insensitivity.
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k.toLowerCase()] = v));
    seen.push({ method, path: url.pathname + url.search, body, headers });
    const answer = route({ method, path: url.pathname, body });
    if (answer) return answer;
    return new Response(JSON.stringify({ message: `no route for ${method} ${url.pathname}` }), {
      status: 404,
    });
  }) as typeof fetch;
  return { fetchImpl, seen };
}

function issueJson(
  over: Partial<{
    number: number;
    title: string;
    body: string;
    state: string;
    state_reason: string | null;
    login: string;
  }> = {},
) {
  return {
    number: over.number ?? 482,
    title: over.title ?? "Issue",
    body: over.body ?? "",
    state: over.state ?? "open",
    state_reason: over.state_reason ?? null,
    html_url: `https://github.com/acme/app/issues/${over.number ?? 482}`,
    assignees: over.login ? [{ login: over.login }] : [],
  };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status });
}

function provider(over: Partial<ConstructorParameters<typeof GithubProvider>[0]> = {}) {
  return new GithubProvider({
    token: "ghp_test",
    repo: "acme/app",
    maxAttempts: 1,
    timeoutMs: 2_000,
    recoverPollMs: [1, 1, 1],
    ...over,
  });
}

describe("the wire contract", () => {
  it("sends Bearer + api-version + the mandatory User-Agent; number-as-externalId", async () => {
    const { fetchImpl, seen } = responder(({ method, path }) =>
      method === "POST" && path === "/repos/acme/app/issues"
        ? json(issueJson({ number: 7 }))
        : null,
    );
    const p = provider({ fetchImpl });
    const task = await p.createTask({ title: "T", idempotencyKey: "ext_n1" });
    expect(task).toMatchObject({
      provider: "github",
      externalId: "7",
      url: "https://github.com/acme/app/issues/7",
    });
    const wire = seen[0]!;
    expect(wire.headers["authorization"]).toBe("Bearer ghp_test");
    expect(wire.headers["x-github-api-version"]).toBe("2022-11-28");
    expect(wire.headers["user-agent"]).toBe("lucent-integration");
    // The marker rides the body — the recovery key.
    expect(String(wire.body?.body)).toContain("<!-- lucent-action:ext_n1 -->");
  });

  it("createTask threads the resolved assignee; updateTask PATCHes the number and composes the close word", async () => {
    const { fetchImpl } = responder(({ method, path, body }) => {
      if (path === "/repos/acme/app/assignees") {
        return json([{ login: "sarah-dev" }, { login: "sarahh" }]);
      }
      if (method === "POST" && path === "/repos/acme/app/issues") {
        return json(issueJson({ number: 9, login: "sarah-dev" }));
      }
      if (method === "PATCH" && path === "/repos/acme/app/issues/9") {
        expect(body?.state).toBe("closed:not_planned".split(":")[0]);
        expect(body?.state_reason).toBe("not_planned");
        return json(issueJson({ number: 9, state: "closed", state_reason: "not_planned" }));
      }
      return null;
    });
    const p = provider({ fetchImpl });
    const created = await p.createTask({ title: "T", assignee: "Sarah-Dev", idempotencyKey: "k" });
    expect(created.assignee).toBe("sarah-dev");
    const updated = await p.updateTask("9", { status: "cancelled" });
    expect(updated.status).toBe("closed:not_planned");
  });

  it("getTask reads by number; searchTasks scopes the query to the repo", async () => {
    const { fetchImpl, seen } = responder(({ method, path }) => {
      if (method === "GET" && path === "/repos/acme/app/issues/12") {
        return json(issueJson({ number: 12, state: "closed", state_reason: "completed" }));
      }
      if (path === "/search/issues") return json({ items: [issueJson({ number: 5 })] });
      return null;
    });
    const p = provider({ fetchImpl });
    const task = await p.getTask("12");
    expect(task).toMatchObject({ externalId: "12", status: "closed:completed" });
    await p.searchTasks("needle");
    // getTask ran first; the search is the second wire call.
    expect(seen[1]!.path).toContain(encodeURIComponent("needle repo:acme/app"));
  });
});

describe("the assignee ladder — reliable strategies only", () => {
  function ladder(users: Array<{ login: string }>) {
    const { fetchImpl, seen } = responder(({ path }) =>
      path === "/repos/acme/app/assignees" ? json(users) : null,
    );
    return { p: provider({ fetchImpl }), seen };
  }

  it("exact login (case-insensitive) resolves; unique partial resolves; cached after one fetch", async () => {
    const { p, seen } = ladder([{ login: "sarah-dev" }, { login: "another" }]);
    expect(await p["resolveAssignee"]("Sarah-Dev")).toBe("sarah-dev");
    expect(await p["resolveAssignee"]("sarah")).toBe("sarah-dev");
    expect(seen.filter((c) => c.path.includes("assignees"))).toHaveLength(1);
  });

  it("two partial matches are unresolvable (null), never a guess; an unknown login is null", async () => {
    const { p } = ladder([{ login: "alex1" }, { login: "alex2" }]);
    expect(await p["resolveAssignee"]("alex")).toBeNull();
    expect(await p["resolveAssignee"]("nobody")).toBeNull();
  });

  it("an email-shaped assignee is NOT resolved — the PAT search scope cannot reliably map email→login (documented)", async () => {
    const { p, seen } = ladder([{ login: "sarah-dev" }]);
    expect(await p["resolveAssignee"]("sarah@example.com")).toBeNull();
    // No user-lookup-by-email wire call is ever made.
    expect(seen.every((c) => !c.path.includes("users"))).toBe(true);
  });
});

describe("mapStatus — the honest vocabulary (the never-guesses rule)", () => {
  const p = provider();
  it("translates the composed words; unknowns are undefined", () => {
    const cases: Array<[string, ExecutionStatus | undefined]> = [
      ["open", "open"],
      ["closed", "completed"],
      ["closed:completed", "completed"],
      ["closed:not_planned", "cancelled"],
      ["In QA", undefined],
      ["whatever", undefined],
    ];
    for (const [word, want] of cases) expect(p.mapStatus(word)).toBe(want);
  });
  it("toExternalStatus is the RECORDED LOSSY map: every non-completed word → open", () => {
    expect(p.toExternalStatus("open")).toBe("open");
    expect(p.toExternalStatus("in_progress")).toBe("open");
    expect(p.toExternalStatus("blocked")).toBe("open");
    expect(p.toExternalStatus("completed")).toBe("closed:completed");
    expect(p.toExternalStatus("cancelled")).toBe("closed:not_planned");
  });
});

describe("capabilityWarnings — the honesty layer (ADR 0034)", () => {
  it("warns dueDate (no native field) and every non-open Lucent status; faithful fields warn nothing", () => {
    const p = provider();
    const warned = p.capabilityWarnings!({
      title: "T",
      assignee: "sarah",
      dueDate: "2026-09-20",
      status: "blocked",
    });
    expect(warned.map((w) => w.field).sort()).toEqual(["dueDate", "status"]);
    expect(warned.find((w) => w.field === "status")!.reason).toContain("blocked");
    expect(warned.find((w) => w.field === "status")!.reason).toContain("open");
    expect(p.capabilityWarnings!({ title: "T", status: "completed" })).toEqual([]);
  });

  it("an unresolvable (cached-null) assignee warns as omitted; a resolvable one does not", async () => {
    const { fetchImpl } = responder(({ path }) =>
      path === "/repos/acme/app/assignees" ? json([{ login: "sarah-dev" }]) : null,
    );
    const p = provider({ fetchImpl });
    await p["resolveAssignee"]("ghost");
    const warned = p.capabilityWarnings!({ title: "T", assignee: "ghost" });
    expect(warned).toEqual([{ field: "assignee", reason: expect.stringContaining("ghost") }]);
    const ok = p.capabilityWarnings!({ title: "T", assignee: "sarah" });
    expect(ok).toEqual([]);
  });
});

describe("recoverCreate — the hardened 0/1/>1 contract", () => {
  const marker = "lucent-action:ext_n1";

  it("polls before declaring not-found, then 1 hit recovers", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const { fetchImpl } = responder(({ path }) => {
      if (path === "/search/issues") {
        calls += 1;
        // First search: empty (the index has not caught up); second: found.
        return json(calls === 1 ? { items: [] } : { items: [issueJson({ number: 3 })] });
      }
      return null;
    });
    const p = provider({
      fetchImpl,
      recoverPollMs: [5, 5, 5],
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    const found = await p.recoverCreate(marker);
    expect(found).toMatchObject({ externalId: "3" });
    expect(calls).toBe(2);
    expect(sleeps).toEqual([5]);
  });

  it("0 hits after the full poll budget → undefined (retry the create)", async () => {
    let calls = 0;
    const { fetchImpl } = responder(({ path }) => {
      if (path === "/search/issues") {
        calls += 1;
        return json({ items: [] });
      }
      return null;
    });
    const p = provider({ fetchImpl, recoverPollMs: [1, 1, 1] });
    expect(await p.recoverCreate(marker)).toBeUndefined();
    expect(calls).toBe(4); // the first + three polls
  });

  it(">1 hits → the honest ambiguous failure, never a guess", async () => {
    const { fetchImpl } = responder(({ path }) =>
      path === "/search/issues"
        ? json({ items: [issueJson({ number: 3 }), issueJson({ number: 4 })] })
        : null,
    );
    const p = provider({ fetchImpl });
    await expect(p.recoverCreate(marker)).rejects.toThrow(/ambiguous recovery: 2/);
  });
});

describe("the error, retry, and factory arms", () => {
  it("429 retries (with maxAttempts + injected sleep); a 422 validation error throws once, non-retryable", async () => {
    let calls = 0;
    let slept = 0;
    const { fetchImpl } = responder(({ method, path }) => {
      if (method === "POST" && path === "/repos/acme/app/issues") {
        calls += 1;
        if (calls === 1)
          return new Response(JSON.stringify({ message: "rate limited" }), { status: 429 });
        return new Response(JSON.stringify({ message: "Validation Failed" }), { status: 422 });
      }
      return null;
    });
    const p = provider({
      fetchImpl,
      maxAttempts: 3,
      sleep: async () => {
        slept += 1;
      },
    });
    await expect(p.createTask({ title: "T" })).rejects.toThrow(/Validation Failed/);
    expect(calls).toBe(2); // one retry for the 429, then the 422 stops it
    expect(slept).toBe(1);
  });

  it("the factory refuses: unset env credential, missing repo, malformed repo (path traversal)", async () => {
    const factory = githubConnectionFactory();
    delete process.env.GH_TEST_TOKEN;
    expect(() => factory({ credentialRef: "GH_TEST_TOKEN", config: { repo: "acme/app" } })).toThrow(
      /not set in the environment/,
    );
    process.env.GH_TEST_TOKEN = "ghp_x";
    expect(() => factory({ credentialRef: "GH_TEST_TOKEN" })).toThrow(/missing config\.repo/);
    expect(() =>
      factory({ credentialRef: "GH_TEST_TOKEN", config: { repo: "../../etc" } }),
    ).toThrow(/owner\/repo/);
    expect(() => factory({ credentialRef: "GH_TEST_TOKEN", config: { repo: "acme" } })).toThrow(
      /owner\/repo/,
    );
    expect(() =>
      factory({
        credentialRef: "GH_TEST_TOKEN",
        config: { repo: "acme/app", baseUrl: "http://evil.example/api" },
      }),
    ).toThrow(/only https/);
    delete process.env.GH_TEST_TOKEN;
  });

  it("validGitHubRepo accepts only the exact owner/repo shape", () => {
    expect(validGitHubRepo("acme/app")).toBe(true);
    expect(validGitHubRepo("a.b-c/d_e.f")).toBe(true);
    expect(validGitHubRepo("../etc")).toBe(false);
    expect(validGitHubRepo("acme/")).toBe(false);
    expect(validGitHubRepo("/app")).toBe(false);
    expect(validGitHubRepo("acme/app/extra")).toBe(false);
  });

  it("GithubError carries retryable computed once", () => {
    const err = new GithubError("boom", 429, true);
    expect(err.retryable).toBe(true);
    expect(err.name).toBe("GithubError");
  });
});
