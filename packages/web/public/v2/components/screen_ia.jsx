// Screen 00b — Information Architecture map
// The product-definition-made-visible

function ScreenIA() {
  const go = useLucentGo();

  const areas = [
    {
      area: 'Home', to: 11, color: 'oklch(0.62 0.15 78)',
      description: 'Today\'s canvas — what needs attention now',
      surfaces: ['Dashboard', 'Inbox', 'Pinned boards', 'Upcoming', 'Quick draft'],
    },
    {
      area: 'Workspace', to: 12, color: 'oklch(0.55 0.14 148)',
      description: 'Everything your org has produced — searchable',
      surfaces: ['Boards', 'Meetings', 'Projects', 'People', 'Templates', 'Trash'],
    },
    {
      area: 'Board', to: 3, color: 'oklch(0.62 0.20 258)',
      description: 'The canvas — the primary surface for everything',
      surfaces: ['Infinite canvas', 'Objects', 'Tools', 'Lenses', 'Inspector', 'Comments', 'Presence'],
    },
    {
      area: 'Meeting', to: 13, color: 'oklch(0.55 0.16 25)',
      description: 'Native meetings that happen ON the board, not in a silo',
      surfaces: ['Lobby', 'Video tiles', 'Live transcript', 'Presenter follow', 'Post-meeting review'],
    },
    {
      area: 'Intelligence', to: 14, color: 'oklch(0.55 0.16 300)',
      description: 'The structured memory extracted from conversations',
      surfaces: ['Decisions', 'Actions', 'Questions', 'Risks', 'Knowledge graph', 'Ask Lucent'],
    },
    {
      area: 'Execution', to: 18, color: 'oklch(0.55 0.14 200)',
      description: 'From decision to shipped work — connected end-to-end',
      surfaces: ['Projects', 'Workstreams', 'Tasks', 'Dependencies', 'Blockers'],
    },
    {
      area: 'History', to: 7, color: 'oklch(0.42 0.02 60)',
      description: 'Full trace — every edit, extraction, approval, and sync',
      surfaces: ['Canvas history', 'Intelligence history', 'Meeting history', 'Integration log'],
    },
  ];

  const loop = [
    'Conversation', 'Canvas', 'Meeting', 'Transcript', 'Intelligence',
    'Decision', 'Action', 'External work', 'History', 'Search / Ask', 'Canvas',
  ];

  return (
    <div className="ds-page">
      <PaperBackdrop grid={false} grain={true} />
      <div style={{ position: 'relative', zIndex: 1 }}>
        <TopBar
          crumbs={[{ label: 'Product · Information architecture', current: true }]}
          actions={<>
            <button className="icon-btn" onClick={() => go(0)}><Ico.Book /> Design system</button>
            <button className="icon-btn primary" onClick={() => go(3)}><Ico.Play /> Open a board</button>
            <div style={{ width: 8 }} />
            <div className="avatar">AK</div>
          </>}
        />

        <div className="ds-content">
          {/* Hero */}
          <div className="ds-hero">
            <div className="ds-eyebrow">Information architecture · v2 · 42 sections</div>
            <div className="ds-h1">
              Not a whiteboard.<br/>
              A <em>workspace with a memory.</em>
            </div>
            <div className="ds-lede">
              Lucent turns conversations into structured knowledge and execution, and keeps
              that knowledge connected to the canvas, meetings, decisions, and work over
              time. The board is always the primary surface — meetings, intelligence, and
              execution layer <em>on top of it</em>, never off to the side.
            </div>
          </div>

          {/* --- The product loop --- */}
          <div className="ds-section">
            <div className="ds-section-head">
              <span className="ds-section-num">◎</span>
              <h2 className="ds-h2">The loop</h2>
            </div>
            <p className="ds-p" style={{ marginBottom: 26 }}>
              Every feature reinforces one continuous loop. Ideas become conversations become
              canvases become meetings become transcripts become intelligence becomes decisions
              become work — and back again as searchable memory.
            </p>
            <div style={{
              padding: 30,
              borderRadius: 20,
              background: 'linear-gradient(135deg, var(--ink-0), var(--graphite))',
              color: 'var(--paper-0)',
              position: 'relative',
              overflow: 'hidden',
            }}>
              <div style={{
                position: 'absolute', top: '-30%', right: '-10%',
                width: 400, height: 400, borderRadius: 999,
                background: 'radial-gradient(circle, var(--bloom-glow), transparent 70%)',
                filter: 'blur(20px)',
              }} />
              <div style={{
                display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8,
                position: 'relative',
              }}>
                {loop.map((step, i) => (
                  <React.Fragment key={i}>
                    <div style={{
                      padding: '8px 14px', borderRadius: 999,
                      background: i === loop.length - 1 ? 'var(--bloom-2)' : 'oklch(1 0 0 / 0.08)',
                      border: `1px solid ${i === loop.length - 1 ? 'var(--bloom-1)' : 'oklch(1 0 0 / 0.14)'}`,
                      color: 'var(--paper-0)',
                      fontFamily: 'var(--font-mono)', fontSize: 11.5, fontWeight: 500,
                      letterSpacing: '0.02em',
                    }}>
                      {step}
                    </div>
                    {i < loop.length - 1 && (
                      <span style={{ color: 'oklch(0.7 0.01 60)', opacity: 0.5, fontFamily: 'var(--font-mono)' }}>→</span>
                    )}
                  </React.Fragment>
                ))}
              </div>
            </div>
          </div>

          {/* --- Top-level areas --- */}
          <div className="ds-section">
            <div className="ds-section-head">
              <span className="ds-section-num">01</span>
              <h2 className="ds-h2">Top-level areas</h2>
            </div>
            <p className="ds-p" style={{ marginBottom: 26 }}>
              Seven persistent surfaces in the global rail. Every screen lives inside one —
              nothing is a modal-only feature, and the board can be visible under most of them.
            </p>
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
              gap: 14,
            }}>
              {areas.map(a => (
                <button key={a.area} onClick={() => go(a.to)}
                  style={{
                    padding: 20, borderRadius: 14,
                    background: 'var(--paper-0)',
                    border: '1px solid oklch(from var(--paper-4) l c h / 0.5)',
                    textAlign: 'left', cursor: 'pointer',
                    transition: 'all 0.15s var(--e-out)',
                    borderLeft: `4px solid ${a.color}`,
                  }}
                  onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.boxShadow = 'var(--shadow-2)'; }}
                  onMouseLeave={e => { e.currentTarget.style.transform = 'translateY(0)'; e.currentTarget.style.boxShadow = 'none'; }}
                >
                  <div style={{
                    fontFamily: 'var(--font-serif)', fontSize: 20, fontWeight: 500,
                    color: 'var(--ink-0)', letterSpacing: '-0.01em',
                    marginBottom: 4,
                  }}>{a.area}</div>
                  <div style={{ fontSize: 12.5, color: 'var(--ink-2)', lineHeight: 1.5, marginBottom: 12, fontFamily: 'var(--font-serif)', fontStyle: 'italic' }}>
                    {a.description}
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                    {a.surfaces.map(s => (
                      <span key={s} className="mono" style={{
                        padding: '2px 7px', borderRadius: 4,
                        fontSize: 10, color: 'var(--ink-2)',
                        background: 'oklch(from var(--paper-2) l c h / 0.7)',
                        letterSpacing: '0.02em',
                      }}>{s}</span>
                    ))}
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* --- The persistent object model --- */}
          <div className="ds-section">
            <div className="ds-section-head">
              <span className="ds-section-num">02</span>
              <h2 className="ds-h2">The object model</h2>
            </div>
            <p className="ds-p" style={{ marginBottom: 26 }}>
              Everything Lucent stores is one of these things. Semantics — not pixels — are the
              canonical state; the canvas is just one view.
            </p>
            <ObjectTree />
          </div>

          {/* --- Cross-cutting behaviors --- */}
          <div className="ds-section">
            <div className="ds-section-head">
              <span className="ds-section-num">03</span>
              <h2 className="ds-h2">Cross-cutting</h2>
            </div>
            <p className="ds-p" style={{ marginBottom: 26 }}>
              These surfaces appear from anywhere via keyboard, and are what makes the whole
              system feel like one product.
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14 }}>
              {[
                { name: 'Command palette',    kbd: '⌘K', desc: 'Every action, search, and Ask in one input',      to: 3 },
                { name: 'Ask Lucent',         kbd: '⌘/', desc: 'Reasoning over your workspace with evidence',     to: 20 },
                { name: 'Notifications',      kbd: '⌘I', desc: 'Grouped by importance — mentions, approvals',     to: 21 },
                { name: 'Review queue',       kbd: '⌘R', desc: 'AI proposals awaiting human approval',            to: 22 },
                { name: 'Voice',              kbd: 'Space', desc: '"Hey Lucent…" from any surface',              to: 5 },
                { name: 'Object inspector',   kbd: 'I', desc: 'Attributes, relationships, provenance',           to: 3 },
              ].map(c => (
                <button key={c.name} onClick={() => go(c.to)}
                  style={{
                    padding: 16, borderRadius: 12,
                    background: 'var(--paper-0)',
                    border: '1px solid oklch(from var(--paper-4) l c h / 0.5)',
                    textAlign: 'left', cursor: 'pointer',
                    transition: 'all 0.14s var(--e-out)',
                  }}
                  onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--ink-3)'; e.currentTarget.style.background = 'var(--paper-1)'; }}
                  onMouseLeave={e => { e.currentTarget.style.borderColor = 'oklch(from var(--paper-4) l c h / 0.5)'; e.currentTarget.style.background = 'var(--paper-0)'; }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                    <span style={{ fontSize: 14, fontWeight: 500, color: 'var(--ink-0)' }}>{c.name}</span>
                    <div style={{ flex: 1 }} />
                    <span className="mono" style={{
                      fontSize: 10, padding: '2px 6px', borderRadius: 4,
                      background: 'oklch(from var(--paper-3) l c h / 0.9)',
                      color: 'var(--ink-2)',
                    }}>{c.kbd}</span>
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--ink-2)', lineHeight: 1.5 }}>{c.desc}</div>
                </button>
              ))}
            </div>
          </div>

          {/* --- Principles restated --- */}
          <div className="ds-section" style={{ borderBottom: 0 }}>
            <div className="ds-section-head">
              <span className="ds-section-num">04</span>
              <h2 className="ds-h2">Principles</h2>
            </div>
            <div className="ds-grid ds-grid-2" style={{ gap: 20 }}>
              {[
                { n: 'i.',   t: 'The board is the surface',      b: 'Meetings, intelligence, execution — they overlay the canvas. Nothing is a silo.' },
                { n: 'ii.',  t: 'Structure over pixels',          b: 'Every object is semantic. One model, many representations.' },
                { n: 'iii.', t: 'Provenance for everything',      b: 'Every fact answers "where did this come from?" — meeting, speaker, timestamp.' },
                { n: 'iv.',  t: 'AI proposes, humans decide',     b: 'Important workspace truth is never silently altered. Reviewable diffs.' },
                { n: 'v.',   t: 'Search is not enough',           b: 'Ask reasons. Answers show evidence, source, and confidence.' },
                { n: 'vi.',  t: 'Connect, don\'t replace',        b: 'Lucent is the intelligence layer between Linear, Slack, GitHub, Notion, Zoom.' },
              ].map(p => (
                <div key={p.n} className="ds-card" style={{ padding: 24 }}>
                  <div className="serif" style={{ fontSize: 32, fontStyle: 'italic', color: 'var(--bloom-2)', marginBottom: 8, fontWeight: 400 }}>
                    {p.n}
                  </div>
                  <div style={{ fontSize: 17, fontWeight: 500, marginBottom: 6, letterSpacing: '-0.01em' }}>{p.t}</div>
                  <div style={{ fontSize: 13.5, color: 'var(--ink-2)', lineHeight: 1.55 }}>{p.b}</div>
                </div>
              ))}
            </div>
          </div>

          <div style={{
            marginTop: 40, paddingTop: 24,
            borderTop: '1px solid oklch(from var(--paper-4) l c h / 0.4)',
            display: 'flex', gap: 20,
            fontFamily: 'var(--font-mono)', fontSize: 11,
            color: 'var(--ink-3)', letterSpacing: '0.04em',
          }}>
            <span>lucent · v2 · product surface</span>
            <span>·</span>
            <span>42 sections</span>
            <span>·</span>
            <span>7 top-level areas</span>
            <span>·</span>
            <span>1 loop</span>
            <div style={{ flex: 1 }} />
            <span>fig. 00b / architecture.md</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function ObjectTree() {
  const tree = [
    { name: 'Workspace', depth: 0, meta: 'org · team · project', highlight: true },
    { name: 'Board', depth: 1, meta: 'the canvas' },
    { name: 'Objects', depth: 2, meta: 'nodes · edges · frames · sticky · text · shapes' },
    { name: 'Relationships', depth: 2, meta: 'depends on · blocks · part of · owned by' },
    { name: 'Comments', depth: 2, meta: 'threads · mentions · reactions' },
    { name: 'History', depth: 2, meta: 'edits · snapshots · authors' },
    { name: 'Meeting', depth: 1, meta: 'native + external (Zoom, Meet, Teams)' },
    { name: 'Participants', depth: 2, meta: 'internal + external + guests' },
    { name: 'Transcript', depth: 2, meta: 'utterances · speaker · timestamp' },
    { name: 'Intelligence extraction', depth: 2, meta: 'AI-proposed → human-approved' },
    { name: 'Intelligence', depth: 1, meta: 'the structured memory', highlight: true },
    { name: 'Decision', depth: 2, meta: 'evidence · owner · status · supersession' },
    { name: 'Action', depth: 2, meta: 'owner · due · priority · external ID' },
    { name: 'Question', depth: 2, meta: 'unresolved · owner · related topic' },
    { name: 'Risk', depth: 2, meta: 'severity · probability · mitigation' },
    { name: 'Requirement', depth: 2, meta: 'source · assumption · constraint' },
    { name: 'Knowledge', depth: 2, meta: 'entities + relationships (graph)' },
    { name: 'Project', depth: 1, meta: 'objectives → workstreams → tasks' },
    { name: 'Workstream', depth: 2, meta: 'grouped tasks by discipline' },
    { name: 'Task', depth: 2, meta: 'the atomic unit of work' },
    { name: 'Integration', depth: 1, meta: 'external systems' },
    { name: 'Adapter', depth: 2, meta: 'Linear · Jira · Slack · GitHub · Notion · Zoom' },
    { name: 'Sync', depth: 2, meta: 'bidirectional state · idempotent' },
  ];
  return (
    <div style={{
      padding: 20,
      borderRadius: 14,
      background: 'var(--paper-0)',
      border: '1px solid oklch(from var(--paper-4) l c h / 0.5)',
      fontFamily: 'var(--font-mono)',
      fontSize: 12.5,
    }}>
      {tree.map((row, i) => (
        <div key={i} style={{
          display: 'flex', alignItems: 'center', gap: 12,
          padding: '5px 0',
          paddingLeft: row.depth * 26,
          color: row.highlight ? 'var(--bloom-2)' : 'var(--ink-0)',
          fontWeight: row.highlight ? 600 : row.depth === 0 ? 600 : 400,
        }}>
          <span style={{
            width: 6, height: 6,
            borderRadius: row.depth === 0 ? 2 : 999,
            background: row.highlight ? 'var(--bloom-2)' : row.depth === 0 ? 'var(--ink-0)' : row.depth === 1 ? 'var(--ink-2)' : 'var(--ink-3)',
            flexShrink: 0,
          }} />
          <span style={{ minWidth: 130 }}>{row.name}</span>
          <span style={{ color: 'var(--ink-3)', fontSize: 11 }}>{row.meta}</span>
        </div>
      ))}
    </div>
  );
}

Object.assign(window, { ScreenIA });
