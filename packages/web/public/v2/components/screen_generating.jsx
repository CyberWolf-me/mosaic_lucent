// Screen 02 — AI generating · Eraser-style DSL emerging into diagram

function ScreenGenerating() {
  const [step, setStep] = useState(0);
  const [typed, setTyped] = useState('');

  const dsl = `architecture "e-commerce" {
  clients [
    Web(react),
    Mobile(react-native)
  ]

  edge {
    Gateway(rate-limit, jwt)
  }

  services {
    Order(checkout, fulfillment),
    Auth(oauth, sessions),
    Payment(stripe, retries)
  }

  data {
    Orders(postgres) <- Order,
    Users(postgres)  <- Auth
  }
}`;

  useEffect(() => {
    let i = 0;
    const type = () => {
      if (i <= dsl.length) {
        setTyped(dsl.slice(0, i));
        // Step transitions timed with typing progress
        if (i === 40) setStep(1);
        if (i === 100) setStep(2);
        if (i === 170) setStep(3);
        if (i === 240) setStep(4);
        if (i === dsl.length) setStep(5);
        i++;
        setTimeout(type, 32 + Math.random() * 20);
      } else {
        setTimeout(() => { i = 0; setStep(0); setTyped(''); setTimeout(type, 600); }, 5000);
      }
    };
    type();
  }, []);

  return (
    <>
      <PaperBackdrop />
      <TopBar crumbs={[{ label: 'E-commerce platform', current: true }]} />
      <GlobalRail active="board" />

      <div style={{
        position: 'absolute',
        top: 72, bottom: 96, left: 90, right: 20,
        display: 'flex', gap: 16,
      }}>
        {/* Left: DSL being typed (Eraser signature) */}
        <div style={{
          width: 360,
          background: 'oklch(0.16 0.014 55)',
          borderRadius: 16,
          padding: '18px 22px',
          fontFamily: 'var(--font-mono)',
          fontSize: 12.5,
          color: 'oklch(0.90 0.008 82)',
          lineHeight: 1.65,
          overflow: 'auto',
          boxShadow: 'var(--shadow-2)',
          position: 'relative',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14, color: 'oklch(0.6 0.012 60)' }}>
            <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 999, background: 'var(--madder)' }} />
            <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 999, background: 'var(--saffron)' }} />
            <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 999, background: 'var(--moss)' }} />
            <span style={{ marginLeft: 6, fontSize: 10.5, letterSpacing: '0.06em', textTransform: 'uppercase' }}>architecture.lucent</span>
            <div style={{ flex: 1 }} />
            <span className="pulse" style={{
              width: 6, height: 6, borderRadius: 999,
              background: 'var(--bloom-1)', display: 'inline-block',
              boxShadow: '0 0 8px var(--bloom-glow)',
              animation: 'pulse-bloom 1.4s ease-in-out infinite',
            }} />
            <span style={{ fontSize: 10, color: 'var(--bloom-1)' }}>drafting</span>
          </div>
          <DslLive text={typed} full={dsl} />
        </div>

        {/* Right: emerging diagram */}
        <div style={{ flex: 1, position: 'relative', minWidth: 0 }}>
          <div style={{
            position: 'absolute', inset: 0,
            background: 'var(--paper-0)',
            border: '1px solid oklch(from var(--paper-4) l c h / 0.5)',
            borderRadius: 16,
            boxShadow: 'var(--shadow-1)',
            overflow: 'hidden',
          }}>
            <div className="paper-grid" />
            <div className="mono-caps" style={{ position: 'absolute', top: 14, left: 20 }}>Live · from DSL</div>

            <div style={{ position: 'absolute', inset: '48px 20px 20px' }}>
              <svg className="connectors" viewBox="0 0 800 480" preserveAspectRatio="none" style={{ width: '100%', height: '100%' }}>
                <ConnectorDefs />
                {step >= 3 && <>
                  <path key={`c1-${step}`} d={handPath({x: 130, y: 90},  {x: 300, y: 110}, 'h', 6, 1)} className="emerging drawing" style={{ '--dash': 220 }} markerEnd="url(#arr-bloom)"/>
                  <path key={`c2-${step}`} d={handPath({x: 130, y: 190}, {x: 300, y: 140}, 'h', 6, 2)} className="emerging drawing" style={{ '--dash': 220, animationDelay: '100ms' }} markerEnd="url(#arr-bloom)"/>
                </>}
                {step >= 4 && <>
                  <path key={`c3-${step}`} d={handPath({x: 430, y: 100}, {x: 570, y: 90},  'h', 6, 3)} className="emerging drawing" style={{ '--dash': 200, animationDelay: '200ms' }} markerEnd="url(#arr-bloom)"/>
                  <path key={`c4-${step}`} d={handPath({x: 430, y: 130}, {x: 570, y: 200}, 'h', 6, 4)} className="emerging drawing" style={{ '--dash': 200, animationDelay: '300ms' }} markerEnd="url(#arr-bloom)"/>
                  <path key={`c5-${step}`} d={handPath({x: 430, y: 160}, {x: 570, y: 320}, 'h', 6, 5)} className="emerging drawing" style={{ '--dash': 200, animationDelay: '400ms' }} markerEnd="url(#arr-bloom)"/>
                </>}
                {step >= 5 && <>
                  <path key={`c6-${step}`} d={handPath({x: 700, y: 90},  {x: 700, y: 400}, 'v', 6, 6)} className="emerging drawing" style={{ '--dash': 320, animationDelay: '500ms' }} markerEnd="url(#arr-bloom)"/>
                  <path key={`c7-${step}`} d={handPath({x: 700, y: 200}, {x: 700, y: 410}, 'v', 6, 7)} className="emerging drawing" style={{ '--dash': 220, animationDelay: '600ms' }} markerEnd="url(#arr-bloom)"/>
                </>}
              </svg>

              {step >= 1 && <IconNodeAnim key={`n1-${step}`} x={20}  y={70}  icon={Svc.react({})}    meta="CLIENT"  title="Web App"       sub="react" />}
              {step >= 2 && <IconNodeAnim key={`n2-${step}`} x={20}  y={170} icon={Svc.react({})}    meta="CLIENT"  title="Mobile App"    sub="react-native" delay={200} />}
              {step >= 3 && <IconNodeAnim key={`n3-${step}`} x={300} y={90}  icon={Svc.gateway({})}  meta="EDGE"    title="Gateway"       sub="rate-limit · jwt" />}
              {step >= 4 && <IconNodeAnim key={`n4-${step}`} x={570} y={70}  icon={Svc.node({})}     meta="SERVICE" title="Order"         sub="checkout · fulfillment" delay={100} />}
              {step >= 4 && <IconNodeAnim key={`n5-${step}`} x={570} y={180} icon={Svc.auth({})}     meta="SERVICE" title="Auth"          sub="oauth · sessions" delay={200} />}
              {step >= 4 && <IconNodeAnim key={`n6-${step}`} x={570} y={300} icon={Svc.stripe({})}   meta="SERVICE" title="Payment"       sub="stripe · retries" delay={300} bloom />}
              {step >= 5 && <IconNodeAnim key={`n7-${step}`} x={630} y={400} icon={Svc.postgres({})} meta="DATA"    title="Orders DB"     sub="postgres" delay={100} />}
            </div>
          </div>
        </div>
      </div>

      <AIPill status="Drafting from voice…" placeholder="Refine or add more…" />
      <ZoomBadge />
      <StatusBadge>
        <span className="pulse" style={{
          width: 6, height: 6, borderRadius: 999,
          background: 'var(--bloom-1)', boxShadow: '0 0 8px var(--bloom-glow)',
          animation: 'pulse-bloom 1.4s ease-in-out infinite',
          display: 'inline-block',
        }} />
        Drafting · <span style={{ color: 'var(--ink-0)' }}>step {step}/5</span>
      </StatusBadge>
    </>
  );
}

function IconNodeAnim({ x, y, icon, meta, title, sub, bloom, delay = 0 }) {
  return (
    <div
      className="emerge"
      style={{
        position: 'absolute', left: x, top: y,
        width: 150, padding: '9px 12px',
        borderRadius: 12,
        background: 'var(--paper-0)',
        border: `1.5px solid ${bloom ? 'var(--bloom-2)' : 'oklch(from var(--paper-edge) l c h / 0.7)'}`,
        boxShadow: bloom ? 'var(--shadow-bloom)' : 'var(--shadow-node)',
        animationDelay: `${delay}ms`,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
        {icon}
        <span className="mono-caps" style={{ fontSize: 9, color: bloom ? 'var(--bloom-2)' : 'var(--ink-3)' }}>{meta}</span>
      </div>
      <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--ink-0)' }}>{title}</div>
      {sub && <div className="mono" style={{ fontSize: 10, color: 'var(--ink-2)' }}>{sub}</div>}
    </div>
  );
}

const DSL_KEYWORDS = new Set(['architecture', 'clients', 'edge', 'services', 'data']);
const DSL_VALUES = new Set(['react', 'react-native', 'postgres', 'stripe', 'jwt', 'oauth', 'sessions', 'rate-limit', 'retries', 'checkout', 'fulfillment']);

function tokenizeDsl(line) {
  // Split into tokens preserving whitespace and punctuation
  const parts = line.split(/(\s+|[{}(),])/);
  const out = [];
  let inString = false;
  let stringBuf = '';
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!p) continue;
    // Handle strings across tokens
    if (inString) {
      stringBuf += p;
      if (p.includes('"')) {
        out.push({ kind: 'string', text: stringBuf });
        stringBuf = '';
        inString = false;
      }
      continue;
    }
    if (p.startsWith('"')) {
      if (p.endsWith('"') && p.length > 1) {
        out.push({ kind: 'string', text: p });
      } else {
        stringBuf = p;
        inString = true;
      }
      continue;
    }
    if (p === '<-' || p === '->' || p === '<' || p === '>') {
      out.push({ kind: 'arrow', text: p });
      continue;
    }
    if (DSL_KEYWORDS.has(p)) { out.push({ kind: 'kw', text: p }); continue; }
    if (DSL_VALUES.has(p))   { out.push({ kind: 'val', text: p }); continue; }
    out.push({ kind: 'plain', text: p });
  }
  if (stringBuf) out.push({ kind: 'string', text: stringBuf });
  return out;
}

function DslLive({ text, full }) {
  const cursor = text.length < (full || '').length;
  const colors = {
    kw: 'oklch(0.72 0.15 300)',
    arrow: 'oklch(0.72 0.18 250)',
    string: 'oklch(0.78 0.14 78)',
    val: 'oklch(0.68 0.20 258)',
    plain: 'oklch(0.90 0.008 82)',
  };
  return (
    <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontFamily: 'inherit' }}>
      {text.split('\n').map((line, i) => (
        <div key={i} style={{ display: 'flex', gap: 14 }}>
          <span style={{ color: 'oklch(0.45 0.012 60)', width: 20, textAlign: 'right', flexShrink: 0, userSelect: 'none' }}>{i + 1}</span>
          <span>
            {tokenizeDsl(line).map((tok, j) => (
              <span key={j} style={{
                color: colors[tok.kind],
                fontWeight: tok.kind === 'kw' ? 600 : 400,
              }}>{tok.text}</span>
            ))}
            {line === '' && ' '}
          </span>
        </div>
      ))}
      {cursor && (
        <span style={{
          display: 'inline-block',
          width: 7, height: 14, background: 'var(--bloom-1)',
          verticalAlign: -2, marginLeft: 34,
          animation: 'pulse-bloom 1s ease-in-out infinite',
          boxShadow: '0 0 6px var(--bloom-glow)',
        }} />
      )}
    </pre>
  );
}

Object.assign(window, { ScreenGenerating });
