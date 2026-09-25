import { z } from "zod";
import {
  MockImageProvider,
  OpenAIImageProvider,
  PollinationsImageProvider,
  type ImageProvider,
} from "@lucent/ai";

/**
 * Request handling for POST /api/image (docs/15 Phase E). Generated images are a
 * media object, not a diagram — the LLM path is untouched. Falls back to the mock
 * provider when no image backend is configured, mirroring how the text provider
 * degrades to MockProvider offline.
 */

export const imageRequestSchema = z.object({
  prompt: z.string().min(1).max(1000),
  size: z.enum(["square", "landscape", "portrait"]).optional(),
  /**
   * The board the image is for. The canvas enriches a prompt with the board's
   * own labels, so the board's AI boundary decides whether it may leave —
   * the same gate /api/vector and /api/generate apply.
   */
  boardId: z.string().min(1).max(200).optional(),
});

export interface HandleResult {
  status: number;
  body: unknown;
}

/** A positive whole number of ms, or undefined — the rule config.ts's `optionalNum` applies. */
const positiveMs = (value: string | undefined): number | undefined => {
  const parsed = Number(value);
  return value !== undefined && value.trim() !== "" && Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : undefined;
};

/**
 * The image request timeout: `LUCENT_IMAGE_TIMEOUT_MS`, else the shared
 * `LUCENT_AI_TIMEOUT_MS`, else undefined (the provider's own default). A
 * stalled image gateway must not hang the request forever.
 *
 * Only a positive integer counts; anything else is treated as unset and falls
 * through. The raw `Number()` this replaced turned "0" into a 0 ms timeout
 * that aborted every call, and a negative value into a RangeError from
 * `AbortSignal.timeout` on every request.
 *
 * It bounds ONE attempt: the provider retries each fallback model with a
 * fresh timeout, so the worst case is (1 + fallbacks) × this.
 */
export function imageTimeoutMs(env: NodeJS.ProcessEnv = process.env): number | undefined {
  return positiveMs(env.LUCENT_IMAGE_TIMEOUT_MS) ?? positiveMs(env.LUCENT_AI_TIMEOUT_MS);
}

/**
 * Choose an image backend. A real one needs a key and an endpoint; without both
 * we use the placeholder generator so the canvas flow still works offline.
 *
 * The key stays server-side, exactly as with the text provider.
 */
export function selectImageProvider(env: NodeJS.ProcessEnv = process.env): ImageProvider {
  const apiKey = env.LUCENT_IMAGE_KEY ?? env.OPENAI_API_KEY;
  let baseUrl = env.LUCENT_IMAGE_BASE_URL;
  if (baseUrl && !baseUrl.endsWith("/images/generations")) {
    baseUrl = baseUrl.replace(/\/+$/, "") + "/images/generations";
  }

  const rawModel = env.LUCENT_IMAGE_MODEL;
  const rawFallback = env.LUCENT_IMAGE_FALLBACK_MODEL;
  const modelList = [
    ...(rawModel
      ? rawModel
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : []),
    ...(rawFallback
      ? rawFallback
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : []),
  ];
  const primaryModel = modelList[0];
  const fallbackModels = modelList.slice(1);

  const timeoutMs = imageTimeoutMs(env);

  if (apiKey && baseUrl) {
    return new OpenAIImageProvider({
      apiKey,
      baseUrl,
      ...(primaryModel ? { model: primaryModel } : {}),
      ...(fallbackModels.length > 0 ? { fallbackModels } : {}),
      ...(env.LUCENT_IMAGE_NAME ? { name: env.LUCENT_IMAGE_NAME } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
  }
  const isTest = env.NODE_ENV === "test" || process.env.VITEST !== undefined;
  if (
    env.LUCENT_IMAGE_PROVIDER === "pollinations" ||
    (!isTest && !env.LUCENT_IMAGE_KEY && !env.LUCENT_IMAGE_BASE_URL)
  ) {
    return new PollinationsImageProvider();
  }
  return new MockImageProvider();
}

export async function handleImage(
  provider: ImageProvider,
  rawBody: unknown,
): Promise<HandleResult> {
  const parsed = imageRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return { status: 400, body: { error: "invalid request", detail: parsed.error.format() } };
  }
  try {
    // Prompt and size only: the board id is Lucent's routing, never the vendor's.
    const { prompt, size } = parsed.data;
    const result = await provider.generateImage({ prompt, ...(size ? { size } : {}) });
    return { status: 200, body: { ...result, provider: provider.name } };
  } catch (err) {
    return {
      status: 502,
      body: { error: "image provider failed", detail: (err as Error).message },
    };
  }
}
