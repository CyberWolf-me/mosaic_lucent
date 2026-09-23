// Screen 01 — Empty canvas. The "blank page" moment.

function ScreenEmpty({ onStart }) {
  const suggestions = [
    'Design an e-commerce checkout flow',
    'Architect a real-time chat app',
    'Map the user journey for onboarding',
    'Draft a Kubernetes deployment',
  ];
  const [q, setQ] = useState('');

  return (
    <>
      <PaperBackdrop />
      <TopBar crumbs={[{ label: 'Untitled workspace', current: true }]} />
      <GlobalRail active="board" />

      {/* Centered empty state */}
      <div style={{
        position: 'absolute', inset: 0,
        display: 'grid', placeItems: 'center',
        pointerEvents: 'none',
      }}>
        <div style={{ textAlign: 'center', maxWidth: 640, pointerEvents: 'auto' }}>
          <div className="mono-caps" style={{ marginBottom: 20, color: 'var(--ink-3)' }}>
            Fig. 01 · Untitled · a blank page
          </div>
          <div style={{
            fontFamily: 'var(--font-serif)',
            fontSize: 54, lineHeight: 1.05,
            letterSpacing: '-0.025em',
            color: 'var(--ink-0)',
            fontWeight: 400,
          }}>
            What should we <em style={{ color: 'var(--bloom-2)', fontStyle: 'italic' }}>build?</em>
          </div>
          <div style={{ marginTop: 18, fontSize: 15.5, color: 'var(--ink-2)', lineHeight: 1.55, fontFamily: 'var(--font-serif)', fontStyle: 'italic' }}>
            Describe your idea. Lucent will draft an editable, semantic canvas.
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 32, justifyContent: 'center' }}>
            {suggestions.map(s => (
              <button
                key={s}
                onClick={() => { setQ(s); onStart && onStart(); }}
                style={{
                  padding: '9px 16px',
                  borderRadius: 999,
                  background: 'oklch(from var(--paper-0) l c h / 0.7)',
                  border: '1px solid oklch(from var(--paper-4) l c h / 0.6)',
                  fontSize: 12.5, color: 'var(--ink-1)',
                  transition: 'all 0.14s var(--e-out)',
                  backdropFilter: 'blur(12px)',
                }}
                onMouseEnter={e => {
                  e.currentTarget.style.background = 'var(--paper-0)';
                  e.currentTarget.style.borderColor = 'var(--ink-3)';
                  e.currentTarget.style.color = 'var(--ink-0)';
                }}
                onMouseLeave={e => {
                  e.currentTarget.style.background = 'oklch(from var(--paper-0) l c h / 0.7)';
                  e.currentTarget.style.borderColor = 'oklch(from var(--paper-4) l c h / 0.6)';
                  e.currentTarget.style.color = 'var(--ink-1)';
                }}
              >
                <Ico.Sparkle style={{ display: 'inline', verticalAlign: -2, marginRight: 6, color: 'var(--bloom-2)' }} />
                {s}
              </button>
            ))}
          </div>
        </div>
      </div>

      <AIPill value={q} onChange={setQ} onSubmit={() => onStart && onStart()} placeholder="Describe your idea…" />
      <ZoomBadge />
      <StatusBadge>
        <Ico.Dot style={{ color: 'var(--ink-3)' }} /> Empty · <span style={{ color: 'var(--ink-0)' }}>ready</span>
      </StatusBadge>
    </>
  );
}

Object.assign(window, { ScreenEmpty });
