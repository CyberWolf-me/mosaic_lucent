// Screen 4 — AI proposing changes
// Right panel showing 6 proposed changes; canvas shows ghost/dashed previews of what would happen.

function ScreenProposing() {
  // Base nodes + proposed additions/modifications
  const base = EC_NODES;
  const proposed = [
    { id: 'redis',   x: 880, y: 340, w: 140, title: 'Redis',        meta: 'CACHE',   sub: 'Session store', dot: 'red',   state: 'proposed' },
    { id: 'queue',   x: 680, y: 500, w: 160, title: 'Order Queue',  meta: 'QUEUE',   sub: 'Async fanout',  dot: 'amber', state: 'proposed' },
    { id: 'notif',   x: 880, y: 460, w: 150, title: 'Notifications',meta: 'SERVICE', sub: 'Email · SMS',   dot: 'violet', state: 'proposed' },
  ];
  const byId = Object.fromEntries([...base, ...proposed].map(n => [n.id, n]));

  const edges = EC_EDGES;
  const proposedEdges = [
    { from: 'cart',  to: 'redis',  dir: 'v' },
    { from: 'order', to: 'queue',  dir: 'v' },
    { from: 'queue', to: 'notif',  dir: 'h' },
  ];

  const changes = [
    { op: 'add', title: 'Redis (Cache)',     sub: 'Session store between Cart and Checkout' },
    { op: 'add', title: 'Order Queue',        sub: 'Decouple Order Service from downstream' },
    { op: 'add', title: 'Notifications',      sub: 'Email + SMS after order confirmed' },
    { op: 'mod', title: 'Order Service',      sub: 'Reroute to Queue instead of direct call' },
    { op: 'move',title: 'Warehouse',          sub: 'Shift down 60px to accommodate Queue' },
    { op: 'del', title: 'Legacy sync path',   sub: 'Remove direct Order → Warehouse edge' },
  ];

  return (
    <div data-screen-label="04 Proposing changes" style={{ position: 'absolute', inset: 0 }}>
      <CanvasBackdrop />
      <TopBar
        crumbs={[
          { label: 'Personal', current: false },
          { label: 'E-commerce platform', current: true },
        ]}
      />
      <LeftRail active="canvas" />

      <div style={{ position: 'absolute', inset: 0 }}>
        <svg className="connectors" style={{ width: '100%', height: '100%' }}>
          <ConnectorDefs />
          {edges.map((e, i) => {
            const from = byId[e.from], to = byId[e.to];
            const a = anchor(from, e.dir === 'v' ? 'b' : 'r');
            const b = anchor(to,   e.dir === 'v' ? 't' : 'l');
            return <path key={i} d={makePath(a, b, e.dir)} markerEnd="url(#arr)" />;
          })}
          {proposedEdges.map((e, i) => {
            const from = byId[e.from], to = byId[e.to];
            const a = anchor(from, e.dir === 'v' ? 'b' : 'r');
            const b = anchor(to,   e.dir === 'v' ? 't' : 'l');
            return <path key={`p-${i}`} d={makePath(a, b, e.dir)} className="dashed emerging" markerEnd="url(#arr-amber)" />;
          })}
        </svg>

        <div className="frame" style={{ left: 50, top: 120, width: 1010, height: 460 }}>
          <div className="frame-label">E-commerce · Architecture</div>
        </div>

        {base.map(n => <Node key={n.id} {...n} />)}
        {proposed.map(n => <Node key={n.id} {...n} state="proposed" />)}
      </div>

      {/* Proposal panel */}
      <div className="right-panel">
        <div className="panel-head">
          <div>
            <div className="panel-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{
                width: 18, height: 18, borderRadius: 5,
                background: 'linear-gradient(135deg, var(--amber-2), var(--amber-3))',
                display: 'grid', placeItems: 'center', color: 'var(--canvas-0)',
              }}><Ico.Sparkle /></span>
              Lucent proposes 6 changes
            </div>
            <div className="panel-sub">Preview · Applies as one commit</div>
          </div>
          <button className="icon-btn" style={{ padding: 6, height: 28 }}><Ico.X /></button>
        </div>
        <div className="panel-body">
          <div style={{
            padding: 12, borderRadius: 8,
            background: 'oklch(from var(--canvas-2) l c h / 0.6)',
            border: '1px solid var(--stroke-1)',
            marginBottom: 10,
            fontSize: 12, color: 'var(--ink-1)', lineHeight: 1.55,
          }}>
            <div style={{
              fontSize: 10, fontFamily: 'var(--font-mono)', letterSpacing: '0.06em',
              textTransform: 'uppercase', color: 'var(--ink-3)', marginBottom: 6,
            }}>Request</div>
            "If payment fails, retry through a queue and notify the customer."
          </div>
          <div style={{
            fontSize: 10, fontFamily: 'var(--font-mono)', letterSpacing: '0.08em',
            textTransform: 'uppercase', color: 'var(--ink-3)', margin: '10px 4px 8px',
          }}>Proposed edits</div>
          {changes.map((c, i) => (
            <div key={i} className="change-item">
              <span className={`change-op ${c.op}`}>{c.op}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="change-title">{c.title}</div>
                <div className="change-sub">{c.sub}</div>
              </div>
              <button style={{ color: 'var(--ink-3)', padding: 4 }}><Ico.Down /></button>
            </div>
          ))}
        </div>
        <div className="panel-foot">
          <button className="btn ghost">Cancel</button>
          <button className="btn ghost">Review</button>
          <button className="btn amber"><Ico.Check /> Apply all</button>
        </div>
      </div>

      <ZoomBadge zoom={80} />
      <StatusBadge>
        <span style={{ width: 6, height: 6, borderRadius: 999, background: 'var(--amber-1)', boxShadow: '0 0 6px var(--amber-glow)' }} />
        Proposal pending · 6 edits
      </StatusBadge>
    </div>
  );
}

Object.assign(window, { ScreenProposing });
