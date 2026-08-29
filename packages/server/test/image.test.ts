import { describe, it, expect } from "vitest";
import { MockImageProvider } from "@lucent/ai";
import { handleImage, selectImageProvider } from "../src/image.js";

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
});
