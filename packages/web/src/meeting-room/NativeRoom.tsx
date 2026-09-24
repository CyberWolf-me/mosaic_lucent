import { useEffect, useRef } from "react";
import { useMeetingSession, type MediaTile } from "./MeetingSessionContext.js";

/**
 * Zoom / Google Meet-Grade Native Video Room for Lucent.
 *
 * Provides:
 * - Immersive 16:9 video participant stage with responsive auto-grid
 * - Active speaker detection with glowing audio indicator rings
 * - Participant avatar fallbacks with initials when cameras are off
 * - Overlaid participant name labels and mic status tags
 * - Modern bottom floating controls bar (Mic, Camera, Screen share, Notes toggle, Leave)
 * - Clean pre-join lobby with camera/mic state preview
 */

function getInitials(name: string): string {
  if (!name) return "U";
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

function VideoTile({
  tile,
  isSpeaking,
  micMuted,
}: {
  tile: MediaTile;
  isSpeaking?: boolean;
  micMuted?: boolean;
}) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = ref.current;
    if (!host) return;
    const el = tile.track.attach();
    if (tile.kind === "audio") {
      (el as HTMLAudioElement).autoplay = true;
      el.style.display = "none";
    } else {
      (el as HTMLVideoElement).autoplay = true;
      (el as HTMLVideoElement).muted = tile.identity === "local";
      (el as HTMLVideoElement).playsInline = true;
      el.style.width = "100%";
      el.style.height = "100%";
      el.style.objectFit = "cover";
    }
    host.appendChild(el);
    return () => {
      try {
        tile.track.detach();
      } catch {
        // teardown race catch
      }
      host.replaceChildren();
    };
  }, [tile]);

  if (tile.kind === "audio") return <div ref={ref} aria-hidden />;

  return (
    <div
      style={{
        position: "relative",
        width: "100%",
        aspectRatio: "16 / 9",
        background: "#181a20",
        borderRadius: 12,
        overflow: "hidden",
        border: isSpeaking ? "2px solid #22c55e" : "1px solid rgba(255, 255, 255, 0.08)",
        boxShadow: isSpeaking ? "0 0 16px rgba(34, 197, 94, 0.35)" : "var(--elev-2)",
        transition: "border 0.15s ease, box-shadow 0.15s ease",
      }}
      aria-label={tile.screen ? `Shared screen from ${tile.name}` : `Video from ${tile.name}`}
    >
      <div ref={ref} style={{ width: "100%", height: "100%" }} />

      {/* Participant Name & Mic Status Pill */}
      <div
        style={{
          position: "absolute",
          bottom: 10,
          left: 10,
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "4px 10px",
          borderRadius: 999,
          background: "rgba(10, 12, 16, 0.75)",
          backdropFilter: "blur(12px)",
          WebkitBackdropFilter: "blur(12px)",
          color: "#fff",
          fontSize: 12,
          fontWeight: 500,
          letterSpacing: "0.02em",
          pointerEvents: "none",
        }}
      >
        <span style={{ fontSize: 11 }}>{micMuted ? "🔇" : isSpeaking ? "🔊" : "🎙️"}</span>
        <span>{tile.screen ? `${tile.name} (Screen)` : tile.name}</span>
      </div>
    </div>
  );
}

function AvatarTile({
  name,
  isSpeaking,
  micMuted,
  isLocal,
}: {
  name: string;
  isSpeaking?: boolean;
  micMuted?: boolean;
  isLocal?: boolean;
}) {
  const initials = getInitials(name);

  return (
    <div
      style={{
        position: "relative",
        width: "100%",
        aspectRatio: "16 / 9",
        background: "radial-gradient(circle at center, #242833 0%, #15171e 100%)",
        borderRadius: 12,
        overflow: "hidden",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        border: isSpeaking ? "2px solid #22c55e" : "1px solid rgba(255, 255, 255, 0.08)",
        boxShadow: isSpeaking ? "0 0 16px rgba(34, 197, 94, 0.35)" : "var(--elev-2)",
        transition: "border 0.15s ease, box-shadow 0.15s ease",
      }}
    >
      {/* Circle Avatar with Initials */}
      <div
        style={{
          width: 72,
          height: 72,
          borderRadius: "50%",
          background: isLocal
            ? "linear-gradient(135deg, #3b82f6, #1d4ed8)"
            : "linear-gradient(135deg, #f59e0b, #d97706)",
          color: "#fff",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 24,
          fontWeight: 600,
          letterSpacing: "0.05em",
          boxShadow: isSpeaking
            ? "0 0 0 4px rgba(34, 197, 94, 0.4)"
            : "0 4px 12px rgba(0, 0, 0, 0.3)",
          transition: "box-shadow 0.2s ease",
        }}
      >
        {initials}
      </div>

      {/* Name and Status Label */}
      <div
        style={{
          position: "absolute",
          bottom: 10,
          left: 10,
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "4px 10px",
          borderRadius: 999,
          background: "rgba(10, 12, 16, 0.75)",
          backdropFilter: "blur(12px)",
          WebkitBackdropFilter: "blur(12px)",
          color: "#fff",
          fontSize: 12,
          fontWeight: 500,
          letterSpacing: "0.02em",
        }}
      >
        <span style={{ fontSize: 11 }}>{micMuted ? "🔇" : isSpeaking ? "🔊" : "🎙️"}</span>
        <span>{name}</span>
      </div>
    </div>
  );
}

export function NativeRoom({
  boardId,
  isRecording = false,
  onToggleRecording,
  panelOpen = false,
  onTogglePanel,
  activePanel = "transcript",
  turnsCount: _turnsCount = 0,
  onToggleNotes,
  notesOpen,
}: {
  boardId: string | null;
  isRecording?: boolean;
  onToggleRecording?: () => void;
  panelOpen?: boolean;
  onTogglePanel?: (panel: "transcript" | "extract" | "saved") => void;
  activePanel?: "transcript" | "extract" | "saved" | "notes";
  turnsCount?: number;
  onToggleNotes?: () => void;
  notesOpen?: boolean;
}) {
  const {
    status,
    error,
    peers,
    tiles,
    micOn,
    camOn,
    screenOn,
    setMicOn,
    setCamOn,
    join,
    leave,
    toggleMic,
    toggleCam,
    toggleScreen,
  } = useMeetingSession();

  const peerList = [...peers.values()];
  const videoTiles = tiles.filter((t) => t.kind === "video");

  // If status is idle or error, render Zoom/Meet style Pre-Join Lobby
  if (status === "idle" || status === "joining" || status === "error") {
    return (
      <div
        className="meet-lobby-card"
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          padding: "48px 24px",
          background: "radial-gradient(circle at center, var(--canvas-2) 0%, var(--canvas-1) 100%)",
          border: "1px solid var(--stroke-1)",
          borderRadius: 16,
          boxShadow: "var(--elev-2)",
          textAlign: "center",
          maxWidth: 640,
          margin: "32px auto",
        }}
      >
        <div
          style={{
            width: 64,
            height: 64,
            borderRadius: "50%",
            background: "oklch(from var(--amber-1) l c h / 0.15)",
            color: "var(--amber-2)",
            display: "grid",
            placeItems: "center",
            fontSize: 28,
            marginBottom: 16,
          }}
        >
          📹
        </div>
        <h3 style={{ margin: "0 0 8px", fontSize: 20, color: "var(--ink-0)", fontWeight: 600 }}>
          Lucent Video Meeting
        </h3>
        <p style={{ margin: "0 0 24px", fontSize: 13.5, color: "var(--ink-2)", maxWidth: 420 }}>
          Join the multi-party video call with screen sharing and live AI diagram extraction
          directly on your canvas.
        </p>

        {/* Device preview toggles */}
        <div style={{ display: "flex", gap: 12, marginBottom: 28 }}>
          <button
            className={`btn ${micOn ? "primary" : ""}`}
            style={{ borderRadius: 999, padding: "8px 16px", fontSize: 13 }}
            onClick={() => setMicOn((m) => !m)}
          >
            {micOn ? "🎙️ Mic On" : "🔇 Mic Off"}
          </button>
          <button
            className={`btn ${camOn ? "primary" : ""}`}
            style={{ borderRadius: 999, padding: "8px 16px", fontSize: 13 }}
            onClick={() => setCamOn((c) => !c)}
          >
            {camOn ? "📹 Camera On" : "📷 Camera Off"}
          </button>
        </div>

        {error && (
          <div
            style={{
              padding: "8px 16px",
              borderRadius: 8,
              background: "oklch(from var(--sig-red) l c h / 0.15)",
              color: "var(--sig-red)",
              fontSize: 12,
              marginBottom: 20,
            }}
          >
            {error}
          </div>
        )}

        <button
          className="btn primary"
          style={{
            flex: "0 0 auto",
            height: 44,
            padding: "0 32px",
            fontSize: 15,
            borderRadius: 999,
            fontWeight: 600,
            letterSpacing: "0.02em",
          }}
          onClick={() => void join(boardId)}
          disabled={status === "joining"}
        >
          {status === "joining" ? "Connecting to room…" : "Join Meeting Now"}
        </button>
      </div>
    );
  }

  // Active Call Stage
  return (
    <div
      className="meet-stage-container"
      style={{
        position: "relative",
        display: "flex",
        flexDirection: "column",
        flex: 1,
        minHeight: 0,
        background: "#0c0d11",
        borderRadius: 16,
        border: "1px solid rgba(255, 255, 255, 0.08)",
        overflow: "hidden",
      }}
    >
      {/* Top Meeting Header Bar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "12px 20px",
          background: "rgba(16, 18, 24, 0.85)",
          backdropFilter: "blur(16px)",
          borderBottom: "1px solid rgba(255, 255, 255, 0.06)",
          zIndex: 20,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: "#22c55e",
              boxShadow: "0 0 8px #22c55e",
            }}
          />
          <span style={{ fontSize: 13, fontWeight: 600, color: "#fff" }}>Live Room</span>
          <span
            style={{
              fontSize: 11,
              padding: "2px 8px",
              borderRadius: 999,
              background: "rgba(255, 255, 255, 0.1)",
              color: "rgba(255, 255, 255, 0.8)",
            }}
          >
            {peerList.length + 1} participant{peerList.length === 0 ? "" : "s"}
          </span>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {screenOn && (
            <span
              style={{
                fontSize: 11,
                color: "var(--amber-2, #f59e0b)",
                background: "rgba(245, 158, 11, 0.15)",
                padding: "3px 10px",
                borderRadius: 999,
              }}
            >
              🖥️ You are sharing your screen
            </span>
          )}
        </div>
      </div>

      {/* Main Video Stage Grid */}
      <div
        style={{
          flex: 1,
          display: "grid",
          gridTemplateColumns:
            videoTiles.length <= 1 && peerList.length <= 0
              ? "1fr"
              : videoTiles.length <= 2 && peerList.length <= 1
                ? "repeat(2, 1fr)"
                : "repeat(auto-fit, minmax(280px, 1fr))",
          gap: 16,
          padding: 20,
          overflowY: "auto",
          alignContent: "center",
          justifyContent: "center",
        }}
      >
        {/* Local Participant Tile */}
        {camOn && videoTiles.some((t) => t.identity === "local") ? (
          videoTiles
            .filter((t) => t.identity === "local" && !t.screen)
            .map((t) => <VideoTile key={t.key} tile={t} isSpeaking={false} micMuted={!micOn} />)
        ) : (
          <AvatarTile name="You" isSpeaking={false} micMuted={!micOn} isLocal={true} />
        )}

        {/* Local Screen Share Tile if sharing */}
        {videoTiles
          .filter((t) => t.identity === "local" && t.screen)
          .map((t) => (
            <VideoTile key={t.key} tile={t} isSpeaking={false} micMuted={!micOn} />
          ))}

        {/* Remote Participant Tiles */}
        {peerList.map((peer) => {
          const peerVideo = videoTiles.find((t) => t.identity === peer.identity && !t.screen);
          const peerScreen = videoTiles.find((t) => t.identity === peer.identity && t.screen);

          return (
            <div key={peer.identity} style={{ display: "contents" }}>
              {peerVideo ? (
                <VideoTile tile={peerVideo} isSpeaking={peer.speaking} micMuted={!peer.micOn} />
              ) : (
                <AvatarTile name={peer.name} isSpeaking={peer.speaking} micMuted={!peer.micOn} />
              )}
              {peerScreen && (
                <VideoTile tile={peerScreen} isSpeaking={false} micMuted={!peer.micOn} />
              )}
            </div>
          );
        })}
      </div>

      {/* Floating Bottom Controls Bar (Zoom / Google Meet Style) */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 14,
          padding: "14px 24px",
          background: "rgba(16, 18, 24, 0.92)",
          backdropFilter: "blur(20px)",
          borderTop: "1px solid rgba(255, 255, 255, 0.08)",
          zIndex: 20,
        }}
      >
        {/* Mic toggle */}
        <button
          onClick={() => void toggleMic()}
          title={micOn ? "Mute microphone" : "Unmute microphone"}
          style={{
            width: 46,
            height: 46,
            borderRadius: "50%",
            background: micOn ? "#262a34" : "#ef4444",
            color: "#fff",
            border: "none",
            display: "grid",
            placeItems: "center",
            fontSize: 18,
            cursor: "pointer",
            transition: "all 0.15s ease",
            boxShadow: "0 2px 8px rgba(0,0,0,0.3)",
          }}
        >
          {micOn ? "🎙️" : "🔇"}
        </button>

        {/* Camera toggle */}
        <button
          onClick={() => void toggleCam()}
          title={camOn ? "Turn camera off" : "Turn camera on"}
          style={{
            width: 46,
            height: 46,
            borderRadius: "50%",
            background: camOn ? "#262a34" : "#ef4444",
            color: "#fff",
            border: "none",
            display: "grid",
            placeItems: "center",
            fontSize: 18,
            cursor: "pointer",
            transition: "all 0.15s ease",
            boxShadow: "0 2px 8px rgba(0,0,0,0.3)",
          }}
        >
          {camOn ? "📹" : "📷"}
        </button>

        {/* Screen share toggle */}
        <button
          onClick={() => void toggleScreen()}
          title={screenOn ? "Stop sharing screen" : "Share your screen"}
          style={{
            width: 46,
            height: 46,
            borderRadius: "50%",
            background: screenOn ? "var(--amber-2, #f59e0b)" : "#262a34",
            color: screenOn ? "#000" : "#fff",
            border: "none",
            display: "grid",
            placeItems: "center",
            fontSize: 18,
            cursor: "pointer",
            transition: "all 0.15s ease",
            boxShadow: "0 2px 8px rgba(0,0,0,0.3)",
          }}
        >
          🖥️
        </button>

        {/* Record audio button */}
        {onToggleRecording && (
          <button
            onClick={onToggleRecording}
            title={
              isRecording ? "Stop recording audio" : "Start recording audio & live AI transcription"
            }
            style={{
              width: 46,
              height: 46,
              borderRadius: "50%",
              background: isRecording ? "#ef4444" : "#262a34",
              color: "#fff",
              border: isRecording ? "2px solid rgba(255,255,255,0.8)" : "none",
              display: "grid",
              placeItems: "center",
              fontSize: 18,
              cursor: "pointer",
              transition: "all 0.15s ease",
              boxShadow: isRecording
                ? "0 0 14px rgba(239, 68, 68, 0.6)"
                : "0 2px 8px rgba(0,0,0,0.3)",
            }}
          >
            {isRecording ? "⏹️" : "🔴"}
          </button>
        )}

        {/* Meeting Minutes Drawer Toggle */}
        {onTogglePanel && (
          <button
            onClick={() => onTogglePanel("transcript")}
            title={
              panelOpen && activePanel === "transcript"
                ? "Hide minutes"
                : "Show meeting minutes & transcript"
            }
            style={{
              width: 46,
              height: 46,
              borderRadius: "50%",
              background:
                panelOpen && activePanel === "transcript" ? "var(--amber-2, #f59e0b)" : "#262a34",
              color: panelOpen && activePanel === "transcript" ? "#000" : "#fff",
              border: "none",
              display: "grid",
              placeItems: "center",
              fontSize: 18,
              cursor: "pointer",
              transition: "all 0.15s ease",
              boxShadow: "0 2px 8px rgba(0,0,0,0.3)",
            }}
          >
            📝
          </button>
        )}

        {/* Extracted Diagram Statements Drawer Toggle */}
        {onTogglePanel && (
          <button
            onClick={() => onTogglePanel("extract")}
            title={
              panelOpen && activePanel === "extract"
                ? "Hide extracted statements"
                : "Show extracted diagram statements"
            }
            style={{
              width: 46,
              height: 46,
              borderRadius: "50%",
              background:
                panelOpen && activePanel === "extract" ? "var(--amber-2, #f59e0b)" : "#262a34",
              color: panelOpen && activePanel === "extract" ? "#000" : "#fff",
              border: "none",
              display: "grid",
              placeItems: "center",
              fontSize: 18,
              cursor: "pointer",
              transition: "all 0.15s ease",
              boxShadow: "0 2px 8px rgba(0,0,0,0.3)",
            }}
          >
            🧠
          </button>
        )}

        {/* Toggle live transcript / notes side drawer */}
        {onToggleNotes && (
          <button
            onClick={onToggleNotes}
            title={notesOpen ? "Hide your notes" : "Your notes — private to you"}
            aria-label={notesOpen ? "Hide your notes" : "Show your notes"}
            aria-pressed={notesOpen}
            style={{
              width: 46,
              height: 46,
              borderRadius: "50%",
              background: notesOpen ? "var(--canvas-3, #333)" : "#262a34",
              color: "#fff",
              border: "none",
              display: "grid",
              placeItems: "center",
              fontSize: 18,
              cursor: "pointer",
              transition: "all 0.15s ease",
              boxShadow: "0 2px 8px rgba(0,0,0,0.3)",
            }}
          >
            📝
          </button>
        )}

        <div
          style={{ width: 1, height: 24, background: "rgba(255, 255, 255, 0.15)", margin: "0 4px" }}
        />

        {/* Leave Meeting Button */}
        <button
          onClick={() => leave()}
          title="Leave meeting"
          style={{
            height: 44,
            padding: "0 22px",
            borderRadius: 999,
            background: "#ef4444",
            color: "#fff",
            border: "none",
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontSize: 14,
            fontWeight: 600,
            cursor: "pointer",
            boxShadow: "0 2px 10px rgba(239, 68, 68, 0.4)",
            transition: "transform 0.15s ease, background 0.15s ease",
          }}
        >
          <span>📞</span>
          <span>Leave Call</span>
        </button>
      </div>
    </div>
  );
}
