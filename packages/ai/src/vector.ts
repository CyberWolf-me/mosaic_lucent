/**
 * Generative vectors (docs/26 §6.3, V3): the `VectorProvider` seam.
 *
 * A provider turns a prompt into SVG documents. Its output is UNTRUSTED —
 * the server runs every document through core's sanitizing importer
 * (`importSvg`) and only structured paths ever reach a board — so a provider
 * is just transport: which vendor, which model, how the style is asked for.
 *
 * Providers (decision 2, docs/26 §12): Recraft first; a mock for offline
 * development and tests; QuiverAI later, only if a benchmark justifies it.
 * The free fallback is not a provider here: the visual agent can author a
 * simple vector itself as a validated CREATE_SHAPE (prompt v14).
 */

export type VectorStyle = "icon" | "illustration" | "logo" | "line";

export interface VectorRequest {
  prompt: string;
  style: VectorStyle;
  /** Variations to return, 1–4. */
  n: number;
}

export interface VectorResult {
  /** Raw SVG documents, one per variation. Untrusted until imported. */
  svgs: string[];
  /** Vendor units spent, when the vendor reports them. */
  credits?: number;
}

export interface VectorProvider {
  readonly name: string;
  readonly model?: string;
  generateVectors(request: VectorRequest, signal?: AbortSignal): Promise<VectorResult>;
}

/** How each style is asked for. V4 models take no curated style names, so the style rides the prompt. */
export const STYLE_BRIEF: Record<VectorStyle, { lead: string; tail: string; size: string }> = {
  icon: {
    lead: "A simple flat vector icon of",
    tail: "Minimal geometric shapes, bold and legible at small sizes, two or three flat colours, centred on a plain background, no text.",
    size: "1:1",
  },
  illustration: {
    lead: "A flat vector illustration of",
    tail: "Clean shapes, a small harmonious palette, no text, plain background.",
    size: "4:3",
  },
  logo: {
    lead: "A minimal vector logo mark for",
    tail: "Simple, distinctive and scalable, flat colours, no text, centred on a plain background.",
    size: "1:1",
  },
  line: {
    lead: "A clean line-art vector drawing of",
    tail: "Uniform stroke weight, no fills, no shading, no text, plain background.",
    size: "4:3",
  },
};

export function briefFor(request: VectorRequest): { prompt: string; size: string } {
  const b = STYLE_BRIEF[request.style];
  return { prompt: `${b.lead} ${request.prompt.trim()}. ${b.tail}`, size: b.size };
}

/** Base64 → UTF-8 text without Buffer: this package is bundled for the browser too. */
function decodeBase64Utf8(b64: string): string {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/**
 * Recraft (https://www.recraft.ai/docs/api-reference). A model ending in
 * `_vector` answers SVG; `b64_json` returns it inline, so there is no second
 * fetch of a temporary vendor URL. The key never leaves the server.
 */
export class RecraftVectorProvider implements VectorProvider {
  readonly name = "recraft";
  readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: { apiKey: string; model?: string; baseUrl?: string; fetch?: typeof fetch }) {
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? "recraftv4_1_vector";
    this.baseUrl = (opts.baseUrl ?? "https://external.api.recraft.ai/v1").replace(/\/+$/, "");
    this.fetchImpl = opts.fetch ?? fetch;
  }

  async generateVectors(request: VectorRequest, signal?: AbortSignal): Promise<VectorResult> {
    const { prompt, size } = briefFor(request);
    const res = await this.fetchImpl(`${this.baseUrl}/images/generations`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        prompt,
        model: this.model,
        n: Math.max(1, Math.min(4, request.n)),
        size,
        response_format: "b64_json",
      }),
      signal: signal ?? AbortSignal.timeout(90_000),
    });
    const text = await res.text();
    let body: {
      data?: Array<{ b64_json?: string; url?: string }>;
      credits?: number;
      code?: string;
      message?: string;
      error?: { message?: string } | string;
    } = {};
    try {
      body = JSON.parse(text) as typeof body;
    } catch {
      /* non-JSON error page */
    }
    if (!res.ok) {
      const why =
        typeof body.error === "string"
          ? body.error
          : (body.error?.message ?? body.message ?? body.code ?? text.slice(0, 200));
      throw new Error(`Recraft ${res.status}: ${why}`);
    }
    const svgs: string[] = [];
    for (const item of body.data ?? []) {
      if (item.b64_json) svgs.push(decodeBase64Utf8(item.b64_json));
      else if (item.url) {
        // Documented fallback shape: a short-lived signed URL.
        const got = await this.fetchImpl(item.url, {
          signal: signal ?? AbortSignal.timeout(30_000),
        });
        if (got.ok) svgs.push(await got.text());
      }
    }
    return { svgs, ...(typeof body.credits === "number" ? { credits: body.credits } : {}) };
  }

  /** The account's remaining units (a free call), for the health/admin surface. */
  async balance(): Promise<number | null> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/users/me`, {
        headers: { authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { credits?: unknown };
      return typeof body.credits === "number" ? body.credits : null;
    } catch {
      return null;
    }
  }
}

/**
 * Offline mock: deterministic, prompt-seeded SVGs (a rounded tile, a circle
 * and a mark) so generate → choose → place works with no key or network, and
 * tests exercise the whole pipeline — importer included.
 */
export class MockVectorProvider implements VectorProvider {
  readonly name = "mock";
  readonly model = "mock-vector";

  async generateVectors(request: VectorRequest): Promise<VectorResult> {
    let seed = 0;
    for (const ch of `${request.style}:${request.prompt}`)
      seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
    const n = Math.max(1, Math.min(4, request.n));
    const svgs: string[] = [];
    for (let i = 0; i < n; i++) {
      const hue = (seed + i * 67) % 360;
      const a = `hsl(${hue}, 65%, 55%)`;
      const b = `hsl(${(hue + 150) % 360}, 60%, 45%)`;
      const r = 6 + ((seed >> (i + 2)) % 4);
      svgs.push(
        request.style === "line"
          ? `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 36"><path d="M6 28C14 8 22 8 24 18S34 30 42 8" fill="none" stroke="${b}" stroke-width="2.5" stroke-linecap="round"/></svg>`
          : `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect width="48" height="48" fill="#ffffff"/><rect x="6" y="6" width="36" height="36" rx="${r}" fill="${a}"/><circle cx="24" cy="24" r="${8 + i}" fill="${b}"/><path d="M18 24h12M24 18v12" stroke="#ffffff" stroke-width="3" stroke-linecap="round"/></svg>`,
      );
    }
    return { svgs };
  }
}
