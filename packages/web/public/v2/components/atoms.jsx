// Lucent v2 — shared atoms: icons, paper backdrop, nodes, hand-drawn connectors
const { useEffect, useState, useRef, useMemo, useLayoutEffect } = React;

// --------- Icons (soft, hand-drawn feel — 1.5 stroke, round caps) ---------
const Ico = {
  Mic:      (p) => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" {...p}><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v3"/></svg>,
  Send:     (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M5 12h14"/><path d="m13 6 6 6-6 6"/></svg>,
  Sparkle:  (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3z"/></svg>,
  Arrow:    (p) => <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M5 12h14M13 6l6 6-6 6"/></svg>,
  Left:     (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M15 18l-6-6 6-6"/></svg>,
  Right:    (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M9 18l6-6-6-6"/></svg>,
  Plus:     (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M12 5v14M5 12h14"/></svg>,
  Share:    (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" {...p}><circle cx="18" cy="5" r="2.4"/><circle cx="6" cy="12" r="2.4"/><circle cx="18" cy="19" r="2.4"/><path d="M8.1 10.9 15.9 6.1M8.1 13.1 15.9 17.9"/></svg>,
  Present:  (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" {...p}><rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M8 20h8M12 16v4"/></svg>,
  Grid:     (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...p}><rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/></svg>,
  History:  (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/></svg>,
  Layers:   (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="m12 3 9 5-9 5-9-5 9-5z"/><path d="m3 13 9 5 9-5M3 18l9 5 9-5"/></svg>,
  Flow:     (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...p}><rect x="3" y="4" width="6" height="5" rx="1.5"/><rect x="15" y="4" width="6" height="5" rx="1.5"/><rect x="3" y="15" width="6" height="5" rx="1.5"/><rect x="15" y="15" width="6" height="5" rx="1.5"/><path d="M9 6.5h6M9 17.5h6M6 9v6M18 9v6"/></svg>,
  Journey:  (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M4 17c3-6 6-2 8-6s5-2 8-4"/><circle cx="4" cy="17" r="1.5"/><circle cx="12" cy="11" r="1.5"/><circle cx="20" cy="7" r="1.5"/></svg>,
  Mind:     (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...p}><circle cx="12" cy="12" r="3"/><circle cx="4" cy="6" r="1.5"/><circle cx="20" cy="6" r="1.5"/><circle cx="4" cy="18" r="1.5"/><circle cx="20" cy="18" r="1.5"/><path d="M5.5 7 9 10.5M18.5 7 15 10.5M5.5 17 9 13.5M18.5 17 15 13.5"/></svg>,
  Search:   (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" {...p}><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>,
  Play:     (p) => <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" {...p}><path d="M6 4l14 8-14 8V4z"/></svg>,
  Undo:     (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M3 7v6h6"/><path d="M3 13a9 9 0 1 1 3 6.7"/></svg>,
  Redo:     (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M21 7v6h-6"/><path d="M21 13a9 9 0 1 0-3 6.7"/></svg>,
  Comment:  (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M4 5h16v11H9l-5 4V5z"/></svg>,
  User:     (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...p}><circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/></svg>,
  Bot:      (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...p}><rect x="4" y="7" width="16" height="12" rx="2.5"/><circle cx="9" cy="13" r="1" fill="currentColor"/><circle cx="15" cy="13" r="1" fill="currentColor"/><path d="M12 4v3M8 19v2M16 19v2"/></svg>,
  Command:  (p) => <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M6 4a2 2 0 1 0 0 4h12a2 2 0 1 0 0-4H6zM6 16a2 2 0 1 0 0 4h12a2 2 0 1 0 0-4H6z"/><path d="M8 8v8M16 8v8"/></svg>,
  Check:    (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M5 12l5 5 9-11"/></svg>,
  X:        (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M6 6l12 12M6 18L18 6"/></svg>,
  Book:     (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M4 5v14a2 2 0 0 1 2-2h14V3H6a2 2 0 0 0-2 2z"/></svg>,
  Folder:   (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6z"/></svg>,
  Pen:      (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M14 4l6 6-11 11H3v-6z"/><path d="M13 5l6 6"/></svg>,
  Sticky:   (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M4 4h11l5 5v11H4z"/><path d="M15 4v5h5"/></svg>,
  Cursor:   (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M4 3l6 17 3-7 7-3z"/></svg>,
  Type:     (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M4 5h16M12 5v14M8 19h8"/></svg>,
  Rect:     (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...p}><rect x="4" y="6" width="16" height="12" rx="2"/></svg>,
  Circle:   (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...p}><circle cx="12" cy="12" r="8"/></svg>,
  Diamond:  (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M12 3l9 9-9 9-9-9z"/></svg>,
  Line:     (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M5 19L19 5"/></svg>,
  Hand:     (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M7 11V6.5a1.5 1.5 0 0 1 3 0V12"/><path d="M10 12V4.5a1.5 1.5 0 0 1 3 0V12"/><path d="M13 12V5.5a1.5 1.5 0 0 1 3 0V13"/><path d="M16 13V8.5a1.5 1.5 0 0 1 3 0V16a5 5 0 0 1-5 5h-2a5 5 0 0 1-5-5v-1l-2-3a1.5 1.5 0 0 1 2-2l1 1.5"/></svg>,
  Zoom:     (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M4 4h4M4 4v4M20 4h-4M20 4v4M4 20h4M4 20v-4M20 20h-4M20 20v-4"/></svg>,
  Settings: (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...p}><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>,
  Dot:      (p) => <svg width="4" height="4" viewBox="0 0 4 4" {...p}><circle cx="2" cy="2" r="2" fill="currentColor"/></svg>,
};

// --------- Paper backdrop (grain + dot grid + soft glow) ---------
function PaperBackdrop({ grid = true, grain = true, style }) {
  return (
    <div style={{ position: 'absolute', inset: 0, ...style }}>
      <div className="paper-bg" />
      {grid && <div className="paper-grid" />}
      {grain && <div className="paper-grain" />}
    </div>
  );
}

// --------- Node ---------
function Node({ x, y, w, title, meta, sub, dot, state, delay=0, rot=0, onClick, style, children }) {
  const cls = ['node'];
  if (state) cls.push(state);
  return (
    <div
      className={cls.join(' ')}
      onClick={onClick}
      style={{
        left: x, top: y, width: w || 156,
        '--node-rot': `${rot}deg`,
        animationDelay: state === 'emerging' ? `${delay}ms, ${delay + 600}ms` : `${delay}ms`,
        ...style,
      }}
    >
      {meta && (
        <div className="node-meta">
          {dot && <span className={`node-dot ${dot}`} />}
          {meta}
        </div>
      )}
      {title && <div className="node-title">{title}</div>}
      {sub && <div className="node-sub">{sub}</div>}
      {children}
    </div>
  );
}

// --------- Hand-drawn bezier path ---------
// A gentle sinusoidal wobble is added to the control points so lines feel drawn.
function handPath(a, b, dir='h', wobble=6, seed=0) {
  const dx = b.x - a.x, dy = b.y - a.y;
  // Deterministic pseudo-random offset based on seed
  const rnd = (i) => {
    const s = Math.sin((seed + i) * 12.9898) * 43758.5453;
    return (s - Math.floor(s)) * 2 - 1;
  };
  if (dir === 'h') {
    const midx = a.x + dx * 0.55 + rnd(1) * wobble;
    const c1x = midx, c1y = a.y + rnd(2) * wobble * 0.4;
    const c2x = midx, c2y = b.y + rnd(3) * wobble * 0.4;
    return `M ${a.x} ${a.y} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${b.x} ${b.y}`;
  }
  if (dir === 'v') {
    const midy = a.y + dy * 0.55 + rnd(1) * wobble;
    const c1x = a.x + rnd(2) * wobble * 0.4, c1y = midy;
    const c2x = b.x + rnd(3) * wobble * 0.4, c2y = midy;
    return `M ${a.x} ${a.y} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${b.x} ${b.y}`;
  }
  return `M ${a.x} ${a.y} L ${b.x} ${b.y}`;
}

// Backwards-compat alias for previous makePath usage
function makePath(a, b, dir='h') { return handPath(a, b, dir, 0, 0); }

// Arrow markers
function ConnectorDefs() {
  return (
    <defs>
      <marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
        <path d="M0 0 L10 5 L0 10 z" fill="var(--ink-2)" />
      </marker>
      <marker id="arr-bloom" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
        <path d="M0 0 L10 5 L0 10 z" fill="var(--bloom-2)" />
      </marker>
      <marker id="arr-ink" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
        <path d="M0 0 L10 5 L0 10 z" fill="var(--ink-0)" />
      </marker>
    </defs>
  );
}

// --------- Frame (group with dashed border + label) ---------
function Frame({ x, y, w, h, label, children, style }) {
  return (
    <div className="frame" style={{ left: x, top: y, width: w, height: h, ...style }}>
      <div className="frame-label">{label}</div>
      {children}
    </div>
  );
}

// --------- Sticky note ---------
function Sticky({ x, y, color='saffron', rot=-1.5, children, author, style }) {
  const cls = ['sticky'];
  if (color !== 'saffron') cls.push(color);
  return (
    <div
      className={cls.join(' ')}
      style={{ left: x, top: y, transform: `rotate(${rot}deg)`, ...style }}
    >
      {children}
      {author && <div className="sticky-author">— {author}</div>}
    </div>
  );
}

// --------- Waveform (ink flowing) ---------
function Waveform({ bars = 20, active = true }) {
  return (
    <div className="waveform" aria-hidden="true">
      {Array.from({ length: bars }).map((_, i) => (
        <span key={i} style={{
          animationDelay: `${(i * 60) % 900}ms`,
          animationPlayState: active ? 'running' : 'paused',
          opacity: active ? 1 : 0.4,
        }} />
      ))}
    </div>
  );
}

// Expose globally
Object.assign(window, { Ico, PaperBackdrop, Node, handPath, makePath, ConnectorDefs, Frame, Sticky, Waveform });
