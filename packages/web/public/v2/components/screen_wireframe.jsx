// Screen 09 — Wireframe · device-frame at 1440

function ScreenWireframe() {
  return (
    <>
      <PaperBackdrop />
      <TopBar crumbs={[
        { label: 'Personal', screen: 6 },
        { label: 'E-commerce platform', screen: 3 },
        { label: 'Checkout wireframe', current: true },
      ]} />
      <GlobalRail active="board" />

      <div style={{
        position: 'absolute', top: 72, bottom: 100, left: 92, right: 40,
        overflow: 'auto',
      }}>
        <div style={{ padding: '20px 0' }}>
          <div className="mono-caps" style={{ marginBottom: 12 }}>Fig. 09 · Checkout · 1440 × 900</div>

          <div style={{ display: 'flex', gap: 24, alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <WireframeFrame title="Cart review" number="01">
              <WireHeader />
              <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 16, padding: '20px 26px' }}>
                <div>
                  <WireLine w={160} h={24} />
                  <div style={{ height: 20 }} />
                  {[0, 1, 2].map(i => (
                    <div key={i} style={{
                      display: 'flex', gap: 12, padding: '12px 0',
                      borderBottom: '1px solid oklch(from var(--paper-4) l c h / 0.4)',
                    }}>
                      <WireBox w={60} h={60} />
                      <div style={{ flex: 1 }}>
                        <WireLine w={180} h={12} />
                        <div style={{ height: 6 }} />
                        <WireLine w={90} h={9} muted />
                        <div style={{ height: 8 }} />
                        <WireLine w={60} h={10} />
                      </div>
                    </div>
                  ))}
                </div>
                <div style={{
                  padding: 16, borderRadius: 8,
                  background: 'var(--paper-2)',
                  border: '1px solid oklch(from var(--paper-4) l c h / 0.4)',
                }}>
                  <WireLine w={100} h={14} />
                  <div style={{ height: 14 }} />
                  {[0,1,2].map(i => (
                    <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0' }}>
                      <WireLine w={80} h={9} muted />
                      <WireLine w={40} h={9} muted />
                    </div>
                  ))}
                  <div style={{ height: 8 }} />
                  <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderTop: '1px solid oklch(from var(--paper-4) l c h / 0.4)' }}>
                    <WireLine w={40} h={12} />
                    <WireLine w={50} h={12} />
                  </div>
                  <div style={{ height: 12 }} />
                  <div style={{
                    height: 36, borderRadius: 6,
                    background: 'var(--bloom-2)',
                  }} />
                </div>
              </div>
            </WireframeFrame>

            <WireframeFrame title="Address" number="02">
              <WireHeader />
              <div style={{ padding: '20px 26px' }}>
                <WireLine w={200} h={24} />
                <div style={{ height: 20 }} />
                {['Full name', 'Street', 'City · State', 'ZIP · Country'].map(l => (
                  <div key={l} style={{ marginBottom: 14 }}>
                    <WireLine w={90} h={8} muted />
                    <div style={{ height: 4 }} />
                    <WireBox w="100%" h={36} />
                  </div>
                ))}
                <div style={{ height: 8 }} />
                <div style={{ display: 'flex', gap: 10 }}>
                  <div style={{ height: 36, flex: 1, borderRadius: 6, background: 'var(--paper-3)' }} />
                  <div style={{ height: 36, flex: 1, borderRadius: 6, background: 'var(--bloom-2)' }} />
                </div>
              </div>
            </WireframeFrame>

            <WireframeFrame title="Payment" number="03">
              <WireHeader />
              <div style={{ padding: '20px 26px' }}>
                <WireLine w={140} h={24} />
                <div style={{ height: 20 }} />
                <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
                  {['Card', 'Apple', 'Klarna'].map((m, i) => (
                    <div key={m} style={{
                      flex: 1, height: 40, borderRadius: 6,
                      background: i === 0 ? 'var(--paper-0)' : 'var(--paper-2)',
                      border: `1px solid ${i === 0 ? 'var(--bloom-2)' : 'oklch(from var(--paper-4) l c h / 0.5)'}`,
                      display: 'grid', placeItems: 'center',
                      fontSize: 12, color: 'var(--ink-2)',
                    }}>{m}</div>
                  ))}
                </div>
                {['Number', 'MM/YY · CVV', 'Name on card'].map(l => (
                  <div key={l} style={{ marginBottom: 14 }}>
                    <WireLine w={80} h={8} muted />
                    <div style={{ height: 4 }} />
                    <WireBox w="100%" h={36} />
                  </div>
                ))}
                <div style={{ height: 12 }} />
                <div style={{ height: 40, borderRadius: 6, background: 'var(--ink-0)' }} />
              </div>
            </WireframeFrame>
          </div>
        </div>
      </div>

      <ShapeToolbar side="bottom" />
      <AIPill placeholder="Edit copy, rearrange, or ask to add a screen…" />
      <ZoomBadge />
      <StatusBadge>
        <Ico.Dot style={{ color: 'var(--ink-3)' }} /> 3 screens · <span style={{ color: 'var(--ink-0)' }}>1440 × 900</span>
      </StatusBadge>
    </>
  );
}

function WireframeFrame({ title, number, children }) {
  return (
    <div>
      <div className="mono-caps" style={{ marginBottom: 8, display: 'flex', gap: 8 }}>
        <span>{number}</span> · <span>{title}</span>
      </div>
      <div style={{
        width: 440, background: 'var(--paper-0)',
        border: '1px solid oklch(from var(--paper-4) l c h / 0.5)',
        borderRadius: 12,
        overflow: 'hidden',
        boxShadow: 'var(--shadow-2)',
      }}>
        {children}
      </div>
    </div>
  );
}

function WireHeader() {
  return (
    <div style={{
      height: 44, borderBottom: '1px solid oklch(from var(--paper-4) l c h / 0.4)',
      display: 'flex', alignItems: 'center', padding: '0 20px', gap: 16,
      background: 'var(--paper-1)',
    }}>
      <div style={{ width: 20, height: 20, borderRadius: 5, background: 'var(--ink-0)' }} />
      <WireLine w={70} h={10} />
      <div style={{ flex: 1 }} />
      <WireBox w={90} h={22} />
    </div>
  );
}

function WireLine({ w = 100, h = 10, muted = false }) {
  return <div style={{ width: w, height: h, background: muted ? 'oklch(from var(--paper-4) l c h / 0.5)' : 'var(--paper-3)', borderRadius: 2 }} />;
}
function WireBox({ w = 60, h = 60 }) {
  return <div style={{ width: w, height: h, background: 'var(--paper-2)', border: '1px solid oklch(from var(--paper-4) l c h / 0.4)', borderRadius: 4 }} />;
}

Object.assign(window, { ScreenWireframe });
