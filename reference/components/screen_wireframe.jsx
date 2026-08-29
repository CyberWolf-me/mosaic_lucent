// Screen 9 — Wireframe artifact
// A large wireframe frame in the middle of the canvas. Small architecture nodes remain visible
// at edges to show these all live in the same workspace.

function ScreenWireframe() {
  return (
    <div data-screen-label="09 Wireframe" style={{ position: 'absolute', inset: 0 }}>
      <CanvasBackdrop />
      <TopBar
        crumbs={[
          { label: 'Personal', current: false },
          { label: 'E-commerce platform', current: false },
          { label: 'Checkout wireframe', current: true },
        ]}
      />
      <LeftRail active="wireframes" />

      {/* Context nodes at edges (dimmed) — same workspace */}
      <div style={{ position: 'absolute', inset: 0, opacity: 0.35 }}>
        <Node x={80}  y={140} w={130} title="Cart"     meta="LINKED" dot="violet" />
        <Node x={80}  y={240} w={130} title="Checkout" meta="THIS"   dot="amber" state="selected" />
        <Node x={80}  y={340} w={130} title="Stripe"   meta="LINKED" dot="amber" />
        <svg style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
          <ConnectorDefs />
          <path d="M145 172 L145 240" stroke="var(--stroke-2)" strokeWidth="1" fill="none" markerEnd="url(#arr)" />
          <path d="M145 272 L145 340" stroke="var(--stroke-2)" strokeWidth="1" fill="none" markerEnd="url(#arr)" />
        </svg>
      </div>

      {/* Wireframe frame — big centered */}
      <div style={{
        position: 'absolute', left: 260, top: 90,
        width: 780, height: 580,
      }}>
        <div className="frame" style={{
          left: 0, top: 0, width: '100%', height: '100%',
          padding: '32px 16px 16px',
        }}>
          <div className="frame-label" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Ico.Grid />
            Checkout · Wireframe · Desktop 1440
          </div>

          {/* Device / browser chrome */}
          <div style={{
            width: '100%', height: '100%',
            background: 'var(--canvas-2)',
            border: '1px solid var(--stroke-2)',
            borderRadius: 12,
            overflow: 'hidden',
            display: 'flex', flexDirection: 'column',
          }}>
            {/* Browser bar */}
            <div style={{
              height: 32, borderBottom: '1px solid var(--stroke-1)',
              display: 'flex', alignItems: 'center', gap: 8, padding: '0 12px',
              background: 'var(--canvas-2)',
            }}>
              <div style={{ display: 'flex', gap: 5 }}>
                {['#c95a3f', '#c9a83f', '#5ac06a'].map((c, i) => (
                  <div key={i} style={{ width: 9, height: 9, borderRadius: 999, background: c, opacity: 0.6 }} />
                ))}
              </div>
              <div style={{
                flex: 1, height: 18, borderRadius: 4,
                background: 'var(--canvas-1)', border: '1px solid var(--stroke-1)',
                display: 'flex', alignItems: 'center', paddingLeft: 8,
                fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--ink-3)',
              }}>
                shop.example.com/checkout
              </div>
            </div>

            {/* Page content */}
            <div style={{ flex: 1, display: 'grid', gridTemplateColumns: '1fr 320px', gap: 20, padding: 24 }}>
              {/* Left column */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
                <WBLabel text="Contact" step={1} />
                <WBField label="Email address" placeholder="you@example.com" />

                <WBLabel text="Shipping" step={2} />
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                  <WBField label="First name" />
                  <WBField label="Last name" />
                </div>
                <WBField label="Address" />
                <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 10 }}>
                  <WBField label="City" />
                  <WBField label="State" />
                  <WBField label="ZIP" />
                </div>

                <WBLabel text="Payment" step={3} />
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
                  {['Card', 'Apple Pay', 'PayPal'].map((p, i) => (
                    <div key={i} style={{
                      height: 44, borderRadius: 6,
                      border: `1px solid ${i === 0 ? 'var(--amber-2)' : 'var(--stroke-2)'}`,
                      background: i === 0 ? 'oklch(0.82 0.15 75 / 0.06)' : 'var(--canvas-2)',
                      display: 'grid', placeItems: 'center',
                      fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--ink-1)',
                      letterSpacing: '0.05em', textTransform: 'uppercase',
                    }}>
                      {p}
                    </div>
                  ))}
                </div>
                <WBField label="Card number" />
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                  <WBField label="Expiry" />
                  <WBField label="CVC" />
                </div>

                <button style={{
                  marginTop: 14,
                  height: 44,
                  borderRadius: 8,
                  background: 'linear-gradient(180deg, oklch(0.9 0.005 80), oklch(0.82 0.006 60))',
                  color: 'var(--canvas-0)',
                  fontSize: 13, fontVariationSettings: "'wght' 550",
                  letterSpacing: '-0.005em',
                }}>
                  Place order · $84.20
                </button>
              </div>

              {/* Right — order summary */}
              <div style={{
                background: 'var(--canvas-2)',
                border: '1px solid var(--stroke-1)',
                borderRadius: 10,
                padding: 18,
                display: 'flex', flexDirection: 'column', gap: 14,
                height: 'fit-content',
              }}>
                <div className="mono" style={{
                  fontSize: 10, color: 'var(--ink-3)', letterSpacing: '0.1em',
                  textTransform: 'uppercase',
                }}>Your order · 3 items</div>

                {[
                  ['Sourdough starter kit', '$32.00'],
                  ['Ceramic proofing basket', '$28.00'],
                  ['Bench scraper', '$14.00'],
                ].map(([n, p], i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <div style={{
                      width: 32, height: 32, borderRadius: 6,
                      background: 'var(--canvas-3)',
                      border: '1px solid var(--stroke-1)',
                    }} />
                    <div style={{ flex: 1, fontSize: 12, color: 'var(--ink-0)' }}>{n}</div>
                    <div className="mono" style={{ fontSize: 11, color: 'var(--ink-1)' }}>{p}</div>
                  </div>
                ))}

                <div style={{ borderTop: '1px solid var(--stroke-1)', paddingTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {[['Subtotal', '$74.00'], ['Shipping', '$6.00'], ['Tax', '$4.20']].map(([l, v], i) => (
                    <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5, color: 'var(--ink-2)' }}>
                      <span>{l}</span><span className="mono">{v}</span>
                    </div>
                  ))}
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: 'var(--ink-0)', fontVariationSettings: "'wght' 550", marginTop: 4 }}>
                    <span>Total</span><span className="mono">$84.20</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Node connections back to architecture */}
        <div style={{
          position: 'absolute', top: 12, left: -14,
          padding: '3px 8px',
          background: 'var(--canvas-1)',
          border: '1px solid var(--stroke-2)',
          borderRadius: 4,
          fontFamily: 'var(--font-mono)',
          fontSize: 9.5, color: 'var(--amber-1)',
          letterSpacing: '0.06em', textTransform: 'uppercase',
          display: 'flex', alignItems: 'center', gap: 6,
        }}>
          <span style={{ width: 4, height: 4, borderRadius: 999, background: 'var(--amber-1)' }} />
          Linked to Checkout node
        </div>
      </div>

      <AIPill
        placeholder="Refine the wireframe — 'move payment above shipping', 'try mobile layout'…"
        history={[
          { role: 'user', time: '1 min ago', content: "Turn this into a wireframe for checkout." },
          { role: 'ai',   time: '1 min ago', content: 'Created a desktop wireframe with contact, shipping, payment, and order summary sections. Linked back to the Checkout node.' },
        ]}
      />
      <ZoomBadge zoom={72} />
      <StatusBadge>
        <Ico.Grid style={{ color: 'var(--ink-3)' }} />
        <span>Wireframe · 1440×900</span>
      </StatusBadge>
    </div>
  );
}

function WBLabel({ text, step }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
      <div style={{
        width: 18, height: 18, borderRadius: 999,
        background: 'var(--canvas-3)',
        border: '1px solid var(--stroke-2)',
        display: 'grid', placeItems: 'center',
        fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--ink-1)',
      }}>{step}</div>
      <div style={{ fontSize: 13, color: 'var(--ink-0)', fontVariationSettings: "'wght' 520", letterSpacing: '-0.005em' }}>
        {text}
      </div>
      <div style={{ flex: 1, height: 1, background: 'var(--stroke-1)' }} />
    </div>
  );
}

function WBField({ label, placeholder }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div className="mono" style={{ fontSize: 10, color: 'var(--ink-3)', letterSpacing: '0.05em', textTransform: 'uppercase' }}>
        {label}
      </div>
      <div style={{
        height: 34, borderRadius: 6,
        background: 'var(--canvas-2)',
        border: '1px solid var(--stroke-1)',
        display: 'flex', alignItems: 'center', paddingLeft: 10,
        fontSize: 12, color: 'var(--ink-3)',
      }}>
        {placeholder || <span style={{ opacity: 0.4 }}>—</span>}
      </div>
    </div>
  );
}

Object.assign(window, { ScreenWireframe });
