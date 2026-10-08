import {
  AnthropicProvider,
  MockProvider,
  OpenAICompatibleProvider,
  type LLMProvider,
} from "@lucent/ai";

/**
 * Provider selection lives server-side so API keys never reach the browser
 * (docs/09 section 8). With no key, we fall back to the MockProvider so the
 * whole loop still works offline.
 *
 * Supported providers:
 *  - "openai" / any OpenAI-compatible gateway (gorouter.app, OpenRouter, etc.)
 *    via LUCENT_AI_BASE_URL + LUCENT_AI_KEY + LUCENT_AI_MODEL.
 *  - "anthropic" via ANTHROPIC_API_KEY.
 *  - mock (default) when nothing is configured.
 *
 * The configured timeout (`LUCENT_AI_TIMEOUT_MS`, parsed by `config.aiTimeoutMs`)
 * is forwarded to every real provider so `AbortSignal.timeout(this.timeoutMs)`
 * honours the env rather than the hardcoded 90s default. `MockProvider` is
 * synchronous and unaffected; passing the value to it would be a no-op.
 */
export interface SelectProviderOptions {
  /** Per-request timeout in ms; default 90_000. Forwarded to providers. */
  timeoutMs?: number;
}

export function selectProvider(
  env: NodeJS.ProcessEnv = process.env,
  options: SelectProviderOptions = {},
): LLMProvider {
  const provider = (env.LUCENT_AI_PROVIDER ?? "").toLowerCase();
  const timeoutMs = options.timeoutMs;

  // Cloudflare Workers AI gateway (OpenAI-compatible)
  if (provider === "cloudflare" || provider === "workers-ai") {
    const accountId = env.CLOUDFLARE_ACCOUNT_ID ?? "812ad3c4e3c15fa0227f57e932fe45de";
    const apiKey = env.CLOUDFLARE_AI_TOKEN ?? env.CLOUDFLARE_API_TOKEN ?? env.LUCENT_AI_KEY;
    if (!apiKey) throw new Error("LUCENT_AI_PROVIDER=cloudflare but CLOUDFLARE_AI_TOKEN is not set");
    return new OpenAICompatibleProvider({
      apiKey,
      baseUrl: `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1`,
      model: env.LUCENT_AI_MODEL ?? "@cf/meta/llama-3.1-8b-instruct-fp8",
      fallbackModel: env.LUCENT_AI_FALLBACK_MODEL,
      name: "cloudflare-workers-ai",
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
  }

  // OpenAI-compatible gateway. Chosen explicitly, or implicitly when a key +
  // base URL are present.
  const compatKey = env.LUCENT_AI_KEY;
  const compatUrl = env.LUCENT_AI_BASE_URL;
  if (provider === "openai" || provider === "gorouter" || (!provider && compatKey && compatUrl)) {
    if (!compatKey) throw new Error("LUCENT_AI_PROVIDER=openai but LUCENT_AI_KEY is not set");
    if (!compatUrl) throw new Error("LUCENT_AI_PROVIDER=openai but LUCENT_AI_BASE_URL is not set");
    return new OpenAICompatibleProvider({
      apiKey: compatKey,
      baseUrl: compatUrl,
      model: env.LUCENT_AI_MODEL ?? "claude-opus-5-thinking",
      fallbackModel: env.LUCENT_AI_FALLBACK_MODEL,
      name: env.LUCENT_AI_NAME ?? "gorouter",
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
  }

  if (provider === "anthropic" || (!provider && env.ANTHROPIC_API_KEY)) {
    const apiKey = env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error("LUCENT_AI_PROVIDER=anthropic but ANTHROPIC_API_KEY is not set");
    }
    return new AnthropicProvider({
      apiKey,
      ...(env.LUCENT_AI_MODEL ? { model: env.LUCENT_AI_MODEL } : {}),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
  }

  return new MockProvider();
}
