import type { Peer } from "../boardSync.js";

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
            style={{ left: p.cursor.x, top: p.cursor.y, color: p.color }}
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
 * else is here?" without needing the canvas.
 */
export function PresenceBar({ peers }: { peers: Peer[] }) {
  if (peers.length === 0) return null;
  const shown = peers.slice(0, 5);
  const extra = peers.length - shown.length;
  return (
    <div
      className="presence-bar"
      title={`${peers.length} other${peers.length > 1 ? "s" : ""} here`}
    >
      {shown.map((p) => (
        <div
          key={p.userId}
          className="presence-avatar"
          style={{ background: p.color }}
          title={p.name}
        >
          {p.name.slice(0, 1).toUpperCase()}
        </div>
      ))}
      {extra > 0 && <div className="presence-avatar more">+{extra}</div>}
    </div>
  );
}
