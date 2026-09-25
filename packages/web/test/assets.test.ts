import { afterEach, describe, expect, it, vi } from "vitest";
import { applyOperations, createWorkspace } from "@lucent/core";
import { assetUrl, peekAssetData, preloadAssetData, uploadAsset, uploadGeneratedImage } from "../src/assets.js";
import { buildBoardSvg } from "../src/board/geometry.js";
import { isSafeImageSrc } from "../src/ui/ShapeToolbar.js";

/**
 * docs/26 §6.4: images on a shared board upload once and travel as a
 * reference, instead of riding the op log as megabytes. These pin the client
 * half of that contract: the upload request, the fallbacks, rendering a
 * reference, and inlining its bytes into an export.
 */

const REF = "asset:ast_abc123def";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("asset references", () => {
  it("render from the gateway, and pass the image guard", () => {
    expect(assetUrl(REF)).toBe("/api/assets/ast_abc123def");
    expect(assetUrl("data:image/png;base64,AAAA")).toBeUndefined();
    expect(isSafeImageSrc(REF)).toBe(true);
    expect(isSafeImageSrc("asset:../../etc/passwd")).toBe(false);
  });
});

describe("uploadAsset", () => {
  it("posts the bytes with CSRF, the mime and the board, and returns the reference", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit = {}) => {
        calls.push({ url, init });
        if (url === "/api/auth/csrf") return Response.json({ token: "csrf-1" });
        return Response.json({ ref: REF, id: "ast_abc123def" }, { status: 201 });
      }),
    );
    const ref = await uploadAsset(new Blob([PNG], { type: "image/png" }), "brd_1");
    expect(ref).toBe(REF);
    const post = calls.find((c) => c.url === "/api/assets")!;
    const headers = post.init.headers as Record<string, string>;
    expect(post.init.method).toBe("POST");
    expect(headers["x-csrf-token"]).toBe("csrf-1");
    expect(headers["x-lucent-asset-mime"]).toBe("image/png");
    expect(headers["x-lucent-board-id"]).toBe("brd_1");
    expect(post.init.credentials).toBe("include");
  });

  it("answers null — so the caller keeps the data URL — on a refusal or no network", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url === "/api/auth/csrf"
          ? Response.json({ token: "t" })
          : Response.json({ error: "quota" }, { status: 413 }),
      ),
    );
    expect(await uploadAsset(new Blob([PNG], { type: "image/png" }), "brd_1")).toBeNull();

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("offline");
      }),
    );
    expect(await uploadAsset(new Blob([PNG], { type: "image/png" }), "brd_1")).toBeNull();
  });

  it("never trusts a malformed reference from the server", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url === "/api/auth/csrf"
          ? Response.json({ token: "t" })
          : Response.json({ ref: "javascript:alert(1)" }, { status: 201 }),
      ),
    );
    expect(await uploadAsset(new Blob([PNG], { type: "image/png" }), "brd_1")).toBeNull();
  });
});

describe("uploadGeneratedImage", () => {
  const DATA_URL = `data:image/png;base64,${Buffer.from(PNG).toString("base64")}`;

  it("uploads a generated data URL on a shared board and returns the reference", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url === "/api/auth/csrf"
          ? Response.json({ token: "t" })
          : url === DATA_URL
            ? new Response(new Blob([PNG], { type: "image/png" }))
            : Response.json({ ref: REF, id: "ast_abc123def" }, { status: 201 }),
      ),
    );
    expect(await uploadGeneratedImage(DATA_URL, "brd_1")).toBe(REF);
  });

  it("keeps the data URL on a local board (no server to hold the bytes)", async () => {
    expect(await uploadGeneratedImage(DATA_URL, null)).toBe(DATA_URL);
  });

  it("keeps a src that isn't a data URL untouched", async () => {
    expect(await uploadGeneratedImage(REF, "brd_1")).toBe(REF);
    expect(await uploadGeneratedImage("https://cdn/x.png", "brd_1")).toBe("https://cdn/x.png");
  });

  it("falls back to the data URL when the upload is refused", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url === "/api/auth/csrf"
          ? Response.json({ token: "t" })
          : url === DATA_URL
            ? new Response(new Blob([PNG], { type: "image/png" }))
            : Response.json({ error: "quota" }, { status: 413 }),
      ),
    );
    expect(await uploadGeneratedImage(DATA_URL, "brd_1")).toBe(DATA_URL);
  });
});

describe("exports inline stored images", () => {
  it("fetches a reference's bytes once and embeds them; anything else stays a placeholder", async () => {
    const fetchSpy = vi.fn(async (url: string) =>
      url === "/api/assets/ast_abc123def"
        ? new Response(new Blob([PNG], { type: "image/png" }))
        : new Response("nope", { status: 404 }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    await preloadAssetData([REF, REF, "asset:ast_missing00", "https://example.com/x.png"]);
    expect(peekAssetData(REF)).toBe(`data:image/png;base64,${Buffer.from(PNG).toString("base64")}`);
    expect(peekAssetData("asset:ast_missing00")).toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    const ws = applyOperations(createWorkspace(), [
      {
        op: "CREATE_SHAPE",
        id: "img",
        kind: "image",
        position: { x: 0, y: 0 },
        size: { width: 80, height: 60 },
        src: REF,
      },
      {
        op: "CREATE_SHAPE",
        id: "gone",
        kind: "image",
        position: { x: 100, y: 0 },
        size: { width: 80, height: 60 },
        src: "asset:ast_missing00",
      },
    ]);
    const svg = buildBoardSvg(ws);
    expect(svg).toContain(`href="data:image/png;base64,`);
    expect(svg).toContain("Linked image");
  });
});
