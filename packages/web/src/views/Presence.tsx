import type { Peer, Spotlight } from "../boardSync.js";
import type { Following } from "./useFollow.js";

/**
 * Remote participants' cursors and selections, drawn inside the pan/zoom layer so
 * they track content coordinates (docs/12 live cursors). Presence is ambient — it
 * never captures pointer events, so it can't get in the way of editing.
 */
export function PresenceCursors({ peers }: { peers: Peer[] }) {
  if (peers.length === 0) return null;
  return (
    <div style={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: 45 }}>
      {peers.map((p) =>
        p.cursor ? (
          <div
            key={p.userId}
            className="presence-cursor"
            // Transform-positioned (see .presence-cursor): layout properties
            // here would reflow the board on every remote cursor frame.
            style={{
              transform: `translate(${p.cursor.x - 2}px, ${p.cursor.y - 2}px)`,
              color: p.color,
            }}
          >
            <svg width="18" height="18" viewBox="0 0 18 18" fill="currentColor" aria-hidden>
              <path d="M2 2l5 14 2.5-5.5L15 8z" />
            </svg>
            <span className="presence-name" style={{ background: p.color }}>
              {p.name}
            </span>
          </div>
        ) : null,
      )}
    </div>
  );
}

/**
 * Avatar stack of everyone present, shown in the top bar. The count answers "who
 * else is here?" without needing the canvas. With `onFollow`, an avatar is a
 * button: your view follows theirs (docs/28 S5).
 */
export function PresenceBar({
  peers,
  followingId,
  onFollow,
}: {
  peers: Peer[];
  followingId?: string | null;
  onFollow?: (peer: Peer) => void;
}) {
  if (peers.length === 0) return null;
  const shown = peers.slice(0, 5);
  const extra = peers.length - shown.length;
  return (
    <div
      className="presence-bar"
      title={`${peers.length} other${peers.length > 1 ? "s" : ""} here`}
    >
      {shown.map((p) =>
        onFollow ? (
          <button
            key={p.userId}
            type="button"
            className={`presence-avatar follow ${followingId === p.userId ? "on" : ""}`}
            style={{ background: p.color }}
            title={followingId === p.userId ? `Following ${p.name}` : `Follow ${p.name}`}
            aria-label={followingId === p.userId ? `Following ${p.name}` : `Follow ${p.name}`}
            aria-pressed={followingId === p.userId}
            onClick={() => onFollow(p)}
          >
            {p.name.slice(0, 1).toUpperCase()}
          </button>
        ) : (
          <div
            key={p.userId}
            className="presence-avatar"
            style={{ background: p.color }}
            title={p.name}
          >
            {p.name.slice(0, 1).toUpperCase()}
          </div>
        ),
      )}
      {extra > 0 && <div className="presence-avatar more">+{extra}</div>}
    </div>
  );
}

/**
 * What following looks like, and the presenter's two moves (docs/28 S5): who
 * you're following (or who has the spotlight), a way out and back in, and —
 * for someone who may edit — Spotlight and Bring everyone here.
 */
export function FollowBar({
  children,
  following,
  spotlight,
  meId,
  steppedOut,
  summonedBy,
  canLead,
  onStop,
  onRejoin,
  onSpotlight,
  onSummon,
  onGoBack,
}: {
  /** The avatars, on the same row as the presenter's moves. */
  children?: React.ReactNode;
  following: Following | null;
  spotlight: Spotlight | null;
  meId: string | null;
  steppedOut: string | null;
  summonedBy: string | null;
  canLead: boolean;
  onStop: () => void;
  onRejoin: () => void;
  onSpotlight: (on: boolean) => void;
  onSummon: () => void;
  onGoBack: () => void;
}) {
  const mine = spotlight !== null && spotlight.userId === meId;
  let status: { text: string; action?: { label: string; run: () => void } } | null = null;
  if (summonedBy) {
    status = {
      text: `${summonedBy} brought everyone here`,
      action: { label: "Go back", run: onGoBack },
    };
  } else if (mine) {
    status = {
      text: "You have the spotlight — everyone sees your view",
      action: { label: "Stop", run: () => onSpotlight(false) },
    };
  } else if (following?.via === "spotlight") {
    status = {
      text: `Following ${following.name}'s spotlight`,
      action: { label: "Stop following", run: onStop },
    };
  } else if (spotlight && steppedOut === spotlight.userId) {
    status = {
      text: `${spotlight.name} has the spotlight`,
      action: { label: "Follow", run: onRejoin },
    };
  } else if (following) {
    status = { text: `Following ${following.name}`, action: { label: "Stop", run: onStop } };
  }
  return (
    <>
      <div className="follow-row">
        {children}
        {canLead && (
          <div className="follow-actions">
            {!mine && (
              <button type="button" className="follow-btn" onClick={() => onSpotlight(true)}>
                Spotlight me
              </button>
            )}
            <button type="button" className="follow-btn" onClick={onSummon}>
              Bring everyone here
            </button>
          </div>
        )}
      </div>
      {status && (
        <div className={`follow-chip ${mine ? "mine" : ""}`} role="status">
          <span>{status.text}</span>
          {status.action && (
            <button type="button" className="follow-chip-btn" onClick={status.action.run}>
              {status.action.label}
            </button>
          )}
        </div>
      )}
    </>
  );
}
