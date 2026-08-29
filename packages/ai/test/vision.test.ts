import { describe, it, expect, vi } from "vitest";
import { AnthropicProvider, OpenAICompatibleProvider } from "../src/index.js";
import { buildUserPrompt, summarizeWorkspace } from "../src/index.js";
import { createWorkspace, TOOL_NAME } from "@lucent/core";

/**
 * Image and document input. Providers previously sent text-only messages, so an
 * attached screenshot or spec could not inform the answer at all.
 */

const PNG = { data: "iVBORw0KGgo=", mediaType: "image/png" };

const base = {
  message: "turn this screenshot into a wireframe",
  summary: summarizeWorkspace(createWorkspace()),
};

const OPS = [{ op: "CREATE_NODE", id: "a", nodeType: "note", label: "A" }];

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function openAiOk() {
  return jsonResponse({
    choices: [
      {
        message: {
          tool_calls: [
            { function: { name: TOOL_NAME, arguments: JSON.stringify({ operations: OPS }) } },
          ],
        },
      },
    ],
  });
}

function anthropicOk() {
  return jsonResponse({
    content: [{ type: "tool_use", name: TOOL_NAME, input: { operations: OPS } }],
  });
}

describe("OpenAI-compatible vision", () => {
  function make(fetchImpl: typeof fetch) {
    return new OpenAICompatibleProvider({
      apiKey: "k",
      baseUrl: "https://gw/v1/chat/completions",
      model: "m",
      fetchImpl,
      maxRetries: 1,
    });
  }

  it("sends an image as a content part alongside the text", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(openAiOk());
    await make(fetchImpl).generateOperations({ ...base, images: [PNG] });

    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    const content = body.messages[1].content;
    expect(Array.isArray(content)).toBe(true);
    expect(content[0].type).toBe("text");
    expect(content[1].type).toBe("image_url");
    expect(content[1].image_url.url).toBe(`data:image/png;base64,${PNG.data}`);
  });

  it("keeps a plain string body when there are no images", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(openAiOk());
    await make(fetchImpl).generateOperations(base);

    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    // A text-only gateway must be unaffected by the vision path existing.
    expect(typeof body.messages[1].content).toBe("string");
  });

  it("sends several images in one request", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(openAiOk());
    await make(fetchImpl).generateOperations({
      ...base,
      images: [PNG, { data: "AAAA", mediaType: "image/jpeg" }],
    });
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(
      body.messages[1].content.filter((c: { type: string }) => c.type === "image_url"),
    ).toHaveLength(2);
  });
});

describe("Anthropic vision", () => {
  function make(fetchImpl: typeof fetch) {
    return new AnthropicProvider({ apiKey: "k", baseUrl: "https://api/x", fetchImpl });
  }

  it("sends an image block before the text block", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(anthropicOk());
    await make(fetchImpl).generateOperations({ ...base, images: [PNG] });

    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    const content = body.messages[0].content;
    expect(content[0].type).toBe("image");
    expect(content[0].source).toEqual({
      type: "base64",
      media_type: "image/png",
      data: PNG.data,
    });
    expect(content[1].type).toBe("text");
  });

  it("keeps a plain string body when there are no images", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(anthropicOk());
    await make(fetchImpl).generateOperations(base);
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(typeof body.messages[0].content).toBe("string");
  });
});

describe("document and image context in the prompt", () => {
  it("includes attached document text", () => {
    const prompt = buildUserPrompt({
      ...base,
      documents: [{ name: "spec.md", text: "Refunds must complete in 14 days." }],
    });
    expect(prompt).toContain("Attached documents:");
    expect(prompt).toContain("spec.md");
    expect(prompt).toContain("Refunds must complete in 14 days.");
  });

  it("tells the model an image is attached", () => {
    const prompt = buildUserPrompt({ ...base, images: [PNG] });
    expect(prompt).toContain("attached 1 image");
  });

  it("pluralizes several images", () => {
    const prompt = buildUserPrompt({ ...base, images: [PNG, PNG] });
    expect(prompt).toContain("attached 2 images");
  });

  it("omits both sections when nothing is attached", () => {
    const prompt = buildUserPrompt(base);
    expect(prompt).not.toContain("Attached documents:");
    expect(prompt).not.toContain("attached");
  });
});
