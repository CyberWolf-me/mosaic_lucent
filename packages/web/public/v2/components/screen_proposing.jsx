// Screen 04 — Proposing changes. Review diff before applying.

function ScreenProposing() {
  const changes = [
    { op: 'add', title: 'Payment Service', sub: 'New service between Orders and Stripe' },
    { op: 'add', title: 'Redis Cache',     sub: 'In front of Orders DB · TTL 300s' },
    { op: 'add', title: 'Notification Bus',sub: 'Webhook fanout · SNS-compatible' },
    { op: 'mod', title: 'API Gateway',     sub: 'Add /payments route + signing' },
    { op: 'mod', title: 'Order Service',   sub: 'Split checkout from fulfillment' },
    { op: 'del', title: 'Legacy Auth',     sub: 'Replaced by OAuth session store' },
  ];
  return (
    <>
      <PaperBackdrop />
      <TopBar crumbs={[
        { label: 'Personal', screen: 6 },
        { label: 'E-commerce platform', current: true },
      ]} />
      <GlobalRail active="board" />

      <div style={{ position: 'absolute', inset: '80px 380px 100px 90px' }}>
        <div style={{ position: 'relative', width: '100%', height: '100%' }}>
          <svg className="connectors" viewBox="0 0 1000 500" preserveAspectRatio="none" style={{ width: '100%', height: '100%' }}>
            <ConnectorDefs />
            <path d={handPath({x: 145, y: 90}, {x: 320, y: 90}, 'h', 6, 1)} markerEnd="url(#arr)" />
            <path d={handPath({x: 460, y: 90}, {x: 640, y: 90}, 'h', 8, 2)} markerEnd="url(#arr)" />
            <path d={handPath({x: 460, y: 90}, {x: 640, y: 240}, 'h', 10, 3)} className="emerging" markerEnd="url(#arr-bloom)" />
            <path d={handPath({x: 460, y: 90}, {x: 640, y: 380}, 'h', 10, 4)} className="emerging" markerEnd="url(#arr-bloom)" />
            <path d={handPath({x: 780, y: 120}, {x: 780, y: 220}, 'v', 6, 5)} className="emerging" markerEnd="url(#arr-bloom)" />
            <path d={handPath({x: 780, y: 275}, {x: 780, y: 350}, 'v', 6, 6)} className="dashed" markerEnd="url(#arr)" />
          </svg>

          <Node x={20}  y={60}  meta="CLIENT" title="Web + Mobile" sub="unchanged" rot={-0.6} />
          <Node x={320} y={60}  meta="EDGE" dot="saffron" title="API Gateway" sub="+ /payments · signing" state="proposed" rot={0.4} />
          <Node x={640} y={60}  meta="SVC" dot="saffron" title="Order Service" sub="split into checkout + fulfillment" state="proposed" rot={-0.6} />
          <Node x={640} y={210} meta="AI · NEW" dot="bloom" title="Payment Service" sub="Stripe intents · retries" state="emerging" rot={0.4} />
          <Node x={640} y={350} meta="AI · NEW" dot="bloom" title="Notification Bus" sub="webhook fanout" state="emerging" rot={-0.4} />
          <Node x={880} y={210} meta="AI · NEW" dot="bloom" title="Redis Cache" sub="orders · TTL 300" state="emerging" rot={0.9} />

          {/* removal — struck-through */}
          <div style={{
            position: 'absolute', left: 20, top: 340,
            padding: '10px 14px',
            borderRadius: 14,
            border: '1.5px dashed var(--madder)',
            background: 'oklch(from var(--madder) l c h / 0.06)',
            width: 180, transform: 'rotate(-1.5deg)',
          }}>
            <div className="mono-caps" style={{ color: 'var(--madder)', marginBottom: 4 }}>REMOVE</div>
            <div style={{
              fontSize: 13.5, color: 'var(--madder)',
              textDecoration: 'line-through', textDecorationThickness: 1,
              fontWeight: 500,
            }}>Legacy Auth</div>
            <div style={{ fontSize: 11.5, color: 'var(--ink-2)', marginTop: 2 }}>replaced by OAuth</div>
          </div>
        </div>
      </div>

      <div className="right-panel">
        <div className="panel-head">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div>
              <div className="panel-title">Proposal · draft 3</div>
              <div className="panel-sub">6 changes · from "add payment processing"</div>
            </div>
            <button style={{
              padding: 6, borderRadius: 8, color: 'var(--ink-3)',
              transition: 'all 0.12s',
            }}>
              <Ico.X />
            </button>
          </div>
        </div>
        <div className="panel-body">
          <div className="mono-caps" style={{ marginBottom: 8 }}>3 additions</div>
          {changes.filter(c => c.op === 'add').map((c, i) => (
            <div key={i} className="change-item">
              <span className="change-op add">Add</span>
              <div style={{ flex: 1 }}>
                <div className="change-title">{c.title}</div>
                <div className="change-sub">{c.sub}</div>
              </div>
              <button style={{ padding: 4, color: 'var(--ink-3)' }}><Ico.X /></button>
            </div>
          ))}
          <div className="mono-caps" style={{ marginBottom: 8, marginTop: 14 }}>2 modifications</div>
          {changes.filter(c => c.op === 'mod').map((c, i) => (
            <div key={i} className="change-item">
              <span className="change-op mod">Mod</span>
              <div style={{ flex: 1 }}>
                <div className="change-title">{c.title}</div>
                <div className="change-sub">{c.sub}</div>
              </div>
              <button style={{ padding: 4, color: 'var(--ink-3)' }}><Ico.X /></button>
            </div>
          ))}
          <div className="mono-caps" style={{ marginBottom: 8, marginTop: 14 }}>1 removal</div>
          {changes.filter(c => c.op === 'del').map((c, i) => (
            <div key={i} className="change-item">
              <span className="change-op del">Del</span>
              <div style={{ flex: 1 }}>
                <div className="change-title">{c.title}</div>
                <div className="change-sub">{c.sub}</div>
              </div>
              <button style={{ padding: 4, color: 'var(--ink-3)' }}><Ico.X /></button>
            </div>
          ))}
        </div>
        <div className="panel-foot">
          <button className="btn ghost">Cancel</button>
          <button className="btn bloom"><Ico.Check /> Apply all</button>
        </div>
      </div>

      <AIPill placeholder="Ask about a specific change, or add more…" />
      <ZoomBadge />
      <StatusBadge>
        <Ico.Dot style={{ color: 'var(--bloom-1)' }} /> Reviewing · <span style={{ color: 'var(--ink-0)' }}>6 proposed edits</span>
      </StatusBadge>
    </>
  );
}

Object.assign(window, { ScreenProposing });
