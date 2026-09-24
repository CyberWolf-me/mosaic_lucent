import { assembleThemes, fallbackThemes, type Themes, type ThemesRequest } from "@lucent/ai";
import { apiFetch } from "./http.js";

/**
 * Sticky notes → themes, client side (docs/27 D2). The server decides
 * whether a model may see the notes; when it can't be reached at all, the
 * same offline sorter runs here, so the action never dead-ends — and the
 * answer always says which sorter produced it.
 */

export type ThemesOffline = "policy" | "no-model" | "model-failed" | "no-server";
export type ThemesAnswer = (Themes & { offline?: ThemesOffline }) | { error: string };

export async function sortIntoThemes(
  texts: string[],
  opts: { boardId?: string | null; hint?: string } = {},
): Promise<ThemesAnswer> {
  const request: ThemesRequest = {
    items: texts.map((text) => ({ text })),
    ...(opts.hint?.trim() ? { hint: opts.hint.trim() } : {}),
  };
  let res: Response;
  try {
    res = await apiFetch("/api/themes", {
      method: "POST",
      body: JSON.stringify({ ...request, ...(opts.boardId ? { boardId: opts.boardId } : {}) }),
    });
  } catch {
    return {
      ...assembleThemes(request, fallbackThemes(request), "fallback"),
      offline: "no-server",
    };
  }
  const body = (await res.json().catch(() => ({}))) as Themes & {
    offline?: ThemesOffline;
    error?: string;
  };
  if (!res.ok) return { error: body.error ?? `Couldn't sort the notes (${res.status}).` };
  return body;
}

/** How the sort was made, for the proposal's explanation. */
export function sortedBy(answer: Themes & { offline?: ThemesOffline }): string {
  switch (answer.offline) {
    case "policy":
      return "sorted by keyword on this device — this board keeps its content from AI providers";
    case "no-model":
      return "sorted by keyword — no AI provider is configured";
    case "model-failed":
      return "sorted by keyword — the AI provider didn't answer";
    case "no-server":
      return "sorted by keyword on this device — Lucent's server couldn't be reached";
    default:
      return "sorted by theme";
  }
}
