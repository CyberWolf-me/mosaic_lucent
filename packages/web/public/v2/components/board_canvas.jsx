// BoardCanvas — the ONE canvas shared by the Board screen and the Meeting-on-Board screen.
// Layout is identical in both places; meeting mode adds overlays around it.

// Canonical board layout (kept in one place so both screens are the same)
const BOARD_LAYOUT = {
  viewBox: { w: 1240, h: 620 },
  containers: [
    { x: 20,   y: 40,  w: 155, h: 280, label: 'Clients',                kind: 'default' },
    { x: 330,  y: 40,  w: 190, h: 200, label: 'Edge · CDN + Gateway',   kind: 'edge' },
    { x: 700,  y: 40,  w: 220, h: 520, label: 'Application services',   kind: 'default' },
    { x: 1010, y: 90,  w: 190, h: 230, label: 'Data plane · Production',kind: 'production' },
    { x: 1010, y: 370, w: 190, h: 70,  label: 'External',               kind: 'staging' },
  ],
  nodes: [
    { id: 'web',    x: 40,   y: 80,  icon: 'react',    meta: 'CLIENT',   title: 'Web App',       sub: 'React · Vite' },
    { id: 'mobile', x: 40,   y: 200, icon: 'react',    meta: 'CLIENT',   title: 'Mobile App',    sub: 'React Native' },
    { id: 'cdn',    x: 350,  y: 80,  icon: 'nginx',    meta: 'EDGE',     title: 'CDN',           sub: 'Cloudflare' },
    { id: 'gw',     x: 350,  y: 200, icon: 'gateway',  meta: 'EDGE · SVC', title: 'API Gateway', sub: 'rate limit · JWT' },
    { id: 'order',  x: 720,  y: 80,  icon: 'node',     meta: 'SERVICE',  title: 'Order Service', sub: 'checkout · fulfillment' },
    { id: 'auth',   x: 720,  y: 220, icon: 'auth',     meta: 'SERVICE',  title: 'Auth Service',  sub: 'OAuth · sessions' },
    { id: 'pay',    x: 720,  y: 360, icon: 'stripe',   meta: 'SERVICE',  title: 'Payment Svc',   sub: 'Stripe intents', bloom: true },
    { id: 'notif',  x: 720,  y: 500, icon: 'queue',    meta: 'SERVICE',  title: 'Notification',  sub: 'SQS · fanout', ghost: true },
    { id: 'odb',    x: 1030, y: 110, icon: 'postgres', meta: 'DATA',     title: 'Orders DB',     sub: 'RDS · Postgres 16' },
    { id: 'udb',    x: 1030, y: 250, icon: 'postgres', meta: 'DATA',     title: 'Users DB',      sub: 'RDS · Postgres 16' },
    { id: 'ext',    x: 1030, y: 385, icon: 'stripe',   meta: 'EXTERNAL', title: 'Stripe',        sub: 'payments API', bloom: true },
  ],
  edges: [
    { from: [175, 100], to: [340, 120], style: 'normal', label: 'HTTPS' },
    { from: [175, 220], to: [340, 150], style: 'normal' },
    { from: [500, 130], to: [720, 100], style: 'normal', label: '/orders' },
    { from: [500, 145], to: [720, 240], style: 'normal', label: '/auth' },
    { from: [500, 160], to: [720, 380], style: 'normal', label: '/pay' },
    { from: [900, 130], to: [1030, 130], style: 'normal', label: 'SQL' },
    { from: [900, 270], to: [1030, 270], style: 'normal', label: 'SQL' },
    { from: [900, 400], to: [1080, 400], style: 'bloom', label: 'webhook' },
  ],
};

function BoardCanvas({
  selected = 'gw',
  onSelect,
  meetingMode = false,        // when true: dim slightly, show presenter spotlight
  presenterHighlight,         // { nodeId, name, color } — draws a dashed halo around a node
  liveCursors = [],           // [{ x, y, name, color }]
}) {
  const L = BOARD_LAYOUT;
  return (
    <div style={{ position: 'relative', width: L.viewBox.w, height: L.viewBox.h }}>
      {/* Containers */}
      {L.containers.map((c, i) => (
        <Container key={i} x={c.x} y={c.y} w={c.w} h={c.h} label={c.label} kind={c.kind} />
      ))}

      {/* Edges */}
      <svg className="connectors" viewBox={`0 0 ${L.viewBox.w} ${L.viewBox.h}`} preserveAspectRatio="none"
        style={{ width: '100%', height: '100%', position: 'absolute', inset: 0 }}>
        <ConnectorDefs />
        {L.edges.map((e, i) => {
          const isBloom = e.style === 'bloom';
          return (
            <g key={i}>
              <path
                d={handPath({x: e.from[0], y: e.from[1]}, {x: e.to[0], y: e.to[1]}, 'h', 6, i + 1)}
                markerEnd={isBloom ? 'url(#arr-bloom)' : 'url(#arr)'}
                className={isBloom ? 'emerging' : ''}
                strokeWidth={isBloom ? 1.75 : 1.6}
              />
              {e.label && (
                <text
                  x={(e.from[0] + e.to[0]) / 2}
                  y={((e.from[1] + e.to[1]) / 2) - 8}
                  textAnchor="middle"
                  className="mono"
                  style={{ fontSize: 10, fill: isBloom ? 'var(--bloom-2)' : 'var(--ink-3)' }}
                >{e.label}</text>
              )}
            </g>
          );
        })}
      </svg>

      {/* Nodes */}
      {L.nodes.map(n => (
        <IconNode
          key={n.id}
          x={n.x} y={n.y}
          icon={Svc[n.icon]({})}
          meta={n.meta} title={n.title} sub={n.sub}
          bloom={n.bloom}
          ghost={n.ghost}
          selected={selected === n.id}
          onClick={() => onSelect && onSelect(n.id)}
        />
      ))}

      {/* Presenter highlight — dashed halo around a node during meetings */}
      {meetingMode && presenterHighlight && (() => {
        const node = L.nodes.find(n => n.id === presenterHighlight.nodeId);
        if (!node) return null;
        return (
          <div style={{
            position: 'absolute',
            left: node.x - 10, top: node.y - 10,
            width: 170, height: 86,
            border: `2px dashed ${presenterHighlight.color}`,
            borderRadius: 16,
            pointerEvents: 'none',
            animation: 'pulse-bloom 1.6s ease-in-out infinite',
          }} />
        );
      })()}

      {/* Live cursors */}
      {liveCursors.map((c, i) => (
        <CursorChip key={i} x={c.x} y={c.y} name={c.name} color={c.color} />
      ))}
    </div>
  );
}

// Extracted IconNode from screen_main so the shared canvas can render it identically.
function IconNode({ x, y, icon, meta, title, sub, selected, ghost, bloom, onClick }) {
  return (
    <div
      onClick={onClick}
      style={{
        position: 'absolute', left: x, top: y,
        width: 150, minHeight: 66,
        padding: '10px 12px',
        borderRadius: 12,
        background: ghost ? 'transparent' : 'var(--paper-0)',
        border: `1.5px ${ghost ? 'dashed' : 'solid'} ${
          selected ? 'var(--bloom-2)' :
          bloom ? 'var(--bloom-2)' :
          ghost ? 'var(--ink-3)' :
          'oklch(from var(--paper-edge) l c h / 0.7)'
        }`,
        boxShadow: selected ? 'var(--shadow-bloom)' : bloom ? '0 0 0 1px var(--bloom-wash-2)' : 'var(--shadow-node)',
        cursor: onClick ? 'pointer' : 'default',
        transition: 'all 0.15s var(--e-out)',
        display: 'flex', flexDirection: 'column', gap: 2,
      }}
      onMouseEnter={e => !selected && (e.currentTarget.style.transform = 'translateY(-1px)')}
      onMouseLeave={e => (e.currentTarget.style.transform = 'translateY(0)')}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
        {icon}
        <span className="mono-caps" style={{ fontSize: 9, letterSpacing: '0.08em', color: bloom ? 'var(--bloom-2)' : 'var(--ink-3)' }}>{meta}</span>
      </div>
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink-0)', letterSpacing: '-0.005em' }}>{title}</div>
      {sub && <div className="mono" style={{ fontSize: 10.5, color: 'var(--ink-2)', letterSpacing: '0.01em' }}>{sub}</div>}
    </div>
  );
}

// Reusable board wrapper — handles overflow / scroll so the canvas never leaks
function BoardScrollFrame({ children, style }) {
  return (
    <div style={{ position: 'absolute', inset: 0, overflow: 'auto', ...style }}>
      <div style={{
        position: 'relative',
        width: BOARD_LAYOUT.viewBox.w,
        height: BOARD_LAYOUT.viewBox.h,
        padding: 0,
      }}>
        {children}
      </div>
    </div>
  );
}

Object.assign(window, { BoardCanvas, BoardScrollFrame, BOARD_LAYOUT, IconNode });
