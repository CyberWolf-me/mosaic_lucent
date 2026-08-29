import { AnthropicProvider } from "@lucent/ai";
import { OpenAICompatibleProvider, type LLMProvider } from "@lucent/ai";

/**
 * The model router (M5/E1): which provider answers one request.
 *
 * The deployment's default provider is built once at boot (`selectProvider`,
 * provider.ts) and billed to the operator's account. The router adds the one
 * degree of freedom the enterprise ask actually needs — bring your own key:
 * a caller may present their own provider API key per request, and the server
 * constructs a throwaway provider around it. The key is used for exactly one
 * upstream call and then dropped: never stored, never logged, never echoed
 * back in a response, and never visible to the model.
 *
 * The gate is explicit and off by default (`LUCENT_ALLOW_BYO_KEYS=1`). A key
 * that arrives on a deployment that has not opted in is refused, not silently
 * ignored — silently ignoring it would make the client's bill a mystery.
 */

export const BYO_KEY_HEADER = "x-lucent-provider-key";
export const BYO_PROVIDER_HEADER = "x-lucent-provider";
export const BYO_MODEL_HEADER = "x-lucent-model";

/** Provider names a BYO key may target. `openai` is the client-facing alias. */
const BYO_PROVIDERS = new Set(["anthropic", "openai", "openai-compat"]);

/** The OpenAI-compatible endpoint used when a BYO caller does not name one. */
const DEFAULT_OPENAI_URL = "https://api.openai.com/v1/chat/completions";

export interface ByoRequest {
  key: string | null;
  provider: string | null;
  model: string | null;
}

/** Read the BYO headers, or nulls when the caller brought nothing. */
export function readByoHeaders(headers: { get(name: string): string | null }): ByoRequest {
  const key = headers.get(BYO_KEY_HEADER);
  return {
    key: key && key.trim() !== "" ? key.trim() : null,
    provider: headers.get(BYO_PROVIDER_HEADER),
    model: headers.get(BYO_MODEL_HEADER),
  };
}

export type ProviderResolution =
  | { ok: true; provider: LLMProvider; byok: boolean }
  | { ok: false; status: 400 | 403; error: string };

/**
 * Resolve the provider for one request. The default provider answers unless a
 * BYO key is present and the deployment allows BYO. A named provider/model is
 * honoured only inside the BYO path — routing between operator-funded
 * providers by client request would let one caller steer spend onto the most
 * expensive model, which is a billing decision, not a client preference.
 */
export function resolveProvider(
  options: { allowByoKeys: boolean; defaultProvider: LLMProvider },
  byo: ByoRequest,
): ProviderResolution {
  if (!byo.key) return { ok: true, provider: options.defaultProvider, byok: false };
  if (!options.allowByoKeys) {
    return {
      ok: false,
      status: 403,
      error: "BYO provider keys are not enabled on this deployment",
    };
  }
  const name = (byo.provider ?? "openai").toLowerCase();
  if (!BYO_PROVIDERS.has(name)) {
    return { ok: false, status: 400, error: `unsupported provider "${byo.provider ?? ""}"` };
  }
  if (byo.model !== null && byo.model.length > 200) {
    return { ok: false, status: 400, error: "model name too long" };
  }
  if (name === "anthropic") {
    return {
      ok: true,
      byok: true,
      provider: new AnthropicProvider({
        apiKey: byo.key,
        ...(byo.model ? { model: byo.model } : {}),
        // Generous enough for a streamed answer; aborted on the same cap the
        // operator's own provider would hit.
      }),
    };
  }
  return {
    ok: true,
    byok: true,
    provider: new OpenAICompatibleProvider({
      apiKey: byo.key,
      baseUrl: DEFAULT_OPENAI_URL,
      model: byo.model ?? "gpt-4o",
      name: "openai-byo",
    }),
  };
}
