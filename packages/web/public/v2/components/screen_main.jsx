// Screen 03 — Main canvas · uses the shared BoardCanvas

function ScreenMain() {
  const [selected, setSelected] = useState('gw');
  return (
    <>
      <PaperBackdrop />
      <TopBar crumbs={[
        { label: 'Personal', screen: 6 },
        { label: 'E-commerce platform', current: true },
      ]} />
      <GlobalRail active="board" />

      {/* Miro-style top toolbar (grouped clusters) */}
      <BoardToolbar />

      {/* Live cursors — collaborators */}
      <CursorChip x={620} y={280} name="Sarah" color="oklch(0.55 0.11 220)" />
      <CursorChip x={880} y={410} name="John" color="oklch(0.55 0.14 148)" />

      {/* Canvas — one shared BoardCanvas, scrollable so it never leaks over other UI */}
      <BoardScrollFrame style={{ top: 120, bottom: 60, left: 84, right: 356 }}>
        <BoardCanvas selected={selected} onSelect={setSelected} />
      </BoardScrollFrame>

      {/* Node inspector on right */}
      <div className="right-panel" style={{ top: 120, bottom: 60, width: 340 }}>
        <div className="panel-head">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {Svc.gateway({})}
            <div>
              <div className="panel-title">API Gateway</div>
              <div className="panel-sub">service.edge</div>
            </div>
          </div>
        </div>
        <div className="panel-body">
          <div style={{ display: 'grid', gap: 14 }}>
            <InspectorRow label="Runtime" value="Node 22 · fastify" mono />
            <InspectorRow label="Layer" value="Edge · 1 of 4" />
            <InspectorRow label="Endpoints" value="/orders · /auth · /pay · /notify" />
            <InspectorRow label="SLO" value="p95 < 120ms · 99.9%" mono />
            <div>
              <div className="mono-caps" style={{ marginBottom: 6 }}>Depends on</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {['Order Svc', 'Auth Svc', 'Payment Svc', 'Notification'].map(d => (
                  <span key={d} style={{
                    padding: '4px 10px', borderRadius: 999,
                    background: 'oklch(from var(--paper-2) l c h / 0.8)',
                    border: '1px solid oklch(from var(--paper-4) l c h / 0.5)',
                    fontSize: 11.5, color: 'var(--ink-1)',
                    fontFamily: 'var(--font-mono)',
                  }}>{d}</span>
                ))}
              </div>
            </div>
            <div style={{
              padding: 14, borderRadius: 12,
              background: 'oklch(from var(--bloom-1) l c h / 0.06)',
              border: '1px solid var(--bloom-wash-2)',
            }}>
              <div className="mono-caps" style={{ color: 'var(--bloom-2)', marginBottom: 6 }}>
                <Ico.Sparkle style={{ display: 'inline', verticalAlign: -2, marginRight: 4 }} />
                Lucent notes
              </div>
              <div style={{ fontSize: 13, color: 'var(--ink-0)', lineHeight: 1.5, fontFamily: 'var(--font-serif)' }}>
                Consider adding request signing between the gateway and payments — Stripe
                webhooks currently hit the gateway unauthenticated.
              </div>
              <button className="btn ghost" style={{ marginTop: 10, height: 28, fontSize: 12 }}>
                <Ico.Sparkle /> Apply suggestion
              </button>
            </div>
          </div>
        </div>
        <div className="panel-foot">
          <button className="btn ghost"><Ico.Comment /> Comment</button>
          <button className="btn primary">Save</button>
        </div>
      </div>

      {/* Minimap */}
      <Minimap>
        <MinimapPreview />
      </Minimap>

      <ZoomBadge />
      <StatusBadge>
        <Ico.Dot style={{ color: 'var(--moss)' }} /> 1 selected · <span style={{ color: 'var(--ink-0)' }}>API Gateway</span>
      </StatusBadge>
    </>
  );
}

// The board's Miro-style top toolbar (shared with meeting mode)
function BoardToolbar({ hidden }) {
  if (hidden) return null;
  return (
    <div style={{
      position: 'absolute',
      top: 68, left: 'calc(50% + 42px)', transform: 'translateX(-50%)',
      zIndex: 22,
      display: 'flex', alignItems: 'center', gap: 6,
      padding: '5px 6px',
      background: 'oklch(from var(--paper-0) l c h / 0.92)',
      border: '1px solid oklch(from var(--paper-4) l c h / 0.6)',
      borderRadius: 12,
      boxShadow: 'var(--shadow-2)',
      backdropFilter: 'blur(20px)',
    }}>
      <ToolCluster>
        <ToolBtn icon={<Ico.Cursor />} active tip="Select · V" />
        <ToolBtn icon={<Ico.Hand />} tip="Hand · H" />
      </ToolCluster>
      <ToolCluster>
        <ToolBtn icon={<Ico.Rect />} tip="Rectangle · R" />
        <ToolBtn icon={<Ico.Circle />} tip="Ellipse · O" />
        <ToolBtn icon={<Ico.Diamond />} tip="Diamond · D" />
        <ToolBtn icon={<Ico.Line />} tip="Arrow · A" />
      </ToolCluster>
      <ToolCluster>
        <ToolBtn icon={<Ico.Sticky />} tip="Sticky · S" />
        <ToolBtn icon={<Ico.Type />} tip="Text · T" />
        <ToolBtn icon={<Ico.Pen />} tip="Pen · P" />
      </ToolCluster>
      <ToolCluster>
        <ToolBtn icon={<ServiceCat />} tip="Service catalog" bloom />
        <ToolBtn icon={<Frame />} tip="Frame" />
        <ToolBtn icon={<Ico.Comment />} tip="Comment · C" />
      </ToolCluster>
      <ToolCluster last>
        <ToolBtn icon={<Ico.Undo />} tip="Undo · ⌘Z" />
        <ToolBtn icon={<Ico.Redo />} tip="Redo · ⇧⌘Z" />
      </ToolCluster>
    </div>
  );
}

function MinimapPreview() {
  const L = BOARD_LAYOUT;
  return (
    <svg width="100%" height="100%" viewBox={`0 0 ${L.viewBox.w} ${L.viewBox.h}`} preserveAspectRatio="xMidYMid meet">
      {L.containers.map((c, i) => {
        const border = c.kind === 'production' ? 'var(--madder)' : c.kind === 'edge' ? 'var(--moss)' : c.kind === 'staging' ? 'var(--saffron)' : 'var(--ink-3)';
        return <rect key={i} x={c.x} y={c.y} width={c.w} height={c.h} fill="none" stroke={border} strokeWidth="6" strokeDasharray="12 12" opacity="0.35"/>;
      })}
      {L.nodes.map((n, i) => (
        <rect key={i} x={n.x} y={n.y} width={150} height={50} rx="8" fill="var(--paper-0)" stroke={n.bloom ? 'var(--bloom-2)' : 'var(--ink-2)'} strokeWidth="4"/>
      ))}
    </svg>
  );
}

function ToolCluster({ children, last }) {
  return (
    <div style={{
      display: 'flex', gap: 1,
      paddingRight: last ? 0 : 6,
      marginRight: last ? 0 : 2,
      borderRight: last ? 'none' : '1px solid oklch(from var(--paper-4) l c h / 0.5)',
    }}>{children}</div>
  );
}
function ToolBtn({ icon, active, tip, bloom, onClick }) {
  return (
    <button
      title={tip}
      onClick={onClick}
      style={{
        width: 34, height: 34, borderRadius: 8,
        display: 'grid', placeItems: 'center',
        background: active ? 'var(--ink-0)' : 'transparent',
        color: active ? 'var(--paper-0)' : bloom ? 'var(--bloom-2)' : 'var(--ink-1)',
        transition: 'all 0.12s var(--e-out)',
      }}
      onMouseEnter={e => !active && (e.currentTarget.style.background = 'var(--paper-2)')}
      onMouseLeave={e => !active && (e.currentTarget.style.background = 'transparent')}
    >{icon}</button>
  );
}
function ServiceCat() { return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/><circle cx="17.5" cy="17.5" r="1.5" fill="currentColor"/></svg>; }
function Frame() { return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M4 8h16M4 16h16M8 4v16M16 4v16" strokeDasharray="2 2"/></svg>; }

function InspectorRow({ label, value, mono }) {
  return (
    <div>
      <div className="mono-caps" style={{ marginBottom: 4 }}>{label}</div>
      <div style={{
        fontFamily: mono ? 'var(--font-mono)' : 'var(--font-sans)',
        fontSize: mono ? 12 : 13.5, color: 'var(--ink-0)', lineHeight: 1.4,
      }}>{value}</div>
    </div>
  );
}

Object.assign(window, { ScreenMain, BoardToolbar, MinimapPreview });
