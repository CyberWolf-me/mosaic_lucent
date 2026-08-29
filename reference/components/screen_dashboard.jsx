// Screen 6 — Project dashboard
// Uses the global theme (dark or light). Sidebar filters the project grid.

const ALL_PROJECTS = [
  { name: 'E-commerce platform', kind: 'Architecture', updated: '2 min ago', nodes: 10, mini: 'arch',    accent: true, to: 3 },
  { name: 'Onboarding v3',       kind: 'User journeys',updated: '1 hr ago',  nodes: 6,  mini: 'journey', to: 8 },
  { name: 'Payments spec',       kind: 'Sequence',     updated: 'Yesterday', nodes: 8,  mini: 'seq',     to: 10 },
  { name: 'Team retro Q3',       kind: 'Mind maps',    updated: '2 days',    nodes: 14, mini: 'mind',    to: 2 },
  { name: 'Dashboard rewrite',   kind: 'Wireframes',   updated: '3 days',    nodes: 4,  mini: 'wire',    to: 9 },
  { name: 'Data pipeline',       kind: 'Flows',        updated: '5 days',    nodes: 9,  mini: 'flow',    to: 4 },
  { name: 'Auth refactor',       kind: 'Architecture', updated: '1 week',    nodes: 7,  mini: 'arch',    to: 7 },
  { name: 'Roadmap 2026',        kind: 'Story map',    updated: '2 weeks',   nodes: 22, mini: 'story',   to: 8 },
  { name: 'Design tokens',       kind: 'Mind maps',    updated: '3 weeks',   nodes: 11, mini: 'mind',    to: 2 },
  { name: 'API refactor',        kind: 'Architecture', updated: '1 month',   nodes: 8,  mini: 'arch',    to: 3 },
];

const ARTIFACT_ITEMS = [
  { id: 'all',           label: 'Architecture',  count: 3, icon: 'Layers'  },
  { id: 'User journeys', label: 'User journeys', count: 1, icon: 'Journey' },
  { id: 'Flows',         label: 'Flows',         count: 1, icon: 'Flow'    },
  { id: 'Wireframes',    label: 'Wireframes',    count: 1, icon: 'Grid'    },
  { id: 'Mind maps',     label: 'Mind maps',     count: 2, icon: 'Mind'    },
  { id: 'Sequence',      label: 'Sequence',      count: 1, icon: 'Flow'    },
];

function ScreenDashboard() {
  const go = (n) => window.__lucentGo && window.__lucentGo(n);

  // filter: 'all' | 'recents' | 'shared' | 'templates' | <artifact-kind>
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');

  const filtered = useMemo(() => {
    let list = ALL_PROJECTS;
    if (filter === 'recents')   list = list.slice(0, 6);
    if (filter === 'shared')    list = list.filter(p => ['Onboarding v3','Auth refactor','Roadmap 2026','Data pipeline'].includes(p.name));
    if (filter === 'templates') list = [];
    if (filter !== 'all' && filter !== 'recents' && filter !== 'shared' && filter !== 'templates') {
      list = list.filter(p => p.kind === filter || p.kind === 'Architecture' && filter === 'Architecture');
      // Architecture matches Architecture literal
      list = ALL_PROJECTS.filter(p => p.kind === filter);
    }
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(p => p.name.toLowerCase().includes(q) || p.kind.toLowerCase().includes(q));
    }
    return list;
  }, [filter, search]);

  const sidebarTop = [
    { id: 'all',       label: 'All projects', count: ALL_PROJECTS.length, icon: <Ico.Grid /> },
    { id: 'recents',   label: 'Recents',      count: 6, icon: <Ico.History /> },
    { id: 'shared',    label: 'Shared',       count: 4, icon: <Ico.Share /> },
    { id: 'templates', label: 'Templates',    count: null, icon: <Ico.Book /> },
  ];
  const byArtifact = [
    { id: 'Architecture', label: 'Architecture',  count: 3, icon: <Ico.Layers /> },
    { id: 'User journeys',label: 'User journeys', count: 1, icon: <Ico.Journey /> },
    { id: 'Flows',        label: 'Flows',         count: 1, icon: <Ico.Flow /> },
    { id: 'Wireframes',   label: 'Wireframes',    count: 1, icon: <Ico.Grid /> },
    { id: 'Mind maps',    label: 'Mind maps',     count: 2, icon: <Ico.Mind /> },
    { id: 'Sequence',     label: 'Sequence',      count: 1, icon: <Ico.Flow /> },
  ];

  const filterTitle = {
    all: 'Recent workspaces',
    recents: 'Recently opened',
    shared: 'Shared with me',
    templates: 'Templates',
  }[filter] || filter;

  return (
    <div data-screen-label="06 Dashboard" style={{
      position: 'fixed', inset: 0,
      background: 'var(--canvas-1)',
      color: 'var(--ink-0)',
      overflow: 'hidden',
    }}>
      {/* Top bar */}
      <div className="top-bar" style={{
        borderBottom: '1px solid var(--stroke-1)',
        background: 'var(--canvas-1)',
      }}>
        <button
          className="brand"
          style={{ background: 'none', border: 0, cursor: 'pointer' }}
          onClick={() => go(6)}
        >
          <div className="logo" />
          <span>Lucent</span>
        </button>
        <span className="crumb-sep">/</span>
        <span className="crumb current">Personal</span>
        <div className="spacer" />
        <div className="actions">
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '5px 12px 5px 10px',
            background: 'var(--canvas-2)',
            border: '1px solid var(--stroke-1)',
            borderRadius: 999,
            width: 240,
          }}>
            <Ico.Search style={{ color: 'var(--ink-3)' }} />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search projects…"
              style={{ flex: 1, fontSize: 12, color: 'var(--ink-0)' }}
            />
            <span className="mono" style={{
              fontSize: 10, color: 'var(--ink-3)',
              padding: '2px 5px', border: '1px solid var(--stroke-1)',
              borderRadius: 3,
            }}>⌘K</span>
          </div>
          <button className="icon-btn primary" onClick={() => go(1)}>
            <Ico.Plus /> New workspace
          </button>
          <ProfileMenu
            onOpenSettings={(sec) => window.__lucentOpenSettings && window.__lucentOpenSettings(sec)}
          />
        </div>
      </div>

      {/* Body */}
      <div style={{
        position: 'absolute', top: 52, left: 0, right: 0, bottom: 0,
        display: 'grid', gridTemplateColumns: '240px 1fr',
        overflow: 'hidden',
      }}>
        {/* Sidebar */}
        <aside style={{
          borderRight: '1px solid var(--stroke-1)',
          padding: '18px 12px',
          background: 'var(--canvas-0)',
          overflowY: 'auto',
        }}>
          {sidebarTop.map(it => (
            <SidebarItem
              key={it.id}
              icon={it.icon}
              label={it.label}
              count={it.count}
              active={filter === it.id}
              onClick={() => setFilter(it.id)}
            />
          ))}

          <div style={{ height: 20 }} />
          <div style={{
            fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.1em',
            textTransform: 'uppercase', color: 'var(--ink-3)',
            padding: '6px 10px',
          }}>By artifact</div>
          {byArtifact.map(it => (
            <SidebarItem
              key={it.id}
              icon={it.icon}
              label={it.label}
              count={it.count}
              active={filter === it.id}
              onClick={() => setFilter(it.id)}
              small
            />
          ))}

          <div style={{ height: 20 }} />
          <div style={{
            fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.1em',
            textTransform: 'uppercase', color: 'var(--ink-3)',
            padding: '6px 10px',
          }}>Workspaces</div>
          {[
            { label: 'Personal', dot: 'oklch(0.55 0.11 30)' },
            { label: 'Acme Team', dot: 'oklch(0.55 0.11 220)' },
          ].map((w, i) => (
            <button key={i} style={{
              display: 'flex', alignItems: 'center', gap: 10, width: '100%',
              padding: '7px 10px', borderRadius: 6,
              fontSize: 12.5, color: 'var(--ink-1)',
              background: i === 0 ? 'var(--canvas-2)' : 'transparent',
            }}>
              <span style={{ width: 8, height: 8, borderRadius: 999, background: w.dot }} />
              <span style={{ flex: 1, textAlign: 'left' }}>{w.label}</span>
              {i === 0 && <Ico.Check />}
            </button>
          ))}

          <div style={{ marginTop: 'auto', paddingTop: 12 }} />
        </aside>

        {/* Main */}
        <main style={{ overflowY: 'auto', padding: '32px 40px 60px', background: 'var(--canvas-1)' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 6 }}>
            <h1 style={{ fontSize: 30, fontVariationSettings: "'wght' 450", letterSpacing: '-0.025em', color: 'var(--ink-0)' }}>
              Good afternoon, Alex
            </h1>
            <span className="mono" style={{ fontSize: 11, color: 'var(--ink-3)' }}>
              Aug 23, 2026 · {ALL_PROJECTS.length} workspaces
            </span>
          </div>
          <p style={{ fontSize: 14, color: 'var(--ink-2)', maxWidth: 520 }}>
            Pick up where you left off, or describe something new and let Lucent build it with you.
          </p>

          {/* Quick-start card */}
          <div style={{
            marginTop: 22, padding: 18,
            border: '1px solid var(--stroke-1)',
            borderRadius: 14,
            background: 'linear-gradient(180deg, var(--canvas-2), var(--canvas-1))',
            display: 'flex', alignItems: 'center', gap: 16,
          }}>
            <div style={{
              width: 40, height: 40, borderRadius: 10,
              background: 'linear-gradient(135deg, var(--amber-2), var(--amber-3))',
              color: 'var(--canvas-0)',
              display: 'grid', placeItems: 'center',
              boxShadow: '0 0 24px -6px var(--amber-glow)',
            }}><Ico.Sparkle /></div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 14, fontVariationSettings: "'wght' 520", color: 'var(--ink-0)' }}>
                Start a workspace by describing your idea
              </div>
              <div style={{ fontSize: 12.5, color: 'var(--ink-2)', marginTop: 2 }}>
                Type or speak — architecture, flow, wireframe, journey, or something new.
              </div>
            </div>
            <button
              onClick={() => go(1)}
              className="icon-btn primary"
              style={{ padding: '9px 16px', gap: 6 }}
            >
              New workspace <Ico.Arrow />
            </button>
          </div>

          <div style={{
            marginTop: 32, marginBottom: 12,
            display: 'flex', alignItems: 'baseline', gap: 12,
          }}>
            <h2 style={{ fontSize: 15, fontVariationSettings: "'wght' 520", color: 'var(--ink-0)' }}>
              {filterTitle}
            </h2>
            <span className="mono" style={{ fontSize: 10.5, color: 'var(--ink-3)', letterSpacing: '0.05em', textTransform: 'uppercase' }}>
              {filtered.length} {filtered.length === 1 ? 'project' : 'projects'}
            </span>
            {filter !== 'all' && (
              <button
                onClick={() => setFilter('all')}
                className="mono"
                style={{
                  marginLeft: 'auto', fontSize: 11, color: 'var(--ink-2)',
                  padding: '4px 10px', borderRadius: 999,
                  border: '1px solid var(--stroke-1)',
                  display: 'inline-flex', alignItems: 'center', gap: 4,
                }}
              >
                Clear filter <Ico.X />
              </button>
            )}
          </div>

          {filtered.length === 0 ? (
            <EmptyDashboardState filter={filter} onNew={() => go(1)} />
          ) : (
            <div style={{
              display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 14,
            }}>
              {filtered.map((p, i) => (
                <ProjectCard key={p.name} {...p} />
              ))}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

function SidebarItem({ icon, label, count, active, onClick, small }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', gap: 10,
        width: '100%',
        padding: small ? '7px 10px' : '8px 10px',
        borderRadius: 6,
        fontSize: small ? 12.5 : 13,
        color: active ? 'var(--ink-0)' : 'var(--ink-1)',
        background: active ? 'var(--canvas-3)' : 'transparent',
        fontVariationSettings: active ? "'wght' 520" : "'wght' 450",
        marginBottom: small ? 1 : 2,
        transition: 'all 0.1s var(--e-out)',
        position: 'relative',
      }}
      onMouseEnter={e => { if (!active) e.currentTarget.style.background = 'var(--canvas-2)'; }}
      onMouseLeave={e => { if (!active) e.currentTarget.style.background = 'transparent'; }}
    >
      {active && (
        <span style={{
          position: 'absolute', left: -12, top: 8, bottom: 8, width: 2,
          background: 'var(--amber-2)', borderRadius: '0 2px 2px 0',
          boxShadow: '0 0 6px var(--amber-glow)',
        }} />
      )}
      {icon}
      <span style={{ flex: 1, textAlign: 'left' }}>{label}</span>
      {count != null && (
        <span className="mono" style={{ fontSize: small ? 10 : 10.5, color: 'var(--ink-3)' }}>
          {count}
        </span>
      )}
    </button>
  );
}

function EmptyDashboardState({ filter, onNew }) {
  const messages = {
    templates: { title: 'Templates coming soon', sub: 'Get a head start on architecture, flows, and journeys.' },
  };
  const msg = messages[filter] || { title: 'No projects match this filter', sub: 'Try another category or describe something new.' };
  return (
    <div style={{
      padding: '60px 40px',
      textAlign: 'center',
      border: '1px dashed var(--stroke-1)',
      borderRadius: 12,
      background: 'var(--canvas-0)',
    }}>
      <div style={{
        width: 44, height: 44, borderRadius: 12, margin: '0 auto 14px',
        background: 'linear-gradient(135deg, var(--amber-2), var(--amber-3))',
        display: 'grid', placeItems: 'center',
        color: 'var(--canvas-0)',
        boxShadow: '0 0 30px -6px var(--amber-glow)',
      }}>
        <Ico.Sparkle />
      </div>
      <div style={{ fontSize: 15, color: 'var(--ink-0)', fontVariationSettings: "'wght' 500", marginBottom: 6 }}>
        {msg.title}
      </div>
      <div style={{ fontSize: 13, color: 'var(--ink-2)', marginBottom: 18 }}>
        {msg.sub}
      </div>
      <button className="icon-btn primary" onClick={onNew}>
        <Ico.Plus /> New workspace
      </button>
    </div>
  );
}

// Mini preview shapes for each artifact kind (uses theme tokens via computed vars)
function MiniPreview({ kind, accent }) {
  const stroke = accent ? 'var(--amber-3)' : 'var(--stroke-3)';
  const fill = 'var(--canvas-2)';

  const box = (x, y, w=22, h=12, key) => (
    <g key={key}>
      <rect x={x} y={y} width={w} height={h} rx="2" fill={fill} stroke={stroke} strokeWidth="0.6" />
    </g>
  );

  if (kind === 'arch') {
    return (
      <svg viewBox="0 0 160 60" width="100%" height="100%">
        {box(6, 10, 26, 12, 'a')}
        {box(40, 10, 26, 12, 'b')}
        {box(74, 10, 26, 12, 'c')}
        {box(108, 10, 26, 12, 'd')}
        {box(40, 36, 26, 12, 'e')}
        {box(74, 36, 26, 12, 'f')}
        {[[32,16,40,16],[66,16,74,16],[100,16,108,16],[53,22,53,36],[66,42,74,42]].map((l,i) =>
          <path key={i} d={`M${l[0]} ${l[1]} L${l[2]} ${l[3]}`} stroke={stroke} strokeWidth="0.6" fill="none" />
        )}
      </svg>
    );
  }
  if (kind === 'journey') {
    return (
      <svg viewBox="0 0 160 60" width="100%" height="100%">
        <path d="M8 40 Q40 10, 60 30 T110 20 T150 30" stroke={stroke} strokeWidth="0.8" fill="none" />
        {[[8,40],[40,20],[70,32],[110,20],[150,30]].map((p,i)=>
          <circle key={i} cx={p[0]} cy={p[1]} r="2.5" fill={fill} stroke={stroke} strokeWidth="0.7" />
        )}
      </svg>
    );
  }
  if (kind === 'seq') {
    return (
      <svg viewBox="0 0 160 60" width="100%" height="100%">
        {[15, 55, 95, 135].map((x,i) => <line key={i} x1={x} y1="8" x2={x} y2="52" stroke={stroke} strokeWidth="0.5" strokeDasharray="2 2" />)}
        {[15, 55, 95, 135].map((x,i) => <rect key={`r${i}`} x={x-8} y="4" width="16" height="8" rx="1.5" fill={fill} stroke={stroke} strokeWidth="0.6" />)}
        {[[15,22,55], [55,32,95], [95,42,135], [135,48,55]].map(([x1,y,x2],i)=>
          <path key={i} d={`M${x1} ${y} L${x2} ${y}`} stroke={stroke} strokeWidth="0.7" fill="none" />
        )}
      </svg>
    );
  }
  if (kind === 'mind') {
    return (
      <svg viewBox="0 0 160 60" width="100%" height="100%">
        <circle cx="80" cy="30" r="7" fill={fill} stroke={stroke} strokeWidth="0.8" />
        {[[20,15],[20,45],[140,15],[140,45],[80,5],[80,55]].map((p,i)=>(
          <g key={i}>
            <path d={`M80 30 L${p[0]} ${p[1]}`} stroke={stroke} strokeWidth="0.5" fill="none" />
            <circle cx={p[0]} cy={p[1]} r="3" fill={fill} stroke={stroke} strokeWidth="0.6" />
          </g>
        ))}
      </svg>
    );
  }
  if (kind === 'wire') {
    return (
      <svg viewBox="0 0 160 60" width="100%" height="100%">
        <rect x="6" y="6" width="148" height="48" rx="2" fill={fill} stroke={stroke} strokeWidth="0.6" />
        <rect x="6" y="6" width="40" height="48" fill="var(--canvas-3)" opacity="0.6" />
        {[14, 22, 30, 38].map((y,i)=><rect key={i} x="10" y={y} width="30" height="3" rx="1" fill={stroke} opacity="0.4" />)}
        {[[52,14],[92,14],[52,30],[92,30]].map(([x,y],i)=><rect key={`c${i}`} x={x} y={y} width="34" height="10" rx="1.5" fill="none" stroke={stroke} strokeWidth="0.5" />)}
      </svg>
    );
  }
  if (kind === 'flow') {
    return (
      <svg viewBox="0 0 160 60" width="100%" height="100%">
        {box(6, 24, 22, 12, 'a')}
        <polygon points="45,24 60,30 45,36 30,30" fill={fill} stroke={stroke} strokeWidth="0.6" />
        {box(66, 24, 22, 12, 'b')}
        {box(66, 4, 22, 12, 'c')}
        {box(100, 24, 22, 12, 'd')}
        {[[28,30,30,30],[60,30,66,30],[77,4,77,24],[88,30,100,30]].map((l,i) =>
          <path key={i} d={`M${l[0]} ${l[1]} L${l[2]} ${l[3]}`} stroke={stroke} strokeWidth="0.6" fill="none" />
        )}
      </svg>
    );
  }
  if (kind === 'story') {
    return (
      <svg viewBox="0 0 160 60" width="100%" height="100%">
        {[10, 40, 70, 100, 130].map((x, i) => (
          <g key={i}>
            {box(x, 6, 22, 8, `t${i}`)}
            {box(x, 20, 22, 8, `s${i}`)}
            {box(x, 34, 22, 8, `s2${i}`)}
            {i < 4 && <rect x={x} y="48" width="22" height="6" rx="1" fill="var(--canvas-3)" stroke={stroke} strokeWidth="0.4" />}
          </g>
        ))}
      </svg>
    );
  }
  return null;
}

function ProjectCard({ name, kind, updated, nodes, mini, accent, to }) {
  const go = (n) => window.__lucentGo && window.__lucentGo(n);
  return (
    <div
      onClick={() => to && go(to)}
      style={{
        background: 'var(--canvas-0)',
        border: '1px solid var(--stroke-1)',
        borderRadius: 12,
        overflow: 'hidden',
        transition: 'all 0.15s var(--e-out)',
        cursor: 'pointer',
      }}
      onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--stroke-3)'; e.currentTarget.style.transform = 'translateY(-1px)'; }}
      onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--stroke-1)'; e.currentTarget.style.transform = 'translateY(0)'; }}
    >
      <div style={{
        height: 110,
        background: accent
          ? 'linear-gradient(180deg, var(--amber-glow-soft), var(--canvas-1))'
          : 'linear-gradient(180deg, var(--canvas-1), var(--canvas-0))',
        padding: 14,
        borderBottom: '1px solid var(--stroke-1)',
      }}>
        <MiniPreview kind={mini} accent={accent} />
      </div>
      <div style={{ padding: '12px 14px 14px' }}>
        <div style={{
          fontSize: 13.5, color: 'var(--ink-0)',
          fontVariationSettings: "'wght' 520",
          letterSpacing: '-0.005em',
          display: 'flex', alignItems: 'center', gap: 6,
        }}>
          {name}
          {accent && (
            <span style={{
              width: 5, height: 5, borderRadius: 999,
              background: 'var(--amber-2)',
              boxShadow: '0 0 6px var(--amber-glow)',
            }} />
          )}
        </div>
        <div className="mono" style={{
          marginTop: 6,
          fontSize: 11, color: 'var(--ink-3)',
          letterSpacing: '0.02em',
          display: 'flex', alignItems: 'center', gap: 6,
        }}>
          <span>{kind}</span>
          <span>·</span>
          <span>{nodes} nodes</span>
          <span>·</span>
          <span>{updated}</span>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { ScreenDashboard });
