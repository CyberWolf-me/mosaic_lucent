// Screen 07 — History · timeline of operations

function ScreenHistory() {
  const events = [
    { time: 'just now', title: 'You reverted "Legacy Auth" removal', desc: 'Restored from commit d2f4a1c', bloom: false, who: 'you' },
    { time: '2m ago',   title: 'Applied 6 changes from proposal',  desc: 'Payment Service · Redis Cache · Notification Bus + 3 edits', bloom: true, who: 'lucent' },
    { time: '4m ago',   title: 'Sarah joined the workspace',       desc: 'Invited via lucent.app/w/e-commerce-x8j2', bloom: false, who: 'sarah' },
    { time: '8m ago',   title: 'Lucent proposed adding payments',  desc: 'From voice · "add stripe integration"', bloom: true, who: 'lucent' },
    { time: '12m ago',  title: 'Renamed "Checkout" → "Order Service"', desc: 'Manual edit by Alex', bloom: false, who: 'you' },
    { time: '18m ago',  title: 'Layout reflowed · ELK mrtree',     desc: 'Auto-layout after 3 node moves', bloom: false, who: 'system' },
    { time: '24m ago',  title: 'Lucent generated initial draft',   desc: 'From "design an e-commerce platform" · 8 nodes, 6 edges', bloom: true, who: 'lucent' },
    { time: '25m ago',  title: 'Workspace created',                desc: 'E-commerce platform · from blank', bloom: false, who: 'you' },
  ];

  return (
    <>
      <PaperBackdrop />
      <TopBar crumbs={[
        { label: 'Personal', screen: 6 },
        { label: 'E-commerce platform', screen: 3 },
        { label: 'History', current: true },
      ]} />
      <GlobalRail active="board" />

      <div style={{
        position: 'absolute', top: 72, bottom: 40, left: 92, right: 40,
        overflowY: 'auto',
      }}>
        <div style={{ padding: '24px 8px', maxWidth: 900, margin: '0 auto' }}>
          <div className="ds-eyebrow" style={{ marginBottom: 8 }}>Fig. 07 · Workspace history</div>
          <div style={{ fontFamily: 'var(--font-serif)', fontSize: 40, letterSpacing: '-0.02em', fontWeight: 400, marginBottom: 8 }}>
            Everything that happened, in order.
          </div>
          <div style={{ fontFamily: 'var(--font-serif)', fontStyle: 'italic', fontSize: 15, color: 'var(--ink-2)', marginBottom: 32 }}>
            8 events today · scroll for older
          </div>

          <div style={{ display: 'flex', gap: 8, marginBottom: 22 }}>
            <button className="icon-btn primary" style={{ height: 30, fontSize: 12 }}>All</button>
            <button className="icon-btn" style={{ height: 30, fontSize: 12 }}><Ico.Sparkle /> Lucent</button>
            <button className="icon-btn" style={{ height: 30, fontSize: 12 }}><Ico.User /> People</button>
            <button className="icon-btn" style={{ height: 30, fontSize: 12 }}><Ico.Bot /> System</button>
            <div style={{ flex: 1 }} />
            <button className="icon-btn" style={{ height: 30, fontSize: 12 }}>Export ledger</button>
          </div>

          {events.map((e, i) => (
            <div key={i} className="tl-row">
              <div className="tl-time">{e.time}</div>
              <div className={`tl-node ${e.bloom ? 'bloom' : ''}`}>
                <div className="dot" />
                {i < events.length - 1 && <div className="line" />}
              </div>
              <div className="tl-body">
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  {e.bloom && <Ico.Sparkle style={{ color: 'var(--bloom-2)' }} />}
                  <div className="tl-title">{e.title}</div>
                  <div style={{ flex: 1 }} />
                  <div className="mono-caps">{e.who}</div>
                </div>
                <div className="tl-desc">{e.desc}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

Object.assign(window, { ScreenHistory });
