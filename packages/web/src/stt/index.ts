import { browserSttProvider } from "./browser.js";
import { whisperSttProvider } from "./whisper.js";
import { livekitSttProvider } from "./livekit.js";
import type { SttProvider, SttProviderId } from "./types.js";

export * from "./types.js";
export { configureLiveKit } from "./livekit.js";

const PROVIDERS: Record<SttProviderId, SttProvider> = {
  browser: browserSttProvider,
  whisper: whisperSttProvider,
  livekit: livekitSttProvider,
};

/** Order used when the requested provider can't run here. */
const FALLBACK_ORDER: SttProviderId[] = ["browser", "whisper", "livekit"];

/** Resolve the requested STT provider, falling back to whichever is supported. */
export function getSttProvider(id: SttProviderId): SttProvider {
  const chosen = PROVIDERS[id];
  if (chosen.isSupported()) return chosen;
  // Scan the rest rather than flipping between two: with three providers a
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
