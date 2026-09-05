import { describe, expect, it } from "vitest";
import { FakeProvider, type RecordedCall } from "../src/integrations/fake.js";
import {
  connectionView,
  InMemoryIntegrationStore,
  INTEGRATION_PROVIDERS,
  normalizeConnection,
} from "../src/integrations/integrations.js";

/**
 * The integration seam (Stage D4, ADR 0030): the FakeProvider behaves like a
 * real system (deterministic ids, real translation both ways, a change bus),
 * and the store holds connections + links with the scoping discipline every
 * store follows — org-scoped connections, board-scoped links, a leaked id is
 * not a read. Credentials are references; the admin view fingerprints them.
 */

describe("FakeProvider", () => {
  it("creates deterministic tasks with urls, mapping the D1 status to the fake vocabulary", async () => {
    const fake = new FakeProvider();
    const t1 = await fake.createTask({ title: "Prepare launch brief", assignee: "David", dueDate: "2026-09-11", status: "assigned" });
    const t2 = await fake.createTask({ title: "QA pass", status: "in_progress" });
    expect(t1.externalId).toBe("fake-1");
    expect(t1.url).toBe("https://fake.example.com/task/fake-1");
    expect(t1.status).toBe("todo"); // assigned → todo (the fake's word)
    expect(t1.assignee).toBe("David");
    expect(t2.externalId).toBe("fake-2");
    expect(t2.status).toBe("active"); // in_progress → active
    expect(fake.taskCount).toBe(2);
  });

  it("updateTask patches in place and translates the status; a ghost id rejects", async () => {
    const fake = new FakeProvider();
    const created = await fake.createTask({ title: "Implementation" });
    const updated = await fake.updateTask(created.externalId, { status: "completed" });
    expect(updated.status).toBe("done"); // completed → done
    expect(updated.title).toBe("Implementation"); // untouched fields stay
    await expect(fake.updateTask("fake-999", { title: "x" })).rejects.toThrow(/does not exist/);
  });

  it("getTask and searchTasks read what was created; search matches title and id", async () => {
    const fake = new FakeProvider();
    await fake.createTask({ title: "Design approval" });
    await fake.createTask({ title: "QA pass" });
    const got = await fake.getTask("fake-2");
    expect(got.title).toBe("QA pass");
    const byTitle = await fake.searchTasks("design");
    expect(byTitle.map((t) => t.externalId)).toEqual(["fake-1"]);
    const byId = await fake.searchTasks("fake-2");
    expect(byId).toHaveLength(1);
  });

  it("mapStatus translates the fake vocabulary into the D1 canonical set", async () => {
    const fake = new FakeProvider();
    expect(fake.mapStatus("todo")).toBe("open");
    expect(fake.mapStatus("active")).toBe("in_progress");
    expect(fake.mapStatus("blocked")).toBe("blocked");
    expect(fake.mapStatus("done")).toBe("completed");
    expect(fake.mapStatus("canceled")).toBe("cancelled");
    // An unknown word returns undefined — NEVER a guess (ADR 0032's rule,
    // the D6 correction): the surface preserves Lucent state and warns.
    expect(fake.mapStatus("whatever")).toBeUndefined();
  });

  it("records every call so tests assert what the platform asked for", async () => {
    const fake = new FakeProvider();
    await fake.createTask({ title: "A" });
    await fake.updateTask("fake-1", { status: "completed" });
    const calls: RecordedCall[] = fake.calls;
    expect(calls.map((c) => c.method)).toEqual(["createTask", "updateTask"]);
    expect(calls[1]!.externalId).toBe("fake-1");
  });

  it("the declared D7 seam works in-memory: emitChange reaches subscribers, unsubscribe stops them", async () => {
    const fake = new FakeProvider();
    const heard: string[] = [];
    const off = fake.subscribeToChanges((change) => heard.push(change.status));
    fake.emitChange("fake-1", "done");
    off();
    fake.emitChange("fake-1", "active");
    expect(heard).toEqual(["done"]); // the second emission landed on nobody
  });
});

describe("InMemoryIntegrationStore", () => {
  const NOW = 1_000;
  const LATER = 2_000;

  it("putConnection is an idempotent upsert by (orgId, provider)", async () => {
    const store = new InMemoryIntegrationStore();
    const first = await store.putConnection(
      { orgId: "org1", provider: "fake", credentialRef: "LUCENT_FAKE_KEY", createdBy: "u1" },
      NOW,
    );
    expect(first.status).toBe("active");
    const second = await store.putConnection(
      { orgId: "org1", provider: "fake", credentialRef: "LUCENT_FAKE_KEY_V2", scopes: ["tasks:write"], createdBy: "u1" },
      LATER,
    );
    // One connection per (org, provider): the second PUT replaced, not stacked.
    const all = await store.connectionsForOrg("org1");
    expect(all).toHaveLength(1);
    expect(all[0]!.credentialRef).toBe("LUCENT_FAKE_KEY_V2");
    expect(all[0]!.scopes).toEqual(["tasks:write"]);
    expect(all[0]!.updatedAt).toBe(LATER);
    expect(second.id).toBe(first.id);
  });

  it("connections are org-scoped; another org sees none", async () => {
    const store = new InMemoryIntegrationStore();
    await store.putConnection({ orgId: "org1", provider: "fake", credentialRef: "R", createdBy: "u" }, NOW);
    expect(await store.connectionsForOrg("org2")).toEqual([]);
    expect(await store.connection("org2", "fake")).toBeUndefined();
    expect(await store.connection("org1", "fake")).toBeDefined();
  });

  it("setConnectionStatus disables without deleting — the reference survives the audit trail", async () => {
    const store = new InMemoryIntegrationStore();
    await store.putConnection({ orgId: "org1", provider: "fake", credentialRef: "R", createdBy: "u" }, NOW);
    expect(await store.setConnectionStatus("org1", "fake", "disabled", LATER)).toBe(true);
    const c = await store.connection("org1", "fake");
    expect(c!.status).toBe("disabled");
    expect(c!.credentialRef).toBe("R"); // still there
    expect(await store.setConnectionStatus("org1", "linear", "disabled", LATER)).toBe(false);
  });

  it("linkTask upserts by (board, node, provider) — re-link replaces, never stacks", async () => {
    const store = new InMemoryIntegrationStore();
    const l1 = await store.linkTask(
      { orgId: "org1", boardId: "b1", nodeId: "n1", provider: "fake", externalId: "fake-1", url: "u", lastSyncedStatus: "todo" },
      NOW,
    );
    await store.linkTask(
      { orgId: "org1", boardId: "b1", nodeId: "n1", provider: "fake", externalId: "fake-9", lastSyncedStatus: "done" },
      LATER,
    );
    const links = await store.linksForNode("b1", "n1");
    expect(links).toHaveLength(1);
    expect(links[0]!.externalId).toBe("fake-9");
    expect(links[0]!.url).toBe("u"); // url survives a re-link without one
    expect(links[0]!.lastSyncedStatus).toBe("done");
    expect(links[0]!.syncedAt).toBe(LATER);
    expect(l1.id).toBe(links[0]!.id);
  });

  it("links are board-scoped; another board's link list does not leak", async () => {
    const store = new InMemoryIntegrationStore();
    await store.linkTask(
      { orgId: "org1", boardId: "b1", nodeId: "n1", provider: "fake", externalId: "fake-1", lastSyncedStatus: "todo" },
      NOW,
    );
    expect(await store.linksForBoard("b2")).toEqual([]);
    expect(await store.linksForNode("b2", "n1")).toEqual([]);
    // Same node id on another board is a DIFFERENT link (board+node is the key).
    await store.linkTask(
      { orgId: "org1", boardId: "b2", nodeId: "n1", provider: "fake", externalId: "fake-2", lastSyncedStatus: "todo" },
      NOW,
    );
    expect((await store.linksForBoard("b1")).map((l) => l.externalId)).toEqual(["fake-1"]);
    expect((await store.linksForBoard("b2")).map((l) => l.externalId)).toEqual(["fake-2"]);
  });

  it("unlink drops exactly the (board, node, provider) link", async () => {
    const store = new InMemoryIntegrationStore();
    await store.linkTask({ orgId: "o", boardId: "b1", nodeId: "n1", provider: "fake", externalId: "fake-1", lastSyncedStatus: "todo" }, NOW);
    await store.linkTask({ orgId: "o", boardId: "b1", nodeId: "n1", provider: "linear", externalId: "LIN-1", lastSyncedStatus: "todo" }, NOW);
    expect(await store.unlink("b1", "n1", "fake")).toBe(true);
    expect(await store.linksForNode("b1", "n1")).toHaveLength(1); // linear stays
    expect(await store.unlink("b1", "n1", "fake")).toBe(false); // already gone
  });

  it("normalizeConnection rejects unknown providers and bad references", () => {
    expect(() =>
      normalizeConnection({ orgId: "o", provider: "linearz" as never, credentialRef: "R", createdBy: "u" }),
    ).toThrow(/unknown provider/);
    expect(() =>
      normalizeConnection({ orgId: "o", provider: "fake", credentialRef: "   ", createdBy: "u" }),
    ).toThrow(/credentialRef/);
    // The known set is the D4/D8 vocabulary.
    expect(INTEGRATION_PROVIDERS).toContain("fake");
    expect(INTEGRATION_PROVIDERS).toContain("linear");
  });

  it("the admin view fingerprints the reference, never echoes it in full", async () => {
    const store = new InMemoryIntegrationStore();
    const c = await store.putConnection(
      { orgId: "org1", provider: "fake", credentialRef: "LUCENT_VERY_LONG_SECRET_REFERENCE_NAME", createdBy: "u1" },
      NOW,
    );
    const view = connectionView(c);
    expect(view.credentialRef).toBe("LUCE…(38 chars)");
    expect(JSON.stringify(view)).not.toContain("LUCENT_VERY_LONG_SECRET_REFERENCE_NAME");
    expect(view.status).toBe("active");
  });
});
