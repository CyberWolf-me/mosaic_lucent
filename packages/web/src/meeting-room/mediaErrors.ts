/**
 * Browser media failures, in words a person can act on (docs/28 F18, rule 6:
 * a refusal explains itself). `getUserMedia` / `getDisplayMedia` reject with
 * a DOMException whose NAME is the stable part; the message varies by
 * browser and is often useless ("Permission denied").
 *
 * Returns null when there is nothing to say — the user cancelled the screen
 * picker, which is a choice, not a failure.
 */
export type MediaDevice = "microphone" | "camera" | "screen";

export function describeMediaError(device: MediaDevice, err: unknown): string | null {
  const name = err instanceof Error || isNamed(err) ? (err as { name: string }).name : "";
  const noun = device === "screen" ? "screen sharing" : `your ${device}`;
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      if (device === "screen") return null;
      return `${capitalize(device)} blocked. Allow it for this site in the address bar, then turn it on again.`;
    case "NotFoundError":
    case "OverconstrainedError":
      return device === "screen"
        ? "Nothing to share was found."
        : `No ${device} found. Check that one is connected and enabled.`;
    case "NotReadableError":
    case "AbortError":
      return `Another app is using ${noun}. Close it, then try again.`;
    default: {
      const detail = err instanceof Error && err.message ? `: ${err.message}` : "";
      return `Couldn't turn on ${noun}${detail}.`;
    }
  }
}

/** The two switches `enableLocalMedia` needs from LiveKit's local participant. */
export interface LocalMediaSwitches {
  setMicrophoneEnabled(on: boolean, options?: { deviceId?: string }): Promise<unknown>;
  setCameraEnabled(on: boolean, options?: { deviceId?: string }): Promise<unknown>;
}

/**
 * Turn on what the person asked for at join, independently (docs/28 F18).
 * One `try` around both used to skip the camera when the mic failed, sent the
 * error only to the console, and left both controls saying "on". Each result
 * says what is really on, and `notice` says why anything is not.
 */
export async function enableLocalMedia(
  local: LocalMediaSwitches,
  want: { mic: boolean; cam: boolean },
  devices: { audioinput?: string; videoinput?: string } = {},
): Promise<{ mic: boolean; cam: boolean; notice: string | null }> {
  const problems: string[] = [];
  let mic = false;
  let cam = false;
  if (want.mic) {
    try {
      await local.setMicrophoneEnabled(
        true,
        devices.audioinput ? { deviceId: devices.audioinput } : undefined,
      );
      mic = true;
    } catch (err) {
      const why = describeMediaError("microphone", err);
      if (why) problems.push(`${why} Others can't hear you until it's on.`);
    }
  }
  if (want.cam) {
    try {
      await local.setCameraEnabled(
        true,
        devices.videoinput ? { deviceId: devices.videoinput } : undefined,
      );
      cam = true;
    } catch (err) {
      const why = describeMediaError("camera", err);
      if (why) problems.push(why);
    }
  }
  return { mic, cam, notice: problems.length > 0 ? problems.join(" ") : null };
}

function isNamed(err: unknown): err is { name: string } {
  return (
    typeof err === "object" && err !== null && typeof (err as { name?: unknown }).name === "string"
  );
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
