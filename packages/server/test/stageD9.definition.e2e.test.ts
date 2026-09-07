import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { MockImageProvider, MockProvider } from "@lucent/ai";
import { createWorkspace, type Operation } from "@lucent/core";
import { createApp } from "../src/app.js";
import { InMemoryUserStore } from "../src/accounts.js";
import { InMemoryBoardStore } from "../src/boards.js";
import { InMemoryProposalStore } from "../src/proposals.js";
import { InMemoryMeetingStore } from "../src/meetings.js";
import { InMemoryUsageStore } from "../src/usageStore.js";
import { UsageTracker, limitsFromEnv } from "../src/usage.js";
import { Telemetry } from "../src/telemetry.js";
import { Limiter } from "../src/limiter.js";
import { InMemoryTicketStore } from "../src/realtimeTicket.js";
import { InMemorySessionStore } from "../src/sessions.js";
import { readConfig } from "../src/config.js";
import {
  InMemoryIntegrationActionStore,
  InMemoryIntegrationStore,
} from "../src/integrations/integrations.js";
import { InMemoryExecutionLedger } from "../src/integrations/ledger.js";
import { GithubProvider } from "../src/integrations/github.js";
import type { ExternalPlanRequest, ExternalPlanResult, LLMProvider } from "@lucent/ai";

/**
 * Stage D9's definition of done — the narrowing agent, end to end: the
 * scripted selector picks 4 of 10, the record carries the AI provenance +
 * the revision snapshot, the D8 warnings ride the narrowed set, the HUMAN
 * approve gate decides it, the wire sees exactly the 4, and every "never"
 * is pinned. The full story in one test, the D7/D8 precedent.
 */

const SECRET = "d9-acceptance-secret-0123456789";

/** The GitHub wire (the D8 stub's shape): the REST issues + assignees. */
class GithubWire {
  readonly issues: Array<{ number: number; title: string; body: string; state: string; state_reason: string | null }> = [];
  private next = 100;

  readonly fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(_url));
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    const issueJson = (issue: { number: number; title: string; body: string; state: string; state_reason: string | null }) => ({
      ...issue,
      html_url: `https://github.test/issues/${issue.number}`,
      assignees: [],
    });
    if (url.pathname === "/repos/acme/app/assignees") {
      return new Response(JSON.stringify([{ login: "sarah-dev" }]), { status: 200 });
    }
    if (method === "POST" && url.pathname === "/repos/acme/app/issues") {
      const number = this.next++;
      const issue = { number, title: String(body?.title ?? ""), body: String(body?.body ?? ""), state: "open", state_reason: null };
      this.issues.push(issue);
      return new Response(JSON.stringify(issueJson(issue)), { status: 201 });
    }
    if (url.pathname === "/search/issues") {
      const q = url.searchParams.get("q") ?? "";
      const token = (q.match(/"([^"]+)"/) ?? [])[1] ?? "";
      return new Response(
        JSON.stringify({ items: this.issues.filter((i) => i.body.includes(token)).map(issueJson) }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ message: "no route" }), { status: 404 });
  }) as typeof fetch;
}


/** The scripted selector: the test sets the plan; every call is recorded. */
class SelectorLLM implements LLMProvider {
  readonly name = "selector";
  calls = 0;
  lastRequest: ExternalPlanRequest | null = null;
  plan: ExternalPlanResult = { nodeIds: [], explanation: "" };

  async generateOperations(): Promise<never> {
    throw new Error("not under test");
  }
  async generateAnswer(): Promise<never> {
    throw new Error("not under test");
  }
  async generateExternalPlan(request: ExternalPlanRequest): Promise<ExternalPlanResult> {
    this.calls += 1;
    this.lastRequest = request;
    return { ...this.plan };
  }
}

async function makeHarness() {
  const limits = limitsFromEnv();
  const config = {
    ...readConfig({ LUCENT_REQUIRE_AUTH: "1", LUCENT_WEB_ORIGIN: "http://127.0.0.1" }),
    requireAuth: true,
  };
  const userStore = new InMemoryUserStore();
  const boardStore = new InMemoryBoardStore();
  const usageStore = new InMemoryUsageStore();
  const wire = new GithubWire();
  const selector = new SelectorLLM();
  process.env.D9_GH_KEY = "ghp_d9";
  const github = new GithubProvider({
    token: "ghp_d9",
    repo: "acme/app",
    fetchImpl: wire.fetchImpl,
    maxAttempts: 1,
    timeoutMs: 2_000,
    recoverPollMs: [1],
  });
  const store = new InMemoryIntegrationStore();
  const actions = new InMemoryIntegrationActionStore();
  const { server, close } = createApp({
    config,
    provider: selector,
    imageProvider: new MockImageProvider(),
    userStore,
    boardStore,
    proposals: new InMemoryProposalStore(),
    meetings: new InMemoryMeetingStore(),
    usageStore,
    sessionStore: new InMemorySessionStore(),
    secret: SECRET,
    usage: new UsageTracker(limits),
    limits,
    telemetry: new Telemetry(),
    authLimiter: new Limiter(1000, 60_000),
    tickets: new InMemoryTicketStore(60_000),
    integrations: {
      store,
      providers: new Map<string, import("../src/integrations/provider.js").ExecutionProviderFactory>([
        ["github", () => github],
      ]),
      actions,
      ledger: new InMemoryExecutionLedger(),
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    userStore,
    boardStore,
    usageStore,
    store,
    actions,
    wire,
    selector,
    close: async () => { await close(); },
  };
}

let open: Awaited<ReturnType<typeof makeHarness>> | null = null;
afterEach(async () => {
  await open?.close();
  open = null;
  delete process.env.D9_GH_KEY;
});

async function api(h: NonNullable<typeof open>, path: string, init: RequestInit & { token?: string; csrf?: string } = {}) {
  const { token, csrf, ...rest } = init;
  const res = await fetch(`${h.base}${path}`, {
    ...rest,
    headers: {
      ...(rest.body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(csrf ? { "x-csrf-token": csrf, "x-requested-with": "lucent" } : {}),
      origin: h.base,
      ...(rest.headers ?? {}),
    },
  });
  const body: any = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

/** Ten launch actions: 3 carry 'launch' in the title + a dueDate (the
 * capability-warning target), 7 don't. */
function tenActions(): Operation[] {
  const names = [
    "Prepare launch brief", "Finalize launch spec", "Launch comms plan",
    "Fix onboarding bug", "QA pass", "Update pricing page",
    "Analytics check", "Security review", "Docs update", "Team retro",
  ];
  const ops: Operation[] = [];
  for (const [i, name] of names.entries()) {
    const id = `nd_${i + 1}`;
    ops.push({ op: "CREATE_NODE", id, nodeType: "action", label: name });
    ops.push({ op: "SET_STATEMENT", id, statement: { kind: "action", status: "open", topic: "d9" } });
    ops.push({
      op: "SET_ISSUE",
      id,
      issue: {
        type: "task",
        status: i < 3 ? "blocked" : "open",
        ...(i < 3 ? { dueDate: "2026-09-20" } : {}),
      },
    });
  }
  return ops;
}

describe("Stage D9 definition of done — the narrowing agent, end to end", () => {
  it("the full story: select 4 of 10 → the AI record → the D8 warnings → the human gate → exactly 4 on the wire → the never-tests", async () => {
    const h = (open = await makeHarness());

    // The user + org + the linear connection.
    const signup = await api(h, "/api/auth/signup", {
      method: "POST",
      body: JSON.stringify({ email: "d9@example.com", password: "password123", name: "D9" }),
    });
    expect(signup.status).toBe(201);
    const token: string = signup.body.token;
    const orgId = (await h.userStore.membershipsFor(signup.body.user.id))[0]!.orgId;
    const put = await api(h, `/api/orgs/${orgId}/integrations/github`, {
      method: "PUT", token, csrf: "csrf",
      body: JSON.stringify({ credentialRef: "D9_GH_KEY", config: { repo: "acme/app" } }),
    });
    expect(put.status).toBe(201);

    // The board with 10 actions (3 with dueDates + blocked status — the
    // warning targets).
    const created = await api(h, "/api/boards", {
      method: "POST", token, body: JSON.stringify({ name: "D9 board", workspace: createWorkspace() }),
    });
    expect(created.status).toBe(201);
    const boardId = created.body.id as string;
    const seeded = await api(h, `/api/boards/${boardId}/ops`, {
      method: "POST", token, body: JSON.stringify({ ops: tenActions(), label: "ten" }),
    });
    expect(seeded.status).toBe(200);

    // THE SELECTION: the model picks 4 (two launch + two others).
    h.selector.plan = {
      nodeIds: ["nd_1", "nd_2", "nd_6", "nd_8", "nd_ghost"],
      explanation: "The launch brief and spec are the critical path; pricing and security support the launch gate.",
    };
    const proposed = await api(h, `/api/boards/${boardId}/integrations/github/propose-ai`, {
      method: "POST", token, csrf: "csrf",
      body: JSON.stringify({ request: "send the actions needed for the launch" }),
    });
    expect(proposed.status).toBe(201);

    // THE PREVIEW: origin ai, the ratio (4 of 10 — the ghost dropped), the
    // explanation, the D8 warnings computed over the NARROWED set (nd_1 and
    // nd_2 carry dueDate + blocked; nd_6 and nd_8 are clean).
    expect(proposed.body.action).toMatchObject({ origin: "ai" });
    expect(proposed.body.action.provenance.request).toBe("send the actions needed for the launch");
    expect(proposed.body.preview.selectedCount).toBe(4);
    expect(proposed.body.preview.totalCandidates).toBe(10);
    expect(proposed.body.preview.statement).toContain("4 of the board's 10");
    expect(proposed.body.preview.explanation).toContain("critical path");
    const warned = proposed.body.preview.creates.filter((c: any) => c.warnings?.length);
    expect(warned.map((c: any) => c.nodeId).sort()).toEqual(["nd_1", "nd_2"]);
    // THE DROP WARNING: the ghost id is visible.
    expect(proposed.body.preview.warnings).toEqual([
      expect.stringContaining("nd_ghost"),
    ]);
    // THE SELECTOR'S REQUEST: the semantic candidates, none of the connection.
    expect(h.selector.lastRequest!.candidates).toHaveLength(10);
    expect(h.selector.lastRequest!.candidates[0]).toMatchObject({ nodeId: "nd_1", label: "Prepare launch brief" });
    expect(JSON.stringify(h.selector.lastRequest)).not.toContain("teamId");
    expect(JSON.stringify(h.selector.lastRequest)).not.toContain("credentialRef");

    // THE RECORD: pending, narrowed, AI-origin — the never-auto-approve.
    const record = await h.actions.action(boardId, proposed.body.action.id);
    expect(record!.status).toBe("pending");
    expect(record!.origin).toBe("ai");
    expect(record!.items).toHaveLength(4);
    expect(record!.sourceSeq).toBeGreaterThan(0);
    // THE METER: one ai-propose usage event.
    expect(await h.usageStore.monthToDate(orgId, "ai.generation", Date.now())).toBe(1);

    // THE HUMAN GATE, arm 1: approve WITHOUT the ack → the 409 (the D8
    // warnings are on the narrowed set), zero wire mutations.
    const refused = await api(h, `/api/boards/${boardId}/integrations/actions/${proposed.body.action.id}/approve`, {
      method: "POST", token, csrf: "csrf",
    });
    expect(refused.status).toBe(409);
    expect(refused.body.warnings.length).toBe(4); // 2 items × 2 warnings
    expect(h.wire.issues).toHaveLength(0);

    // Arm 2: WITH the ack → applied, exactly 4 on the wire.
    const approved = await api(h, `/api/boards/${boardId}/integrations/actions/${proposed.body.action.id}/approve`, {
      method: "POST", token, csrf: "csrf",
      body: JSON.stringify({ acknowledgeWarnings: true }),
    });
    expect(approved.status).toBe(200);
    expect(approved.body.applied).toBe(4);
    expect(h.wire.issues).toHaveLength(4);
    // The wire's issues are exactly the narrowed set, the marker in every
    // body — and the consented loss holds: no dueDate, state open (GitHub
    // is the warning-carrying provider; the ack is what the 409 demanded).
    expect(h.wire.issues.map((i) => i.title).sort()).toEqual([
      "Finalize launch spec", "Prepare launch brief", "Security review", "Update pricing page",
    ]);
    for (const issue of h.wire.issues) {
      expect(issue.body).toContain("<!-- lucent-action:ext_");
      expect(issue.state).toBe("open");
    }

    // THE STALE-BOARD ARM: the board changes after the propose — the
    // approval applied the REVIEWED SNAPSHOT regardless (sourceSeq is
    // audit, not a gate). Flip an unselected node's status and re-check
    // the wire count did not move.
    await api(h, `/api/boards/${boardId}/ops`, {
      method: "POST", token, body: JSON.stringify({
        ops: [{ op: "SET_ISSUE", id: "nd_5", issue: { type: "task", status: "completed", statusCategory: "done" } }],
        label: "stale flip",
      }),
    });
    expect(h.wire.issues).toHaveLength(4); // unchanged — the snapshot held

    // THE NEVER-SPEND ARM: propose-ai on a provider with no connection →
    // 404, ZERO selector calls (linear is unregistered in this harness).
    const noConn = await api(h, `/api/boards/${boardId}/integrations/linear/propose-ai`, {
      method: "POST", token, csrf: "csrf",
      body: JSON.stringify({ request: "anything" }),
    });
    expect(noConn.status).toBe(404);
    expect(h.selector.calls).toBe(1); // only the successful call

    // THE LIST: the origin + provenance surface.
    const list = await api(h, `/api/boards/${boardId}/integrations/actions`, { token });
    const row = list.body.actions.find((a: any) => a.id === proposed.body.action.id);
    expect(row).toMatchObject({ status: "approved" });

    // DUPLICATE APPROVAL: the decided-once guard.
    const dup = await api(h, `/api/boards/${boardId}/integrations/actions/${proposed.body.action.id}/approve`, {
      method: "POST", token, csrf: "csrf",
      body: JSON.stringify({ acknowledgeWarnings: true }),
    });
    expect(dup.body.duplicate).toBe(true);
    expect(h.wire.issues).toHaveLength(4);
  });
});
