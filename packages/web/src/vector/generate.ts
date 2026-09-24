import type { VectorData } from "@lucent/core";
import { apiFetch } from "../http.js";
import type { IconIndex } from "../icons/registry.js";

/**
 * The client half of generative vectors (docs/26 §6.3, V3). The server does
 * the vendor call and the sanitizing; what comes back is structured paths.
 */

export type VectorStyle = "icon" | "illustration" | "logo" | "line";

export const VECTOR_STYLES: Array<{ id: VectorStyle; label: string }> = [
  { id: "icon", label: "Icon" },
  { id: "illustration", label: "Illustration" },
  { id: "logo", label: "Logo mark" },
  { id: "line", label: "Line art" },
];

export interface GeneratedVariation {
  vector: VectorData;
  width: number;
  height: number;
}

export type GenerateResult =
  | { ok: true; variations: GeneratedVariation[]; provider: string }
  | { ok: false; error: string };

export async function generateVectors(req: {
  prompt: string;
  style: VectorStyle;
  n: number;
  boardId: string | null;
}): Promise<GenerateResult> {
  try {
    const res = await apiFetch("/api/vector", {
      method: "POST",
      body: JSON.stringify({
        prompt: req.prompt,
        style: req.style,
        n: req.n,
        ...(req.boardId ? { boardId: req.boardId } : {}),
      }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      variations?: GeneratedVariation[];
      provider?: string;
      error?: string;
      detail?: string;
    };
    if (!res.ok) {
      const why =
        res.status === 503
          ? "Vector generation isn't set up on this workspace."
          : res.status === 402 || /credits|quota|allowance/i.test(body.detail ?? body.error ?? "")
            ? "The generation allowance is used up."
            : res.status === 403
              ? (body.error ?? "This board's AI policy doesn't allow sending prompts to a vendor.")
              : (body.error ?? `Generation failed (${res.status}).`);
      return { ok: false, error: why };
    }
    return { ok: true, variations: body.variations ?? [], provider: body.provider ?? "unknown" };
  } catch {
    return { ok: false, error: "Couldn't reach Lucent. Check the connection and try again." };
  }
}

const LOGO_WORDS = new Set([
  "logo",
  "logos",
  "logotype",
  "wordmark",
  "brand",
  "branding",
  "trademark",
  "icon",
  "mark",
]);

const words = (text: string) =>
  text
    .toLowerCase()
    .replace(/['’]s\b/g, "")
    .replace(/[^a-z0-9.+]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);

/**
 * A third-party brand named as the subject of a logo-ish request. Recraft's
 * developer terms forbid generating other companies' marks (and it's the
 * wrong tool anyway): the registry already holds the real one, which the UI
 * offers instead. The brand (4+ characters, and not itself one of the logo
 * words — there is a brand called "ICON") must sit within three words of
 * "logo", "icon", "mark"…: "the Stripe logo" is a Stripe logo; "an icon for a
 * checkout flow" and "a notion of speed" are not.
 */
export function brandInPrompt(
  prompt: string,
  index: IconIndex,
): { slug: string; title: string } | null {
  const toks = words(prompt);
  const anchors = toks.flatMap((t, i) => (LOGO_WORDS.has(t) ? [i] : []));
  if (anchors.length === 0) return null;
  let best: { slug: string; title: string; len: number } | null = null;
  for (const [slug, title] of index.simple.icons) {
    const t = words(title);
    const phrase = t.join(" ");
    if (phrase.length < 4 || (t.length === 1 && LOGO_WORDS.has(phrase))) continue;
    for (let i = 0; i + t.length <= toks.length; i++) {
      if (toks[i] !== t[0] || toks.slice(i, i + t.length).join(" ") !== phrase) continue;
      const near = anchors.some(
        (a) => a >= i - 3 && a <= i + t.length - 1 + 3 && (a < i || a >= i + t.length),
      );
      if (near && (!best || phrase.length > best.len)) best = { slug, title, len: phrase.length };
    }
  }
  return best ? { slug: best.slug, title: best.title } : null;
}
