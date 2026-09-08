/**
 * Local persistence is scoped per signed-in account (the owner's report:
 * creating a NEW account on the same browser showed the previous account's
 * projects as "Recents"). These tests pin the three contracts:
 *
 *   1. Two accounts never see each other's projects — the namespace switch
 *      is the boundary, and the boot auth check is what aims it.
 *   2. The first authenticating account adopts the pre-scoping global data
 *      once (nobody loses boards), and later accounts start clean.
 *   3. Sign-out returns to the legacy/global view — no account's boards.
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";

beforeAll(() => {
  const backing = new Map<string, string>();
  const shim: Storage = {
    get length(): number {
      return backing.size;
    },
    clear: () => backing.clear(),
    getItem: (k) => (backing.has(k) ? backing.get(k)! : null),
    key: (i) => [...backing.keys()][i] ?? null,
    removeItem: (k) => void backing.delete(k),
    setItem: (k, v) => void backing.set(k, String(v)),
  };
  Object.defineProperty(globalThis, "localStorage", {
    value: shim,
    configurable: true,
  });
});

// AFTER the shim: the module captures localStorage at import time.
import { createWorkspace } from "@lucent/core";
import {
  listProjects,
  saveProject,
  setPersistenceScope,
  newProjectId,
  setLastOpenProject,
  loadLastOpenProject,
} from "../src/persistence.js";

function project(name: string) {
  const id = newProjectId();
  return { id, name, workspace: createWorkspace({ name }), chat: [] };
}

beforeEach(() => {
  localStorage.clear();
  // Reset the module's in-memory scope between tests.
  setPersistenceScope(null);
});

describe("per-account persistence scoping", () => {
  it("a second account does not see the first account's projects", () => {
    setPersistenceScope("user_A");
    saveProject({ ...project("A's board") });
    expect(listProjects().map((p) => p.name)).toEqual(["A's board"]);

    setPersistenceScope("user_B");
    expect(listProjects()).toEqual([]);
  });

  it("both accounts' data coexist — switching back restores the list", () => {
    setPersistenceScope("user_A");
    saveProject({ ...project("A's board") });
    setPersistenceScope("user_B");
    saveProject({ ...project("B's board") });

    setPersistenceScope("user_A");
    expect(listProjects().map((p) => p.name)).toEqual(["A's board"]);
    setPersistenceScope("user_B");
    expect(listProjects().map((p) => p.name)).toEqual(["B's board"]);
  });

  it("the first authenticating account adopts legacy global projects, once", () => {
    // Pre-scoping data: written under the legacy global keys (scope is null).
    saveProject({ ...project("Legacy board") });
    expect(listProjects().map((p) => p.name)).toEqual(["Legacy board"]);

    // The first account authenticates: it inherits the existing boards.
    setPersistenceScope("user_A");
    expect(listProjects().map((p) => p.name)).toEqual(["Legacy board"]);

    // A second account does NOT inherit them (the claim was taken).
    setPersistenceScope("user_B");
    expect(listProjects()).toEqual([]);
  });

  it("sign-out drops to the global view; sign-in re-aims the account", () => {
    setPersistenceScope("user_A");
    saveProject({ ...project("A's board") });

    setPersistenceScope(null);
    expect(listProjects()).toEqual([]);

    setPersistenceScope("user_A");
    expect(listProjects().map((p) => p.name)).toEqual(["A's board"]);
  });

  it("the last-open pointer is scoped too", () => {
    const a = project("A's board");
    const b = project("B's board");

    setPersistenceScope("user_A");
    saveProject(a);
    setLastOpenProject(a.id);

    setPersistenceScope("user_B");
    saveProject(b);
    setLastOpenProject(b.id);

    setPersistenceScope("user_A");
    expect(loadLastOpenProject()?.name).toBe("A's board");
    setPersistenceScope("user_B");
    expect(loadLastOpenProject()?.name).toBe("B's board");
  });
});
