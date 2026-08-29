// Screen 2 — AI generating live
// Progressive emergence: nodes appear one by one, connectors draw in, layout settles.
// Auto-plays; restarts when screen becomes active. Warm amber glow on the node currently being generated.

const EC_NODES = [
  { id: 'user',      x: 80,   y: 200, w: 150, title: 'Customer',    meta: 'ACTOR',    sub: 'Browses & buys',   dot: 'blue' },
  { id: 'catalog',   x: 280,  y: 160, w: 160, title: 'Product Catalog', meta: 'SERVICE', sub: 'Search · Filter',  dot: 'violet' },
  { id: 'cart',      x: 480,  y: 200, w: 150, title: 'Cart',         meta: 'SERVICE',  sub: 'Session · Items',  dot: 'violet' },
  { id: 'checkout',  x: 680,  y: 240, w: 160, title: 'Checkout',     meta: 'SERVICE',  sub: 'Shipping · Tax',   dot: 'violet' },
  { id: 'stripe',    x: 880,  y: 180, w: 150, title: 'Stripe',       meta: 'EXTERNAL', sub: 'Payments',         dot: 'amber' },
  { id: 'order',     x: 680,  y: 380, w: 160, title: 'Order Service',meta: 'SERVICE',  sub: 'Fulfillment',      dot: 'violet' },
  { id: 'wh',        x: 480,  y: 460, w: 160, title: 'Warehouse',    meta: 'SYSTEM',   sub: 'Pick · Pack',      dot: 'green' },
  { id: 'ship',      x: 260,  y: 460, w: 160, title: 'Shipping',     meta: 'EXTERNAL', sub: 'Carrier API',      dot: 'amber' },
];

const EC_EDGES = [
  { from: 'user',     to: 'catalog',   dir: 'h' },
  { from: 'catalog',  to: 'cart',      dir: 'h' },
  { from: 'cart',     to: 'checkout',  dir: 'h' },
  { from: 'checkout', to: 'stripe',    dir: 'h' },
  { from: 'checkout', to: 'order',     dir: 'v' },
  { from: 'order',    to: 'wh',        dir: 'h' },
  { from: 'wh',       to: 'ship',      dir: 'h' },
];

// Anchor: right-center for outgoing, left-center for incoming (approx from node box)
function anchor(node, side) {
  const w = node.w || 150;
  const h = 62; // approx height
  if (side === 'r') return { x: node.x + w, y: node.y + h/2 };
  if (side === 'l') return { x: node.x, y: node.y + h/2 };
  if (side === 't') return { x: node.x + w/2, y: node.y };
  if (side === 'b') return { x: node.x + w/2, y: node.y + h };
  return { x: node.x + w/2, y: node.y + h/2 };
}

function ScreenGenerating({ active }) {
  const [step, setStep] = useState(0);
  const timerRef = useRef(null);

  useEffect(() => {
    if (!active) return;
    setStep(0);
    // Sequence: each step adds a node/edge
    const seq = [];
    // nodes appear one by one
    for (let i = 0; i < EC_NODES.length; i++) seq.push(400 + i * 550);
    // then keep looping
    const totalSteps = EC_NODES.length + 1; // +1 for "finished" state
    seq.forEach((delay, i) => {
      seq[i] = setTimeout(() => setStep(i + 1), delay);
    });
    const loop = setTimeout(() => setStep(0), 400 + EC_NODES.length * 550 + 3200);
    return () => {
      seq.forEach(t => clearTimeout(t));
      clearTimeout(loop);
    };
  }, [active]);

  const nodesById = useMemo(() => Object.fromEntries(EC_NODES.map(n => [n.id, n])), []);

  const status = step === 0
    ? { text: 'Understanding your description…' }
    : step < EC_NODES.length
      ? { text: `Constructing · ${step} of ${EC_NODES.length} elements` }
      : { text: 'Layout settling · Draw complete' };

  const history = [
    {
      role: 'user',
      time: 'just now',
      content: "I'm building an e-commerce platform. Customers browse products, add to cart, checkout, and pay with Stripe. Orders go to the warehouse and then shipping.",
    },
    step > 2 && {
      role: 'ai',
      time: 'just now',
      content: 'Reading your description. 8 entities · 7 relationships. Building as a horizontal flow with fulfillment branching below.',
    },
  ].filter(Boolean);

  return (
    <div data-screen-label="02 AI generating" style={{ position: 'absolute', inset: 0 }}>
      <CanvasBackdrop />
      <TopBar
        crumbs={[
          { label: 'Personal', current: false },
          { label: 'E-commerce platform', current: true },
        ]}
      />
      <LeftRail active="canvas" side="right" />

      {/* Ambient amber wash while generating */}
      {step > 0 && step <= EC_NODES.length && (
        <div style={{
          position: 'absolute', inset: 0,
          background: 'radial-gradient(ellipse at center, oklch(0.82 0.15 75 / 0.03) 0%, transparent 55%)',
          pointerEvents: 'none',
          transition: 'opacity 0.4s',
        }} />
      )}

      {/* Diagram canvas */}
      <div style={{ position: 'absolute', inset: 0 }}>
        <svg className="connectors" style={{ width: '100%', height: '100%' }}>
          <ConnectorDefs />
          {EC_EDGES.map((e, i) => {
            // Show edge only after both nodes exist
            const fromIdx = EC_NODES.findIndex(n => n.id === e.from);
            const toIdx = EC_NODES.findIndex(n => n.id === e.to);
            const visibleAt = Math.max(fromIdx, toIdx) + 1;
            if (step < visibleAt + 1) return null;
            const isFresh = step === visibleAt + 1 || step - 1 === toIdx;
            const from = nodesById[e.from], to = nodesById[e.to];
            const a = anchor(from, e.dir === 'v' ? 'b' : 'r');
            const b = anchor(to,   e.dir === 'v' ? 't' : 'l');
            return (
              <path
                key={i}
                d={makePath(a, b, e.dir)}
                className={`drawing ${isFresh ? 'emerging' : ''}`}
                style={{ '--dash': 400 }}
                markerEnd={isFresh ? 'url(#arr-amber)' : 'url(#arr)'}
              />
            );
          })}
        </svg>

        {/* Frame around the whole architecture */}
        {step > 1 && (
          <div className="frame emerge" style={{
            left: 50, top: 120, width: 1010, height: 400,
            animationDelay: '0ms',
          }}>
            <div className="frame-label">E-commerce · Architecture</div>
          </div>
        )}

        {EC_NODES.map((n, i) => {
          if (step <= i) return null;
          const isEmerging = step === i + 1;
          return (
            <Node
              key={n.id}
              {...n}
              state={isEmerging ? 'emerging' : ''}
              delay={0}
            />
          );
        })}

        {/* Placeholder ghost nodes to show what's coming */}
        {step > 0 && step < EC_NODES.length && step < 3 && EC_NODES.slice(step, step + 2).map((n, i) => (
          <div
            key={`ghost-${n.id}`}
            className="node ghost"
            style={{
              left: n.x, top: n.y, width: n.w || 150,
              opacity: 0.25,
              pointerEvents: 'none',
            }}
          >
            <div className="node-meta"><span className="node-dot" /> …</div>
            <div className="node-title">…</div>
          </div>
        ))}
      </div>

      <ShapeToolbar activeTool="select" orientation="left" />
      <AIPill
        status={status}
        placeholder="Refine, add, or transform — just describe it"
        expanded={true}
        history={history}
      />
      <ZoomBadge zoom={85} />
      <StatusBadge>
        <span style={{ width: 6, height: 6, borderRadius: 999, background: 'var(--amber-1)', boxShadow: '0 0 8px var(--amber-glow)' }} />
        AI · Creating
      </StatusBadge>
    </div>
  );
}

Object.assign(window, { ScreenGenerating });
