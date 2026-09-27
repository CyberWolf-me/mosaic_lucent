import { useEffect, useRef, useState } from "react";
import { useMeetingSession } from "./MeetingSessionContext.js";
import { peopleSentence } from "./callProtocol.js";
import {
  canChooseSpeaker,
  createLevelMeter,
  deviceLabel,
  listDevices,
  openPreview,
  playTestSound,
  previewCopy,
  stopStream,
  type DeviceChoice,
  type DeviceKind,
  type DeviceLists,
  type PreviewState,
} from "./devices.js";
import { apiFetch } from "../http.js";
import { Ico } from "../ui/icons.js";

/**
 * S4 — the lobby (docs/28): see yourself, hear your mic move the meter,
 * choose devices, see who's already in, then join. Every problem says what
 * to do about it; a blocked or missing microphone still lets you join as a
 * listener.
 */

interface LobbyMedia {
  audio: MediaStreamTrack | null;
  video: MediaStreamTrack | null;
  mic: PreviewState;
  cam: PreviewState;
}

/**
 * The preview tracks. The first request asks for both devices at once (one
 * browser prompt); after that, turning one device off or switching it only
 * touches that device, so the camera doesn't blink when the mic changes.
 */
function useLobbyMedia(
  micOn: boolean,
  camOn: boolean,
  choice: DeviceChoice,
  retry: number,
): LobbyMedia {
  const [media, setMedia] = useState<LobbyMedia>({
    audio: null,
    video: null,
    mic: micOn ? "asking" : "off",
    cam: camOn ? "asking" : "off",
  });
  const held = useRef<{
    audio: MediaStreamTrack | null;
    video: MediaStreamTrack | null;
    audioKey: string | null;
    videoKey: string | null;
  }>({ audio: null, video: null, audioKey: null, videoKey: null });
  const audioId = choice.audioinput;
  const videoId = choice.videoinput;

  useEffect(() => {
    let cancelled = false;
    const h = held.current;
    const audioKey = micOn ? `${audioId ?? ""}#${retry}` : null;
    const videoKey = camOn ? `${videoId ?? ""}#${retry}` : null;
    const needAudio = audioKey !== null && audioKey !== h.audioKey;
    const needVideo = videoKey !== null && videoKey !== h.videoKey;
    if (h.audio && (audioKey === null || needAudio)) {
      h.audio.stop();
      h.audio = null;
      h.audioKey = null;
    }
    if (h.video && (videoKey === null || needVideo)) {
      h.video.stop();
      h.video = null;
      h.videoKey = null;
    }
    setMedia((m) => ({
      audio: h.audio,
      video: h.video,
      mic: !micOn ? "off" : needAudio ? "asking" : m.mic,
      cam: !camOn ? "off" : needVideo ? "asking" : m.cam,
    }));
    if (!needAudio && !needVideo) return;
    void openPreview(
      { mic: needAudio, cam: needVideo },
      { audioinput: audioId, videoinput: videoId },
    ).then((p) => {
      if (cancelled) {
        stopStream(p.stream);
        return;
      }
      if (needAudio) {
        h.audio = p.stream?.getAudioTracks()[0] ?? null;
        h.audioKey = h.audio ? audioKey : null;
      }
      if (needVideo) {
        h.video = p.stream?.getVideoTracks()[0] ?? null;
        h.videoKey = h.video ? videoKey : null;
      }
      setMedia((m) => ({
        audio: h.audio,
        video: h.video,
        mic: needAudio ? p.mic : m.mic,
        cam: needVideo ? p.cam : m.cam,
      }));
    });
    return () => {
      cancelled = true;
    };
  }, [micOn, camOn, audioId, videoId, retry]);

  useEffect(
    () => () => {
      held.current.audio?.stop();
      held.current.video?.stop();
    },
    [],
  );
  return media;
}

function PreviewVideo({ track }: { track: MediaStreamTrack }) {
  const ref = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.srcObject = new MediaStream([track]);
    void el.play().catch(() => {});
    return () => {
      el.srcObject = null;
    };
  }, [track]);
  return <video ref={ref} className="call-lobby-video" muted playsInline autoPlay />;
}

/** The mic meter: drawn straight to the DOM, not through React state. */
export function LevelMeter({ track }: { track: MediaStreamTrack | null }) {
  const bar = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    if (!track) return;
    return createLevelMeter(track, (level) => {
      if (bar.current) bar.current.style.transform = `scaleX(${level.toFixed(3)})`;
    });
  }, [track]);
  return (
    <span className="call-meter" role="img" aria-label="Microphone level">
      <span ref={bar} className="call-meter-fill" />
    </span>
  );
}

export function DevicePicker({
  kind,
  label,
  lists,
  value,
  onChange,
}: {
  kind: DeviceKind;
  label: string;
  lists: DeviceLists;
  value: string | undefined;
  onChange: (id: string) => void;
}) {
  const options = lists[kind];
  if (options.length === 0) return null;
  const selected = value && options.some((d) => d.deviceId === value) ? value : "";
  return (
    <label className="call-device">
      <span className="call-device-label">{label}</span>
      <select value={selected} onChange={(e) => onChange(e.target.value)}>
        {!selected && <option value="">System default</option>}
        {options.map((d, i) => (
          <option key={d.deviceId} value={d.deviceId}>
            {deviceLabel(d, i)}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Devices, refreshed when one is plugged in or out. */
export function useDeviceLists(ready: boolean): DeviceLists {
  const [lists, setLists] = useState<DeviceLists>({
    audioinput: [],
    videoinput: [],
    audiooutput: [],
  });
  useEffect(() => {
    let alive = true;
    const refresh = () => void listDevices().then((l) => alive && setLists(l));
    refresh();
    navigator.mediaDevices?.addEventListener?.("devicechange", refresh);
    return () => {
      alive = false;
      navigator.mediaDevices?.removeEventListener?.("devicechange", refresh);
    };
  }, [ready]);
  return lists;
}

type WhoHere =
  | { kind: "loading" }
  | { kind: "ready"; names: string[] }
  | { kind: "unavailable" }
  | { kind: "unknown" };

/** Who is already in the board's call, refreshed while the lobby is open. */
function useWhoHere(boardId: string | null): WhoHere {
  const [who, setWho] = useState<WhoHere>({ kind: boardId ? "loading" : "unknown" });
  useEffect(() => {
    if (!boardId) return;
    let alive = true;
    const load = async () => {
      try {
        const res = await apiFetch(`/api/boards/${encodeURIComponent(boardId)}/call`);
        if (!alive) return;
        if (res.status === 503) return setWho({ kind: "unavailable" });
        if (!res.ok) return setWho({ kind: "unknown" });
        const body = (await res.json()) as { participants?: Array<{ name: string }> };
        if (alive) setWho({ kind: "ready", names: (body.participants ?? []).map((p) => p.name) });
      } catch {
        if (alive) setWho({ kind: "unknown" });
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 5000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [boardId]);
  return who;
}

const CALLS_UNAVAILABLE =
  "Video calls aren't set up on this server. You can still transcribe on this device.";

export function CallLobby({ boardId, title }: { boardId: string | null; title: string }) {
  const {
    status,
    error,
    join,
    cancelJoin,
    micOn,
    camOn,
    setMicOn,
    setCamOn,
    devices,
    chooseDevice,
  } = useMeetingSession();
  const [retry, setRetry] = useState(0);
  const media = useLobbyMedia(micOn, camOn, devices, retry);
  const lists = useDeviceLists(media.mic === "ready" || media.cam === "ready");
  const who = useWhoHere(boardId);
  const [testing, setTesting] = useState(false);
  const joining = status === "joining";

  const micProblem = micOn ? previewCopy("microphone", media.mic) : null;
  const camProblem = camOn ? previewCopy("camera", media.cam) : null;
  const unavailable = who.kind === "unavailable";
  const micUnusable = micOn && ["denied", "missing", "busy", "failed"].includes(media.mic);

  const joinNow = (listener = false) => {
    if (listener) setMicOn(false);
    void join(boardId, listener ? { mic: false } : undefined);
  };

  return (
    <section className="call-lobby" aria-label="Join the call">
      <div className="call-lobby-preview">
        <div className="call-lobby-frame">
          {camOn && media.video ? (
            <PreviewVideo track={media.video} />
          ) : (
            <div className="call-lobby-off">
              {camOn && media.cam === "asking"
                ? "Starting camera…"
                : camOn
                  ? (camProblem ?? "Camera is off")
                  : "Camera is off"}
            </div>
          )}
          <div className="call-lobby-toggles">
            <button
              type="button"
              className={`call-btn ${micOn ? "" : "is-off"}`}
              aria-pressed={micOn}
              aria-label={micOn ? "Turn off microphone" : "Turn on microphone"}
              title={micOn ? "Turn off microphone" : "Turn on microphone"}
              onClick={() => setMicOn((m) => !m)}
            >
              {micOn ? <Ico.Mic width={18} height={18} /> : <Ico.MicOff width={18} height={18} />}
            </button>
            <button
              type="button"
              className={`call-btn ${camOn ? "" : "is-off"}`}
              aria-pressed={camOn}
              aria-label={camOn ? "Turn off camera" : "Turn on camera"}
              title={camOn ? "Turn off camera" : "Turn on camera"}
              onClick={() => setCamOn((c) => !c)}
            >
              {camOn ? (
                <Ico.Video width={18} height={18} />
              ) : (
                <Ico.VideoOff width={18} height={18} />
              )}
            </button>
          </div>
          {micOn && media.audio && (
            <div className="call-lobby-meter">
              <Ico.Mic width={12} height={12} />
              <LevelMeter track={media.audio} />
            </div>
          )}
        </div>

        <div className="call-lobby-devices">
          <DevicePicker
            kind="audioinput"
            label="Microphone"
            lists={lists}
            value={devices.audioinput}
            onChange={(id) => void chooseDevice("audioinput", id)}
          />
          <DevicePicker
            kind="videoinput"
            label="Camera"
            lists={lists}
            value={devices.videoinput}
            onChange={(id) => void chooseDevice("videoinput", id)}
          />
          {canChooseSpeaker() && (
            <DevicePicker
              kind="audiooutput"
              label="Speaker"
              lists={lists}
              value={devices.audiooutput}
              onChange={(id) => void chooseDevice("audiooutput", id)}
            />
          )}
          <button
            type="button"
            className="call-link-btn"
            disabled={testing}
            onClick={() => {
              setTesting(true);
              void playTestSound(devices.audiooutput)
                .catch(() => {})
                .finally(() => setTesting(false));
            }}
          >
            {testing ? "Playing…" : "Test speaker"}
          </button>
        </div>
      </div>

      <div className="call-lobby-side">
        <h3 className="call-lobby-title">Ready to join?</h3>
        <p className="call-lobby-sub">{title}</p>
        <p className="call-lobby-who" role="status">
          {who.kind === "ready"
            ? peopleSentence(who.names)
            : who.kind === "loading"
              ? "Checking who's here…"
              : null}
        </p>

        {(micProblem || camProblem) && !unavailable && (
          <div className="call-lobby-problems" role="alert">
            {micProblem && <p>{micProblem}</p>}
            {camProblem && <p>{camProblem}</p>}
            {(media.mic === "denied" ||
              media.cam === "denied" ||
              media.mic === "busy" ||
              media.cam === "busy") && (
              <button
                type="button"
                className="call-link-btn"
                onClick={() => setRetry((r) => r + 1)}
              >
                Retry
              </button>
            )}
          </div>
        )}

        {(unavailable || error) && (
          <p className="call-lobby-error" role="alert">
            {unavailable ? CALLS_UNAVAILABLE : error}
          </p>
        )}

        <div className="call-lobby-actions">
          {joining ? (
            <>
              <button type="button" className="call-join" disabled>
                Connecting…
              </button>
              <button type="button" className="call-link-btn" onClick={cancelJoin}>
                Cancel
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="call-join"
                disabled={unavailable}
                onClick={() => joinNow(micUnusable)}
              >
                {micUnusable ? "Join as listener" : error ? "Try again" : "Join now"}
              </button>
              {!micUnusable && micOn && !unavailable && (
                <button type="button" className="call-link-btn" onClick={() => joinNow(true)}>
                  Join with mic off
                </button>
              )}
            </>
          )}
        </div>
        <p className="call-lobby-fine">
          Everyone on this board can join. Lucent transcribes only when someone starts recording,
          and everyone in the call sees it.
        </p>
      </div>
    </section>
  );
}
