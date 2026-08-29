// Screen 7 — History timeline
// Timeline of events: human + AI + proposals. Right side shows a version thumbnail preview.

function ScreenHistory() {
  const events = [
    { t: '10:42', who: 'user', label: 'Started workspace',   detail: 'Empty canvas · New session' },
    { t: '10:42', who: 'user', label: 'Described the system',detail: '"I\'m building an e-commerce platform…"' },
    { t: '10:43', who: 'ai',   label: 'Built initial architecture', detail: '8 nodes · 7 connectors · Horizontal flow', pinned: true },
    { t: '10:45', who: 'user', label: 'Requested authentication', detail: '"Add authentication."' },
    { t: '10:46', who: 'ai',   label: 'Added Auth service', detail: 'Wired to Customer · Google OAuth' },
    { t: '10:48', who: 'user', label: 'Reverted change',    detail: 'Auth linked to gateway instead' },
    { t: '10:51', who: 'ai',   label: 'Proposed retry pattern', detail: '6 changes · Not applied', status: 'proposed' },
    { t: '10:54', who: 'user', label: 'Applied 4 of 6',     detail: 'Skipped: legacy path removal' },
    { t: '11:02', who: 'user', label: 'Transformed to sequence diagram', detail: 'Checkout flow · New artifact' },
    { t: '11:15', who: 'ai',   label: 'Detected new requirement', detail: 'Meeting mode · "Enterprise SSO"', status: 'meeting' },
    { t: '11:23', who: 'user', label: 'Currently editing',  detail: 'Payments spec', current: true },
  ];

  const [selected, setSelected] = useState(2); // "Built initial architecture"

  return (
    <div data-screen-label="07 History" style={{ position: 'absolute', inset: 0 }}>
      <CanvasBackdrop />
      <TopBar
        crumbs={[
          { label: 'Personal', current: false },
          { label: 'E-commerce platform', current: false },
          { label: 'History', current: true },
        ]}
        actions={
          <>
            <button className="icon-btn"><Ico.Undo /></button>
            <button className="icon-btn"><Ico.Redo /></button>
            <div style={{ width: 6 }} />
            <button className="icon-btn primary">Restore version</button>
          </>
        }
      />
      <LeftRail active="canvas" />

      {/* Center: timeline + preview */}
      <div style={{
        position: 'absolute', top: 76, bottom: 30, left: 76, right: 30,
        display: 'grid', gridTemplateColumns: '420px 1fr', gap: 18,
      }}>
        {/* Timeline */}
        <div style={{
          background: 'oklch(from var(--canvas-2) l c h / 0.75)',
          border: '1px solid var(--stroke-1)',
          borderRadius: 16,
          overflow: 'hidden',
          display: 'flex', flexDirection: 'column',
        }}>
          <div style={{
            padding: '14px 18px',
            borderBottom: '1px solid var(--stroke-1)',
            display: 'flex', alignItems: 'center', gap: 10,
          }}>
            <div style={{ fontSize: 13, fontVariationSettings: "'wght' 550" }}>Timeline</div>
            <span className="mono" style={{ fontSize: 10, color: 'var(--ink-3)', letterSpacing: '0.05em' }}>
              {events.length} events · Today
            </span>
            <div style={{ flex: 1 }} />
            <button className="icon-btn" style={{ height: 26, padding: '0 8px', fontSize: 11 }}>
              <Ico.Search /> Filter
            </button>
          </div>

          <div style={{ flex: 1, overflowY: 'auto', padding: '10px 8px 20px' }} className="panel-body">
            {events.map((e, i) => {
              const isSel = i === selected;
              return (
                <div key={i} style={{ display: 'flex', gap: 12, position: 'relative' }}>
                  {/* Rail */}
                  <div style={{ width: 24, position: 'relative', flexShrink: 0 }}>
                    {i < events.length - 1 && (
                      <div style={{
                        position: 'absolute', top: 22, bottom: -6, left: 11,
                        width: 1, background: 'var(--stroke-1)',
                      }} />
                    )}
                    <div style={{
                      position: 'absolute', top: 10, left: 6,
                      width: 12, height: 12, borderRadius: 999,
                      background: e.who === 'ai'
                        ? 'linear-gradient(135deg, var(--amber-2), var(--amber-3))'
                        : 'var(--canvas-3)',
                      border: `1px solid ${e.who === 'ai' ? 'oklch(0.82 0.15 75 / 0.5)' : 'var(--stroke-2)'}`,
                      boxShadow: e.who === 'ai' ? '0 0 8px var(--amber-glow)' : 'none',
                      display: 'grid', placeItems: 'center',
                    }}>
                      {e.who === 'ai' && (
                        <div style={{ width: 3, height: 3, borderRadius: 999, background: 'var(--canvas-0)' }} />
                      )}
                    </div>
                  </div>
                  {/* Card */}
                  <button
                    onClick={() => setSelected(i)}
                    style={{
                      flex: 1, textAlign: 'left',
                      padding: '8px 12px',
                      marginBottom: 4,
                      borderRadius: 8,
                      background: isSel ? 'var(--canvas-3)' : 'transparent',
                      border: `1px solid ${isSel ? 'var(--stroke-2)' : 'transparent'}`,
                      transition: 'all 0.12s var(--e-out)',
                    }}
                    onMouseEnter={ev => { if (!isSel) ev.currentTarget.style.background = 'oklch(from var(--canvas-2) l c h / 0.6)'; }}
                    onMouseLeave={ev => { if (!isSel) ev.currentTarget.style.background = 'transparent'; }}
                  >
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 2 }}>
                      <span className="mono" style={{ fontSize: 10.5, color: 'var(--ink-3)', letterSpacing: '0.02em' }}>{e.t}</span>
                      <span style={{ fontSize: 13, color: 'var(--ink-0)', fontVariationSettings: "'wght' 500", flex: 1 }}>
                        {e.label}
                      </span>
                      {e.pinned && (
                        <span className="mono" style={{
                          fontSize: 9, color: 'var(--amber-1)',
                          padding: '2px 6px', borderRadius: 3,
                          background: 'oklch(0.82 0.15 75 / 0.12)',
                          border: '1px solid oklch(0.82 0.15 75 / 0.25)',
                          letterSpacing: '0.05em', textTransform: 'uppercase',
                        }}>Pinned</span>
                      )}
                      {e.current && (
                        <span className="mono" style={{
                          fontSize: 9, color: 'var(--sig-green)',
                          padding: '2px 6px', borderRadius: 3,
                          background: 'oklch(0.78 0.11 155 / 0.12)',
                          border: '1px solid oklch(0.78 0.11 155 / 0.25)',
                          letterSpacing: '0.05em', textTransform: 'uppercase',
                        }}>Now</span>
                      )}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--ink-2)', lineHeight: 1.45, marginLeft: 0 }}>
                      {e.detail}
                    </div>
                  </button>
                </div>
              );
            })}
          </div>
        </div>

        {/* Preview */}
        <div style={{
          background: 'var(--canvas-0)',
          border: '1px solid var(--stroke-1)',
          borderRadius: 16,
          overflow: 'hidden',
          display: 'flex', flexDirection: 'column',
        }}>
          <div style={{
            padding: '14px 18px',
            borderBottom: '1px solid var(--stroke-1)',
            display: 'flex', alignItems: 'center', gap: 10,
          }}>
            <div>
              <div style={{ fontSize: 13, fontVariationSettings: "'wght' 550" }}>
                {events[selected].label}
              </div>
              <div className="mono" style={{ fontSize: 10.5, color: 'var(--ink-3)', letterSpacing: '0.03em', marginTop: 2 }}>
                {events[selected].t} · Version #{selected + 1}
              </div>
            </div>
            <div style={{ flex: 1 }} />
            <button className="icon-btn" style={{ height: 28, fontSize: 11.5 }}>Compare</button>
            <button className="icon-btn primary" style={{ height: 28, fontSize: 11.5 }}>Restore</button>
          </div>
          <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
            {/* Mini rendering of the diagram at that point */}
            <div style={{
              position: 'absolute', inset: 0,
              background: 'radial-gradient(oklch(0.24 0.005 60 / 0.55) 1px, transparent 1px)',
              backgroundSize: '20px 20px',
            }} />
            <div style={{ position: 'absolute', inset: 0, transform: 'scale(0.65)', transformOrigin: 'center' }}>
              <svg className="connectors" style={{ width: '100%', height: '100%' }}>
                <ConnectorDefs />
                {EC_EDGES.map((e, i) => {
                  const from = EC_NODES.find(n => n.id === e.from);
                  const to = EC_NODES.find(n => n.id === e.to);
                  const a = anchor(from, e.dir === 'v' ? 'b' : 'r');
                  const b = anchor(to,   e.dir === 'v' ? 't' : 'l');
                  return <path key={i} d={makePath(a, b, e.dir)} markerEnd="url(#arr)" />;
                })}
              </svg>
              {EC_NODES.map(n => <Node key={n.id} {...n} />)}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { ScreenHistory });
