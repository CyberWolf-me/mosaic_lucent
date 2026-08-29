// Screen 3 — Main canvas populated
// The finished e-commerce architecture, all nodes present, calm state.
// One node selected to demonstrate selection style. Auth cluster added to show iteration.

function ScreenMain() {
  const [selected, setSelected] = useState('checkout');
  const [shapes, setShapes] = useState([]);
  const [tool, setTool] = useState('select');

  const addShape = ({ kind, x, y }) => {
    const stickyColors = ['', 'blue', 'pink', 'green'];
    const color = kind === 'sticky'
      ? stickyColors[Math.floor(Math.random() * stickyColors.length)]
      : undefined;
    const rotation = kind === 'sticky' ? (Math.random() * 4 - 2) : 0;
    setShapes(s => [...s, {
      id: `shape-${Date.now()}`, kind, x, y, color, rotation,
      label: kind === 'sticky' ? sampleStickyText() : undefined,
    }]);
  };

  // All nodes plus auth cluster (added later by AI)
  const nodes = [
    ...EC_NODES,
    { id: 'auth',    x: 80,   y: 400, w: 150, title: 'Auth',       meta: 'SERVICE',  sub: 'Google OAuth', dot: 'green' },
    { id: 'db',      x: 880,  y: 380, w: 150, title: 'Postgres',   meta: 'DATABASE', sub: 'Orders · Users', dot: 'blue' },
  ];
  const edges = [
    ...EC_EDGES,
    { from: 'auth',  to: 'user',  dir: 'v' },
    { from: 'order', to: 'db',    dir: 'h' },
  ];
  const byId = Object.fromEntries(nodes.map(n => [n.id, n]));

  const history = [
    { role: 'user', time: '2 min ago', content: "Add authentication with Google OAuth." },
    { role: 'ai',   time: '2 min ago', content: 'Added Auth service, wired to Customer via OAuth. Also connected Order to Postgres for persistence.' },
    { role: 'user', time: 'just now', content: "Perfect. What if payment fails?" },
  ];

  return (
    <div data-screen-label="03 Main canvas" style={{ position: 'absolute', inset: 0 }}>
      {/* Zoomable, pannable viewport (pinch/wheel + hand tool) */}
      <CanvasViewport initialZoom={85} tool={tool}>
        <svg className="connectors" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', overflow: 'visible' }}>
          <ConnectorDefs />
          {edges.map((e, i) => {
            const from = byId[e.from], to = byId[e.to];
            const a = anchor(from, e.dir === 'v' ? 'b' : 'r');
            const b = anchor(to,   e.dir === 'v' ? 't' : 'l');
            return <path key={i} d={makePath(a, b, e.dir)} markerEnd="url(#arr)" />;
          })}
        </svg>

        <div className="frame" style={{ left: 50, top: 120, width: 1010, height: 400 }}>
          <div className="frame-label">E-commerce · Architecture</div>
        </div>

        {nodes.map(n => (
          <Node
            key={n.id}
            {...n}
            state={selected === n.id ? 'selected' : ''}
            onClick={() => setSelected(n.id)}
          />
        ))}

        {/* User-added shapes (via ShapeToolbar) */}
        {shapes.map(sh => <ShapeElement key={sh.id} {...sh} />)}

        {/* Selection HUD (contextual popover near selected node) */}
        {selected && (() => {
          const n = byId[selected];
          if (!n) return null;
          return (
            <div className="selection-hud" style={{
              left: n.x + (n.w || 150) / 2, top: n.y - 42,
            }}>
              {['Explain', 'Transform', 'Expand', 'Comment'].map((label, i) => (
                <button key={i}>{label}</button>
              ))}
              <div className="sep" />
              <button style={{ padding: '5px 8px' }}><Ico.Down /></button>
            </div>
          );
        })()}
      </CanvasViewport>

      <TopBar
        crumbs={[
          { label: 'Personal', current: false },
          { label: 'E-commerce platform', current: true },
        ]}
      />

      {/* Figjam-style layout: shape tools LEFT vertical, navigation RIGHT vertical */}
      <ShapeToolbar activeTool={tool} onSelectTool={setTool} onAddShape={addShape} orientation="left" />
      <LeftRail active="canvas" side="right" />

      <AIPill
        placeholder="Refine, add, or transform — just describe it"
        history={history}
      />
      <ZoomBadge zoom={85} />
      <StatusBadge>
        <span className="mono" style={{ color: 'var(--ink-3)' }}>
          {shapes.length > 0 ? `${shapes.length} shape${shapes.length > 1 ? 's' : ''} · ` : ''}
          Checkout
        </span>
        <span style={{ color: 'var(--ink-3)' }}>·</span>
        <span>1 selected</span>
      </StatusBadge>
    </div>
  );
}

function sampleStickyText() {
  const options = [
    'Try one-click checkout',
    'Ask: what happens if Stripe fails?',
    'Move payment above shipping',
    'Add SSO for enterprise',
    'Loading state — skeleton?',
    'Consider magic link',
    'Cache session in Redis',
  ];
  return options[Math.floor(Math.random() * options.length)];
}

Object.assign(window, { ScreenMain });
