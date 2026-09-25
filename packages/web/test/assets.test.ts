import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyOperations, createWorkspace } from "@lucent/core";
import {
  assetUrl,
  dataUrlToBlob,
  peekAssetData,
  preloadAssetData,
  uploadAsset,
  uploadGeneratedImage,
} from "../src/assets.js";
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

// A failed upload now says so on the console; keep the suite's output clean
// and let the tests that care read the spy.
let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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

describe("dataUrlToBlob", () => {
  it("decodes base64 in-process, with the declared type", async () => {
    const blob = dataUrlToBlob(`data:image/png;base64,${Buffer.from(PNG).toString("base64")}`);
    expect(blob.type).toBe("image/png");
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(PNG);
  });

  it("decodes a percent-encoded (non-base64) payload", async () => {
    const blob = dataUrlToBlob("data:image/svg+xml;charset=utf-8,%3Csvg%2F%3E");
    expect(blob.type).toBe("image/svg+xml");
    expect(await blob.text()).toBe("<svg/>");
  });

  it("throws on something that isn't a data URL", () => {
    expect(() => dataUrlToBlob("https://example.com/x.png")).toThrow();
    expect(() => dataUrlToBlob("data:image/png;base64")).toThrow();
  });
});

describe("uploadGeneratedImage", () => {
  const DATA_URL = `data:image/png;base64,${Buffer.from(PNG).toString("base64")}`;

  it("uploads a generated data URL on a shared board — decoded without fetch(data:)", async () => {
    // The production CSP (connect-src 'self' https: wss:) refuses fetch() of a
    // data: URL, so the bytes must never be read that way.
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit = {}) => {
        calls.push({ url, init });
        if (url.startsWith("data:")) throw new TypeError("Refused to connect: CSP connect-src");
        return url === "/api/auth/csrf"
          ? Response.json({ token: "t" })
          : Response.json({ ref: REF, id: "ast_abc123def" }, { status: 201 });
      }),
    );
    expect(await uploadGeneratedImage(DATA_URL, "brd_1")).toBe(REF);
    expect(calls.some((c) => c.url.startsWith("data:"))).toBe(false);
    const post = calls.find((c) => c.url === "/api/assets")!;
    const body = post.init.body as Blob;
    expect(body.type).toBe("image/png");
    expect(new Uint8Array(await body.arrayBuffer())).toEqual(PNG);
    expect(warn).not.toHaveBeenCalled();
  });

  it("keeps the mock's SVG inline without posting it (the store refuses SVG by design)", async () => {
    const fetchSpy = vi.fn(async () => Response.json({ error: "unsupported" }, { status: 415 }));
    vi.stubGlobal("fetch", fetchSpy);
    const svg = "data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%2F%3E";
    expect(await uploadGeneratedImage(svg, "brd_1")).toBe(svg);
    expect(await uploadGeneratedImage("data:image/svg+xml;base64,PHN2Zy8+", "brd_1")).toBe(
      "data:image/svg+xml;base64,PHN2Zy8+",
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("keeps a malformed data URL inline, and says why once", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const broken = "data:image/png;base64,@@not-base64@@";
    expect(await uploadGeneratedImage(broken, "brd_1")).toBe(broken);
    expect(await uploadGeneratedImage(broken, "brd_1")).toBe(broken);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toMatch(/couldn't be decoded/);
  });

  it("keeps the data URL on a local board (no server to hold the bytes)", async () => {
    expect(await uploadGeneratedImage(DATA_URL, null)).toBe(DATA_URL);
  });

  it("keeps a src that isn't a data URL untouched", async () => {
    expect(await uploadGeneratedImage(REF, "brd_1")).toBe(REF);
    expect(await uploadGeneratedImage("https://cdn/x.png", "brd_1")).toBe("https://cdn/x.png");
  });

  it("falls back to the data URL when the upload is refused, warning once per reason", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url === "/api/auth/csrf"
          ? Response.json({ token: "t" })
          : Response.json({ error: "storage full" }, { status: 507 }),
      ),
    );
    expect(await uploadGeneratedImage(DATA_URL, "brd_1")).toBe(DATA_URL);
    expect(await uploadGeneratedImage(DATA_URL, "brd_1")).toBe(DATA_URL);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toMatch(/HTTP 507/);
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
