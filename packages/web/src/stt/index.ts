import { browserSttProvider } from "./browser.js";
import { whisperSttProvider } from "./whisper.js";
import { livekitSttProvider } from "./livekit.js";
import { hostedSttProvider } from "./hosted.js";
import type { SttProvider, SttProviderId } from "./types.js";

export * from "./types.js";
export * from "./events.js";
export { configureLiveKit } from "./livekit.js";
export { hostedSttProvider } from "./hosted.js";

const PROVIDERS: Record<SttProviderId, SttProvider> = {
  browser: browserSttProvider,
  whisper: whisperSttProvider,
  livekit: livekitSttProvider,
  hosted: hostedSttProvider,
};

/** Order used when the requested provider can't run here. */
const FALLBACK_ORDER: SttProviderId[] = ["browser", "whisper", "livekit", "hosted"];

/** What each provider is called where a person reads it. */
export const STT_LABELS: Record<SttProviderId, string> = {
  browser: "Browser speech recognition",
  whisper: "On-device Whisper",
  livekit: "LiveKit",
  hosted: "Hosted transcription",
};

/**
 * The provider that will actually run, and — when it is not the one asked for
 * — which was asked for and why it can't run here (docs/28 F22). The fallback
 * used to happen without a word.
 */
export function resolveSttProvider(id: SttProviderId): {
  provider: SttProvider;
  fellBackFrom: SttProviderId | null;
  reason: string | null;
} {
  const provider = getSttProvider(id);
  if (provider.id === id) return { provider, fellBackFrom: null, reason: null };
  return { provider, fellBackFrom: id, reason: PROVIDERS[id].unavailableReason?.() ?? null };
}

/** Resolve the requested STT provider, falling back to whichever is supported. */
export function getSttProvider(id: SttProviderId): SttProvider {
  const chosen = PROVIDERS[id];
  if (chosen.isSupported()) return chosen;
  // Scan the rest rather than flipping between two: with four providers a
  // binary fallback could land on another unsupported one.
  for (const candidate of FALLBACK_ORDER) {
    if (candidate === id) continue;
    if (PROVIDERS[candidate].isSupported()) return PROVIDERS[candidate];
  }
  return chosen;
}

export function isAnyVoiceSupported(): boolean {
  return FALLBACK_ORDER.some((id) => PROVIDERS[id].isSupported());
}

/** Every provider plus why it can't be used, for the settings UI. */
export function sttProviderStatus(): Array<{
  id: SttProviderId;
  supported: boolean;
  reason: string | null;
}> {
  return FALLBACK_ORDER.map((id) => {
    const p = PROVIDERS[id];
    return { id, supported: p.isSupported(), reason: p.unavailableReason?.() ?? null };
  });
}
