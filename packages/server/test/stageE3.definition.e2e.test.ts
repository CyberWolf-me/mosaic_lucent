import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import {
  MockImageProvider,
  type ExternalPlanRequest,
  type ExternalPlanResult,
  type LLMProvider,
} from "@lucent/ai";
import { createWorkspace, stampAuthorship, type Operation } from "@lucent/core";
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

/**
 * Stage E3's definition of done — the create-the-work bridge, end to end:
 * a plan region's derived actions named by ID (no selector model — the
 * spend is zero, pinned by a counting selector that must stay at 0), the
 * ids through the SAME intersect/cap/warn narrowing a model selection
 * takes, the D5/D8 approve + ack gates exactly as on any external action,
 * the exactly-once ledger, and the duplicate guard. ADR 0037's E3
 * extension, pinned the D9 way: one continuous story.
 */

const SECRET = "e3-acceptance-secret-0123456789";

/** The GitHub wire (the D8 stub's shape, reused). */
class GithubWire {
  readonly issues: Array<{
    number: number;
    title: string;
    body: string;
    state: string;
    state_reason: string | null;
  }> = [];
  private next = 100;

  readonly fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(_url));
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : undefined;
    const issueJson = (issue: {
      number: number;
      title: string;
      body: string;
      state: string;
      state_reason: string | null;
    }) => ({
      ...issue,
      html_url: `https://github.test/issues/${issue.number}`,
      assignees: [],
    });
    if (url.pathname === "/repos/acme/app/assignees") {
      return new Response(JSON.stringify([{ login: "sarah-dev" }]), { status: 200 });
    }
    if (method === "POST" && url.pathname === "/repos/acme/app/issues") {
      const number = this.next++;
      const issue = {
        number,
        title: String(body?.title ?? ""),
        body: String(body?.body ?? ""),
        state: "open",
        state_reason: null,
      };
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

/** The counting selector: the bridge must NEVER call it. */
class CountingSelectorLLM implements LLMProvider {
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
  const selector = new CountingSelectorLLM();
  process.env.E3_GH_KEY = "ghp_e3";
  const github = new GithubProvider({
    token: "ghp_e3",
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
      providers: new Map<
        string,
        import("../src/integrations/provider.js").ExecutionProviderFactory
      >([["github", () => github]]),
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
    close: async () => {
      await close();
    },
  };
}

let open: Awaited<ReturnType<typeof makeHarness>> | null = null;
afterEach(async () => {
  await open?.close();
  open = null;
  delete process.env.E3_GH_KEY;
});

async function api(
  h: NonNullable<typeof open>,
  path: string,
  init: RequestInit & { token?: string; csrf?: string } = {},
) {
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

/**
 * The plan-shaped board (the E1/E3 tree): a decision, its plan region
 * holding four derived actions (createdFrom-stamped, workstream-grouped),
 * plus two pre-existing plain actions outside the plan — the narrowing
 * boundary the bridge must respect (only the named ids go, not every
 * executable action).
 */
function planBoard(): Operation[] {
  const derivedIds = ["req-0-action", "req-1-action", "rsk-0-action", "rsk-1-action"];
  const ops: Operation[] = [
    { op: "CREATE_NODE", id: "dec-0", nodeType: "decision", label: "Phased rollout" },
    { op: "SET_STATEMENT", id: "dec-0", statement: { kind: "decision", status: "resolved" } },
    { op: "CREATE_NODE", id: "req-0", nodeType: "requirement", label: "Support SSO" },
    { op: "SET_STATEMENT", id: "req-0", statement: { kind: "requirement", status: "open" } },
    { op: "CREATE_NODE", id: "req-1", nodeType: "requirement", label: "Add audit log" },
    { op: "SET_STATEMENT", id: "req-1", statement: { kind: "requirement", status: "open" } },
    { op: "CREATE_NODE", id: "rsk-0", nodeType: "risk", label: "Migration data loss" },
    { op: "SET_STATEMENT", id: "rsk-0", statement: { kind: "risk", status: "open" } },
    { op: "CREATE_NODE", id: "rsk-1", nodeType: "risk", label: "Cost overrun" },
    { op: "SET_STATEMENT", id: "rsk-1", statement: { kind: "risk", status: "open" } },
    // The plan region + workstreams (the mock's emitted shape, stamped the
    // send path's way: createdFrom on every derived node).
    {
      op: "CREATE_GROUP",
      id: "plan-region",
      label: "Launch plan",
      children: [...derivedIds, "dec-0"],
      kind: "process",
    },
  ];
  for (const id of derivedIds) {
    ops.push({
      op: "CREATE_NODE",
      id,
      nodeType: "action",
      label: `Address: ${id.replace("-action", "")}`,
    });
    // Provenance nests inside the statement (attachProvenance's rule), not
    // at the op's top level — the strict programmatic parse refuses the
    // latter, which is exactly what it is for.
    ops.push({
      op: "SET_STATEMENT",
      id,
      statement: {
        kind: "action",
        status: "open",
        topic: "plan",
        provenance: { createdFrom: ["dec-0"] },
      },
    });
    ops.push({ op: "SET_ISSUE", id, issue: { type: "task", status: "open" } });
  }
  ops.push({
    op: "CREATE_GROUP",
    id: "plan-ws-research",
    label: "Research",
    children: ["req-0-action", "req-1-action"],
  });
  ops.push({
    op: "CREATE_GROUP",
    id: "plan-ws-engineering",
    label: "Engineering",
    children: ["rsk-0-action", "rsk-1-action"],
  });
  // Two pre-existing plain actions OUTSIDE the plan.
  ops.push({ op: "CREATE_NODE", id: "old-0", nodeType: "action", label: "Old work" });
  ops.push({ op: "SET_STATEMENT", id: "old-0", statement: { kind: "action", status: "open" } });
  ops.push({ op: "SET_ISSUE", id: "old-0", issue: { type: "task", status: "open" } });
  ops.push({ op: "CREATE_NODE", id: "old-1", nodeType: "action", label: "Older work" });
  ops.push({ op: "SET_STATEMENT", id: "old-1", statement: { kind: "action", status: "open" } });
  ops.push({ op: "SET_ISSUE", id: "old-1", issue: { type: "task", status: "open" } });
  return stampAuthorship(ops, "plan-user");
}

describe("Stage E3 definition of done — the create-the-work bridge, end to end", () => {
  it("the plan's derived actions named by id → no selector call → the narrowed record → the approve gate → exactly the plan on the wire", async () => {
    const h = (open = await makeHarness());

    // The user + org + the GitHub connection.
    const signup = await api(h, "/api/auth/signup", {
      method: "POST",
      body: JSON.stringify({ email: "e3@example.com", password: "password123", name: "E3" }),
    });
    expect(signup.status).toBe(201);
    const token: string = signup.body.token;
    const orgId = (await h.userStore.membershipsFor(signup.body.user.id))[0]!.orgId;
    const put = await api(h, `/api/orgs/${orgId}/integrations/github`, {
      method: "PUT",
      token,
      csrf: "csrf",
      body: JSON.stringify({ credentialRef: "E3_GH_KEY", config: { repo: "acme/app" } }),
    });
    expect(put.status).toBe(201);

    // The plan-shaped board.
    const created = await api(h, "/api/boards", {
      method: "POST",
      token,
      body: JSON.stringify({ name: "E3 board", workspace: createWorkspace() }),
    });
    expect(created.status).toBe(201);
    const boardId = created.body.id as string;
    const seeded = await api(h, `/api/boards/${boardId}/ops`, {
      method: "POST",
      token,
      body: JSON.stringify({ ops: planBoard(), label: "the plan" }),
    });
    expect(seeded.status).toBe(200);

    // THE BRIDGE: the plan's four derived ids + one ghost, named by the
    // surface — the selector model is never asked.
    const proposed = await api(h, `/api/boards/${boardId}/integrations/github/propose-ai`, {
      method: "POST",
      token,
      csrf: "csrf",
      body: JSON.stringify({
        request: "Send the plan's derived actions",
        nodeIds: ["req-0-action", "req-1-action", "rsk-0-action", "rsk-1-action", "ghost-id"],
      }),
    });
    expect(proposed.status).toBe(201);

    // NO SPEND: the selector was never called (the bridge's whole point).
    expect(h.selector.calls).toBe(0);
    // THE PREVIEW: origin ai, exactly the four named ids (the ghost
    // dropped with a visible warning), the ratio against the board's six
    // executable actions.
    expect(proposed.body.action).toMatchObject({ origin: "ai" });
    expect(proposed.body.action.provenance.nodeIds).toEqual([
      "req-0-action",
      "req-1-action",
      "rsk-0-action",
      "rsk-1-action",
      "ghost-id",
    ]);
    expect(proposed.body.preview.selectedCount).toBe(4);
    expect(proposed.body.preview.totalCandidates).toBe(6);
    expect(proposed.body.preview.warnings).toEqual([expect.stringContaining("ghost-id")]);
    const createIds = proposed.body.preview.creates.map((c: any) => c.nodeId).sort();
    expect(createIds).toEqual(["req-0-action", "req-1-action", "rsk-0-action", "rsk-1-action"]);
    // The plain pre-existing actions did NOT ride along.
    expect(createIds).not.toContain("old-0");
    expect(createIds).not.toContain("old-1");

    // THE METER: one generation, the plan-bridge mode tag.
    expect(await h.usageStore.monthToDate(orgId, "ai.generation", Date.now())).toBe(1);

    // THE RECORD: pending, narrowed, provenance carries the named ids.
    const record = await h.actions.action(boardId, proposed.body.action.id);
    expect(record!.status).toBe("pending");
    expect(record!.origin).toBe("ai");
    expect(record!.items).toHaveLength(4);

    // THE HUMAN GATE: approve (no warnings here — the derived actions
    // carry no dueDates, so nothing to ack) → exactly the plan on the wire.
    const approved = await api(
      h,
      `/api/boards/${boardId}/integrations/actions/${proposed.body.action.id}/approve`,
      {
        method: "POST",
        token,
        csrf: "csrf",
        body: JSON.stringify({}),
      },
    );
    expect(approved.status).toBe(200);
    expect(approved.body.applied).toBe(4);
    expect(h.wire.issues).toHaveLength(4);
    for (const issue of h.wire.issues) {
      expect(issue.body).toContain("<!-- lucent-action:ext_");
    }

    // DUPLICATE APPROVAL: the decided-once guard — the ledger holds.
    const dup = await api(
      h,
      `/api/boards/${boardId}/integrations/actions/${proposed.body.action.id}/approve`,
      {
        method: "POST",
        token,
        csrf: "csrf",
        body: JSON.stringify({}),
      },
    );
    expect(dup.body.duplicate).toBe(true);
    expect(h.wire.issues).toHaveLength(4);

    // THE EMPTY SELECTION: nodeIds naming nothing executable → the honest
    // 422, zero wire mutations, still no selector call.
    const empty = await api(h, `/api/boards/${boardId}/integrations/github/propose-ai`, {
      method: "POST",
      token,
      csrf: "csrf",
      body: JSON.stringify({ request: "send nothing real", nodeIds: ["nope-1", "nope-2"] }),
    });
    expect(empty.status).toBe(422);
    expect(h.selector.calls).toBe(0);
    expect(h.wire.issues).toHaveLength(4);
    // 30s budget, not the 5s default: same load-flake rationale as D9
    // (seen live 2026-09-17; ~380ms in isolation).
  }, 30000);
});
