// Screen 10 — Sequence diagram · Eraser-style with alt/opt/loop frames + DSL sidebar

function ScreenSequence() {
  const [tab, setTab] = useState('diagram');
  const lanes = [
    { name: 'User',          type: 'ACTOR',    x: 100, icon: Svc.client({}) },
    { name: 'Web App',       type: 'CLIENT',   x: 280, icon: Svc.react({}) },
    { name: 'API Gateway',   type: 'EDGE',     x: 460, icon: Svc.gateway({}) },
    { name: 'Order Service', type: 'SERVICE',  x: 640, icon: Svc.node({}) },
    { name: 'Payment Svc',   type: 'SERVICE',  x: 820, icon: Svc.stripe({}), bloom: true },
    { name: 'Stripe',        type: 'EXTERNAL', x: 1000, icon: Svc.stripe({}) },
  ];
  const msgs = [
    { from: 100, to: 280,  y: 130, label: 'clicks "Pay"', kind: 'user' },
    { from: 280, to: 460,  y: 170, label: 'POST /checkout', kind: 'req' },
    { from: 460, to: 640,  y: 210, label: 'validateOrder()', kind: 'req' },
    { from: 640, to: 460,  y: 250, label: 'order.pending', kind: 'res' },

    // Payment flow inside 'alt' block
    { from: 460, to: 820,  y: 330, label: 'createIntent()', kind: 'req bloom' },
    { from: 820, to: 1000, y: 370, label: 'Stripe.paymentIntents.create', kind: 'req bloom' },
    { from: 1000, to: 820, y: 410, label: 'intent { id, secret }', kind: 'res bloom' },
    { from: 820, to: 460,  y: 450, label: 'return secret', kind: 'res bloom' },

    // Failure branch
    { from: 460, to: 820,  y: 530, label: 'onFailure(err)', kind: 'req err' },
    { from: 820, to: 460,  y: 570, label: '502 · retry once', kind: 'res err' },

    // Confirmation
    { from: 460, to: 280,  y: 640, label: '200 OK · secret', kind: 'res' },
    { from: 280, to: 100,  y: 680, label: 'confirm payment sheet', kind: 'user' },
  ];

  const dsl = `sequence payment {
  User -> Web: clicks "Pay"
  Web -> Gateway: POST /checkout
  Gateway -> Order: validateOrder()
  Order --> Gateway: order.pending

  alt success {
    Gateway -> Payment: createIntent()
    Payment -> Stripe: paymentIntents.create
    Stripe --> Payment: intent {id, secret}
    Payment --> Gateway: return secret
  } else failure {
    Gateway -> Payment: onFailure(err)
    Payment --> Gateway: 502 · retry once
  }

  Gateway --> Web: 200 OK · secret
  Web --> User: confirm payment sheet
}`;

  return (
    <>
      <PaperBackdrop />
      <TopBar crumbs={[
        { label: 'Personal', screen: 6 },
        { label: 'E-commerce platform', screen: 3 },
        { label: 'Checkout sequence', current: true },
      ]} />
      <GlobalRail active="board" />

      {/* Tabs */}
      <div style={{
        position: 'absolute', top: 68, left: 92, zIndex: 15,
        display: 'flex', gap: 4,
        padding: 4,
        background: 'oklch(from var(--paper-0) l c h / 0.85)',
        border: '1px solid oklch(from var(--paper-4) l c h / 0.5)',
        borderRadius: 10,
        backdropFilter: 'blur(12px)',
      }}>
        {[
          { id: 'diagram', label: 'Diagram' },
          { id: 'code',    label: 'Code · DSL' },
          { id: 'split',   label: 'Split' },
        ].map(t => (
          <button key={t.id}
            onClick={() => setTab(t.id)}
            style={{
              padding: '6px 12px', borderRadius: 7,
              fontSize: 12, fontWeight: 500,
              background: tab === t.id ? 'var(--ink-0)' : 'transparent',
              color: tab === t.id ? 'var(--paper-0)' : 'var(--ink-1)',
            }}
          >{t.label}</button>
        ))}
      </div>

      <div style={{
        position: 'absolute', top: 120, bottom: 40, left: 92, right: 40,
        display: 'flex', gap: 16,
      }}>
        {(tab === 'diagram' || tab === 'split') && (
          <div style={{ flex: 1, overflow: 'auto' }}>
            <div style={{
              minWidth: 1160,
              padding: '20px 16px',
              background: 'var(--paper-0)',
              border: '1px solid oklch(from var(--paper-4) l c h / 0.5)',
              borderRadius: 16,
              position: 'relative',
              boxShadow: 'var(--shadow-1)',
            }}>
              <div className="mono-caps" style={{ marginBottom: 12 }}>Fig. 10 · Payment intent handshake · 12 messages</div>

              <div style={{ position: 'relative', height: 780 }}>
                {/* Lane headers */}
                {lanes.map(l => (
                  <div key={l.name} style={{
                    position: 'absolute',
                    left: l.x - 70, top: 0,
                    width: 140,
                    padding: '10px 12px',
                    borderRadius: 10,
                    background: l.bloom ? 'var(--bloom-wash)' : 'var(--paper-1)',
                    border: `1px solid ${l.bloom ? 'var(--bloom-wash-2)' : 'oklch(from var(--paper-4) l c h / 0.5)'}`,
                    boxShadow: 'var(--shadow-1)',
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                      {l.icon}
                      <span className="mono-caps" style={{ fontSize: 9, color: l.bloom ? 'var(--bloom-2)' : 'var(--ink-3)' }}>
                        {l.type}
                      </span>
                    </div>
                    <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink-0)' }}>{l.name}</div>
                  </div>
                ))}

                {/* Lifelines */}
                <svg viewBox="0 0 1160 700" style={{
                  position: 'absolute', top: 80, left: 0, width: '100%', height: 700,
                  pointerEvents: 'none',
                }}>
                  <defs>
                    <marker id="sq-arr2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L10 5 L0 10z" fill="var(--ink-2)"/></marker>
                    <marker id="sq-arr2-bloom" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L10 5 L0 10z" fill="var(--bloom-2)"/></marker>
                    <marker id="sq-arr2-user" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L10 5 L0 10z" fill="var(--ink-0)"/></marker>
                    <marker id="sq-arr2-err" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L10 5 L0 10z" fill="var(--madder)"/></marker>
                  </defs>
                  {lanes.map(l => (
                    <line key={l.name} x1={l.x} y1="0" x2={l.x} y2="700"
                      stroke="oklch(from var(--paper-4) l c h / 0.9)"
                      strokeDasharray="4 5" strokeWidth="1" />
                  ))}

                  {msgs.map((m, i) => {
                    const y = m.y - 80;
                    const stroke =
                      m.kind.includes('err')   ? 'var(--madder)' :
                      m.kind.includes('bloom') ? 'var(--bloom-2)' :
                      m.kind === 'user'        ? 'var(--ink-0)' : 'var(--ink-2)';
                    const markerEnd =
                      m.kind.includes('err')   ? 'url(#sq-arr2-err)' :
                      m.kind.includes('bloom') ? 'url(#sq-arr2-bloom)' :
                      m.kind === 'user'        ? 'url(#sq-arr2-user)' : 'url(#sq-arr2)';
                    const strokeWidth = m.kind.includes('bloom') || m.kind === 'user' ? 1.75 : 1.4;
                    const dash = m.kind.includes('res') ? '5 4' : 'none';
                    const midx = (m.from + m.to) / 2;
                    const isReply = m.to < m.from;
                    const path = `M ${m.from} ${y} Q ${midx} ${y + (isReply ? -6 : 6)} ${m.to} ${y}`;
                    return (
                      <g key={i}>
                        <path d={path} stroke={stroke} strokeWidth={strokeWidth}
                          fill="none" markerEnd={markerEnd}
                          strokeDasharray={dash} strokeLinecap="round" />
                        <text x={midx} y={y - 6} textAnchor="middle"
                          style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, fill: stroke, fontWeight: 500 }}
                        >{m.label}</text>
                      </g>
                    );
                  })}
                </svg>

                {/* Alt/opt frames — outside the message flow area, so labels don't cover arrows */}
                <SeqFrame kind="alt"  x={80} y={310} w={1000} h={190} label="success" />
                <SeqFrame kind="alt"  x={80} y={515} w={1000} h={85}  label="failure" />
                <SeqFrame kind="loop" x={80} y={70}  w={1000} h={230} label="each request lifecycle" />

                {/* Time axis */}
                <div style={{
                  position: 'absolute', left: 8, top: 80, bottom: 20,
                  width: 40,
                  display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
                  fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--ink-3)',
                  letterSpacing: '0.03em',
                }}>
                  <div>t=0</div>
                  <div>+45ms</div>
                  <div>+120ms</div>
                  <div>+180ms</div>
                  <div>+240ms</div>
                  <div>+300ms</div>
                </div>
              </div>
            </div>
          </div>
        )}

        {(tab === 'code' || tab === 'split') && (
          <div style={{
            width: tab === 'split' ? 420 : '100%',
            background: 'oklch(0.16 0.014 55)',
            border: '1px solid oklch(from var(--paper-4) l c h / 0.5)',
            borderRadius: 16,
            padding: '18px 22px',
            fontFamily: 'var(--font-mono)',
            fontSize: 13,
            color: 'oklch(0.90 0.008 82)',
            lineHeight: 1.6,
            overflow: 'auto',
            boxShadow: 'var(--shadow-2)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16, color: 'oklch(0.6 0.012 60)' }}>
              <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 999, background: 'var(--madder)' }} />
              <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 999, background: 'var(--saffron)' }} />
              <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 999, background: 'var(--moss)' }} />
              <span style={{ marginLeft: 6, fontSize: 11, letterSpacing: '0.06em', textTransform: 'uppercase' }}>sequence.lucent</span>
              <div style={{ flex: 1 }} />
              <span style={{ fontSize: 10, color: 'oklch(0.55 0.012 60)' }}>auto-synced</span>
            </div>
            <DslText text={dsl} />
          </div>
        )}
      </div>

      <AskAnythingBar placeholder="Ask about the sequence — or add a message…" />
    </>
  );
}

const SEQ_KW = new Set(['sequence', 'alt', 'else', 'opt', 'loop', 'par', 'end', 'note', 'as']);
function tokenizeSeq(line) {
  const parts = line.split(/(\s+|[{}(),])/);
  const out = [];
  let inString = false, buf = '';
  for (const p of parts) {
    if (!p) continue;
    if (inString) {
      buf += p;
      if (p.includes('"')) { out.push({ kind: 'string', text: buf }); buf = ''; inString = false; }
      continue;
    }
    if (p.startsWith('"')) {
      if (p.length > 1 && p.endsWith('"')) out.push({ kind: 'string', text: p });
      else { buf = p; inString = true; }
      continue;
    }
    if (p === '-->' || p === '->') { out.push({ kind: 'arrow', text: p }); continue; }
    if (SEQ_KW.has(p))               { out.push({ kind: 'kw', text: p }); continue; }
    out.push({ kind: 'plain', text: p });
  }
  if (buf) out.push({ kind: 'string', text: buf });
  return out;
}

function DslText({ text }) {
  const colors = {
    kw: 'oklch(0.72 0.15 300)',
    arrow: 'oklch(0.72 0.18 250)',
    string: 'oklch(0.78 0.14 78)',
    plain: 'oklch(0.90 0.008 82)',
  };
  return (
    <pre style={{
      margin: 0, whiteSpace: 'pre-wrap',
      fontFamily: 'inherit', fontSize: 'inherit',
    }}>
      {text.split('\n').map((line, i) => (
        <div key={i} style={{ display: 'flex', gap: 14 }}>
          <span style={{ color: 'oklch(0.45 0.012 60)', width: 20, textAlign: 'right', flexShrink: 0, userSelect: 'none' }}>{i + 1}</span>
          <span>
            {tokenizeSeq(line).map((tok, j) => (
              <span key={j} style={{
                color: colors[tok.kind],
                fontWeight: tok.kind === 'kw' ? 600 : 400,
              }}>{tok.text}</span>
            ))}
            {line === '' && ' '}
          </span>
        </div>
      ))}
    </pre>
  );
}

Object.assign(window, { ScreenSequence });
