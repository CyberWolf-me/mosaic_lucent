import { describe, it, expect, vi } from "vitest";
import { isImageDataUrl } from "@lucent/core";
import { MockImageProvider, OpenAIImageProvider } from "../src/image.js";

/**
 * The mock emits base64 (the workspace schema refuses percent-encoded data
 * URLs, which can carry markup into an SVG sink), so assertions about the SVG
 * body have to decode it first.
 */
function decodeSvg(src: string): string {
  return Buffer.from(src.slice(src.indexOf(",") + 1), "base64").toString("utf8");
}

describe("MockImageProvider (Phase E)", () => {
  it("returns an SVG data URL for a prompt", async () => {
    const p = new MockImageProvider();
    const r = await p.generateImage({ prompt: "a friendly robot" });
    expect(r.src.startsWith("data:image/svg+xml")).toBe(true);
    expect(r.explanation).toContain("a friendly robot");
  });

  it("varies dimensions by size hint", async () => {
    const p = new MockImageProvider();
    const land = await p.generateImage({ prompt: "x", size: "landscape" });
    const port = await p.generateImage({ prompt: "x", size: "portrait" });
    expect(decodeSvg(land.src)).toContain('width="512"');
    expect(decodeSvg(port.src)).toContain('height="512"');
  });

  it("strips markup from the prompt label", async () => {
    const p = new MockImageProvider();
    const r = await p.generateImage({ prompt: "<script>alert(1)</script>" });
    expect(decodeSvg(r.src)).not.toContain("<script>");
  });

  it("emits a src the workspace schema accepts", async () => {
    const p = new MockImageProvider();
    const r = await p.generateImage({ prompt: "a friendly robot" });
    expect(isImageDataUrl(r.src)).toBe(true);
  });
});

describe("OpenAIImageProvider", () => {
  const OK_B64 = "iVBORw0KGgo=";

  function make(fetchImpl: typeof fetch) {
    return new OpenAIImageProvider({
      apiKey: "k",
      baseUrl: "https://api/v1/images/generations",
      fetchImpl,
    });
  }

  function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  it("returns a self-contained data URL rather than a remote link", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(200, { data: [{ b64_json: OK_B64 }] }));
    const result = await make(fetchImpl).generateImage({ prompt: "a cat" });
    expect(result.src).toBe(`data:image/png;base64,${OK_B64}`);
  });

  it("asks for bytes and maps the aspect hint to a size", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(200, { data: [{ b64_json: OK_B64 }] }));
    await make(fetchImpl).generateImage({ prompt: "a cat", size: "landscape" });

    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(body.response_format).toBe("b64_json");
    expect(body.size).toBe("1536x1024");
    expect(body.prompt).toBe("a cat");
  });

  it("surfaces a revised prompt as the explanation", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        jsonResponse(200, { data: [{ b64_json: OK_B64, revised_prompt: "a fluffy cat" }] }),
      );
    const result = await make(fetchImpl).generateImage({ prompt: "a cat" });
    expect(result.explanation).toBe("a fluffy cat");
  });

  it("accepts a URL when a gateway ignores response_format", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(200, { data: [{ url: "https://cdn/x.png" }] }));
    const result = await make(fetchImpl).generateImage({ prompt: "a cat" });
    expect(result.src).toBe("https://cdn/x.png");
    expect(result.explanation).toMatch(/may expire/i);
  });

  it("reports an HTTP failure with its status", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(429, { error: {} }));
    await expect(make(fetchImpl).generateImage({ prompt: "a cat" })).rejects.toThrow(/429/);
  });

  it("reports a provider error message", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(200, { error: { message: "content rejected" } }));
    await expect(make(fetchImpl).generateImage({ prompt: "x" })).rejects.toThrow(
      /content rejected/,
    );
  });

  it("errors when the response carries no image", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(200, { data: [] }));
    await expect(make(fetchImpl).generateImage({ prompt: "x" })).rejects.toThrow(/no image data/i);
  });

  it("requires a key and an endpoint", () => {
    expect(() => new OpenAIImageProvider({ apiKey: "", baseUrl: "https://x" })).toThrow(/apiKey/);
    expect(() => new OpenAIImageProvider({ apiKey: "k", baseUrl: "" })).toThrow(/baseUrl/);
  });

  it("tries fallback models when primary model fails", async () => {
    const modelsUsed: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation((_url, init) => {
      const parsed = JSON.parse(((init as RequestInit)?.body as string) ?? "{}");
      modelsUsed.push(parsed.model);
      if (parsed.model === "primary") {
        return Promise.resolve(jsonResponse(500, { error: { message: "Internal error" } }));
      }
      return Promise.resolve(jsonResponse(200, { data: [{ b64_json: OK_B64 }] }));
    });

    const provider = new OpenAIImageProvider({
      apiKey: "k",
      baseUrl: "https://api/v1/images/generations",
      model: "primary",
      fallbackModels: ["backup-1", "backup-2"],
      fetchImpl,
    });

    const res = await provider.generateImage({ prompt: "a cat" });
    expect(res.src).toBe(`data:image/png;base64,${OK_B64}`);
    expect(modelsUsed).toEqual(["primary", "backup-1"]);
  });
});
