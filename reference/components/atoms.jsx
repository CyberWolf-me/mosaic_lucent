// Shared visual atoms: icons, nodes, connectors, canvas backdrop
const { useEffect, useState, useRef, useMemo } = React;

// --------- Icons (thin, consistent stroke) ---------
const Ico = {
  Mic:      (p) => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" {...p}><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v3"/></svg>,
  Send:     (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M5 12h14"/><path d="m13 6 6 6-6 6"/></svg>,
  Sparkle:  (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8"/></svg>,
  Arrow:    (p) => <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M5 12h14M13 6l6 6-6 6"/></svg>,
  Left:     (p) => <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M15 18l-6-6 6-6"/></svg>,
  Right:    (p) => <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M9 18l6-6-6-6"/></svg>,
  Plus:     (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M12 5v14M5 12h14"/></svg>,
  Share:    (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" {...p}><circle cx="18" cy="5" r="2.4"/><circle cx="6" cy="12" r="2.4"/><circle cx="18" cy="19" r="2.4"/><path d="M8.1 10.9 15.9 6.1M8.1 13.1 15.9 17.9"/></svg>,
  Present:  (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" {...p}><rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M8 20h8M12 16v4"/></svg>,
  Grid:     (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...p}><rect x="4" y="4" width="7" height="7" rx="1"/><rect x="13" y="4" width="7" height="7" rx="1"/><rect x="4" y="13" width="7" height="7" rx="1"/><rect x="13" y="13" width="7" height="7" rx="1"/></svg>,
  History:  (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/></svg>,
  Layers:   (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="m12 3 9 5-9 5-9-5 9-5z"/><path d="m3 13 9 5 9-5M3 18l9 5 9-5"/></svg>,
  Flow:     (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...p}><rect x="3" y="4" width="6" height="5" rx="1"/><rect x="15" y="4" width="6" height="5" rx="1"/><rect x="3" y="15" width="6" height="5" rx="1"/><rect x="15" y="15" width="6" height="5" rx="1"/><path d="M9 6.5h6M9 17.5h6M6 9v6M18 9v6"/></svg>,
  Journey:  (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M4 17c3-6 6-2 8-6s5-2 8-4"/><circle cx="4" cy="17" r="1.5"/><circle cx="12" cy="11" r="1.5"/><circle cx="20" cy="7" r="1.5"/></svg>,
  Mind:     (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...p}><circle cx="12" cy="12" r="3"/><circle cx="4" cy="6" r="1.5"/><circle cx="20" cy="6" r="1.5"/><circle cx="4" cy="18" r="1.5"/><circle cx="20" cy="18" r="1.5"/><path d="M5.5 7 9 10.5M18.5 7 15 10.5M5.5 17 9 13.5M18.5 17 15 13.5"/></svg>,
  Search:   (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" {...p}><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>,
  Play:     (p) => <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" {...p}><path d="M6 4l14 8-14 8V4z"/></svg>,
  Undo:     (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M3 7v6h6"/><path d="M3 13a9 9 0 1 1 3 6.7"/></svg>,
  Redo:     (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M21 7v6h-6"/><path d="M21 13a9 9 0 1 0-3 6.7"/></svg>,
  Zoom:     (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M4 4h4M4 4v4M20 4h-4M20 4v4M4 20h4M4 20v-4M20 20h-4M20 20v-4"/></svg>,
  Comment:  (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M4 5h16v11H9l-5 4V5z"/></svg>,
  User:     (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...p}><circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/></svg>,
  Bot:      (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...p}><rect x="4" y="7" width="16" height="12" rx="2"/><circle cx="9" cy="13" r="1" fill="currentColor"/><circle cx="15" cy="13" r="1" fill="currentColor"/><path d="M12 4v3M8 19v2M16 19v2"/></svg>,
  Command:  (p) => <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M6 4a2 2 0 1 0 0 4h12a2 2 0 1 0 0-4H6zM6 16a2 2 0 1 0 0 4h12a2 2 0 1 0 0-4H6z"/><path d="M8 8v8M16 8v8"/></svg>,
  Attach:   (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M20 12l-8 8a5.5 5.5 0 0 1-7.8-7.8l9-9a3.7 3.7 0 0 1 5.2 5.2l-9 9a1.8 1.8 0 0 1-2.6-2.6l7.5-7.5"/></svg>,
  Mic2:     (p) => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" {...p}><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v3M8 21h8"/></svg>,
  Check:    (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M5 12l5 5 9-11"/></svg>,
  X:        (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M6 6l12 12M6 18L18 6"/></svg>,
  Down:     (p) => <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M6 9l6 6 6-6"/></svg>,
  Dot:      (p) => <svg width="4" height="4" viewBox="0 0 4 4" {...p}><circle cx="2" cy="2" r="2" fill="currentColor"/></svg>,
  Book:     (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M4 5v14a2 2 0 0 1 2-2h14V3H6a2 2 0 0 0-2 2z"/></svg>,
  Folder:   (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6z"/></svg>,
};

// --------- Canvas backdrop (grid + vignette) ---------
function CanvasBackdrop({ children, style }) {
  return (
    <div style={{ position: 'absolute', inset: 0, background: 'var(--canvas-1)', ...style }}>
      <div className="canvas-grid" />
      <div className="canvas-vignette" />
      {children}
    </div>
  );
}

// --------- Node ---------
function Node({ x, y, w, title, meta, sub, dot, state, delay=0, onClick, style }) {
  const cls = ['node'];
  if (state) cls.push(state);
  return (
    <div
      className={cls.join(' ')}
      onClick={onClick}
      style={{
        left: x, top: y, width: w || 150,
        animationDelay: state === 'emerging' ? `${delay}ms, ${delay + 400}ms` : `${delay}ms`,
        ...style,
      }}
    >
      {meta && (
        <div className="node-meta">
          {dot && <span className={`node-dot ${dot}`} />}
          {meta}
        </div>
      )}
      <div className="node-title">{title}</div>
      {sub && <div className="node-sub">{sub}</div>}
    </div>
  );
}

// --------- Connector (SVG path between two anchor points) ---------
// direction: 'h' horizontal-first curve, 'v' vertical-first
function makePath(a, b, dir='h') {
  const dx = b.x - a.x, dy = b.y - a.y;
  if (dir === 'h') {
    const mid = a.x + dx * 0.55;
    return `M ${a.x} ${a.y} C ${mid} ${a.y}, ${mid} ${b.y}, ${b.x} ${b.y}`;
  }
  if (dir === 'v') {
    const mid = a.y + dy * 0.55;
    return `M ${a.x} ${a.y} C ${a.x} ${mid}, ${b.x} ${mid}, ${b.x} ${b.y}`;
  }
  return `M ${a.x} ${a.y} L ${b.x} ${b.y}`;
}

// Arrowhead marker defs (reusable)
function ConnectorDefs() {
  return (
    <defs>
      <marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
        <path d="M0 0 L10 5 L0 10 z" fill="var(--stroke-3)" />
      </marker>
      <marker id="arr-amber" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
        <path d="M0 0 L10 5 L0 10 z" fill="var(--amber-2)" />
      </marker>
    </defs>
  );
}

// --------- Canvas viewport (pinch/wheel zoom + pan) ----------
// Wraps its children in a transformed layer. Wheel (with ctrl or via pinch)
// zooms, wheel without ctrl pans, drag with hand tool pans.
// Broadcasts current zoom + pan to window.__lucentViewport so ZoomBadge
// can read/write.
function CanvasViewport({ children, initialZoom = 85, tool = 'select', backdrop = true }) {
  const [zoom, setZoom] = useState(initialZoom);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const dragRef = useRef({ dragging: false, startX: 0, startY: 0, panX: 0, panY: 0, mode: null });
  const containerRef = useRef(null);

  // Publish current state so the ZoomBadge can control it
  useEffect(() => {
    window.__lucentViewport = {
      getZoom: () => zoom,
      setZoom: (z) => setZoom(clamp(z, 25, 400)),
      resetZoom: () => { setZoom(100); setPan({ x: 0, y: 0 }); },
      onChange: null,
    };
    if (typeof window.__lucentZoomListener === 'function') window.__lucentZoomListener(zoom);
    return () => { delete window.__lucentViewport; };
  }, [zoom]);

  // Wheel: pinch (ctrlKey) = zoom, plain wheel = pan
  const onWheel = (e) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const factor = Math.exp(-e.deltaY * 0.006);
      setZoom(z => clamp(z * factor, 25, 400));
    } else {
      // pan with 2-finger scroll
      e.preventDefault();
      setPan(p => ({ x: p.x - e.deltaX, y: p.y - e.deltaY }));
    }
  };

  const onMouseDown = (e) => {
    // Middle mouse OR Space-held OR hand tool active → pan
    const shouldPan = e.button === 1 || tool === 'hand' || e.shiftKey;
    if (!shouldPan) return;
    dragRef.current = {
      dragging: true,
      startX: e.clientX, startY: e.clientY,
      panX: pan.x, panY: pan.y,
      mode: 'pan',
    };
  };
  const onMouseMove = (e) => {
    const d = dragRef.current;
    if (!d.dragging) return;
    setPan({ x: d.panX + (e.clientX - d.startX), y: d.panY + (e.clientY - d.startY) });
  };
  const onMouseUp = () => { dragRef.current.dragging = false; };

  useEffect(() => {
    // Cmd/Ctrl + = / - shortcuts
    const onKey = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if ((e.ctrlKey || e.metaKey) && (e.key === '=' || e.key === '+')) { e.preventDefault(); setZoom(z => clamp(z * 1.2, 25, 400)); }
      if ((e.ctrlKey || e.metaKey) && (e.key === '-' || e.key === '_')) { e.preventDefault(); setZoom(z => clamp(z / 1.2, 25, 400)); }
      if ((e.ctrlKey || e.metaKey) && e.key === '0')                    { e.preventDefault(); setZoom(100); setPan({ x: 0, y: 0 }); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const cursor = tool === 'hand' ? (dragRef.current.dragging ? 'grabbing' : 'grab') : 'default';

  return (
    <div
      ref={containerRef}
      onWheel={onWheel}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={onMouseUp}
      style={{
        position: 'absolute', inset: 0, overflow: 'hidden',
        cursor,
        touchAction: 'none',
      }}
    >
      {backdrop && <CanvasBackdrop />}
      <div style={{
        position: 'absolute', inset: 0,
        transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom / 100})`,
        transformOrigin: '50% 40%',
        transition: dragRef.current.dragging ? 'none' : 'transform 0.08s var(--e-out)',
        willChange: 'transform',
      }}>
        {children}
      </div>
    </div>
  );
}

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

// Expose to global
Object.assign(window, { Ico, CanvasBackdrop, Node, makePath, ConnectorDefs, CanvasViewport, clamp });
