// Screen 1 — Empty canvas / magic moment entry
// The showpiece opening: quiet dark canvas, a big central prompt, one line inviting user in.

function ScreenEmpty({ onStart }) {
  const [val, setVal] = useState('');
  const suggestions = [
    "An e-commerce platform with Stripe payments",
    "The architecture for a real-time chat app",
    "A user journey for SaaS onboarding",
    "Mind map for a new product launch",
  ];

  return (
    <div data-screen-label="01 Empty canvas" style={{ position: 'absolute', inset: 0 }}>
      <CanvasBackdrop />
      <TopBar
        crumbs={[
          { label: 'Personal', current: false },
          { label: 'Untitled workspace', current: true },
        ]}
      />
      <LeftRail active="canvas" />

      {/* Center hero */}
      <div style={{
        position: 'absolute', inset: 0,
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        gap: 22, padding: '0 40px',
      }}>
        {/* Ambient glow behind */}
        <div style={{
          position: 'absolute', width: 640, height: 640,
          background: 'radial-gradient(circle, oklch(0.82 0.15 75 / 0.06) 0%, transparent 60%)',
          pointerEvents: 'none',
        }} />

        <div style={{
          fontFamily: 'var(--font-mono)', fontSize: 10,
          letterSpacing: '0.14em', textTransform: 'uppercase',
          color: 'var(--ink-3)',
          display: 'flex', gap: 8, alignItems: 'center',
        }}>
          <span style={{
            width: 6, height: 6, borderRadius: 999,
            background: 'var(--amber-1)',
            boxShadow: '0 0 10px var(--amber-glow)',
          }} />
          Lucent · Session ready
        </div>

        <h1 style={{
          fontSize: 48,
          letterSpacing: '-0.028em',
          fontVariationSettings: "'wght' 400",
          textAlign: 'center',
          lineHeight: 1.05,
          maxWidth: 720,
          background: 'linear-gradient(180deg, oklch(0.99 0 0), oklch(0.72 0.006 60))',
          WebkitBackgroundClip: 'text',
          WebkitTextFillColor: 'transparent',
          backgroundClip: 'text',
        }}>
          What are you thinking about?
        </h1>

        <p style={{
          fontSize: 14, color: 'var(--ink-2)', maxWidth: 460, textAlign: 'center',
          lineHeight: 1.55,
        }}>
          Describe an idea, a system, a flow. Lucent turns your words into a visual workspace you can shape as you talk.
        </p>

        {/* Large input */}
        <div style={{
          width: 620, marginTop: 12,
          background: 'oklch(from var(--canvas-2) l c h / 0.75)',
          backdropFilter: 'blur(20px) saturate(1.5)',
          border: '1px solid var(--stroke-2)',
          borderRadius: 18,
          padding: 16,
          display: 'flex', flexDirection: 'column', gap: 14,
          boxShadow: 'var(--elev-2)',
        }}>
          <input
            value={val}
            onChange={e => setVal(e.target.value)}
            placeholder="e.g. I'm building an e-commerce platform. Customers browse, add to cart, checkout, pay with Stripe…"
            style={{
              fontSize: 15, color: 'var(--ink-0)', width: '100%',
              padding: '2px 4px',
              lineHeight: 1.5,
            }}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button
              className="icon-btn"
              style={{ background: 'var(--canvas-3)' }}
              onClick={() => window.__lucentGo && window.__lucentGo(5)}
            >
              <Ico.Mic2 /> Speak
            </button>
            <button className="icon-btn"><Ico.Attach /> Attach</button>
            <div style={{ flex: 1 }} />
            <span style={{ fontSize: 11, color: 'var(--ink-3)', fontFamily: 'var(--font-mono)' }}>
              Enter to send
            </span>
            <button className="btn amber" style={{ flex: 'none', padding: '0 16px', height: 34 }} onClick={onStart}>
              Begin <Ico.Arrow />
            </button>
          </div>
        </div>

        {/* Prompt suggestions */}
        <div style={{
          display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center',
          maxWidth: 700, marginTop: 6,
        }}>
          {suggestions.map((s, i) => (
            <button
              key={i}
              onClick={() => setVal(s)}
              style={{
                fontSize: 12, color: 'var(--ink-2)',
                padding: '6px 12px',
                border: '1px solid var(--stroke-1)',
                borderRadius: 999,
                background: 'oklch(from var(--canvas-1) l c h / 0.5)',
                transition: 'all 0.15s var(--e-out)',
              }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--stroke-3)'; e.currentTarget.style.color = 'var(--ink-0)'; }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--stroke-1)'; e.currentTarget.style.color = 'var(--ink-2)'; }}
            >
              {s}
            </button>
          ))}
        </div>

        {/* Corner hint (ghost node preview) */}
        <div style={{
          marginTop: 40,
          display: 'flex', alignItems: 'center', gap: 18,
          opacity: 0.6,
        }}>
          <div style={{
            fontFamily: 'var(--font-mono)', fontSize: 10,
            letterSpacing: '0.1em', textTransform: 'uppercase',
            color: 'var(--ink-3)',
          }}>
            You can also
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <span className="kbd" style={{ padding: '3px 6px', border: '1px solid var(--stroke-2)', borderRadius: 4, fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--ink-2)' }}>drag files</span>
            <span style={{ color: 'var(--ink-3)', fontSize: 11 }}>·</span>
            <span className="kbd" style={{ padding: '3px 6px', border: '1px solid var(--stroke-2)', borderRadius: 4, fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--ink-2)' }}>paste a diagram</span>
            <span style={{ color: 'var(--ink-3)', fontSize: 11 }}>·</span>
            <span className="kbd" style={{ padding: '3px 6px', border: '1px solid var(--stroke-2)', borderRadius: 4, fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--ink-2)' }}>double-click canvas</span>
          </div>
        </div>
      </div>

      <ZoomBadge zoom={100} />
      <StatusBadge>
        <span style={{ width: 6, height: 6, borderRadius: 999, background: 'var(--sig-green)', boxShadow: '0 0 6px oklch(0.78 0.11 155 / 0.6)' }} />
        Autosaved
      </StatusBadge>
    </div>
  );
}

Object.assign(window, { ScreenEmpty });
