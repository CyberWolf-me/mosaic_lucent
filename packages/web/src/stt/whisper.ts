import type { SttProvider, VoiceHandlers, VoiceSession } from "./types.js";

/**
 * On-device Whisper via transformers.js. Free, private, works in any browser
 * (no cloud, no key). Records mic audio with MediaRecorder, then on stop decodes
 * to 16kHz mono PCM and runs whisper-tiny.en locally. No live interim words —
 * text arrives when you stop (status "transcribing" in between).
 *
 * The model (~40MB) is fetched once from the HF CDN and cached by the browser,
 * so the first use is slow and needs a network; later uses are offline.
 */

const MODEL = "Xenova/whisper-tiny.en";

// Lazily created; the transformers pipeline is heavy so we build it on first use
// and reuse it across sessions.
type TranscribeFn = (audio: Float32Array) => Promise<{ text: string }>;
let transcriberPromise: Promise<TranscribeFn> | null = null;

async function getTranscriber(): Promise<TranscribeFn> {
  if (!transcriberPromise) {
    transcriberPromise = (async () => {
      const { pipeline } = await import("@huggingface/transformers");
      const pipe = await pipeline("automatic-speech-recognition", MODEL);
      return (audio: Float32Array) => pipe(audio) as Promise<{ text: string }>;
    })();
  }
  return transcriberPromise;
}

/** Decode recorded audio blob to the 16kHz mono Float32 the model expects. */
async function blobToPcm16k(blob: Blob): Promise<Float32Array> {
  const arrayBuf = await blob.arrayBuffer();
  const AudioCtx =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new AudioCtx();
  try {
    const decoded = await ctx.decodeAudioData(arrayBuf);
    const target = 16000;
    if (decoded.sampleRate === target) {
      return decoded.getChannelData(0).slice();
    }
    // Resample to 16kHz mono via an offline context.
    const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * target), target);
    const src = offline.createBufferSource();
    src.buffer = decoded;
    src.connect(offline.destination);
    src.start();
    const rendered = await offline.startRendering();
    return rendered.getChannelData(0).slice();
  } finally {
    void ctx.close();
  }
}

export const whisperSttProvider: SttProvider = {
  id: "whisper",
  isSupported: () =>
    typeof MediaRecorder !== "undefined" &&
    typeof navigator !== "undefined" &&
    Boolean(navigator.mediaDevices?.getUserMedia),
  start(handlers: VoiceHandlers): VoiceSession | null {
    if (!this.isSupported()) {
      handlers.onError?.(
        "On-device voice needs MediaRecorder + microphone support, which this browser lacks.",
      );
      return null;
    }

    let recorder: MediaRecorder | null = null;
    let stream: MediaStream | null = null;
    const chunks: BlobPart[] = [];
    let stopped = false;

    navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then((s) => {
        if (stopped) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        stream = s;
        recorder = new MediaRecorder(s);
        recorder.ondataavailable = (e) => {
          if (e.data.size > 0) chunks.push(e.data);
        };
        recorder.onstop = async () => {
          stream?.getTracks().forEach((t) => t.stop());
          if (chunks.length === 0) {
            handlers.onStatus?.("idle");
            return;
          }
          handlers.onStatus?.("transcribing");
          try {
            const blob = new Blob(chunks, { type: recorder?.mimeType || "audio/webm" });
            const pcm = await blobToPcm16k(blob);
            const transcribe = await getTranscriber();
            const { text } = await transcribe(pcm);
            handlers.onStatus?.("idle");
            const clean = text.trim();
            if (clean) handlers.onFinal(clean);
            else handlers.onError?.("Didn't catch any speech — try again.");
          } catch (err) {
            handlers.onStatus?.("idle");
            handlers.onError?.(
              `On-device transcription failed: ${(err as Error).message || "unknown"}.`,
            );
          }
        };
        recorder.start();
        handlers.onStart?.();
        handlers.onStatus?.("listening");
      })
      .catch(() =>
        handlers.onError?.(
          "Microphone access was denied. Allow the mic for this site, then try again.",
        ),
      );

    return {
      stop: () => {
        stopped = true;
        try {
          if (recorder && recorder.state !== "inactive") recorder.stop();
          else stream?.getTracks().forEach((t) => t.stop());
        } catch {
          /* ignore */
        }
      },
    };
  },
};
