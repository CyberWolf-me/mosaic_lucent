import { useRef, useEffect, useState } from "react";
import { useMeetingSession, type MediaTile } from "./MeetingSessionContext.js";
import { useWorkspace } from "../workspace.js";
import { Ico } from "../ui/icons.js";

function getInitials(name: string): string {
  if (!name) return "U";
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

function MiniTrackPreview({ tile }: { tile: MediaTile }) {
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
        el.remove();
      } catch {
        /* ignore cleanup errors */
      }
    };
  }, [tile]);

  return <div ref={ref} style={{ width: "100%", height: "100%", overflow: "hidden" }} />;
}

export function MeetingHuddleDock() {
  const { view, setView } = useWorkspace();
  const {
    status,
    peers,
    tiles,
    micOn,
    camOn,
    screenOn,
    activeLease,
    setActiveLease,
    toggleMic,
    toggleCam,
    toggleScreen,
    leave,
  } = useMeetingSession();

  const [leaseRemainingSec, setLeaseRemainingSec] = useState(0);

  useEffect(() => {
    if (!activeLease) {
      setLeaseRemainingSec(0);
      return;
    }
    const update = () => {
      const diff = Math.max(0, Math.ceil((activeLease.expiresAt - Date.now()) / 1000));
      setLeaseRemainingSec(diff);
      if (diff <= 0) {
        setActiveLease(null);
      }
    };
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [activeLease, setActiveLease]);

  // Only show the floating dock when in a live meeting AND NOT currently on the full meeting screen
  if (status !== "live" || view === "meeting") {
    return null;
  }

  const peerList = [...peers.values()];
  const screenTile = tiles.find((t) => t.screen);
  const videoTiles = tiles.filter((t) => t.kind === "video" && !t.screen);

  return (
    <aside
      className="meeting-huddle-dock"
      aria-label="Active Meeting Huddle"
      style={{
        position: "fixed",
        bottom: 24,
        right: 24,
        zIndex: 1200,
        display: "flex",
        flexDirection: "column",
        gap: 10,
        padding: "12px 14px",
        background: "rgba(16, 18, 24, 0.88)",
        backdropFilter: "blur(20px)",
        WebkitBackdropFilter: "blur(20px)",
        borderRadius: 18,
        border: "1px solid rgba(255, 255, 255, 0.12)",
        boxShadow: "0 16px 36px rgba(0, 0, 0, 0.45), 0 0 0 1px rgba(255, 255, 255, 0.05)",
        maxWidth: 320,
        minWidth: 260,
      }}
    >
      {/* Header bar with live indicator */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          fontSize: 12,
          fontWeight: 600,
          color: "var(--ink-0)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: "#22c55e",
              boxShadow: "0 0 8px #22c55e",
            }}
          />
          <span>Lucent Huddle</span>
          <span style={{ fontSize: 11, color: "var(--ink-2)", fontWeight: 400 }}>
            ({peerList.length} peer{peerList.length === 1 ? "" : "s"})
          </span>
        </div>

        <button
          className="btn"
          onClick={() => setView("meeting")}
          title="Expand to Full Meeting Stage"
          style={{
            padding: "2px 8px",
            fontSize: 11,
            borderRadius: 6,
            background: "rgba(255, 255, 255, 0.08)",
            border: "none",
            color: "var(--ink-1)",
            cursor: "pointer",
          }}
        >
          ⛶ Expand
        </button>
      </div>

      {/* Conversational Lease Follow-Up Indicator */}
      {activeLease && leaseRemainingSec > 0 && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "5px 8px",
            borderRadius: 8,
            background: "rgba(99, 102, 241, 0.16)",
            border: "1px solid rgba(99, 102, 241, 0.35)",
            color: "#c7d2fe",
            fontSize: 11,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 6, overflow: "hidden" }}>
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                background: "#818cf8",
                boxShadow: "0 0 8px #818cf8",
                flexShrink: 0,
              }}
            />
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              ↳ Continuing with {activeLease.speakerName || activeLease.speakerId} (
              {leaseRemainingSec}s)
            </span>
          </div>
          <button
            type="button"
            onClick={() => setActiveLease(null)}
            title="Dismiss conversational lease (Esc)"
            style={{
              background: "rgba(255, 255, 255, 0.1)",
              border: "none",
              borderRadius: 4,
              color: "#fff",
              cursor: "pointer",
              fontSize: 9.5,
              padding: "1px 5px",
              marginLeft: 6,
              flexShrink: 0,
            }}
          >
            Esc
          </button>
        </div>
      )}

      {/* Screen share notification if active */}
      {screenTile && (
        <div
          onClick={() => setView("meeting")}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "6px 10px",
            borderRadius: 8,
            background: "rgba(34, 197, 94, 0.12)",
            border: "1px solid rgba(34, 197, 94, 0.25)",
            color: "#22c55e",
            fontSize: 11.5,
            cursor: "pointer",
          }}
        >
          <Ico.Screen width={14} height={14} />
          <span
            style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
          >
            {screenTile.identity === "local"
              ? "You are presenting"
              : `${screenTile.name} is presenting`}
          </span>
          <span style={{ fontSize: 10, opacity: 0.8 }}>View</span>
        </div>
      )}

      {/* Participant avatar strip */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          overflowX: "auto",
          padding: "4px 0",
        }}
      >
        {/* Local user */}
        <div
          style={{
            position: "relative",
            width: 44,
            height: 44,
            borderRadius: "50%",
            overflow: "hidden",
            background: "linear-gradient(135deg, #3b82f6, #1d4ed8)",
            display: "grid",
            placeItems: "center",
            flexShrink: 0,
            border: micOn ? "2px solid rgba(255, 255, 255, 0.2)" : "2px solid transparent",
          }}
        >
          {camOn && videoTiles.some((t) => t.identity === "local") ? (
            <MiniTrackPreview tile={videoTiles.find((t) => t.identity === "local")!} />
          ) : (
            <span style={{ fontSize: 13, fontWeight: 600, color: "#fff" }}>You</span>
          )}
          {!micOn && (
            <span
              style={{
                position: "absolute",
                bottom: 0,
                right: 0,
                background: "#ef4444",
                borderRadius: "50%",
                width: 14,
                height: 14,
                display: "grid",
                placeItems: "center",
                fontSize: 8,
                color: "#fff",
              }}
            >
              🔇
            </span>
          )}
        </div>

        {/* Remote peers */}
        {peerList
          .filter((p) => p.identity !== "local")
          .map((peer) => {
            const peerTile = videoTiles.find((t) => t.identity === peer.identity);
            return (
              <div
                key={peer.identity}
                title={peer.name}
                style={{
                  position: "relative",
                  width: 44,
                  height: 44,
                  borderRadius: "50%",
                  overflow: "hidden",
                  background: "linear-gradient(135deg, #8b5cf6, #6d28d9)",
                  display: "grid",
                  placeItems: "center",
                  flexShrink: 0,
                  boxShadow: peer.speaking
                    ? "0 0 0 2.5px #22c55e, 0 0 10px rgba(34, 197, 94, 0.5)"
                    : "0 0 0 1.5px rgba(255, 255, 255, 0.15)",
                  transition: "box-shadow 0.15s ease",
                }}
              >
                {peer.camOn && peerTile ? (
                  <MiniTrackPreview tile={peerTile} />
                ) : (
                  <span style={{ fontSize: 13, fontWeight: 600, color: "#fff" }}>
                    {getInitials(peer.name)}
                  </span>
                )}
                {!peer.micOn && (
                  <span
                    style={{
                      position: "absolute",
                      bottom: 0,
                      right: 0,
                      background: "#ef4444",
                      borderRadius: "50%",
                      width: 14,
                      height: 14,
                      display: "grid",
                      placeItems: "center",
                      fontSize: 8,
                      color: "#fff",
                    }}
                  >
                    🔇
                  </span>
                )}
              </div>
            );
          })}
      </div>

      {/* Floating Call Controls */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 6,
          paddingTop: 4,
          borderTop: "1px solid rgba(255, 255, 255, 0.08)",
        }}
      >
        <button
          className={`btn ${micOn ? "" : "danger"}`}
          onClick={() => void toggleMic()}
          title={micOn ? "Mute Microphone" : "Unmute Microphone"}
          style={{
            flex: 1,
            height: 34,
            borderRadius: 8,
            display: "grid",
            placeItems: "center",
            background: micOn ? "rgba(255, 255, 255, 0.08)" : "#ef4444",
            color: "#fff",
            border: "none",
            cursor: "pointer",
          }}
        >
          {micOn ? <Ico.Mic width={15} height={15} /> : <Ico.MicOff width={15} height={15} />}
        </button>

        <button
          className="btn"
          onClick={() => void toggleCam()}
          title={camOn ? "Turn Camera Off" : "Turn Camera On"}
          style={{
            flex: 1,
            height: 34,
            borderRadius: 8,
            display: "grid",
            placeItems: "center",
            background: camOn ? "rgba(255, 255, 255, 0.08)" : "rgba(255, 255, 255, 0.03)",
            color: camOn ? "#fff" : "var(--ink-2)",
            border: "none",
            cursor: "pointer",
          }}
        >
          {camOn ? <Ico.Video width={15} height={15} /> : <Ico.VideoOff width={15} height={15} />}
        </button>

        <button
          className="btn"
          onClick={() => void toggleScreen()}
          title={screenOn ? "Stop Screen Share" : "Share Screen"}
          style={{
            flex: 1,
            height: 34,
            borderRadius: 8,
            display: "grid",
            placeItems: "center",
            background: screenOn ? "#22c55e" : "rgba(255, 255, 255, 0.08)",
            color: "#fff",
            border: "none",
            cursor: "pointer",
          }}
        >
          <Ico.Screen width={15} height={15} />
        </button>

        <button
          className="btn danger"
          onClick={() => leave()}
          title="Leave Call"
          style={{
            flex: 1.2,
            height: 34,
            borderRadius: 8,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 4,
            background: "rgba(239, 68, 68, 0.25)",
            color: "#ef4444",
            border: "1px solid rgba(239, 68, 68, 0.4)",
            cursor: "pointer",
            fontSize: 12,
            fontWeight: 600,
          }}
        >
          <Ico.PhoneOff width={14} height={14} />
          <span>Leave</span>
        </button>
      </div>
    </aside>
  );
}
