import { describe, it, expect, vi } from "vitest";
import { isImageDataUrl } from "@lucent/core";
import { MockImageProvider, OpenAIImageProvider, sniffImageMime } from "../src/image.js";

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

  it("bounds the request with an abort signal so a stalled gateway can't hang", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(200, { data: [{ b64_json: OK_B64 }] }));
    await make(fetchImpl).generateImage({ prompt: "a cat" });
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
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

  it("labels the data URL with the type the bytes really are", async () => {
    // gpt-image models honour output_format jpeg/webp, and gateways return
    // whatever their backend drew: the declared type has to follow the bytes.
    const jpeg = bytes(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46);
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(200, { data: [{ b64_json: jpeg }] }));
    const result = await make(fetchImpl).generateImage({ prompt: "a cat" });
    expect(result.src).toBe(`data:image/jpeg;base64,${jpeg}`);
    expect(isImageDataUrl(result.src)).toBe(true);
  });

  it("keeps the PNG label for bytes it cannot identify", async () => {
    const unknown = bytes(0x00, 0x01, 0x02, 0x03, 0x04, 0x05);
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(200, { data: [{ b64_json: unknown }] }));
    const result = await make(fetchImpl).generateImage({ prompt: "a cat" });
    expect(result.src).toBe(`data:image/png;base64,${unknown}`);
  });
});

/** Base64 of raw bytes (Node test code, so Buffer is fine here). */
function bytes(...values: number[]): string {
  return Buffer.from(values).toString("base64");
}

/** Bytes of an ASCII signature followed by arbitrary data. */
function ascii(text: string, ...rest: number[]): string {
  return Buffer.concat([Buffer.from(text, "latin1"), Buffer.from(rest)]).toString("base64");
}

describe("sniffImageMime", () => {
  it("recognises PNG, JPEG, GIF and WebP by their magic bytes", () => {
    expect(sniffImageMime(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0))).toBe(
      "image/png",
    );
    expect(sniffImageMime(bytes(0xff, 0xd8, 0xff, 0xdb, 0, 0x43))).toBe("image/jpeg");
    expect(sniffImageMime(ascii("GIF89a", 1, 0, 1, 0))).toBe("image/gif");
    expect(sniffImageMime(ascii("GIF87a", 1, 0, 1, 0))).toBe("image/gif");
    expect(sniffImageMime(ascii("RIFF$\0\0\0WEBPVP8 "))).toBe("image/webp");
  });

  it("does not call every RIFF file WebP", () => {
    // A WAV file is RIFF too; only the WEBP form type at byte 8 counts.
    expect(sniffImageMime(ascii("RIFF$\0\0\0WAVEfmt "))).toBeNull();
  });

  it("returns null for unknown bytes, text, and malformed base64", () => {
    expect(sniffImageMime(bytes(0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11))).toBeNull();
    expect(sniffImageMime(ascii("<svg xmlns="))).toBeNull();
    expect(sniffImageMime("!!!not base64!!!")).toBeNull();
    expect(sniffImageMime("")).toBeNull();
  });

  it("tolerates line-wrapped base64", () => {
    const png = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d);
    expect(sniffImageMime(`${png.slice(0, 8)}\n${png.slice(8)}`)).toBe("image/png");
  });
});
