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
 * Free high-quality image generation via Pollinations AI.
 * Requires no API key and returns self-contained base64 data URLs.
 */
export class PollinationsImageProvider implements ImageProvider {
  readonly name = "pollinations";
  private readonly fetchImpl: typeof fetch;

  constructor(options: { fetchImpl?: typeof fetch } = {}) {
    this.fetchImpl =
      options.fetchImpl ??
      (typeof fetch !== "undefined" ? fetch : (undefined as unknown as typeof fetch));
  }

  async generateImage(request: ImageRequest): Promise<ImageResult> {
    const dims =
      request.size === "landscape"
        ? [1024, 640]
        : request.size === "portrait"
          ? [640, 1024]
          : [768, 768];
    const [w, h] = dims;
    const cleanPrompt = request.prompt.trim();
    const seed = Math.floor(Math.random() * 1000000);
    const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(cleanPrompt)}?width=${w}&height=${h}&nologo=true&seed=${seed}`;

    try {
      const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(15000) });
      if (res.ok) {
        const arrayBuf = await res.arrayBuffer();
        let b64 = "";
        if (typeof Buffer !== "undefined") {
          b64 = Buffer.from(arrayBuf).toString("base64");
        } else {
          const bytes = new Uint8Array(arrayBuf);
          let binary = "";
          for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
          b64 = btoa(binary);
        }
        const mime = res.headers.get("content-type") || "image/jpeg";
        const src = `data:${mime};base64,${b64}`;
        return { src, explanation: `Generated visual for "${cleanPrompt}".` };
      }
    } catch {
      // Fall back to placeholder if offline or unreachable
    }
    return new MockImageProvider().generateImage(request);
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
  /** Optional fallback models to use if the primary model fails. */
  fallbackModels?: string[];
  fetchImpl?: typeof fetch;
  name?: string;
  /**
   * Per-request timeout in ms. Without it a stalled gateway would leave the
   * request hanging indefinitely — the same `AbortSignal.timeout` guard every
   * other outbound provider (STT, TTS, integrations, Pollinations) already has.
   */
  timeoutMs?: number;
}

/**
 * Default image timeout. Image models are slower than chat completions, so this
 * is generous — it only exists to bound a truly stuck gateway.
 */
const DEFAULT_IMAGE_TIMEOUT_MS = 120_000;

interface ImagesResponse {
  data?: Array<{ b64_json?: string; url?: string; revised_prompt?: string }>;
  error?: { message?: string };
}

/**
 * The image type a base64 payload really holds, read from its magic bytes:
 * PNG, JPEG, WebP or GIF, or null for anything else.
 *
 * `b64_json` carries no type of its own, and "PNG" is only what OpenAI's
 * endpoint returns by default: gpt-image models honour an `output_format` of
 * jpeg or webp, and gateways that mirror the shape return whatever their
 * backend drew. A data URL whose declared type disagrees with its bytes is the
 * kind of mismatch a strict image decoder refuses and a lenient one guesses
 * at, so the declared type comes from the bytes. Only the first 16 base64
 * characters (12 bytes) are decoded — enough for RIFF…WEBP, the longest
 * signature here.
 */
export function sniffImageMime(base64: string): string | null {
  let head: string;
  try {
    head = atob(base64.replace(/\s+/g, "").slice(0, 16));
  } catch {
    return null;
  }
  const byte = (i: number) => head.charCodeAt(i);
  if (head.startsWith("\x89PNG\r\n\x1a\n")) return "image/png";
  if (byte(0) === 0xff && byte(1) === 0xd8 && byte(2) === 0xff) return "image/jpeg";
  if (head.startsWith("GIF87a") || head.startsWith("GIF89a")) return "image/gif";
  if (head.startsWith("RIFF") && head.slice(8, 12) === "WEBP") return "image/webp";
  return null;
}

const SIZE_MAP: Record<NonNullable<ImageRequest["size"]>, string> = {
  square: "1024x1024",
  landscape: "1536x1024",
  portrait: "1024x1536",
};

export class OpenAIImageProvider implements ImageProvider {
  readonly name: string;
  readonly model: string;
  private readonly fallbackModels: string[];
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: OpenAIImageOptions) {
    if (!options.apiKey) throw new Error("OpenAIImageProvider requires an apiKey");
    if (!options.baseUrl) throw new Error("OpenAIImageProvider requires a baseUrl");
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl;
    this.model = options.model ?? "gpt-image-1";
    this.fallbackModels = options.fallbackModels ?? [];
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.name = options.name ?? "openai-image";
    this.timeoutMs = options.timeoutMs ?? DEFAULT_IMAGE_TIMEOUT_MS;
  }

  async generateImage(request: ImageRequest): Promise<ImageResult> {
    const candidateModels = [this.model, ...this.fallbackModels.filter((m) => m !== this.model)];
    let lastError: Error | null = null;
    for (const modelToUse of candidateModels) {
      try {
        return await this.executeGenerateImage(request, modelToUse);
      } catch (err) {
        lastError = err as Error;
      }
    }
    throw lastError ?? new Error("Image provider request failed");
  }

  private async executeGenerateImage(
    request: ImageRequest,
    modelToUse: string,
  ): Promise<ImageResult> {
    const response = await this.fetchImpl(this.baseUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: modelToUse,
        prompt: request.prompt,
        n: 1,
        size: SIZE_MAP[request.size ?? "square"],
        // Ask for bytes, not a URL, so the shape carries its own image.
        response_format: "b64_json",
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`Image request failed (${response.status}): ${detail.slice(0, 300)}`);
    }

    const data = (await response.json()) as ImagesResponse;
    if (data.error?.message) throw new Error(`Image provider error: ${data.error.message}`);

    const first = data.data?.[0];
    if (first?.b64_json) {
      // Unrecognised bytes keep the old label: PNG is the endpoint's default,
      // and refusing an image over a signature this list lacks would be worse.
      const mime = sniffImageMime(first.b64_json) ?? "image/png";
      return {
        src: `data:${mime};base64,${first.b64_json}`,
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

export interface CloudflareImageOptions {
  accountId: string;
  apiToken: string;
  model?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Cloudflare Workers AI image generation (@cf/bytedance/stable-diffusion-xl-lightning,
 * @cf/stabilityai/stable-diffusion-xl-base-1.0, or @cf/black-forest-labs/flux-1-schnell).
 */
export class CloudflareImageProvider implements ImageProvider {
  readonly name = "cloudflare-workers-ai";
  readonly model: string;
  private readonly accountId: string;
  private readonly apiToken: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: CloudflareImageOptions) {
    this.accountId = options.accountId;
    this.apiToken = options.apiToken;
    this.model = options.model ?? "@cf/bytedance/stable-diffusion-xl-lightning";
    this.fetchImpl =
      options.fetchImpl ??
      (typeof fetch !== "undefined" ? fetch : (undefined as unknown as typeof fetch));
    this.timeoutMs = options.timeoutMs ?? DEFAULT_IMAGE_TIMEOUT_MS;
  }

  async generateImage(request: ImageRequest): Promise<ImageResult> {
    const url = `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/ai/run/${this.model}`;
    const cleanPrompt = request.prompt.trim();
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        prompt: cleanPrompt,
        num_steps: 4,
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(
        `Cloudflare Workers AI image failed (${res.status}): ${detail.slice(0, 300)}`,
      );
    }

    const arrayBuf = await res.arrayBuffer();
    let b64 = "";
    if (typeof Buffer !== "undefined") {
      b64 = Buffer.from(arrayBuf).toString("base64");
    } else {
      const bytes = new Uint8Array(arrayBuf);
      let binary = "";
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
      b64 = btoa(binary);
    }

    const mime = sniffImageMime(b64) ?? res.headers.get("content-type") ?? "image/png";
    const src = `data:${mime};base64,${b64}`;
    return {
      src,
      explanation: `Generated visual for "${cleanPrompt}".`,
    };
  }
}
