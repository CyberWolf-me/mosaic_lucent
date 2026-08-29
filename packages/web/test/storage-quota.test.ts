import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { onStorageError, saveProject } from "../src/persistence.js";
import { createWorkspace } from "@lucent/core";

/**
 * Storage-quota handling (M0.5). Autosave used to throw silently when
 * localStorage was full, so the user kept editing a board that would not
 * survive a reload. The write is now guarded and reports through a listener.
 */

interface FakeStorage {
  store: Map<string, string>;
  full: boolean;
}

let fake: FakeStorage;

beforeEach(() => {
  fake = { store: new Map(), full: false };
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => fake.store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (fake.full) {
        const err = new Error("QuotaExceededError: storage is full");
        err.name = "QuotaExceededError";
        throw err;
      }
      fake.store.set(k, v);
    },
    removeItem: (k: string) => {
      fake.store.delete(k);
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("saveProject under a full quota", () => {
  it("writes normally when there is room", () => {
    const messages: string[] = [];
    const off = onStorageError((m) => messages.push(m));
    const result = saveProject({
      id: "p1",
      name: "Board",
      workspace: createWorkspace(),
      chat: [],
    });
    off();
    expect(result.id).toBe("p1");
    expect(messages).toHaveLength(0);
    // Both the project and the index were written.
    expect(fake.store.size).toBeGreaterThanOrEqual(2);
  });

  it("reports through the listener instead of throwing", () => {
    fake.full = true;
    const messages: string[] = [];
    const off = onStorageError((m) => messages.push(m));
    // The call must not throw — the caller (autosave) has no recovery path.
    expect(() =>
      saveProject({ id: "p1", name: "Board", workspace: createWorkspace(), chat: [] }),
    ).not.toThrow();
    off();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("Local storage is full");
  });

  it("skips the index write when the project write failed", () => {
    fake.full = true;
    const messages: string[] = [];
    const off = onStorageError((m) => messages.push(m));
    saveProject({ id: "p1", name: "Board", workspace: createWorkspace(), chat: [] });
    off();
    // One message, not two: writing the index after a failed project write
    // would leave a dashboard entry pointing at a board that isn't there.
    expect(messages).toHaveLength(1);
  });

  it("unsubscribes cleanly", () => {
    const messages: string[] = [];
    const off = onStorageError((m) => messages.push(m));
    off();
    fake.full = true;
    saveProject({ id: "p1", name: "Board", workspace: createWorkspace(), chat: [] });
    expect(messages).toHaveLength(0);
  });

  it("still returns a record so the caller's state stays coherent", () => {
    fake.full = true;
    const off = onStorageError(() => {});
    const result = saveProject({
      id: "p9",
      name: "Unsaved",
      workspace: createWorkspace(),
      chat: [],
    });
    off();
    expect(result.id).toBe("p9");
    expect(result.updatedAt).toBeGreaterThan(0);
  });
});
