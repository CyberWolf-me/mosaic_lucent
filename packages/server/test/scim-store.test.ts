import { describe, expect, it } from "vitest";
import { InMemoryScimIdentityStore } from "../src/scim.js";

/**
 * In-memory SCIM identity store parity (M6 / F1).
 *
 * The Postgres-backed store (pg-scim-identities.ts) shares this interface
 * and is gated on `LUCENT_TEST_DATABASE_URL`; the parity path lives in
 * pg-store.test.ts. This file pins the in-memory contract the route handlers
 * rely on: idempotent insert, by-external and by-user lookups, list-for-idp
 * filtering, and the "remove-or-not-found" boolean.
 */

const idp = "okta";

describe("in-memory scim identity store", () => {
  it("inserts and looks up by external id", async () => {
    const s = new InMemoryScimIdentityStore();
    await s.insert({ idp, externalId: "ext-1", userId: "usr_a", createdAt: 100 });
    expect(await s.byExternalId(idp, "ext-1")).toEqual({
      idp,
      externalId: "ext-1",
      userId: "usr_a",
      createdAt: 100,
    });
  });

  it("inserts are idempotent on (idp, externalId)", async () => {
    const s = new InMemoryScimIdentityStore();
    await s.insert({ idp, externalId: "ext-1", userId: "usr_a", createdAt: 100 });
    // A second insert with the same external id should NOT change the
    // pairing — re-provisioning is a no-op in v1 (the SCIM handler turns
    // re-inserts into a 200 "already exists" reply).
    await s.insert({ idp, externalId: "ext-1", userId: "usr_b", createdAt: 200 });
    expect(await s.byExternalId(idp, "ext-1")).toEqual({
      idp,
      externalId: "ext-1",
      userId: "usr_a",
      createdAt: 100,
    });
  });

  it("filters listForIdp by IdP label", async () => {
    const s = new InMemoryScimIdentityStore();
    await s.insert({ idp, externalId: "ext-1", userId: "usr_a", createdAt: 100 });
    await s.insert({ idp, externalId: "ext-2", userId: "usr_b", createdAt: 200 });
    await s.insert({ idp: "azure", externalId: "ext-3", userId: "usr_c", createdAt: 300 });
    const oktaRows = await s.listForIdp(idp);
    expect(oktaRows.map((r) => r.externalId).sort()).toEqual(["ext-1", "ext-2"]);
    const azureRows = await s.listForIdp("azure");
    expect(azureRows).toEqual([
      { idp: "azure", externalId: "ext-3", userId: "usr_c", createdAt: 300 },
    ]);
  });

  it("remove returns true only when the row existed", async () => {
    const s = new InMemoryScimIdentityStore();
    await s.insert({ idp, externalId: "ext-1", userId: "usr_a", createdAt: 100 });
    expect(await s.remove(idp, "ext-1")).toBe(true);
    expect(await s.remove(idp, "ext-1")).toBe(false);
  });

  it("lookups return undefined for unknown rows", async () => {
    const s = new InMemoryScimIdentityStore();
    expect(await s.byExternalId(idp, "nope")).toBeUndefined();
    expect(await s.byUserId(idp, "nope")).toBeUndefined();
    expect(await s.listForIdp(idp)).toEqual([]);
  });

  it("the same external id on a different IdP is independent", async () => {
    const s = new InMemoryScimIdentityStore();
    await s.insert({ idp: "okta", externalId: "shared-1", userId: "usr_a", createdAt: 100 });
    await s.insert({ idp: "azure", externalId: "shared-1", userId: "usr_b", createdAt: 200 });
    expect((await s.byExternalId("okta", "shared-1"))?.userId).toBe("usr_a");
    expect((await s.byExternalId("azure", "shared-1"))?.userId).toBe("usr_b");
  });
});
