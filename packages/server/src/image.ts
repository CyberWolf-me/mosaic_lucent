import { z } from "zod";
import { MockImageProvider, OpenAIImageProvider, type ImageProvider } from "@lucent/ai";

/**
 * Request handling for POST /api/image (docs/15 Phase E). Generated images are a
 * media object, not a diagram — the LLM path is untouched. Falls back to the mock
 * provider when no image backend is configured, mirroring how the text provider
 * degrades to MockProvider offline.
 */

export const imageRequestSchema = z.object({
  prompt: z.string().min(1).max(1000),
  size: z.enum(["square", "landscape", "portrait"]).optional(),
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
  const baseUrl = env.LUCENT_IMAGE_BASE_URL;
  if (apiKey && baseUrl) {
    return new OpenAIImageProvider({
      apiKey,
      baseUrl,
      ...(env.LUCENT_IMAGE_MODEL ? { model: env.LUCENT_IMAGE_MODEL } : {}),
      ...(env.LUCENT_IMAGE_NAME ? { name: env.LUCENT_IMAGE_NAME } : {}),
    });
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
    const result = await provider.generateImage(parsed.data);
    return { status: 200, body: { ...result, provider: provider.name } };
  } catch (err) {
    return {
      status: 502,
      body: { error: "image provider failed", detail: (err as Error).message },
    };
  }
}
