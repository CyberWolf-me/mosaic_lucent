import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import {
  createIntegrationWebhookReceiver,
  githubWebhookScheme,
  linearWebhookScheme,
  InMemoryIntegrationWebhookEventStore,
  integrationWebhookEventId,
  parseLinearWebhook,
  verifyLinearSignature,
  type SignatureCandidate,
} from "../src/integrations/webhook.js";
import { ingestInboundChange } from "../src/integrations/inbound.js";
import { InMemoryInboundChangeStore } from "../src/integrations/inbound.js";
import { InMemoryIntegrationStore } from "../src/integrations/integrations.js";

/** The LinearProvider's mapStatus, pinned in the D6 suite — the words the
 * ingest translates through. Re-implemented here so this suite tests the
 * receiver's contract, not the adapter's table. */
const mapStatus = (word: string) =>
  word === "Todo" || word === "Backlog"
    ? ("open" as const)
    : word === "In Progress"
      ? ("in_progress" as const)
      : word === "Done" || word === "Completed"
        ? ("completed" as const)
        : word === "Blocked"
          ? ("blocked" as const)
          : word === "Canceled" || word === "Cancelled"
            ? ("cancelled" as const)
            : undefined;

function sign(body: string, secret: string): string {
  return createHmac("sha256", secret).update(Buffer.from(body, "utf8")).digest("hex");
}

function issueUpdate(identifier: string, stateName: string): string {
  return JSON.stringify({
    action: "update",
    type: "Issue",
    created_at: "2026-09-06T00:00:00.000Z",
    data: {
      id: "uuid-x",
      identifier,
      name: "Some issue",
      state: { name: stateName, type: "started" },
    },
    url: "https://linear.test/issue/" + identifier,
  });
}

const ORG_A = "org_aaa";
const ORG_B = "org_bbb";
const SECRET_A = "whsec_aaa";
const SECRET_B = "whsec_bbb";

function candidates(): SignatureCandidate[] {
  return [
    { connectionId: "int_a", orgId: ORG_A, secret: SECRET_A },
    { connectionId: "int_b", orgId: ORG_B, secret: SECRET_B },
  ];
}

describe("verifyLinearSignature — the signature is the org resolution", () => {
  const body = issueUpdate("LIN-1", "Done");

  it("accepts a correctly signed body and resolves the matching org", () => {
    const result = verifyLinearSignature(Buffer.from(body), candidates(), sign(body, SECRET_A));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.match.orgId).toBe(ORG_A);
  });

  it("rejects a tampered body under the same signature", () => {
    const result = verifyLinearSignature(
      Buffer.from(body.replace("Done", "Todo")),
      candidates(),
      sign(body, SECRET_A),
    );
    expect(result).toEqual({
      ok: false,
      reason: "no_match",
      detail: expect.any(String),
    });
  });

  it("rejects a missing header", () => {
    const result = verifyLinearSignature(Buffer.from(body), candidates(), undefined);
    expect(result.ok && !result.ok).toBe(false);
    expect(result).toMatchObject({ ok: false, reason: "missing_header" });
  });

  it("rejects a malformed header as a clean false, never a throw", () => {
    for (const bad of ["zzzz", "deadbeef", "0".repeat(63), "g".repeat(64)]) {
      const result = verifyLinearSignature(Buffer.from(body), candidates(), bad);
      expect(result).toMatchObject({ ok: false, reason: "malformed_header" });
    }
  });

  it("answers no_candidate_secrets when no connection carries a secret", () => {
    const result = verifyLinearSignature(Buffer.from(body), [], sign(body, SECRET_A));
    expect(result).toMatchObject({ ok: false, reason: "no_candidate_secrets" });
  });
});

describe("parseLinearWebhook — verified bytes to a change", () => {
  it("reduces an issue update to the ExternalTaskChange shape", () => {
    const parsed = parseLinearWebhook(
      "linear",
      Buffer.from(issueUpdate("LIN-9", "In Progress")),
      123,
    );
    expect(parsed).toEqual({
      kind: "change",
      change: { provider: "linear", externalId: "LIN-9", status: "In Progress", at: 123 },
    });
  });

  it("ignores non-issue entities", () => {
    const parsed = parseLinearWebhook(
      "linear",
      Buffer.from(JSON.stringify({ action: "update", type: "Comment", data: {} })),
      123,
    );
    expect(parsed).toMatchObject({ kind: "ignored" });
  });

  it("ignores create and remove — inbound create is an import flow, remove is the sweep's call", () => {
    for (const action of ["create", "remove"]) {
      const parsed = parseLinearWebhook(
        "linear",
        Buffer.from(
          JSON.stringify({
            action,
            type: "Issue",
            data: { identifier: "LIN-1", state: { name: "Todo" } },
          }),
        ),
        123,
      );
      expect(parsed).toMatchObject({ kind: "ignored", reason: expect.stringContaining(action) });
    }
  });

  it("ignores an update without identifier or state", () => {
    const parsed = parseLinearWebhook(
      "linear",
      Buffer.from(JSON.stringify({ action: "update", type: "Issue", data: {} })),
      123,
    );
    expect(parsed).toMatchObject({ kind: "ignored" });
  });
});

describe("the receiver — the Stripe protocol, Linear's scheme", () => {
  function harness() {
    const events = new InMemoryIntegrationWebhookEventStore();
    const changes: Array<{
      change: { provider: string; externalId: string; status: string; at: number };
      orgId: string;
    }> = [];
    const receiver = createIntegrationWebhookReceiver({
      provider: "linear",
      scheme: linearWebhookScheme,
      candidates: candidates(),
      events,
      onChange: async (change, orgId) => {
        changes.push({ change, orgId });
      },
      now: () => 1_000,
    });
    return { receiver, events, changes };
  }

  it("processes a signed delivery and hands the change + org to the queue", async () => {
    const h = harness();
    const body = issueUpdate("LIN-1", "Done");
    const result = await h.receiver.receive({
      payload: Buffer.from(body),
      signature: sign(body, SECRET_A),
    });
    expect(result).toMatchObject({ status: 200, outcome: "processed" });
    expect(h.changes).toEqual([
      {
        change: { provider: "linear", externalId: "LIN-1", status: "Done", at: 1_000 },
        orgId: ORG_A,
      },
    ]);
  });

  it("answers 400 invalid_signature on a tampered body — and the ledger stays EMPTY", async () => {
    const h = harness();
    const body = issueUpdate("LIN-1", "Done");
    const tampered = body.replace("Done", "Todo");
    const result = await h.receiver.receive({
      payload: Buffer.from(tampered),
      signature: sign(body, SECRET_A),
    });
    expect(result).toMatchObject({ status: 400, outcome: "invalid_signature" });
    expect((await h.events.pending(0, 1_000, 10)).length).toBe(0);
  });

  it("answers 400 invalid_signature when no candidate secrets exist", async () => {
    const events = new InMemoryIntegrationWebhookEventStore();
    const receiver = createIntegrationWebhookReceiver({
      provider: "linear",
      scheme: linearWebhookScheme,
      candidates: [],
      events,
      onChange: async () => {},
    });
    const body = issueUpdate("LIN-1", "Done");
    const result = await receiver.receive({
      payload: Buffer.from(body),
      signature: sign(body, "whatever"),
    });
    expect(result).toMatchObject({
      status: 400,
      outcome: "invalid_signature",
      body: { error: "no_candidate_secrets" },
    });
  });

  it("a redelivery of the SAME bytes is a duplicate — one change, one row", async () => {
    const h = harness();
    const body = issueUpdate("LIN-1", "Done");
    const delivery = { payload: Buffer.from(body), signature: sign(body, SECRET_A) };
    await h.receiver.receive(delivery);
    const second = await h.receiver.receive(delivery);
    expect(second).toMatchObject({ status: 200, outcome: "duplicate" });
    expect(h.changes).toHaveLength(1);
  });

  it("an in-flight delivery (claimed, not stale) answers 409", async () => {
    const h = harness();
    const body = issueUpdate("LIN-1", "Done");
    const delivery = { payload: Buffer.from(body), signature: sign(body, SECRET_A) };
    await h.receiver.receive(delivery);
    // Same bytes re-delivered before the stale window: duplicate (processed).
    // For in_flight we simulate a claimed-but-unfinished row directly.
    const id = integrationWebhookEventId("linear", delivery.payload);
    const events2 = new InMemoryIntegrationWebhookEventStore();
    const receiver2 = createIntegrationWebhookReceiver({
      provider: "linear",
      scheme: linearWebhookScheme,
      candidates: candidates(),
      events: events2,
      onChange: async () => {},
      now: () => 1_000,
      staleAfterMs: 60_000,
    });
    await events2.claim({
      id,
      provider: "linear",
      orgId: ORG_A,
      externalId: "LIN-1",
      now: 900,
      staleAfterMs: 60_000,
    });
    const result = await receiver2.receive(delivery);
    expect(result).toMatchObject({ status: 409, outcome: "in_flight" });
  });

  it("ignores an entity Lucent does not sync inbound (200 ignored, no change)", async () => {
    const h = harness();
    const body = JSON.stringify({ action: "update", type: "Comment", data: { id: "c1" } });
    const result = await h.receiver.receive({
      payload: Buffer.from(body),
      signature: sign(body, SECRET_B),
    });
    expect(result).toMatchObject({ status: 200, outcome: "ignored" });
    expect(h.changes).toHaveLength(0);
  });

  it("a failing onChange answers 500 failed and the row is re-claimable", async () => {
    const events = new InMemoryIntegrationWebhookEventStore();
    let calls = 0;
    const receiver = createIntegrationWebhookReceiver({
      provider: "linear",
      scheme: linearWebhookScheme,
      candidates: candidates(),
      events,
      onChange: async () => {
        calls += 1;
        throw new Error("queue down");
      },
      now: () => 1_000,
      staleAfterMs: 100,
    });
    const body = issueUpdate("LIN-2", "Done");
    const result = await receiver.receive({
      payload: Buffer.from(body),
      signature: sign(body, SECRET_A),
    });
    expect(result).toMatchObject({ status: 500, outcome: "failed" });
    // Not yet stale (claimed at t=1000, stale window 100ms): the sweeper
    // at t=1050 sees nothing.
    expect(await events.pending(1_050 - 100, 1_050, 10)).toHaveLength(0);
    // Stale at t=1101: the failed row is re-claimable work.
    expect(await events.pending(1_101 - 100, 1_101, 10)).toHaveLength(1);
    expect(calls).toBe(1);
  });
});

describe("ingest — the verified change into the human-gated queue", () => {
  function harness(opts?: { nodeStatus?: string; orgs?: string[] }) {
    const store = new InMemoryIntegrationStore();
    const inbound = new InMemoryInboundChangeStore();
    const nodeStatus = opts?.nodeStatus ?? "todo";
    for (const orgId of opts?.orgs ?? [ORG_A]) {
      for (let i = 1; i <= 2; i += 1) {
        // Two boards in the org, each linking LIN-1 (the multi-board case).
        void store.linkTask(
          {
            orgId,
            boardId: `brd_${i}`,
            nodeId: `nd_${i}`,
            provider: "linear",
            externalId: "LIN-1",
            lastSyncedStatus: "Todo",
          },
          100,
        );
      }
    }
    const deps = {
      linksForExternalId: (provider: string, externalId: string) =>
        store.linksForExternalId(provider, externalId),
      boardNodeStatus: async () => nodeStatus,
      store: inbound,
      provider: { mapStatus },
      now: () => 1_000,
    };
    return { deps, inbound, store };
  }

  it("queues one pending record per link, translated through mapStatus", async () => {
    const h = harness();
    const outcome = await ingestInboundChange(
      h.deps,
      { provider: "linear", externalId: "LIN-1", status: "Done" },
      ORG_A,
    );
    expect(outcome).toMatchObject({ outcome: "queued", count: 2 });
    expect(outcome.records).toHaveLength(2);
    const records = await h.inbound.forBoard("brd_1");
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      provider: "linear",
      nodeId: "nd_1",
      externalId: "LIN-1",
      field: "status",
      externalValue: "Done",
      mappedValue: "completed",
      status: "pending",
      source: "webhook",
    });
  });

  it("a record whose live board value already equals the mapped value is NOT queued", async () => {
    const h = harness({ nodeStatus: "completed" });
    const outcome = await ingestInboundChange(
      h.deps,
      { provider: "linear", externalId: "LIN-1", status: "Done" },
      ORG_A,
    );
    expect(outcome).toEqual({ outcome: "queued", count: 0, records: [] });
    expect(await h.inbound.forBoard("brd_1")).toHaveLength(0);
  });

  it("an untranslatable word produces the WARNING record — mappedValue undefined", async () => {
    const h = harness();
    await ingestInboundChange(
      h.deps,
      { provider: "linear", externalId: "LIN-1", status: "In QA" },
      ORG_A,
    );
    const records = await h.inbound.forBoard("brd_2");
    expect(records[0]).toMatchObject({
      externalValue: "In QA",
      mappedValue: undefined,
      status: "pending",
    });
  });

  it("the queue-level dedupe: same value refreshes, new value updates — never a second row", async () => {
    const h = harness();
    await ingestInboundChange(
      h.deps,
      { provider: "linear", externalId: "LIN-1", status: "Done" },
      ORG_A,
    );
    await ingestInboundChange(
      h.deps,
      { provider: "linear", externalId: "LIN-1", status: "Done" },
      ORG_A,
    );
    let records = await h.inbound.forBoard("brd_1");
    expect(records).toHaveLength(1);
    expect(records[0]?.detectedAt).toBe(1_000);
    await ingestInboundChange(
      h.deps,
      { provider: "linear", externalId: "LIN-1", status: "In Progress" },
      ORG_A,
    );
    records = await h.inbound.forBoard("brd_1");
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ externalValue: "In Progress", mappedValue: "in_progress" });
  });

  it("an issue no org linked is unlinked — no record, no noise", async () => {
    const h = harness();
    const outcome = await ingestInboundChange(
      h.deps,
      { provider: "linear", externalId: "LIN-999", status: "Done" },
      ORG_A,
    );
    expect(outcome).toEqual({ outcome: "unlinked", count: 0, records: [] });
  });

  it("a webhook resolved to one org never writes another org's board", async () => {
    const h = harness({ orgs: [ORG_A, ORG_B] });
    const outcome = await ingestInboundChange(
      h.deps,
      { provider: "linear", externalId: "LIN-1", status: "Done" },
      ORG_A,
    );
    expect(outcome.count).toBe(2); // only org A's two links
    const b = await h.inbound.forBoard("brd_1");
    expect(b).toHaveLength(1);
    expect(b[0]?.orgId).toBe(ORG_A);
  });

  it("a node with no issue fields is nothing to compare — the record still queues", async () => {
    const h = harness({ nodeStatus: "todo" });
    const deps = { ...h.deps, boardNodeStatus: async () => null };
    const outcome = await ingestInboundChange(
      deps,
      { provider: "linear", externalId: "LIN-1", status: "Done" },
      ORG_A,
    );
    expect(outcome.count).toBe(2);
  });
});

describe("the github scheme — X-Hub-Signature-256, the composed words (D8)", () => {
  const GH_ORG = "org_gh";
  const GH_SECRET = "whsec_gh";

  function ghSign(body: string): string {
    return `sha256=${createHmac("sha256", GH_SECRET).update(Buffer.from(body, "utf8")).digest("hex")}`;
  }

  function ghHarness() {
    const events = new InMemoryIntegrationWebhookEventStore();
    const changes: Array<{
      change: { provider: string; externalId: string; status: string; at: number };
      orgId: string;
    }> = [];
    const receiver = createIntegrationWebhookReceiver({
      provider: "github",
      scheme: githubWebhookScheme,
      candidates: [{ connectionId: "int_gh", orgId: GH_ORG, secret: GH_SECRET }],
      events,
      onChange: async (change, orgId) => {
        changes.push({ change, orgId });
      },
      now: () => 1_000,
    });
    return { receiver, events, changes };
  }

  function issueEvent(
    action: string,
    over: { number: number; state: string; state_reason?: string | null },
  ): string {
    return JSON.stringify({
      action,
      issue: {
        number: over.number,
        state: over.state,
        state_reason: over.state_reason ?? null,
        title: "Some issue",
      },
    });
  }

  it("verifies the sha256= prefixed signature and resolves the org", async () => {
    const h = ghHarness();
    const body = issueEvent("closed", {
      number: 482,
      state: "closed",
      state_reason: "not_planned",
    });
    const result = await h.receiver.receive({
      payload: Buffer.from(body),
      signature: ghSign(body),
    });
    expect(result).toMatchObject({ status: 200, outcome: "processed" });
    expect(h.changes).toEqual([
      {
        change: { provider: "github", externalId: "482", status: "closed:not_planned", at: 1_000 },
        orgId: GH_ORG,
      },
    ]);
  });

  it("a bare hex signature (Linear's shape) is rejected — the prefix is required", async () => {
    const h = ghHarness();
    const body = issueEvent("opened", { number: 1, state: "open" });
    const bare = ghSign(body).slice("sha256=".length);
    const result = await h.receiver.receive({ payload: Buffer.from(body), signature: bare });
    expect(result).toMatchObject({
      status: 400,
      outcome: "invalid_signature",
      body: { error: "malformed_header" },
    });
    expect(h.changes).toHaveLength(0);
  });

  it("a tampered body under the right prefix: 400, the ledger stays empty", async () => {
    const h = ghHarness();
    const body = issueEvent("closed", { number: 9, state: "closed", state_reason: "completed" });
    const tampered = issueEvent("opened", { number: 9, state: "open" });
    const result = await h.receiver.receive({
      payload: Buffer.from(tampered),
      signature: ghSign(body),
    });
    expect(result).toMatchObject({ status: 400, outcome: "invalid_signature" });
    expect((await h.events.pending(0, 1_000 + 1, 10)).length).toBe(0);
  });

  it("opened/reopened emit the plain state word; edited is ignored (status-first)", async () => {
    const h = ghHarness();
    const opened = issueEvent("opened", { number: 2, state: "open" });
    const reopened = issueEvent("reopened", { number: 2, state: "open" });
    const edited = issueEvent("edited", { number: 2, state: "open" });
    await h.receiver.receive({ payload: Buffer.from(opened), signature: ghSign(opened) });
    await h.receiver.receive({ payload: Buffer.from(reopened), signature: ghSign(reopened) });
    const editedResult = await h.receiver.receive({
      payload: Buffer.from(edited),
      signature: ghSign(edited),
    });
    expect(editedResult).toMatchObject({ status: 200, outcome: "ignored" });
    // opened + reopened processed; edited ignored — two changes only.
    expect(h.changes).toHaveLength(2);
    expect(h.changes[0]!.change).toMatchObject({ externalId: "2", status: "open" });
  });

  it("a redelivery of the identical bytes is a duplicate (the D7 regression, per provider)", async () => {
    const h = ghHarness();
    const body = issueEvent("closed", { number: 3, state: "closed", state_reason: "completed" });
    const delivery = { payload: Buffer.from(body), signature: ghSign(body) };
    const first = await h.receiver.receive(delivery);
    expect(first).toMatchObject({ outcome: "processed" });
    const second = await h.receiver.receive(delivery);
    expect(second).toMatchObject({ status: 200, outcome: "duplicate" });
    expect(h.changes).toHaveLength(1);
  });
});
