// Screen 06 — Dashboard · project cards on paper

function ScreenDashboard() {
  const go = useLucentGo();
  const projects = [
    { name: 'E-commerce platform',   meta: '12 nodes · 2 min ago',   preview: 'arch', color: 'bloom', to: 3 },
    { name: 'Onboarding journey',    meta: '8 steps · 1 hour ago',   preview: 'journey', color: 'moss', to: 8 },
    { name: 'Checkout wireframes',   meta: '4 screens · yesterday',  preview: 'wire', color: 'saffron', to: 9 },
    { name: 'Auth sequence',         meta: '11 messages · Mon',      preview: 'seq', color: 'graphite', to: 10 },
    { name: 'Realtime chat',         meta: 'Draft · never edited',   preview: 'arch', color: 'madder', to: 1 },
    { name: 'K8s deployment',        meta: '9 nodes · last week',    preview: 'arch', color: 'moss', to: 3 },
  ];
  return (
    <>
      <PaperBackdrop grid={false} grain={true} />
      <TopBar crumbs={[{ label: 'Personal', current: true }]} />
      <GlobalRail active="board" />

      <div style={{
        position: 'absolute',
        top: 72, left: 92, right: 40, bottom: 40,
        overflowY: 'auto',
      }}>
        <div style={{ padding: '24px 8px 60px' }}>
          <div className="ds-eyebrow" style={{ marginBottom: 12 }}>Personal workspace</div>
          <div style={{
            fontFamily: 'var(--font-serif)',
            fontSize: 46, letterSpacing: '-0.02em',
            color: 'var(--ink-0)', fontWeight: 400,
          }}>
            Good morning, Alex.
          </div>
          <div style={{ marginTop: 8, fontSize: 15, color: 'var(--ink-2)', fontFamily: 'var(--font-serif)', fontStyle: 'italic' }}>
            Six workspaces, one draft. Where would you like to think today?
          </div>

          <div style={{ display: 'flex', gap: 10, marginTop: 24, marginBottom: 32, flexWrap: 'wrap' }}>
            <button className="icon-btn bloom" onClick={() => go(1)}><Ico.Plus /> New workspace</button>
            <button className="icon-btn"><Ico.Sparkle /> Ask Lucent to draft…</button>
            <button className="icon-btn"><Ico.Present /> Start meeting</button>
            <div style={{ flex: 1 }} />
            <button className="icon-btn"><Ico.Search /> Search · ⌘K</button>
          </div>

          <div className="mono-caps" style={{ marginBottom: 14 }}>Recent · 6 workspaces</div>
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
            gap: 18,
          }}>
            {projects.map((p, i) => (
              <div key={i} className="project-card" onClick={() => go(p.to)}>
                <div className="thumb">
                  <ProjectPreview kind={p.preview} accent={p.color} />
                </div>
                <div className="info">
                  <div className="name">{p.name}</div>
                  <div className="meta">
                    <span className={`node-dot ${p.color}`} />
                    {p.meta}
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* Templates row */}
          <div className="mono-caps" style={{ marginBottom: 14, marginTop: 40 }}>Templates</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14 }}>
            {[
              { icon: <Ico.Layers />, title: 'Service architecture', desc: 'Microservices with data plane' },
              { icon: <Ico.Flow />,   title: 'Sequence diagram',     desc: 'Request/response over time' },
              { icon: <Ico.Journey/>, title: 'User journey',         desc: 'Steps + emotions across time' },
              { icon: <Ico.Grid />,   title: 'Wireframe set',        desc: 'Screens at real device sizes' },
            ].map((t, i) => (
              <div key={i} style={{
                padding: 18, borderRadius: 14,
                background: 'var(--paper-0)',
                border: '1px solid oklch(from var(--paper-4) l c h / 0.5)',
                cursor: 'pointer', transition: 'all 0.14s var(--e-out)',
              }}
                onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--ink-3)'; e.currentTarget.style.transform = 'translateY(-2px)'; }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = 'oklch(from var(--paper-4) l c h / 0.5)'; e.currentTarget.style.transform = 'translateY(0)'; }}
              >
                <div style={{
                  width: 34, height: 34, borderRadius: 10,
                  background: 'var(--paper-2)',
                  border: '1px solid oklch(from var(--paper-4) l c h / 0.5)',
                  display: 'grid', placeItems: 'center',
                  color: 'var(--ink-1)', marginBottom: 12,
                }}>{t.icon}</div>
                <div style={{ fontSize: 13.5, fontWeight: 500, color: 'var(--ink-0)', marginBottom: 4 }}>{t.title}</div>
                <div style={{ fontSize: 12, color: 'var(--ink-2)', lineHeight: 1.45 }}>{t.desc}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

function ProjectPreview({ kind, accent }) {
  const dotColor = {
    bloom: 'var(--bloom-2)', moss: 'var(--moss)',
    saffron: 'var(--saffron)', madder: 'var(--madder)',
    graphite: 'var(--graphite)',
  }[accent] || 'var(--ink-2)';

  if (kind === 'arch') {
    return (
      <svg width="100%" height="100%" viewBox="0 0 300 190">
        <defs>
          <marker id={`am-${accent}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0 L10 5 L0 10z" fill="var(--ink-3)"/></marker>
        </defs>
        <rect x="30" y="60" width="60" height="34" rx="6" fill="var(--paper-0)" stroke="var(--ink-3)" strokeWidth="1"/>
        <rect x="120" y="30" width="60" height="34" rx="6" fill="var(--paper-0)" stroke="var(--ink-3)" strokeWidth="1"/>
        <rect x="120" y="90" width="60" height="34" rx="6" fill="var(--paper-0)" stroke="var(--ink-3)" strokeWidth="1"/>
        <rect x="210" y="60" width="60" height="34" rx="6" fill="var(--paper-0)" stroke="var(--ink-3)" strokeWidth="1"/>
        <rect x="120" y="140" width="60" height="34" rx="6" fill="var(--paper-0)" stroke={dotColor} strokeWidth="1.5"/>
        <path d="M90 77 L120 47" stroke="var(--ink-3)" strokeWidth="1" fill="none" markerEnd={`url(#am-${accent})`}/>
        <path d="M90 77 L120 107" stroke="var(--ink-3)" strokeWidth="1" fill="none" markerEnd={`url(#am-${accent})`}/>
        <path d="M180 47 L210 77" stroke="var(--ink-3)" strokeWidth="1" fill="none" markerEnd={`url(#am-${accent})`}/>
        <path d="M180 107 L210 77" stroke="var(--ink-3)" strokeWidth="1" fill="none" markerEnd={`url(#am-${accent})`}/>
        <path d="M150 124 L150 140" stroke={dotColor} strokeWidth="1.5" fill="none"/>
        <circle cx="270" cy="30" r="3" fill={dotColor} />
      </svg>
    );
  }
  if (kind === 'journey') {
    return (
      <svg width="100%" height="100%" viewBox="0 0 300 190">
        <path d="M20 130 C 60 40, 100 40, 140 100 S 220 160, 280 60" stroke={dotColor} strokeWidth="2" fill="none"/>
        {[20, 80, 140, 200, 260].map((x, i) => (
          <circle key={i} cx={x} cy={i%2===0 ? (i===0?130:100) : (i===1?60:i===3?140:60)} r="4" fill={dotColor}/>
        ))}
      </svg>
    );
  }
  if (kind === 'wire') {
    return (
      <svg width="100%" height="100%" viewBox="0 0 300 190">
        {[0,1,2].map(i => (
          <g key={i} transform={`translate(${20 + i * 90}, 30)`}>
            <rect x="0" y="0" width="70" height="130" rx="8" fill="var(--paper-0)" stroke="var(--ink-3)" strokeWidth="1"/>
            <rect x="8" y="10" width="54" height="8" rx="2" fill="var(--paper-3)"/>
            <rect x="8" y="24" width="40" height="6" rx="2" fill="var(--paper-3)"/>
            <rect x="8" y="40" width="54" height="24" rx="4" fill="var(--paper-3)"/>
            <rect x="8" y="70" width="54" height="24" rx="4" fill="var(--paper-3)"/>
            <rect x="8" y="100" width="30" height="20" rx="4" fill={dotColor} opacity="0.7"/>
          </g>
        ))}
      </svg>
    );
  }
  if (kind === 'seq') {
    return (
      <svg width="100%" height="100%" viewBox="0 0 300 190">
        {[50, 130, 210].map((x, i) => (
          <g key={i}>
            <rect x={x-25} y="20" width="50" height="18" rx="4" fill="var(--paper-0)" stroke="var(--ink-3)" strokeWidth="1"/>
            <line x1={x} y1="40" x2={x} y2="170" stroke="var(--ink-3)" strokeDasharray="3 3" strokeWidth="1"/>
          </g>
        ))}
        <path d="M50 60 L130 60" stroke={dotColor} strokeWidth="1.5" markerEnd="url(#seqArr)"/>
        <path d="M130 90 L210 90" stroke="var(--ink-3)" strokeWidth="1"/>
        <path d="M210 120 L130 120" stroke="var(--ink-3)" strokeWidth="1"/>
        <path d="M130 150 L50 150" stroke={dotColor} strokeWidth="1.5"/>
        <defs>
          <marker id="seqArr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0 L10 5 L0 10z" fill={dotColor}/></marker>
        </defs>
      </svg>
    );
  }
  return null;
}

Object.assign(window, { ScreenDashboard });
