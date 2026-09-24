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

  if (apiKey && baseUrl) {
    return new OpenAIImageProvider({
      apiKey,
      baseUrl,
      ...(primaryModel ? { model: primaryModel } : {}),
      ...(fallbackModels.length > 0 ? { fallbackModels } : {}),
      ...(env.LUCENT_IMAGE_NAME ? { name: env.LUCENT_IMAGE_NAME } : {}),
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
