/**
 * Cameras, microphones and speakers for the call (docs/28 S4 and S5): the
 * lobby's preview and level meter, the device pickers, and the choice the
 * person made last time.
 *
 * The preview asks for both devices in one prompt; when that fails it asks
 * for each alone, so a blocked camera never costs the microphone (the lobby
 * says which one is the problem, and the call can still be joined).
 */

export type DeviceKind = "audioinput" | "videoinput" | "audiooutput";
export type DeviceChoice = Partial<Record<DeviceKind, string>>;
export type DeviceLists = Record<DeviceKind, MediaDeviceInfo[]>;

const CHOICE_KEY = "lucent.devices";

/** The devices chosen last time (per browser). Empty when storage is unavailable. */
export function loadDeviceChoice(): DeviceChoice {
  try {
    const raw = localStorage.getItem(CHOICE_KEY);
    const value = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const choice: DeviceChoice = {};
    for (const kind of ["audioinput", "videoinput", "audiooutput"] as const) {
      if (typeof value[kind] === "string") choice[kind] = value[kind];
    }
    return choice;
  } catch {
    return {};
  }
}

export function saveDeviceChoice(choice: DeviceChoice): void {
  try {
    localStorage.setItem(CHOICE_KEY, JSON.stringify(choice));
  } catch {
    /* a convenience only */
  }
}

export async function listDevices(): Promise<DeviceLists> {
  const lists: DeviceLists = { audioinput: [], videoinput: [], audiooutput: [] };
  if (!navigator.mediaDevices?.enumerateDevices) return lists;
  const all = await navigator.mediaDevices.enumerateDevices();
  for (const d of all) {
    // Before permission, browsers list devices with empty ids; they can't be chosen.
    if (d.deviceId && d.kind in lists) lists[d.kind as DeviceKind].push(d);
  }
  return lists;
}

const NOUNS: Record<DeviceKind, string> = {
  audioinput: "Microphone",
  videoinput: "Camera",
  audiooutput: "Speaker",
};

export function deviceLabel(device: MediaDeviceInfo, index: number): string {
  return device.label || `${NOUNS[device.kind as DeviceKind] ?? "Device"} ${index + 1}`;
}

/** Whether this browser can route call audio to a chosen speaker. */
export function canChooseSpeaker(): boolean {
  return typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype;
}

/** One device's state in the lobby (docs/28 S4). */
export type PreviewState = "asking" | "ready" | "off" | "denied" | "missing" | "busy" | "failed";

/** What a getUserMedia failure means for the person, from the error's stable name. */
export function previewStateOf(err: unknown): PreviewState {
  const name = (err as { name?: unknown })?.name;
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return "denied";
    case "NotFoundError":
    case "OverconstrainedError":
      return "missing";
    case "NotReadableError":
    case "AbortError":
      return "busy";
    default:
      return "failed";
  }
}

/** The lobby's line for a device that isn't ready; null when there's nothing to say. */
export function previewCopy(device: "microphone" | "camera", state: PreviewState): string | null {
  const Noun = device === "microphone" ? "Microphone" : "Camera";
  switch (state) {
    case "denied":
      return `${Noun} blocked. Allow it for this site in the address bar, then Retry.`;
    case "missing":
      return `No ${device} found.`;
    case "busy":
      return `Another app is using your ${device}.`;
    case "failed":
      return `Couldn't start your ${device}.`;
    default:
      return null;
  }
}

export interface Preview {
  stream: MediaStream | null;
  mic: PreviewState;
  cam: PreviewState;
}

function constraint(id: string | undefined): MediaTrackConstraints | true {
  // `ideal`, not `exact`: a device unplugged since last time falls back to
  // the default instead of failing the whole preview.
  return id ? { deviceId: { ideal: id } } : true;
}

/** Open the lobby preview for what the person wants on. */
export async function openPreview(
  want: { mic: boolean; cam: boolean },
  choice: DeviceChoice,
): Promise<Preview> {
  if (!navigator.mediaDevices?.getUserMedia) {
    return { stream: null, mic: want.mic ? "failed" : "off", cam: want.cam ? "failed" : "off" };
  }
  if (!want.mic && !want.cam) return { stream: null, mic: "off", cam: "off" };
  const ask = (audio: boolean, video: boolean) =>
    navigator.mediaDevices.getUserMedia({
      audio: audio ? constraint(choice.audioinput) : false,
      video: video ? constraint(choice.videoinput) : false,
    });
  try {
    const stream = await ask(want.mic, want.cam);
    return { stream, mic: want.mic ? "ready" : "off", cam: want.cam ? "ready" : "off" };
  } catch (both) {
    if (!(want.mic && want.cam)) {
      const state = previewStateOf(both);
      return { stream: null, mic: want.mic ? state : "off", cam: want.cam ? state : "off" };
    }
  }
  // Both at once failed: ask for each alone, so one blocked device doesn't cost the other.
  const tracks: MediaStreamTrack[] = [];
  let mic: PreviewState = "failed";
  let cam: PreviewState = "failed";
  try {
    tracks.push(...(await ask(true, false)).getTracks());
    mic = "ready";
  } catch (err) {
    mic = previewStateOf(err);
  }
  try {
    tracks.push(...(await ask(false, true)).getTracks());
    cam = "ready";
  } catch (err) {
    cam = previewStateOf(err);
  }
  return { stream: tracks.length > 0 ? new MediaStream(tracks) : null, mic, cam };
}

export function stopStream(stream: MediaStream | null): void {
  for (const t of stream?.getTracks() ?? []) t.stop();
}

/**
 * A live input level, 0–1, for the lobby and the settings meter. Returns a
 * stop function; nothing leaves the browser.
 */
export function createLevelMeter(
  track: MediaStreamTrack,
  onLevel: (level: number) => void,
): () => void {
  const Ctx =
    (window as unknown as { AudioContext?: typeof AudioContext }).AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) return () => {};
  const ctx = new Ctx();
  const source = ctx.createMediaStreamSource(new MediaStream([track]));
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);
  const data = new Uint8Array(analyser.fftSize);
  let frame = 0;
  const tick = () => {
    analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (const v of data) {
      const x = (v - 128) / 128;
      sum += x * x;
    }
    // RMS of speech sits around 0.02–0.2; scale so normal talking fills the bar.
    onLevel(Math.min(1, Math.sqrt(sum / data.length) * 4));
    frame = requestAnimationFrame(tick);
  };
  tick();
  return () => {
    cancelAnimationFrame(frame);
    source.disconnect();
    void ctx.close().catch(() => {});
  };
}

/** A short two-note chime through the chosen speaker, to test it. */
export async function playTestSound(sinkId?: string): Promise<void> {
  const rate = 22050;
  const seconds = 0.6;
  const samples = Math.floor(rate * seconds);
  const buffer = new ArrayBuffer(44 + samples * 2);
  const view = new DataView(buffer);
  const text = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  text(0, "RIFF");
  view.setUint32(4, 36 + samples * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, samples * 2, true);
  for (let i = 0; i < samples; i++) {
    const t = i / rate;
    const freq = t < seconds / 2 ? 660 : 880;
    const envelope = Math.min(1, (seconds - t) * 8, t * 40) * 0.3;
    view.setInt16(44 + i * 2, Math.sin(2 * Math.PI * freq * t) * envelope * 32767, true);
  }
  const url = URL.createObjectURL(new Blob([buffer], { type: "audio/wav" }));
  const audio = new Audio(url);
  try {
    if (sinkId && "setSinkId" in audio) {
      await (audio as HTMLAudioElement & { setSinkId(id: string): Promise<void> }).setSinkId(
        sinkId,
      );
    }
    await audio.play();
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000 + 100));
  } finally {
    URL.revokeObjectURL(url);
  }
}
