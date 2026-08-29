// Screen 10 — Sequence diagram
// Vertical actor lanes with animated messages passing between them.

function ScreenSequence() {
  const actors = [
    { id: 'user',    label: 'Customer',   x: 160, dot: 'blue' },
    { id: 'web',     label: 'Web App',    x: 340, dot: 'violet' },
    { id: 'api',     label: 'API',        x: 520, dot: 'violet' },
    { id: 'stripe',  label: 'Stripe',     x: 700, dot: 'amber' },
    { id: 'db',      label: 'Postgres',   x: 880, dot: 'green' },
  ];

  const messages = [
    { from: 'user',   to: 'web',    y: 160, label: 'Click "Place order"',  kind: 'sync' },
    { from: 'web',    to: 'api',    y: 210, label: 'POST /checkout',       kind: 'sync' },
    { from: 'api',    to: 'stripe', y: 260, label: 'Create charge',        kind: 'sync' },
    { from: 'stripe', to: 'api',    y: 310, label: '200 · charge.succeeded',kind: 'return' },
    { from: 'api',    to: 'db',     y: 360, label: 'INSERT order',         kind: 'sync' },
    { from: 'db',     to: 'api',    y: 410, label: 'order_id',             kind: 'return' },
    { from: 'api',    to: 'web',    y: 460, label: '201 · Created',        kind: 'return' },
    { from: 'web',    to: 'user',   y: 510, label: 'Show confirmation',    kind: 'sync' },
  ];

  const byId = Object.fromEntries(actors.map(a => [a.id, a]));

  return (
    <div data-screen-label="10 Sequence" style={{ position: 'absolute', inset: 0 }}>
      <CanvasBackdrop />
      <TopBar
        crumbs={[
          { label: 'Personal', current: false },
          { label: 'E-commerce platform', current: false },
          { label: 'Checkout sequence', current: true },
        ]}
      />
      <LeftRail active="canvas" />

      <div style={{ position: 'absolute', inset: 0 }}>
        {/* Frame */}
        <div className="frame" style={{ left: 80, top: 90, width: 900, height: 520 }}>
          <div className="frame-label" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Ico.Flow />
            Checkout · Sequence
          </div>
        </div>

        {/* Actor headers */}
        {actors.map(a => (
          <div key={a.id} style={{
            position: 'absolute',
            left: a.x - 60, top: 110,
            width: 120,
          }}>
            <div className="node" style={{
              width: '100%',
              textAlign: 'center',
              padding: '10px 14px',
            }}>
              <div className="node-meta" style={{ justifyContent: 'center' }}>
                <span className={`node-dot ${a.dot}`} />
                ACTOR
              </div>
              <div className="node-title">{a.label}</div>
            </div>
          </div>
        ))}

        {/* Lifelines */}
        <svg style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
          <ConnectorDefs />
          {actors.map(a => (
            <line
              key={a.id}
              x1={a.x} y1={168}
              x2={a.x} y2={580}
              stroke="var(--stroke-1)"
              strokeWidth="1"
              strokeDasharray="3 4"
            />
          ))}
          {/* Messages */}
          {messages.map((m, i) => {
            const from = byId[m.from], to = byId[m.to];
            const isReturn = m.kind === 'return';
            const isRight = to.x > from.x;
            return (
              <g key={i}>
                <line
                  x1={from.x} y1={m.y}
                  x2={to.x}   y2={m.y}
                  stroke={isReturn ? 'var(--ink-3)' : 'var(--stroke-3)'}
                  strokeWidth={isReturn ? 1 : 1.4}
                  strokeDasharray={isReturn ? '4 3' : ''}
                  markerEnd="url(#arr)"
                />
              </g>
            );
          })}
        </svg>

        {/* Message labels */}
        {messages.map((m, i) => {
          const from = byId[m.from], to = byId[m.to];
          const isReturn = m.kind === 'return';
          const cx = (from.x + to.x) / 2;
          return (
            <div key={i} style={{
              position: 'absolute',
              left: cx, top: m.y - 22,
              transform: 'translateX(-50%)',
              padding: '3px 10px',
              background: 'var(--canvas-1)',
              border: `1px solid ${isReturn ? 'var(--stroke-1)' : 'var(--stroke-2)'}`,
              borderRadius: 5,
              fontFamily: 'var(--font-mono)',
              fontSize: 10.5,
              color: isReturn ? 'var(--ink-2)' : 'var(--ink-1)',
              whiteSpace: 'nowrap',
              letterSpacing: '0.01em',
            }}>
              {m.label}
            </div>
          );
        })}

        {/* Activation bars (small vertical rectangles on lifelines during a call) */}
        {[
          { actor: 'web', from: 160, to: 510 },
          { actor: 'api', from: 210, to: 460 },
          { actor: 'stripe', from: 260, to: 310 },
          { actor: 'db', from: 360, to: 410 },
        ].map((bar, i) => (
          <div key={i} style={{
            position: 'absolute',
            left: byId[bar.actor].x - 3, top: bar.from,
            width: 6, height: bar.to - bar.from,
            background: 'var(--canvas-3)',
            border: '1px solid var(--stroke-2)',
            borderRadius: 2,
          }} />
        ))}

        {/* Time markers on left */}
        <div style={{
          position: 'absolute', left: 100, top: 160, bottom: 100,
          display: 'flex', flexDirection: 'column',
          fontFamily: 'var(--font-mono)', fontSize: 9.5,
          color: 'var(--ink-3)', letterSpacing: '0.03em',
        }}>
          {messages.map((m, i) => (
            <div key={i} style={{
              position: 'absolute', top: m.y - 160 - 6, right: 20,
              transform: 'translateY(-3px)',
            }}>
              {`t${i}`}
            </div>
          ))}
        </div>
      </div>

      <AIPill
        placeholder="Add a step, show alternate path, or transform to something else…"
        history={[
          { role: 'user', time: '3 min ago', content: "Show me the checkout sequence." },
          { role: 'ai',   time: '3 min ago', content: 'Created a sequence with 8 messages across Customer, Web, API, Stripe, and Postgres. Ready to add error paths.' },
        ]}
      />
      <ZoomBadge zoom={90} />
      <StatusBadge>
        <Ico.Flow style={{ color: 'var(--ink-3)' }} />
        <span>Sequence · 8 messages · 5 actors</span>
      </StatusBadge>
    </div>
  );
}

Object.assign(window, { ScreenSequence });
