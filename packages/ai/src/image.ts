/**
 * Image generation is a separate provider from the LLM (docs/15 Phase E). The
 * LLM emits structured operations and NEVER draws; generated images are a
 * distinct media object. Keeping this behind its own interface preserves the
 * "diagrams stay semantic, generated visuals are media" rule (docs/14 §7).
 */
export interface ImageRequest {
  prompt: string;
  /** Optional aspect hint; providers may ignore it. */
  size?: "square" | "landscape" | "portrait";
}

export interface ImageResult {
  /** Data URL or remote URL of the generated image. */
  src: string;
  /** Natural-language note for the conversation pane. */
  explanation?: string;
}

export interface ImageProvider {
  readonly name: string;
  /**
   * The model this provider draws with, when it has a name for one. Exposed on
   * the provider rather than on ImageResult because the result is spread
   * straight into the HTTP response — the meter needs the model id, the client
   * has no use for it (M4).
   */
  readonly model?: string;
  generateImage(request: ImageRequest): Promise<ImageResult>;
}

/**
 * Offline mock: renders the prompt into a deterministic SVG data URL so the
 * whole generate → place-on-canvas flow works with no key or network (mirrors
 * MockProvider for the LLM). Not real generation — it exercises the pipeline.
 */
/**
 * Base64 without Buffer: this module is imported by the web bundle as well as
 * the server. The workspace schema only accepts base64 data URLs (a
 * percent-encoded one can carry quotes and angle brackets into an SVG sink),
 * so the mock has to emit the same form a real provider does.
 */
function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export class MockImageProvider implements ImageProvider {
  readonly name = "mock-image";

  async generateImage(request: ImageRequest): Promise<ImageResult> {
    const dims =
      request.size === "landscape"
        ? [512, 320]
        : request.size === "portrait"
          ? [320, 512]
          : [400, 400];
    const [w, h] = dims;
    const safe = request.prompt.replace(/[<>&]/g, "").slice(0, 40);
    const hue = [...request.prompt].reduce((a, c) => a + c.charCodeAt(0), 0) % 360;
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
      `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
      `<stop offset="0" stop-color="hsl(${hue} 70% 55%)"/>` +
      `<stop offset="1" stop-color="hsl(${(hue + 60) % 360} 70% 40%)"/></linearGradient></defs>` +
      `<rect width="${w}" height="${h}" fill="url(#g)"/>` +
      `<text x="50%" y="50%" fill="white" font-family="sans-serif" font-size="16" text-anchor="middle" dominant-baseline="middle">${safe}</text></svg>`;
    const src = `data:image/svg+xml;base64,${toBase64(svg)}`;
    return { src, explanation: `Generated a placeholder visual for "${safe}".` };
  }
}

/**
 * Real image generation against an OpenAI-compatible `/v1/images/generations`
 * endpoint (OpenAI, Azure OpenAI, or a gateway that mirrors the shape).
 *
 * Dependency-free like the text providers, and it returns a data URL so a
 * generated image lands on the board as a self-contained shape — a remote URL
 * would break the moment the provider expired it, and would leak board contents
 * to whoever later fetched it.
 */
export interface OpenAIImageOptions {
  apiKey: string;
  /** Full images endpoint, e.g. https://api.openai.com/v1/images/generations */
  baseUrl: string;
  model?: string;
  fetchImpl?: typeof fetch;
  name?: string;
}

interface ImagesResponse {
  data?: Array<{ b64_json?: string; url?: string; revised_prompt?: string }>;
  error?: { message?: string };
}

const SIZE_MAP: Record<NonNullable<ImageRequest["size"]>, string> = {
  square: "1024x1024",
  landscape: "1536x1024",
  portrait: "1024x1536",
};

export class OpenAIImageProvider implements ImageProvider {
  readonly name: string;
  readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAIImageOptions) {
    if (!options.apiKey) throw new Error("OpenAIImageProvider requires an apiKey");
    if (!options.baseUrl) throw new Error("OpenAIImageProvider requires a baseUrl");
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl;
    this.model = options.model ?? "gpt-image-1";
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.name = options.name ?? "openai-image";
  }

  async generateImage(request: ImageRequest): Promise<ImageResult> {
    const response = await this.fetchImpl(this.baseUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        prompt: request.prompt,
        n: 1,
        size: SIZE_MAP[request.size ?? "square"],
        // Ask for bytes, not a URL, so the shape carries its own image.
        response_format: "b64_json",
      }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`Image request failed (${response.status}): ${detail.slice(0, 300)}`);
    }

    const data = (await response.json()) as ImagesResponse;
    if (data.error?.message) throw new Error(`Image provider error: ${data.error.message}`);

    const first = data.data?.[0];
    if (first?.b64_json) {
      return {
        src: `data:image/png;base64,${first.b64_json}`,
        ...(first.revised_prompt ? { explanation: first.revised_prompt } : {}),
      };
    }
    // Some gateways ignore response_format and hand back a URL instead.
    if (first?.url) {
      return {
        src: first.url,
        explanation: "Generated image (hosted by the provider; it may expire).",
      };
    }
    throw new Error("Image provider returned no image data");
  }
}
