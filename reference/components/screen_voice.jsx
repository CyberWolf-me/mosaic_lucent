// Screen 5 — Voice / listening state
// The AI pill is in listening mode; a full-canvas subtle amber wash pulses.
// A transcription bubble hovers above the pill showing the live text.

function ScreenVoice() {
  const nodes = EC_NODES;
  const edges = EC_EDGES;
  const byId = Object.fromEntries(nodes.map(n => [n.id, n]));

  const [phrase, setPhrase] = useState('');
  const full = "Add a payment failure retry — put a queue between checkout and the order service.";
  useEffect(() => {
    let i = 0;
    setPhrase('');
    const t = setInterval(() => {
      i++;
      setPhrase(full.slice(0, i));
      if (i >= full.length) clearInterval(t);
    }, 40);
    return () => clearInterval(t);
  }, []);

  return (
    <div data-screen-label="05 Voice listening" style={{ position: 'absolute', inset: 0 }}>
      <CanvasBackdrop />
      {/* Amber breathing wash */}
      <div style={{
        position: 'absolute', inset: 0,
        background: 'radial-gradient(circle at 50% 100%, oklch(0.82 0.15 75 / 0.08) 0%, transparent 55%)',
        pointerEvents: 'none',
        animation: 'breathe 3s ease-in-out infinite',
      }} />
      <style>{`
        @keyframes breathe {
          0%, 100% { opacity: 0.6; }
          50% { opacity: 1; }
        }
      `}</style>

      <TopBar
        crumbs={[
          { label: 'Personal', current: false },
          { label: 'E-commerce platform', current: true },
        ]}
      />
      <LeftRail active="canvas" side="right" />

      {/* Diagram (dimmed slightly to focus on listening state) */}
      <div style={{ position: 'absolute', inset: 0, opacity: 0.85 }}>
        <svg className="connectors" style={{ width: '100%', height: '100%' }}>
          <ConnectorDefs />
          {edges.map((e, i) => {
            const from = byId[e.from], to = byId[e.to];
            const a = anchor(from, e.dir === 'v' ? 'b' : 'r');
            const b = anchor(to,   e.dir === 'v' ? 't' : 'l');
            return <path key={i} d={makePath(a, b, e.dir)} markerEnd="url(#arr)" />;
          })}
        </svg>
        <div className="frame" style={{ left: 50, top: 120, width: 1010, height: 400 }}>
          <div className="frame-label">E-commerce · Architecture</div>
        </div>
        {nodes.map(n => <Node key={n.id} {...n} />)}
      </div>

      {/* Live transcription above the pill */}
      <div style={{
        position: 'absolute',
        bottom: 108,
        left: '50%', transform: 'translateX(-50%)',
        zIndex: 35,
        maxWidth: 640,
        padding: '14px 20px',
        background: 'oklch(from var(--canvas-2) l c h / 0.9)',
        backdropFilter: 'blur(24px)',
        border: '1px solid oklch(0.82 0.15 75 / 0.35)',
        borderRadius: 18,
        boxShadow: '0 0 0 4px oklch(0.82 0.15 75 / 0.06), var(--elev-3)',
        display: 'flex', gap: 12, alignItems: 'flex-start',
      }}>
        <div style={{
          width: 22, height: 22, borderRadius: 6, flexShrink: 0,
          background: 'var(--canvas-3)',
          color: 'var(--ink-1)',
          display: 'grid', placeItems: 'center',
        }}>
          <Ico.User />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontSize: 10, fontFamily: 'var(--font-mono)', letterSpacing: '0.06em',
            textTransform: 'uppercase', color: 'var(--amber-1)', marginBottom: 4,
            display: 'flex', gap: 6, alignItems: 'center',
          }}>
            <span style={{
              width: 6, height: 6, borderRadius: 999, background: 'var(--amber-1)',
              boxShadow: '0 0 8px var(--amber-glow)',
              animation: 'pulse-amber 1.2s ease-in-out infinite',
            }} />
            Transcribing · 00:04
          </div>
          <div style={{ fontSize: 15, color: 'var(--ink-0)', lineHeight: 1.5, letterSpacing: '-0.005em' }}>
            "{phrase}<span style={{
              display: 'inline-block', width: 2, height: 15, background: 'var(--amber-1)',
              verticalAlign: 'text-bottom', marginLeft: 2,
              animation: 'blink 1s steps(2) infinite',
            }} />"
          </div>
        </div>
      </div>
      <style>{`@keyframes blink { 50% { opacity: 0; } }`}</style>

      <ShapeToolbar activeTool="select" orientation="left" />
      <AIPill listening={true} />
      <ZoomBadge zoom={80} />
      <StatusBadge>
        <span style={{ width: 6, height: 6, borderRadius: 999, background: 'var(--amber-1)', boxShadow: '0 0 8px var(--amber-glow)' }} />
        Listening · Voice
      </StatusBadge>
    </div>
  );
}

Object.assign(window, { ScreenVoice });
