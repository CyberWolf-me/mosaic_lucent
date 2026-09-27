import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  useMeetingSession,
  type HostAction,
  type LiveReaction,
  type MediaTile,
} from "./MeetingSessionContext.js";
import type { RoomPeer } from "./roomPeers.js";
import {
  formatElapsed,
  gridColumns,
  initials,
  MAX_CHAT_CHARS,
  REACTIONS,
  sortRoster,
  type ChatMessage,
} from "./callProtocol.js";
import { MediaNotice } from "./MediaNotice.js";
import { DevicePicker, useDeviceLists } from "./CallLobby.js";
import { canChooseSpeaker } from "./devices.js";
import { Ico, ToolIco } from "../ui/icons.js";

/**
 * S5 — the room (docs/28): the people, the controls, and every state the
 * connection can be in. Laid out the way Meet and Zoom are, so nobody has to
 * learn it: an auto grid, a spotlight when someone presents or is pinned, a
 * control bar along the bottom, People and Chat in a side panel.
 */

const LOCAL = "local";

/** One person in the call, as the stage draws them. */
interface Person {
  identity: string;
  name: string;
  isLocal: boolean;
  host: boolean;
  handAt: number | null;
  micOn: boolean;
  camOn: boolean;
  speaking: boolean;
  capture: boolean;
  /** Asked not to be transcribed (docs/28 §4.3). */
  optedOut: boolean;
  quality: RoomPeer["quality"];
  video: MediaTile | undefined;
  screen: MediaTile | undefined;
}

type Layout = "auto" | "grid" | "speaker";
type Panel = "people" | "chat" | null;

// --- Small pieces ----------------------------------------------------------

/** A popover menu anchored to its button; closes on Escape or a click outside. */
function Menu({
  label,
  button,
  className = "",
  align = "end",
  children,
}: {
  label: string;
  button: ReactNode;
  className?: string;
  align?: "start" | "end" | "up";
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div className="call-menu-root" ref={root}>
      <button
        type="button"
        className={className}
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {button}
      </button>
      {open && (
        <div className={`call-menu call-menu-${align}`} role="menu">
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

function MenuItem({
  onClick,
  children,
  danger,
}: {
  onClick: () => void;
  children: ReactNode;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className={`call-menu-item ${danger ? "is-danger" : ""}`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function TrackVideo({ tile, mirror }: { tile: MediaTile; mirror: boolean }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const host = ref.current;
    if (!host) return;
    const el = tile.track.attach() as HTMLVideoElement;
    el.autoplay = true;
    el.muted = true;
    el.playsInline = true;
    el.className = `call-video ${mirror ? "is-mirrored" : ""} ${tile.screen ? "is-screen" : ""}`;
    host.appendChild(el);
    return () => {
      try {
        tile.track.detach(el);
      } catch {
        /* teardown race */
      }
      el.remove();
    };
  }, [tile, mirror]);
  return <div ref={ref} className="call-video-host" />;
}

function hostActionsFor(person: Person, run: (a: HostAction) => void, close: () => void) {
  const go = (a: HostAction) => () => {
    close();
    run(a);
  };
  return (
    <>
      {person.micOn && (
        <MenuItem onClick={go({ kind: "mute", identity: person.identity })}>Mute</MenuItem>
      )}
      {person.handAt !== null && (
        <MenuItem onClick={go({ kind: "lower-hand", identity: person.identity })}>
          Lower hand
        </MenuItem>
      )}
      {!person.host && (
        <MenuItem onClick={go({ kind: "make-host", identity: person.identity })}>
          Make co-host
        </MenuItem>
      )}
      <MenuItem danger onClick={go({ kind: "remove", identity: person.identity })}>
        Remove from call
      </MenuItem>
    </>
  );
}

function Tile({
  person,
  screen = false,
  reactions,
  handRank,
  pinned,
  onPin,
  canHost,
  onHostAction,
  size,
  transcribingNow,
}: {
  person: Person;
  screen?: boolean;
  reactions: LiveReaction[];
  handRank: number | null;
  pinned: boolean;
  onPin: () => void;
  canHost: boolean;
  onHostAction: (a: HostAction) => void;
  size: "grid" | "main" | "strip";
  /** Someone is transcribing the call, so "Not transcribed" means something. */
  transcribingNow: boolean;
}) {
  const media = screen ? person.screen : person.camOn ? person.video : undefined;
  const label = screen
    ? `${person.isLocal ? "You are" : `${person.name} is`} presenting`
    : person.isLocal
      ? "You"
      : person.name;
  return (
    <div
      className={`call-tile call-tile-${size} ${person.speaking && !screen ? "is-speaking" : ""} ${screen ? "is-screen" : ""}`}
      aria-label={screen ? label : `${label}${person.micOn ? "" : ", muted"}`}
    >
      {media ? (
        <TrackVideo tile={media} mirror={person.isLocal && !screen} />
      ) : (
        <div className="call-avatar" aria-hidden>
          <span>{initials(person.name)}</span>
        </div>
      )}

      <div className="call-tile-top">
        {handRank !== null && !screen && (
          <span className="call-chip is-hand" title="Hand raised">
            <Ico.HandRaise width={12} height={12} /> {handRank}
          </span>
        )}
        {person.optedOut && !person.capture && !screen && transcribingNow && (
          <span className="call-chip" title="Asked not to be transcribed">
            Not transcribed
          </span>
        )}
        {person.capture && !screen && (
          <span className="call-chip is-rec" title="Transcribing this meeting">
            <span className="call-rec-dot" aria-hidden /> Transcribing
          </span>
        )}
        {(person.quality === "poor" || person.quality === "lost") && (
          <span
            className="call-chip is-weak"
            title={person.quality === "lost" ? "Connection lost" : "Weak connection"}
          >
            <Ico.Signal width={12} height={12} />
          </span>
        )}
      </div>

      <div className="call-tile-name">
        {!screen && !person.micOn && (
          <Ico.MicOff width={12} height={12} aria-label="Muted" className="call-muted-icon" />
        )}
        <span className="call-tile-label">{label}</span>
        {person.host && !screen && <span className="call-host-badge">Host</span>}
      </div>

      <div className="call-tile-actions">
        <button
          type="button"
          className="call-tile-btn"
          aria-label={pinned ? "Unpin" : `Pin ${screen ? "the presentation" : label}`}
          title={pinned ? "Unpin" : "Pin"}
          aria-pressed={pinned}
          onClick={onPin}
        >
          <Ico.Pin width={14} height={14} />
        </button>
        {canHost && !person.isLocal && !screen && (
          <Menu
            label={`Host controls for ${person.name}`}
            className="call-tile-btn"
            button={<Ico.More width={14} height={14} />}
          >
            {(close) => hostActionsFor(person, onHostAction, close)}
          </Menu>
        )}
      </div>

      {!screen && reactions.length > 0 && (
        <div className="call-reactions" aria-live="polite">
          {reactions.map((r) => (
            <span key={r.id} className="call-reaction" aria-label={`${r.name} reacted ${r.emoji}`}>
              {r.emoji}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// --- Panels ----------------------------------------------------------------

function PeoplePanel({
  people,
  isHost,
  onHostAction,
  onClose,
  transcriber,
}: {
  people: Person[];
  isHost: boolean;
  onHostAction: (a: HostAction) => void;
  onClose: () => void;
  transcriber: { name: string } | null;
}) {
  const sorted = sortRoster(people);
  const hands = sorted.filter((p) => p.handAt !== null);
  const anyoneUnmuted = people.some((p) => !p.isLocal && p.micOn);
  return (
    <aside className="call-panel" aria-label="People">
      <header className="call-panel-head">
        <h4>People · {people.length}</h4>
        <button type="button" className="call-tile-btn" aria-label="Close people" onClick={onClose}>
          <Ico.X width={14} height={14} />
        </button>
      </header>
      {isHost && (
        <div className="call-panel-tools">
          <button
            type="button"
            className="call-link-btn"
            disabled={!anyoneUnmuted}
            onClick={() => onHostAction({ kind: "mute-everyone" })}
          >
            Mute everyone
          </button>
        </div>
      )}
      {hands.length > 0 && <p className="call-panel-section">Raised hands · {hands.length}</p>}
      <ul className="call-roster">
        {sorted.map((p) => (
          <li key={p.identity} className="call-roster-row">
            <span className="call-roster-avatar" aria-hidden>
              {initials(p.name)}
            </span>
            <span className="call-roster-name">
              {p.isLocal ? `${p.name} (You)` : p.name}
              {p.host && <span className="call-host-badge">Host</span>}
              {p.capture && <span className="call-roster-note">Transcribing</span>}
              {p.optedOut && !p.capture && transcriber && (
                <span className="call-roster-note is-muted">Not transcribed</span>
              )}
            </span>
            <span className="call-roster-icons">
              {p.handAt !== null && (
                <Ico.HandRaise width={14} height={14} aria-label="Hand raised" />
              )}
              {p.micOn ? (
                <Ico.Mic width={14} height={14} aria-label="Mic on" />
              ) : (
                <Ico.MicOff width={14} height={14} aria-label="Muted" className="is-off" />
              )}
              {p.camOn ? (
                <Ico.Video width={14} height={14} aria-label="Camera on" />
              ) : (
                <Ico.VideoOff width={14} height={14} aria-label="Camera off" className="is-off" />
              )}
              {isHost && !p.isLocal && (
                <Menu
                  label={`Host controls for ${p.name}`}
                  className="call-tile-btn"
                  button={<Ico.More width={14} height={14} />}
                >
                  {(close) => hostActionsFor(p, onHostAction, close)}
                </Menu>
              )}
            </span>
          </li>
        ))}
      </ul>
    </aside>
  );
}

function ChatPanel({
  messages,
  onSend,
  onClose,
}: {
  messages: ChatMessage[];
  onSend: (text: string) => Promise<boolean>;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState("");
  const list = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight });
  }, [messages.length]);
  const send = async () => {
    const text = draft.trim();
    if (!text) return;
    if (await onSend(text)) setDraft("");
  };
  return (
    <aside className="call-panel" aria-label="Chat">
      <header className="call-panel-head">
        <h4>In-call messages</h4>
        <button type="button" className="call-tile-btn" aria-label="Close chat" onClick={onClose}>
          <Ico.X width={14} height={14} />
        </button>
      </header>
      <p className="call-panel-note">
        Only people in the call see these messages, and they're gone when the call ends.
      </p>
      <div className="call-chat" ref={list} aria-live="polite">
        {messages.length === 0 && <p className="call-panel-empty">No messages yet.</p>}
        {messages.map((m, i) => {
          const prev = messages[i - 1];
          const grouped = prev && prev.from === m.from && m.at - prev.at < 60_000;
          return (
            <div key={`${m.from}:${m.id}`} className="call-chat-msg">
              {!grouped && (
                <div className="call-chat-meta">
                  <strong>{m.from === LOCAL ? "You" : m.name}</strong>
                  <time>
                    {new Date(m.at).toLocaleTimeString(undefined, {
                      hour: "numeric",
                      minute: "2-digit",
                    })}
                  </time>
                </div>
              )}
              <p className="call-chat-text">{m.text}</p>
            </div>
          );
        })}
      </div>
      <form
        className="call-chat-form"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <textarea
          value={draft}
          maxLength={MAX_CHAT_CHARS}
          rows={2}
          placeholder="Send a message"
          aria-label="Message everyone in the call"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button type="submit" className="call-send" disabled={!draft.trim()} aria-label="Send">
          <Ico.Send width={16} height={16} />
        </button>
      </form>
    </aside>
  );
}

// --- The stage -------------------------------------------------------------

export interface CallStageProps {
  boardId: string | null;
  title: string;
  isRecording?: boolean;
  onToggleRecording?: () => void;
  panelOpen?: boolean;
  onTogglePanel?: (panel: "transcript" | "extract" | "saved") => void;
  activePanel?: "transcript" | "extract" | "saved" | "notes";
  onToggleNotes?: () => void;
  notesOpen?: boolean;
}

export function CallStage({
  boardId,
  title,
  isRecording = false,
  onToggleRecording,
  panelOpen = false,
  onTogglePanel,
  activePanel = "transcript",
  onToggleNotes,
  notesOpen,
}: CallStageProps) {
  const s = useMeetingSession();
  const {
    status,
    peers,
    tiles,
    micOn,
    camOn,
    screenOn,
    meta,
    isHost,
    selfName,
    notice,
    dismissNotice,
    toast,
    audioBlocked,
    startAudio,
    chat,
    chatUnread,
    setChatOpen,
    sendChat,
    reactions,
    sendReaction,
    handUp,
    setHand,
    hostAction,
    toggleMic,
    toggleCam,
    toggleScreen,
    leave,
    devices,
    chooseDevice,
    transcriber,
    transcribeMe,
    setTranscribeMe,
    contribution,
    captionsOn,
    setCaptionsOn,
    captions,
    captionsRequested,
    setCallSettings,
    answerGuest,
  } = s;

  const [panel, setPanel] = useState<Panel>(null);
  const [layout, setLayout] = useState<Layout>("auto");
  const [pinned, setPinned] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [lastSpeaker, setLastSpeaker] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [joinedAt] = useState(() => Date.now());
  const stageRef = useRef<HTMLDivElement | null>(null);
  const lists = useDeviceLists(settingsOpen);

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);

  useEffect(() => {
    setChatOpen(panel === "chat");
  }, [panel, setChatOpen]);
  useEffect(() => () => setChatOpen(false), [setChatOpen]);

  const people: Person[] = useMemo(() => {
    const list: Person[] = [];
    const local = peers.get(LOCAL);
    const video = (id: string) =>
      tiles.find((t) => t.identity === id && t.kind === "video" && !t.screen);
    const screen = (id: string) =>
      tiles.find((t) => t.identity === id && t.kind === "video" && t.screen);
    list.push({
      identity: LOCAL,
      name: selfName ?? "You",
      isLocal: true,
      host: isHost,
      handAt: local?.handAt ?? null,
      micOn,
      camOn,
      speaking: local?.speaking ?? false,
      capture: local?.capture ?? false,
      optedOut: !transcribeMe,
      quality: local?.quality ?? "unknown",
      video: video(LOCAL),
      screen: screenOn ? screen(LOCAL) : undefined,
    });
    for (const p of peers.values()) {
      if (p.identity === LOCAL) continue;
      list.push({
        identity: p.identity,
        name: p.name,
        isLocal: false,
        host: Boolean(meta?.hosts.includes(p.identity)),
        handAt: p.handAt,
        micOn: p.micOn,
        camOn: p.camOn,
        speaking: p.speaking,
        capture: p.capture,
        optedOut: p.optedOut,
        quality: p.quality,
        video: video(p.identity),
        screen: screen(p.identity),
      });
    }
    return list;
  }, [peers, tiles, micOn, camOn, screenOn, meta, isHost, selfName, transcribeMe]);

  // The speaker view follows whoever spoke last (not you, unless you're alone).
  useEffect(() => {
    const talking = people.find((p) => p.speaking && !p.isLocal);
    if (talking) setLastSpeaker(talking.identity);
  }, [people]);

  // A pinned person who left, or a pinned presentation that stopped, unpins.
  useEffect(() => {
    if (!pinned) return;
    const [id, what] = pinned.split("#");
    const person = people.find((p) => p.identity === id);
    if (!person || (what === "screen" && !person.screen)) setPinned(null);
  }, [pinned, people]);

  const hands = people
    .filter((p) => p.handAt !== null)
    .sort((a, b) => a.handAt! - b.handAt!)
    .map((p) => p.identity);
  const handRank = (p: Person) => (p.handAt === null ? null : hands.indexOf(p.identity) + 1);
  const reactionsOf = (p: Person) => reactions.filter((r) => r.identity === p.identity);
  const transcribing = people.filter((p) => p.capture);

  // What takes the big spot: a pin, else a presentation, else (speaker view) the last speaker.
  const presenter = people.find((p) => p.screen);
  let spotlight: { person: Person; screen: boolean } | null = null;
  if (pinned) {
    const [id, what] = pinned.split("#");
    const person = people.find((p) => p.identity === id);
    if (person) spotlight = { person, screen: what === "screen" };
  } else if (presenter && layout !== "grid") {
    spotlight = { person: presenter, screen: true };
  } else if (layout === "speaker" && people.length > 1) {
    const person = people.find((p) => p.identity === lastSpeaker) ?? people.find((p) => !p.isLocal);
    if (person) spotlight = { person, screen: false };
  }

  const runHost = (action: HostAction) => void hostAction(action);
  const tileFor = (person: Person, screen: boolean, size: "grid" | "main" | "strip") => {
    const key = `${person.identity}#${screen ? "screen" : "cam"}`;
    return (
      <Tile
        key={key}
        person={person}
        screen={screen}
        reactions={reactionsOf(person)}
        handRank={handRank(person)}
        pinned={pinned === key}
        onPin={() => setPinned((p) => (p === key ? null : key))}
        canHost={isHost}
        onHostAction={runHost}
        size={size}
        transcribingNow={transcriber !== null}
      />
    );
  };

  // Meet's shortcuts: Ctrl/⌘+D mic, Ctrl/⌘+E camera, Ctrl/⌘+Alt+H hand —
  // only while the call is on screen and nobody is typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const stage = stageRef.current;
      if (!stage || stage.getClientRects().length === 0) return;
      const mod = e.ctrlKey || e.metaKey;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
      ) {
        return;
      }
      const key = e.key.toLowerCase();
      if (!mod) {
        if (key === "c" && !e.altKey && !e.shiftKey) {
          e.preventDefault();
          void setCaptionsOn(!captionsOn);
        }
        return;
      }
      if (key === "d" && !e.altKey) {
        e.preventDefault();
        void toggleMic();
      } else if (key === "e" && !e.altKey) {
        e.preventDefault();
        void toggleCam();
      } else if (key === "h" && e.altKey) {
        e.preventDefault();
        void setHand(!handUp);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleMic, toggleCam, setHand, handUp, setCaptionsOn, captionsOn]);

  const copyLink = () => {
    if (!boardId) return;
    const url = new URL(window.location.origin + window.location.pathname);
    url.searchParams.set("board", boardId);
    url.searchParams.set("view", "meeting");
    url.searchParams.set("call", "1");
    void navigator.clipboard
      ?.writeText(url.toString())
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 2500);
      })
      .catch(() => {});
  };

  // One call, one transcript (docs/28 A3.5): while someone else records it,
  // this person's words already go into theirs.
  const recordedElsewhere = !isRecording && transcriber !== null && !transcriber.isLocal;
  const recordLabel = isRecording
    ? "Stop transcribing"
    : recordedElsewhere
      ? `${transcriber?.name ?? "Someone"} is already transcribing this call`
      : "Transcribe this meeting";

  // Only hosts present, when the host says so (docs/28 S5).
  const shareLocked = Boolean(meta?.hostsOnlyShare) && !isHost && !screenOn;
  // Your device transcribes you for someone's captions, not for a transcript.
  const captionsOnly = captionsRequested && !isRecording && !(transcriber && !transcriber.isLocal);

  const startedAt = meta?.startedAt && meta.startedAt <= now ? meta.startedAt : joinedAt;
  const others = people.filter((p) => !p.isLocal);
  const cols = gridColumns(people.length);

  return (
    <div className="call-stage" ref={stageRef}>
      <header className="call-head">
        <div className="call-head-title">
          <span className="call-live-dot" aria-hidden />
          <strong>{title}</strong>
          <span className="call-head-time mono">{formatElapsed(now - startedAt)}</span>
        </div>
        <div className="call-head-state">
          {transcriber?.isLocal && (
            <span className="call-chip is-rec" role="status">
              <span className="call-rec-dot" aria-hidden />
              You're transcribing this meeting
            </span>
          )}
          {transcriber && !transcriber.isLocal && (
            <span className="call-chip is-rec" role="status">
              <span className="call-rec-dot" aria-hidden />
              {`Lucent is transcribing · ${transcriber.name}`}
            </span>
          )}
          {!transcriber && transcribing.length > 0 && (
            <span className="call-chip is-rec" role="status">
              <span className="call-rec-dot" aria-hidden />
              {`Lucent is transcribing · ${transcribing.map((p) => p.name).join(", ")}`}
            </span>
          )}
          {meta?.locked && (
            <span className="call-chip" title="No one new can join">
              Locked
            </span>
          )}
          {screenOn && <span className="call-chip is-share">You're presenting</span>}
        </div>
      </header>

      {isHost &&
        (meta?.waiting ?? []).map((w) => (
          <div key={w.userId} className="call-banner is-waiting" role="status">
            <span>
              <strong>{w.name}</strong> wants to join — a guest from outside the workspace.
            </span>
            <span className="call-banner-actions">
              <button
                type="button"
                className="call-link-btn"
                onClick={() => void answerGuest(w.userId, false)}
              >
                Deny
              </button>
              <button
                type="button"
                className="call-join small"
                onClick={() => void answerGuest(w.userId, true)}
              >
                Let in
              </button>
            </span>
          </div>
        ))}

      {transcriber && !transcriber.isLocal && (
        <div className="call-banner is-capture" role="status">
          <span>
            {!transcribeMe
              ? "You're not being transcribed. Others see that on your tile."
              : contribution === "live"
                ? "Your words are transcribed as you speak and go into the meeting's transcript under your name."
                : contribution === "paused"
                  ? "Your mic is off, so nothing of yours is transcribed."
                  : contribution === "unsupported"
                    ? "This browser can't transcribe you, so your words aren't in the transcript. Chrome and Edge can."
                    : "Starting transcription…"}
          </span>
          <button
            type="button"
            className="call-link-btn"
            onClick={() => void setTranscribeMe(!transcribeMe)}
          >
            {transcribeMe ? "Stop transcribing me" : "Include me"}
          </button>
        </div>
      )}

      {captionsOnly && (
        <div className="call-banner is-capture" role="status">
          <span>
            {transcribeMe
              ? "Someone is reading live captions, so your words are transcribed as you speak. Captions aren't kept."
              : "You're not being transcribed, so your words don't appear in anyone's captions."}
          </span>
          <button
            type="button"
            className="call-link-btn"
            onClick={() => void setTranscribeMe(!transcribeMe)}
          >
            {transcribeMe ? "Stop transcribing me" : "Include me"}
          </button>
        </div>
      )}

      {status === "reconnecting" && (
        <div className="call-banner is-warn" role="status">
          Reconnecting… Your transcript is safe; the call resumes when the connection is back.
        </div>
      )}
      {audioBlocked && (
        <div className="call-banner" role="status">
          Your browser paused the call's sound.
          <button type="button" className="call-link-btn" onClick={startAudio}>
            Turn on sound
          </button>
        </div>
      )}
      {notice && (
        <div className="call-notice">
          <MediaNotice text={notice} onDismiss={dismissNotice} />
        </div>
      )}

      <div className="call-body">
        <div className="call-main">
          {spotlight ? (
            <div
              className={`call-spotlight ${others.length === 0 && !spotlight.screen ? "is-solo" : ""}`}
            >
              <div className="call-spot-main">
                {tileFor(spotlight.person, spotlight.screen, "main")}
              </div>
              <div className="call-strip" aria-label="Everyone else">
                {people
                  .filter((p) => spotlight.screen || p.identity !== spotlight.person.identity)
                  .map((p) => tileFor(p, false, "strip"))}
              </div>
            </div>
          ) : (
            <div
              className="call-grid"
              style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
            >
              {people.map((p) => tileFor(p, false, "grid"))}
            </div>
          )}
          {others.length === 0 && (
            <div className="call-alone" role="status">
              <p>You're the only one here.</p>
              {boardId && (
                <button type="button" className="call-link-btn" onClick={copyLink}>
                  <Ico.Link width={14} height={14} />{" "}
                  {copied ? "Link copied" : "Copy the link to invite someone"}
                </button>
              )}
            </div>
          )}
          {captionsOn && (
            <div
              className={`call-captions ${others.length === 0 ? "is-raised" : ""}`}
              aria-live="polite"
              aria-label="Live captions"
            >
              {captions.length === 0 ? (
                <p className="call-caption is-waiting">Captions appear when someone speaks.</p>
              ) : (
                captions.map((c) => (
                  <p key={c.identity} className="call-caption">
                    <strong>{c.name}</strong> {c.text}
                  </p>
                ))
              )}
            </div>
          )}
          {toast && (
            <div className="call-toast" role="status">
              {toast}
            </div>
          )}
        </div>

        {panel === "people" && (
          <PeoplePanel
            people={people}
            isHost={isHost}
            onHostAction={runHost}
            onClose={() => setPanel(null)}
            transcriber={transcriber}
          />
        )}
        {panel === "chat" && (
          <ChatPanel messages={chat} onSend={sendChat} onClose={() => setPanel(null)} />
        )}
      </div>

      {settingsOpen && (
        <div className="call-settings" role="dialog" aria-label="Audio and video settings">
          <header className="call-panel-head">
            <h4>Audio and video</h4>
            <button
              type="button"
              className="call-tile-btn"
              aria-label="Close settings"
              onClick={() => setSettingsOpen(false)}
            >
              <Ico.X width={14} height={14} />
            </button>
          </header>
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
        </div>
      )}

      <footer className="call-bar">
        <div className="call-bar-side">
          <span className="call-bar-time mono">
            {new Date(now).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
          </span>
        </div>

        <div className="call-bar-center">
          <button
            type="button"
            className={`call-btn ${micOn ? "" : "is-off"}`}
            aria-pressed={!micOn}
            aria-label={micOn ? "Turn off microphone (Ctrl+D)" : "Turn on microphone (Ctrl+D)"}
            title={micOn ? "Turn off microphone (Ctrl+D)" : "Turn on microphone (Ctrl+D)"}
            onClick={() => void toggleMic()}
          >
            {micOn ? <Ico.Mic width={18} height={18} /> : <Ico.MicOff width={18} height={18} />}
          </button>
          <button
            type="button"
            className={`call-btn ${camOn ? "" : "is-off"}`}
            aria-pressed={!camOn}
            aria-label={camOn ? "Turn off camera (Ctrl+E)" : "Turn on camera (Ctrl+E)"}
            title={camOn ? "Turn off camera (Ctrl+E)" : "Turn on camera (Ctrl+E)"}
            onClick={() => void toggleCam()}
          >
            {camOn ? <Ico.Video width={18} height={18} /> : <Ico.VideoOff width={18} height={18} />}
          </button>
          <button
            type="button"
            className={`call-btn ${screenOn ? "is-on" : ""}`}
            aria-pressed={screenOn}
            aria-label={
              shareLocked
                ? "Only hosts can present in this call"
                : screenOn
                  ? "Stop presenting"
                  : "Present your screen"
            }
            disabled={shareLocked}
            title={
              shareLocked
                ? "Only hosts can present in this call"
                : screenOn
                  ? "Stop presenting"
                  : "Present your screen"
            }
            onClick={() => void toggleScreen()}
          >
            <Ico.Screen width={18} height={18} />
          </button>
          <Menu
            label="Send a reaction"
            className="call-btn"
            align="up"
            button={<Ico.Smile width={18} height={18} />}
          >
            {(close) => (
              <div className="call-reaction-picker">
                {REACTIONS.map((emoji) => (
                  <button
                    key={emoji}
                    type="button"
                    role="menuitem"
                    className="call-reaction-btn"
                    aria-label={`React ${emoji}`}
                    onClick={() => {
                      sendReaction(emoji);
                      close();
                    }}
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            )}
          </Menu>
          <button
            type="button"
            className={`call-btn ${handUp ? "is-on" : ""}`}
            aria-pressed={handUp}
            aria-label={handUp ? "Lower your hand (Ctrl+Alt+H)" : "Raise your hand (Ctrl+Alt+H)"}
            title={handUp ? "Lower your hand (Ctrl+Alt+H)" : "Raise your hand (Ctrl+Alt+H)"}
            onClick={() => void setHand(!handUp)}
          >
            <Ico.HandRaise width={18} height={18} />
          </button>
          <button
            type="button"
            className={`call-btn ${captionsOn ? "is-on" : ""}`}
            aria-pressed={captionsOn}
            aria-label={captionsOn ? "Turn off captions (c)" : "Turn on captions (c)"}
            title={captionsOn ? "Turn off captions (c)" : "Turn on captions (c)"}
            onClick={() => void setCaptionsOn(!captionsOn)}
          >
            <span className="call-cc" aria-hidden>
              CC
            </span>
          </button>
          {onToggleRecording && (
            <button
              type="button"
              className={`call-btn ${isRecording ? "is-rec" : ""}`}
              aria-pressed={isRecording}
              aria-label={recordLabel}
              title={recordLabel}
              disabled={recordedElsewhere}
              onClick={onToggleRecording}
            >
              <span className="call-rec-glyph" aria-hidden />
            </button>
          )}
          <Menu
            label="More options"
            className="call-btn"
            align="up"
            button={<Ico.More width={18} height={18} />}
          >
            {(close) => (
              <>
                <p className="call-menu-heading">Layout</p>
                {(["auto", "grid", "speaker"] as const).map((l) => (
                  <MenuItem
                    key={l}
                    onClick={() => {
                      setLayout(l);
                      setPinned(null);
                      close();
                    }}
                  >
                    {layout === l ? "● " : ""}
                    {l === "auto" ? "Auto" : l === "grid" ? "Tiled" : "Spotlight"}
                  </MenuItem>
                ))}
                <hr className="call-menu-rule" />
                <MenuItem
                  onClick={() => {
                    setSettingsOpen(true);
                    close();
                  }}
                >
                  Audio and video settings
                </MenuItem>
                {boardId && (
                  <MenuItem
                    onClick={() => {
                      copyLink();
                      close();
                    }}
                  >
                    {copied ? "Link copied" : "Copy joining link"}
                  </MenuItem>
                )}
                {isHost && (
                  <>
                    <hr className="call-menu-rule" />
                    <p className="call-menu-heading">Host</p>
                    <MenuItem
                      onClick={() => {
                        close();
                        void setCallSettings({ locked: !meta?.locked });
                      }}
                    >
                      {meta?.locked ? "Unlock the call" : "Lock the call"}
                      <small>
                        {meta?.locked
                          ? "Anyone on the board can join again."
                          : "No one new can join until you unlock it."}
                      </small>
                    </MenuItem>
                    <MenuItem
                      onClick={() => {
                        close();
                        void setCallSettings({ openToGuests: !meta?.openToGuests });
                      }}
                    >
                      {meta?.openToGuests ? "Guests ask to join" : "Let guests in without asking"}
                      <small>
                        {meta?.openToGuests
                          ? "People outside the workspace wait for a host again."
                          : "People outside the workspace join like everyone else."}
                      </small>
                    </MenuItem>
                    <MenuItem
                      onClick={() => {
                        close();
                        void setCallSettings({ hostsOnlyShare: !meta?.hostsOnlyShare });
                      }}
                    >
                      {meta?.hostsOnlyShare ? "Let everyone present" : "Only hosts can present"}
                      <small>
                        {meta?.hostsOnlyShare
                          ? "Anyone in the call can share their screen."
                          : "Others stop presenting and can't start."}
                      </small>
                    </MenuItem>
                  </>
                )}
                {isHost && others.length > 0 && (
                  <MenuItem
                    onClick={() => {
                      runHost({ kind: "mute-everyone" });
                      close();
                    }}
                  >
                    Mute everyone
                  </MenuItem>
                )}
              </>
            )}
          </Menu>
          {isHost ? (
            <Menu
              label="Leave or end the call"
              className="call-leave"
              align="up"
              button={
                <>
                  <Ico.PhoneOff width={18} height={18} />
                  <span>Leave</span>
                </>
              }
            >
              {(close) => (
                <>
                  <MenuItem
                    onClick={() => {
                      close();
                      leave();
                    }}
                  >
                    Leave the call
                    <small>The call goes on without you.</small>
                  </MenuItem>
                  <MenuItem
                    danger
                    onClick={() => {
                      close();
                      runHost({ kind: "end" });
                    }}
                  >
                    End the call for everyone
                    <small>Everyone leaves, and a recording in progress stops.</small>
                  </MenuItem>
                </>
              )}
            </Menu>
          ) : (
            <button type="button" className="call-leave" onClick={() => leave()}>
              <Ico.PhoneOff width={18} height={18} />
              <span>Leave</span>
            </button>
          )}
        </div>

        <div className="call-bar-side is-end">
          <button
            type="button"
            className={`call-side-btn ${panel === "people" ? "is-active" : ""}`}
            aria-pressed={panel === "people"}
            aria-label={`People (${people.length})`}
            title="People"
            onClick={() => setPanel((p) => (p === "people" ? null : "people"))}
          >
            <Ico.Team width={18} height={18} />
            <span className="call-count">{people.length}</span>
            {hands.length > 0 && <span className="call-badge is-hand">{hands.length}</span>}
          </button>
          <button
            type="button"
            className={`call-side-btn ${panel === "chat" ? "is-active" : ""}`}
            aria-pressed={panel === "chat"}
            aria-label={chatUnread > 0 ? `Chat (${chatUnread} unread)` : "Chat"}
            title="Chat"
            onClick={() => setPanel((p) => (p === "chat" ? null : "chat"))}
          >
            <Ico.Comment width={18} height={18} />
            {chatUnread > 0 && <span className="call-badge">{chatUnread}</span>}
          </button>
          {onTogglePanel && (
            <button
              type="button"
              className={`call-side-btn ${panelOpen && activePanel === "transcript" ? "is-active" : ""}`}
              aria-pressed={panelOpen && activePanel === "transcript"}
              aria-label="Transcript"
              title="Transcript"
              onClick={() => onTogglePanel("transcript")}
            >
              <ToolIco.Text width={18} height={18} />
            </button>
          )}
          {onTogglePanel && (
            <button
              type="button"
              className={`call-side-btn ${panelOpen && activePanel === "extract" ? "is-active" : ""}`}
              aria-pressed={panelOpen && activePanel === "extract"}
              aria-label="What Lucent extracted"
              title="What Lucent extracted"
              onClick={() => onTogglePanel("extract")}
            >
              <Ico.Sparkle width={18} height={18} />
            </button>
          )}
          {onToggleNotes && (
            <button
              type="button"
              className={`call-side-btn ${notesOpen ? "is-active" : ""}`}
              aria-pressed={notesOpen}
              aria-label={notesOpen ? "Hide your notes" : "Your notes — private to you"}
              title="Your notes — private to you"
              onClick={onToggleNotes}
            >
              <ToolIco.Pen width={18} height={18} />
            </button>
          )}
        </div>
      </footer>
    </div>
  );
}
