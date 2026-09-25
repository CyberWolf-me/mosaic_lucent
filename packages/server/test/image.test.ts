import { afterEach, describe, it, expect, vi } from "vitest";
import { MockImageProvider } from "@lucent/ai";
import { handleImage, imageTimeoutMs, selectImageProvider } from "../src/image.js";

const provider = new MockImageProvider();

describe("handleImage (Phase E)", () => {
  it("returns a generated image src for a valid prompt", async () => {
    const res = await handleImage(provider, { prompt: "a mountain at dawn", size: "landscape" });
    expect(res.status).toBe(200);
    const body = res.body as { src: string; provider: string };
    expect(body.src.startsWith("data:image/")).toBe(true);
    expect(body.provider).toBe("mock-image");
  });

  it("rejects an empty prompt with 400", async () => {
    const res = await handleImage(provider, { prompt: "" });
    expect(res.status).toBe(400);
  });

  it("rejects a malformed body with 400", async () => {
    const res = await handleImage(provider, { nope: true });
    expect(res.status).toBe(400);
  });
});

describe("selectImageProvider", () => {
  it("falls back to the placeholder generator with no configuration", () => {
    expect(selectImageProvider({}).name).toBe("mock-image");
  });

  it("uses a real backend when a key and endpoint are both present", () => {
    const provider = selectImageProvider({
      LUCENT_IMAGE_KEY: "k",
      LUCENT_IMAGE_BASE_URL: "https://api/v1/images/generations",
    });
    expect(provider.name).toBe("openai-image");
  });

  it("accepts OPENAI_API_KEY as the key", () => {
    expect(
      selectImageProvider({
        OPENAI_API_KEY: "k",
        LUCENT_IMAGE_BASE_URL: "https://api/v1/images/generations",
      }).name,
    ).toBe("openai-image");
  });

  it("stays on the mock when only half the configuration is present", () => {
    // A key with no endpoint (or vice versa) is a misconfiguration, not a
    // reason to start sending requests somewhere unknown.
    expect(selectImageProvider({ LUCENT_IMAGE_KEY: "k" }).name).toBe("mock-image");
    expect(selectImageProvider({ LUCENT_IMAGE_BASE_URL: "https://api/x" }).name).toBe("mock-image");
  });

  it("honours a friendly provider name", () => {
    expect(
      selectImageProvider({
        LUCENT_IMAGE_KEY: "k",
        LUCENT_IMAGE_BASE_URL: "https://api/x",
        LUCENT_IMAGE_NAME: "azure-images",
      }).name,
    ).toBe("azure-images");
  });

  it("normalizes baseUrl and parses comma-separated models", () => {
    const provider = selectImageProvider({
      LUCENT_IMAGE_KEY: "k",
      LUCENT_IMAGE_BASE_URL: "https://api/v1",
      LUCENT_IMAGE_MODEL: "gpt-image-2.5,gpt-image-2",
    });
    expect(provider.name).toBe("openai-image");
    expect(provider.model).toBe("gpt-image-2.5");
  });
});

describe("image timeout (LUCENT_IMAGE_TIMEOUT_MS)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("takes only a positive integer, falling through to the shared AI timeout, then the default", () => {
    expect(imageTimeoutMs({ LUCENT_IMAGE_TIMEOUT_MS: "30000" })).toBe(30000);
    expect(imageTimeoutMs({ LUCENT_IMAGE_TIMEOUT_MS: "1500.7" })).toBe(1500);
    expect(imageTimeoutMs({ LUCENT_AI_TIMEOUT_MS: "9000" })).toBe(9000);
    expect(imageTimeoutMs({ LUCENT_IMAGE_TIMEOUT_MS: "20000", LUCENT_AI_TIMEOUT_MS: "9000" })).toBe(20000);
    for (const bad of ["0", "-5", "abc", "", " ", "Infinity", "NaN"]) {
      expect(imageTimeoutMs({ LUCENT_IMAGE_TIMEOUT_MS: bad }), bad).toBeUndefined();
      expect(imageTimeoutMs({ LUCENT_IMAGE_TIMEOUT_MS: bad, LUCENT_AI_TIMEOUT_MS: "9000" }), bad).toBe(9000);
    }
    expect(imageTimeoutMs({})).toBeUndefined();
  });

  it("a zero or negative setting no longer breaks generation", async () => {
    // Before: "0" became a 0 ms signal that aborted every call, and "-5" made
    // AbortSignal.timeout throw a RangeError before the request was sent.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit = {}) => {
        await new Promise((r) => setTimeout(r, 5));
        if (init.signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
        return Response.json({ data: [{ b64_json: "AAAA" }] });
      }),
    );
    for (const bad of ["0", "-5"]) {
      const provider = selectImageProvider({
        LUCENT_IMAGE_KEY: "k",
        LUCENT_IMAGE_BASE_URL: "https://api/v1",
        LUCENT_IMAGE_TIMEOUT_MS: bad,
      });
      await expect(provider.generateImage({ prompt: "a lighthouse" }), bad).resolves.toMatchObject({
        src: "data:image/png;base64,AAAA",
      });
    }
  });
});
