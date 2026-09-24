import { z } from "zod";
import { importSvg, withoutBackground, type VectorData } from "@lucent/core";
import { MockVectorProvider, RecraftVectorProvider, type VectorProvider } from "@lucent/ai";
import type { HandleResult } from "./image.js";

/**
 * POST /api/vector (docs/26 §6.3, V3): prompt → editable vector variations.
 *
 * The vendor's SVG is untrusted. Every document goes through core's
 * sanitizing importer HERE, on the server, before anything is returned — the
 * client receives structured paths (the same `VectorData` a pasted file
 * becomes), never SVG text. A document that doesn't survive the importer is
 * dropped; if none do, the call fails honestly.
 */

export const vectorRequestSchema = z.object({
  prompt: z.string().trim().min(2).max(1_000),
  style: z.enum(["icon", "illustration", "logo", "line"]).default("icon"),
  n: z.number().int().min(1).max(4).default(3),
  /** The board it's for: its role and AI boundary are checked by the route. */
  boardId: z.string().min(1).max(200).optional(),
});
export type VectorRouteRequest = z.infer<typeof vectorRequestSchema>;

export interface VectorVariation {
  vector: VectorData;
  width: number;
  height: number;
}

/**
 * Choose the vector backend. Recraft when a key is configured (decision 2);
 * otherwise the offline mock, so the flow works in development. Setting
 * LUCENT_VECTOR_PROVIDER=off disables generation — the route then answers 503.
 */
export function selectVectorProvider(env: NodeJS.ProcessEnv = process.env): VectorProvider | null {
  const choice = env.LUCENT_VECTOR_PROVIDER?.trim().toLowerCase();
  if (choice === "off") return null;
  const key = env.LUCENT_RECRAFT_API_KEY?.trim();
  if (key && choice !== "mock") {
    return new RecraftVectorProvider({
      apiKey: key,
      ...(env.LUCENT_RECRAFT_MODEL?.trim() ? { model: env.LUCENT_RECRAFT_MODEL.trim() } : {}),
    });
  }
  return new MockVectorProvider();
}

export async function handleVector(
  provider: VectorProvider,
  request: VectorRouteRequest,
): Promise<HandleResult & { produced: number }> {
  let svgs: string[];
  try {
    svgs = (
      await provider.generateVectors({ prompt: request.prompt, style: request.style, n: request.n })
    ).svgs;
  } catch (err) {
    return {
      status: 502,
      produced: 0,
      body: { error: "vector provider failed", detail: (err as Error).message },
    };
  }
  const generator =
    provider.name === "recraft" ? "recraft" : provider.name === "mock" ? "mock" : "llm";
  const variations: VectorVariation[] = [];
  for (const svg of svgs) {
    const r = importSvg(svg, {
      generator,
      prompt: request.prompt.slice(0, 1_000),
      ...(provider.model ? { model: provider.model.slice(0, 100) } : {}),
    });
    if (!r.ok) continue;
    const vector = withoutBackground(r.vector);
    variations.push({ vector, width: r.width, height: r.height });
  }
  if (variations.length === 0) {
    return {
      status: 502,
      produced: svgs.length,
      body: { error: "the generated art couldn't be turned into editable vectors" },
    };
  }
  return {
    status: 200,
    produced: svgs.length,
    body: { variations, provider: provider.name, model: provider.model ?? null },
  };
}
