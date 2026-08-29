import { describe, it, expect, vi, afterEach } from "vitest";
import { createWorkspace } from "@lucent/core";
import { fetchBoard, listBoards, saveBoard } from "../src/boards.js";

/**
 * The board REST client is what turns a local board into a shareable one — the
 * realtime room is keyed by board id, so this call has to happen before anyone
 * can join. Previously the web app never called these endpoints at all, which is
 * why multiplayer was unreachable despite a working server.
 */
const store: Record<string, string> = {};
Object.defineProperty(globalThis, "localStorage", {
  value: {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => {
      store[k] = v;
    },
    removeItem: (k: string) => {
      delete store[k];
    },
  },
  configurable: true,
});

afterEach(() => {
  vi.restoreAllMocks();
  delete store["lucent.token"];
});

function signedIn() {
  store["lucent.token"] = "tok123";
}

describe("board client", () => {
  it("does not call the server when signed out", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await saveBoard("org_1", "b", createWorkspace())).toBeNull();
    expect(await listBoards("org_1")).toEqual([]);
    expect(await fetchBoard("x")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends the bearer token and the workspace when publishing", async () => {
    signedIn();
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(
        new Response(JSON.stringify({ id: "brd_1", name: "b", updatedAt: 1 }), { status: 201 }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const out = await saveBoard("org_1", "b", createWorkspace());
    expect(out?.id).toBe("brd_1");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/boards");
    expect(init!.method).toBe("POST");
    expect((init!.headers as Record<string, string>).authorization).toBe("Bearer tok123");
    expect(JSON.parse(String(init!.body)).workspace).toBeTruthy();
    // The tenant has to be on the wire: without it the server publishes into
    // `memberships[0]` (app.ts:2183), an arbitrary org for anyone in two.
    expect(JSON.parse(String(init!.body)).orgId).toBe("org_1");
    expect(out?.orgId).toBe("org_1");
  });

  it("passes an id when updating an existing board in place", async () => {
    signedIn();
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(
        new Response(JSON.stringify({ id: "brd_1", name: "b", updatedAt: 2 }), { status: 201 }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    await saveBoard("org_1", "b", createWorkspace(), "brd_1");
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body)).id).toBe("brd_1");
  });

  it("returns null rather than throwing when the server refuses", async () => {
    signedIn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 403 })),
    );
    expect(await saveBoard("org_1", "b", createWorkspace())).toBeNull();
    expect(await fetchBoard("brd_1")).toBeNull();
  });

  it("lists boards from the boards field", async () => {
    signedIn();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ boards: [{ id: "a", name: "A", updatedAt: 1 }] }), {
            status: 200,
          }),
      ),
    );
    expect((await listBoards("org_1")).map((b) => b.id)).toEqual(["a"]);
  });

  it("fetches one board with its workspace", async () => {
    signedIn();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ id: "a", name: "A", workspace: createWorkspace() }), {
            status: 200,
          }),
      ),
    );
    const b = await fetchBoard("a");
    expect(b?.workspace.nodes).toEqual({});
  });

  it("scopes the list request to one org and leaves scope to the server default", async () => {
    signedIn();
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(new Response(JSON.stringify({ boards: [] }), { status: 200 })),
    );
    vi.stubGlobal("fetch", fetchMock);
    await listBoards("org_1");
    // `GET /api/boards` with no orgId answers 400 `orgId query parameter
    // required` (app.ts:2277), which is why the no-argument version of this
    // call returned [] for every caller, always.
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/boards?orgId=org_1");
  });

  it("asks for the shared scope when told to", async () => {
    signedIn();
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(new Response(JSON.stringify({ boards: [] }), { status: 200 })),
    );
    vi.stubGlobal("fetch", fetchMock);
    await listBoards("org_1", "shared");
    // The scope an outside collaborator needs: it lists what they hold a
    // `board_members` row on without requiring an org membership.
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/boards?orgId=org_1&scope=shared");
  });
});
