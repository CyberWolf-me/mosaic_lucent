// Screen 12 — Workspace browser · org > team > project

function ScreenWorkspace() {
  const go = useLucentGo();
  const [tab, setTab] = useState('boards');
  const [project, setProject] = useState('q4');
  const projects = {
    q4:         { name: 'Q4 Roadmap',        meta: '24 boards · 8 meetings this month · 42 open actions', team: 'Product' },
    payment:    { name: 'Payment overhaul',  meta: '12 boards · 4 meetings this month · 18 open actions', team: 'Product' },
    onboarding: { name: 'Onboarding v3',     meta: '6 boards · 2 meetings · 11 open actions', team: 'Product' },
    eng:        { name: 'Engineering',       meta: '38 boards · 14 meetings · 96 open actions', team: 'Engineering' },
    design:     { name: 'Design',            meta: '22 boards · 6 meetings · 24 open actions', team: 'Design' },
    growth:     { name: 'Growth',            meta: '9 boards · 3 meetings · 12 open actions', team: 'Growth' },
    okrs:       { name: 'Company OKRs 2026', meta: '3 boards · 1 meeting · 8 open actions', team: 'Shared' },
    investor:   { name: 'Investor deck',     meta: '1 board · 0 meetings · 0 open actions', team: 'Shared' },
    sketches:   { name: 'Sketches',          meta: '4 personal boards', team: 'Personal' },
    reading:    { name: 'Reading queue',     meta: '2 personal boards', team: 'Personal' },
  };
  const p = projects[project];

  return (
    <AppShell activeArea="workspace"
      crumbs={[{ label: 'Northbeam', current: false }, { label: 'Product · Q4', current: true }]}
    >
      <div style={{ display: 'flex', height: '100%' }}>
        {/* Local rail — workspace tree */}
        <div style={{
          width: 240, flexShrink: 0,
          borderRight: '1px solid oklch(from var(--paper-4) l c h / 0.5)',
          padding: '24px 12px',
          overflow: 'auto',
        }}>
          <div className="mono-caps" style={{ padding: '0 12px', marginBottom: 10 }}>Organization</div>
          <TreeItem icon={<OrgIcon />}    label="Northbeam" bold />
          <TreeItem icon={<TeamIcon />}   label="Product" indent={1} bold active={['q4','payment','onboarding'].includes(project)} />
          <TreeItem icon={<Ico.Folder />} label="Q4 Roadmap"       indent={2} active={project === 'q4'}         onClick={() => setProject('q4')} />
          <TreeItem icon={<Ico.Folder />} label="Payment overhaul" indent={2} active={project === 'payment'}    onClick={() => setProject('payment')} />
          <TreeItem icon={<Ico.Folder />} label="Onboarding v3"    indent={2} active={project === 'onboarding'} onClick={() => setProject('onboarding')} />
          <TreeItem icon={<TeamIcon />}   label="Engineering" indent={1} active={project === 'eng'}    onClick={() => setProject('eng')} />
          <TreeItem icon={<TeamIcon />}   label="Design"      indent={1} active={project === 'design'} onClick={() => setProject('design')} />
          <TreeItem icon={<TeamIcon />}   label="Growth"      indent={1} active={project === 'growth'} onClick={() => setProject('growth')} />

          <div className="mono-caps" style={{ padding: '20px 12px 10px' }}>Shared with me</div>
          <TreeItem icon={<Ico.Folder />} label="Company OKRs 2026" active={project === 'okrs'}     onClick={() => setProject('okrs')} />
          <TreeItem icon={<Ico.Folder />} label="Investor deck"     active={project === 'investor'} onClick={() => setProject('investor')} />

          <div className="mono-caps" style={{ padding: '20px 12px 10px' }}>Personal</div>
          <TreeItem icon={<Ico.Folder />} label="Sketches"      active={project === 'sketches'} onClick={() => setProject('sketches')} />
          <TreeItem icon={<Ico.Folder />} label="Reading queue" active={project === 'reading'}  onClick={() => setProject('reading')} />
        </div>

        {/* Main */}
        <div style={{ flex: 1, overflow: 'auto', padding: '32px 40px 60px' }}>
          <SectionHeader
            eyebrow={`Northbeam / ${p.team} / ${p.name}`}
            title={p.name}
            meta={p.meta}
            actions={<>
              <button className="icon-btn" title="Share this workspace"><Ico.Share /> Share</button>
              <button className="icon-btn" onClick={() => go(24)} title="Invite people (opens Admin › Members)"><Ico.Plus /> Invite</button>
              <button className="icon-btn primary" onClick={() => go(1)} title="Start a new board"><Ico.Plus /> New</button>
            </>}
          />

          {/* Tabs */}
          <div style={{
            display: 'flex', gap: 20,
            borderBottom: '1px solid oklch(from var(--paper-4) l c h / 0.5)',
            marginBottom: 20,
          }}>
            {[
              { id: 'boards',   label: 'Boards',   count: 24 },
              { id: 'meetings', label: 'Meetings', count: 8 },
              { id: 'projects', label: 'Projects', count: 5 },
              { id: 'people',   label: 'People',   count: 14 },
              { id: 'files',    label: 'Files',    count: 62 },
            ].map(t => (
              <button key={t.id}
                onClick={() => setTab(t.id)}
                style={{
                  padding: '8px 0 12px',
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  fontSize: 13.5, fontWeight: 500,
                  color: tab === t.id ? 'var(--ink-0)' : 'var(--ink-2)',
                  borderBottom: `2px solid ${tab === t.id ? 'var(--ink-0)' : 'transparent'}`,
                  marginBottom: -1,
                }}
              >
                {t.label}
                <span className="mono" style={{
                  fontSize: 10.5, padding: '1px 6px', borderRadius: 4,
                  background: 'oklch(from var(--paper-3) l c h / 0.9)', color: 'var(--ink-2)',
                }}>{t.count}</span>
              </button>
            ))}
          </div>

          {/* Filter bar */}
          <FilterBar
            filters={[
              { id: 'all',    label: 'All', count: 24 },
              { id: 'mine',   label: 'Mine' },
              { id: 'shared', label: 'Shared with me' },
              { id: 'starred',label: 'Starred' },
              { id: 'recent', label: 'Recent' },
            ]}
            active="all"
            extra={<>
              <button className="icon-btn" style={{ height: 30, fontSize: 12 }}><Ico.Search /> Search…</button>
              <button className="icon-btn" style={{ height: 30, fontSize: 12 }}>Sort · Modified</button>
              <button className="icon-btn" style={{ height: 30, fontSize: 12 }}><ViewIcon /></button>
            </>}
          />

          {tab === 'boards' && (
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
              gap: 14,
            }}>
              {[
                { name: 'E-commerce platform', kind: 'Architecture', meta: 'Alex · updated 2m ago', decisions: 6, actions: 12, live: true },
                { name: 'Checkout redesign',   kind: 'Wireframe', meta: 'Sarah · updated 1h ago', decisions: 3, actions: 8 },
                { name: 'Payment sequence',    kind: 'Sequence', meta: 'John · updated 3h ago', decisions: 2, actions: 4 },
                { name: 'Auth architecture v3',kind: 'Architecture', meta: 'Alex · yesterday', decisions: 4, actions: 0, status: 'settled' },
                { name: 'Onboarding journey',  kind: 'Journey', meta: 'Sarah · yesterday', decisions: 2, actions: 6 },
                { name: 'Notification bus',    kind: 'Draft', meta: 'AI · draft', decisions: 0, actions: 0, ai: true },
                { name: 'Q4 OKRs',             kind: 'Mind map', meta: 'Team · Sep 15', decisions: 8, actions: 22 },
                { name: 'Data platform review',kind: 'Architecture', meta: 'Kim · Sep 12', decisions: 5, actions: 9 },
              ].map((b, i) => (
                <BoardTile key={i} {...b} onClick={() => go(3)} />
              ))}
            </div>
          )}

          {tab === 'meetings' && (
            <div style={{ display: 'grid', gap: 10 }}>
              {[
                { time: 'Today 10:00', title: 'Checkout design review', kind: 'Design review', people: 3, board: 'E-commerce platform', live: true },
                { time: 'Yesterday', title: 'Payment strategy — Klarna decision', kind: 'Product review', people: 4, board: 'E-commerce platform', extracted: '6 decisions · 4 actions' },
                { time: 'Yesterday', title: 'Weekly product sync',      kind: 'Sync', people: 6, board: 'Q4 OKRs', extracted: '2 decisions · 3 actions' },
                { time: 'Sep 18', title: 'Auth architecture v3 — kickoff', kind: 'Architecture review', people: 5, board: 'Auth architecture v3', extracted: '4 decisions · 8 actions' },
                { time: 'Sep 15', title: 'Q4 OKR planning',              kind: 'Strategy', people: 8, board: 'Q4 OKRs', extracted: '8 decisions · 22 actions' },
                { time: 'Sep 12', title: 'Data platform review',         kind: 'Architecture review', people: 4, board: 'Data platform', extracted: '5 decisions · 9 actions' },
              ].map((m, i) => <MeetingRow key={i} {...m} onClick={() => go(13)} />)}
            </div>
          )}

          {tab === 'projects' && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 14 }}>
              {[
                { name: 'Payment Service launch', progress: 68, blockers: 1, actions: 18, target: 'Nov 15' },
                { name: 'Auth v3 rollout',        progress: 32, blockers: 0, actions: 12, target: 'Dec 1' },
                { name: 'Onboarding overhaul',    progress: 12, blockers: 0, actions: 6, target: 'Jan 15' },
                { name: 'Q4 launch marketing',    progress: 88, blockers: 0, actions: 3, target: 'Oct 30', status: 'on track' },
              ].map((p, i) => <ProjectTile key={i} {...p} onClick={() => go(18)}/>)}
            </div>
          )}

          {tab === 'people' && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12 }}>
              {[
                { name: 'Alex Kim',    role: 'Product Lead', color: 'oklch(0.55 0.16 25)',  boards: 12, actions: 7 },
                { name: 'Sarah Chen',  role: 'Design',       color: 'oklch(0.55 0.11 220)', boards: 8, actions: 4 },
                { name: 'John Torres', role: 'Engineering',  color: 'oklch(0.55 0.14 148)', boards: 6, actions: 9 },
                { name: 'Kim Park',    role: 'Engineering',  color: 'oklch(0.55 0.16 300)', boards: 4, actions: 5 },
                { name: 'Marco Rossi', role: 'Data',         color: 'oklch(0.55 0.14 200)', boards: 3, actions: 2 },
                { name: 'Ana López',   role: 'Growth',       color: 'oklch(0.55 0.16 40)',  boards: 5, actions: 6 },
              ].map((p, i) => <PersonCard key={i} {...p} />)}
            </div>
          )}
        </div>
      </div>
    </AppShell>
  );
}

function TreeItem({ icon, label, indent = 0, active, bold, onClick }) {
  return (
    <button
      onClick={onClick}
      title={label}
      style={{
        display: 'flex', alignItems: 'center', gap: 8,
        width: '100%',
        padding: '5px 10px',
        paddingLeft: 10 + indent * 16,
        borderRadius: 6,
        fontSize: 12.5,
        color: active ? 'var(--ink-0)' : 'var(--ink-1)',
        background: active && indent >= 2 ? 'var(--paper-2)' : 'transparent',
        fontWeight: bold || active ? 500 : 400,
        textAlign: 'left',
        transition: 'background 0.1s',
        cursor: 'pointer',
      }}
      onMouseEnter={e => !active && (e.currentTarget.style.background = 'var(--paper-2)')}
      onMouseLeave={e => !active && (e.currentTarget.style.background = 'transparent')}
    >
      <span style={{ color: 'var(--ink-3)', display: 'grid', placeItems: 'center' }}>{icon}</span>
      {label}
    </button>
  );
}
function OrgIcon() { return <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"/><path d="M8 12h8M12 8v8"/></svg>; }
function TeamIcon() { return <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><circle cx="8" cy="9" r="3"/><circle cx="16" cy="11" r="2.5"/><path d="M3 20c1-3 3-4.5 5-4.5s4 1.5 5 4.5M14 20c1-2.5 2-3.5 3-4"/></svg>; }
function ViewIcon() { return <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>; }

function BoardTile({ name, kind, meta, decisions, actions, live, ai, status, onClick }) {
  return (
    <button onClick={onClick} style={{
      padding: 0, borderRadius: 12,
      background: 'var(--paper-0)',
      border: `1px solid ${ai ? 'var(--bloom-wash-2)' : 'oklch(from var(--paper-4) l c h / 0.5)'}`,
      textAlign: 'left', cursor: 'pointer',
      overflow: 'hidden',
      transition: 'all 0.15s var(--e-out)',
      display: 'flex', flexDirection: 'column',
      boxShadow: 'var(--shadow-1)',
    }}
      onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.boxShadow = 'var(--shadow-2)'; }}
      onMouseLeave={e => { e.currentTarget.style.transform = 'translateY(0)'; e.currentTarget.style.boxShadow = 'var(--shadow-1)'; }}
    >
      <div style={{
        aspectRatio: '16/10',
        background: ai ? 'var(--bloom-wash)' : 'var(--paper-2)',
        borderBottom: '1px solid oklch(from var(--paper-4) l c h / 0.4)',
        position: 'relative', overflow: 'hidden',
      }}>
        <MiniBoardPreview kind={kind} />
        {live && (
          <div style={{
            position: 'absolute', top: 8, left: 8,
            padding: '3px 8px 3px 6px',
            background: 'var(--madder)', color: 'white',
            fontFamily: 'var(--font-mono)', fontSize: 9.5, fontWeight: 700,
            letterSpacing: '0.05em', borderRadius: 4,
            display: 'inline-flex', alignItems: 'center', gap: 4,
          }}>
            <span style={{ width: 5, height: 5, borderRadius: 999, background: 'white', animation: 'pulse-bloom 1.4s ease-in-out infinite' }} />
            LIVE
          </div>
        )}
        {ai && (
          <div style={{
            position: 'absolute', top: 8, left: 8,
            padding: '3px 8px', background: 'var(--bloom-2)', color: 'white',
            fontFamily: 'var(--font-mono)', fontSize: 9.5, fontWeight: 700,
            letterSpacing: '0.05em', borderRadius: 4,
          }}>AI DRAFT</div>
        )}
        {status && (
          <div style={{
            position: 'absolute', top: 8, right: 8,
            padding: '3px 8px', background: 'var(--moss)', color: 'white',
            fontFamily: 'var(--font-mono)', fontSize: 9.5, fontWeight: 600,
            letterSpacing: '0.05em', borderRadius: 4,
          }}>SETTLED</div>
        )}
      </div>
      <div style={{ padding: '12px 14px' }}>
        <div style={{ fontSize: 13.5, fontWeight: 500, color: 'var(--ink-0)', marginBottom: 4 }}>{name}</div>
        <div className="mono" style={{ fontSize: 10.5, color: 'var(--ink-3)', marginBottom: 8, letterSpacing: '0.02em' }}>
          {kind} · {meta}
        </div>
        <div style={{ display: 'flex', gap: 10, fontSize: 10.5, color: 'var(--ink-2)' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <DecisionIcon /> {decisions}
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <ActionIcon /> {actions}
          </span>
        </div>
      </div>
    </button>
  );
}
function MiniBoardPreview({ kind }) {
  if (kind === 'Architecture' || kind === 'Draft') {
    return (
      <svg width="100%" height="100%" viewBox="0 0 300 190">
        {[[40,60,'var(--paper-0)'],[130,40,'var(--paper-0)'],[130,100,'var(--paper-0)'],[220,60,'var(--paper-0)'],[130,150,'var(--bloom-wash-2)']].map(([x,y,f], i) => (
          <rect key={i} x={x} y={y} width="60" height="32" rx="6" fill={f} stroke="var(--ink-3)" strokeWidth="1"/>
        ))}
        <path d="M100 76 L130 56" stroke="var(--ink-3)" strokeWidth="1"/>
        <path d="M100 76 L130 116" stroke="var(--ink-3)" strokeWidth="1"/>
        <path d="M190 56 L220 76" stroke="var(--ink-3)" strokeWidth="1"/>
        <path d="M190 116 L220 76" stroke="var(--ink-3)" strokeWidth="1"/>
      </svg>
    );
  }
  if (kind === 'Wireframe') {
    return (
      <svg width="100%" height="100%" viewBox="0 0 300 190">
        {[0,1,2].map(i => (
          <g key={i} transform={`translate(${20+i*90}, 30)`}>
            <rect x="0" y="0" width="70" height="130" rx="6" fill="var(--paper-0)" stroke="var(--ink-3)" strokeWidth="1"/>
            <rect x="8" y="10" width="54" height="6" rx="2" fill="var(--paper-3)"/>
            <rect x="8" y="22" width="40" height="4" rx="2" fill="var(--paper-3)"/>
            <rect x="8" y="35" width="54" height="22" rx="3" fill="var(--paper-3)"/>
            <rect x="8" y="62" width="54" height="22" rx="3" fill="var(--paper-3)"/>
          </g>
        ))}
      </svg>
    );
  }
  if (kind === 'Sequence') {
    return (
      <svg width="100%" height="100%" viewBox="0 0 300 190">
        {[50,130,210].map((x,i) => (
          <g key={i}>
            <rect x={x-25} y="20" width="50" height="16" rx="3" fill="var(--paper-0)" stroke="var(--ink-3)"/>
            <line x1={x} y1="38" x2={x} y2="170" stroke="var(--ink-3)" strokeDasharray="3 3"/>
          </g>
        ))}
        <path d="M50 55 L130 55" stroke="var(--bloom-2)" strokeWidth="1.5"/>
        <path d="M130 90 L210 90" stroke="var(--ink-3)"/>
        <path d="M210 125 L130 125" stroke="var(--ink-3)" strokeDasharray="4 3"/>
      </svg>
    );
  }
  if (kind === 'Journey') {
    return (
      <svg width="100%" height="100%" viewBox="0 0 300 190">
        <path d="M20 140 C 60 60, 100 60, 140 100 S 220 160, 280 60" stroke="var(--bloom-2)" strokeWidth="2" fill="none"/>
        {[[20,140],[80,80],[140,100],[200,140],[260,70]].map(([x,y], i) => (
          <circle key={i} cx={x} cy={y} r="4" fill="var(--bloom-2)"/>
        ))}
      </svg>
    );
  }
  if (kind === 'Mind map') {
    return (
      <svg width="100%" height="100%" viewBox="0 0 300 190">
        <circle cx="150" cy="95" r="24" fill="var(--paper-0)" stroke="var(--ink-3)"/>
        {[[60,50],[240,50],[60,140],[240,140],[150,20],[150,170]].map(([x,y], i) => (
          <g key={i}>
            <path d={`M 150 95 Q ${x} 95 ${x} ${y}`} stroke="var(--ink-3)" strokeWidth="1" fill="none"/>
            <circle cx={x} cy={y} r="12" fill="var(--paper-0)" stroke="var(--ink-3)"/>
          </g>
        ))}
      </svg>
    );
  }
  return null;
}

function MeetingRow({ time, title, kind, people, board, live, extracted, onClick }) {
  return (
    <button onClick={onClick} style={{
      padding: '14px 16px',
      borderRadius: 12,
      background: 'var(--paper-0)',
      border: `1px solid ${live ? 'var(--madder)' : 'oklch(from var(--paper-4) l c h / 0.5)'}`,
      display: 'flex', alignItems: 'center', gap: 14,
      textAlign: 'left', cursor: 'pointer',
      transition: 'all 0.14s',
    }}
      onMouseEnter={e => { e.currentTarget.style.background = 'var(--paper-1)'; }}
      onMouseLeave={e => { e.currentTarget.style.background = 'var(--paper-0)'; }}
    >
      <div style={{
        padding: '6px 10px', borderRadius: 6,
        background: live ? 'var(--madder)' : 'var(--paper-2)',
        color: live ? 'white' : 'var(--ink-1)',
        fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: live ? 700 : 500,
        letterSpacing: '0.02em', flexShrink: 0, width: 100, textAlign: 'center',
      }}>
        {live && <span style={{ marginRight: 4, animation: 'pulse-bloom 1.4s ease-in-out infinite' }}>●</span>}
        {time}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 500, color: 'var(--ink-0)', marginBottom: 3 }}>{title}</div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', fontSize: 11.5, color: 'var(--ink-2)' }}>
          <span className="mono" style={{ padding: '1px 6px', background: 'var(--paper-2)', borderRadius: 3, fontSize: 10 }}>{kind}</span>
          <span>{people} people</span>
          {board && <><span>·</span><span style={{ color: 'var(--bloom-2)' }}>{board}</span></>}
        </div>
      </div>
      {extracted && (
        <span className="mono" style={{ fontSize: 10.5, color: 'var(--bloom-2)', letterSpacing: '0.02em' }}>
          <Ico.Sparkle style={{ display: 'inline', verticalAlign: -2, marginRight: 3 }} />
          {extracted}
        </span>
      )}
      {live && (
        <button className="btn bloom" style={{ height: 30, fontSize: 12, flex: 'none', padding: '0 14px' }}>
          <Ico.Play /> Join
        </button>
      )}
    </button>
  );
}

function ProjectTile({ name, progress, blockers, actions, target, status, onClick }) {
  return (
    <button onClick={onClick} style={{
      padding: 18, borderRadius: 12,
      background: 'var(--paper-0)',
      border: '1px solid oklch(from var(--paper-4) l c h / 0.5)',
      textAlign: 'left', cursor: 'pointer',
      transition: 'all 0.14s',
    }}
      onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-1px)'; e.currentTarget.style.boxShadow = 'var(--shadow-1)'; }}
      onMouseLeave={e => { e.currentTarget.style.transform = 'translateY(0)'; e.currentTarget.style.boxShadow = 'none'; }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 4 }}>
        <div style={{ fontFamily: 'var(--font-serif)', fontSize: 20, fontWeight: 500, letterSpacing: '-0.01em' }}>{name}</div>
        <div className="mono" style={{ fontSize: 10.5, color: 'var(--ink-3)' }}>Target · {target}</div>
      </div>
      <div style={{ display: 'flex', gap: 20, marginTop: 12, marginBottom: 12, fontSize: 12, color: 'var(--ink-2)' }}>
        <span><b style={{ color: 'var(--ink-0)', fontFamily: 'var(--font-mono)' }}>{progress}%</b> complete</span>
        <span><b style={{ color: blockers > 0 ? 'var(--madder)' : 'var(--ink-0)', fontFamily: 'var(--font-mono)' }}>{blockers}</b> blocker{blockers === 1 ? '' : 's'}</span>
        <span><b style={{ color: 'var(--ink-0)', fontFamily: 'var(--font-mono)' }}>{actions}</b> open action{actions === 1 ? '' : 's'}</span>
      </div>
      <div style={{
        height: 6, borderRadius: 999,
        background: 'var(--paper-3)',
        overflow: 'hidden',
      }}>
        <div style={{
          width: `${progress}%`, height: '100%',
          background: blockers > 0 ? 'var(--madder)' : 'var(--moss)',
          borderRadius: 999,
        }} />
      </div>
    </button>
  );
}

function PersonCard({ name, role, color, boards, actions }) {
  return (
    <div style={{
      padding: '14px 16px', borderRadius: 12,
      background: 'var(--paper-0)',
      border: '1px solid oklch(from var(--paper-4) l c h / 0.5)',
      display: 'flex', gap: 12, alignItems: 'center',
    }}>
      <div style={{
        width: 42, height: 42, borderRadius: 999,
        background: color, color: 'white',
        display: 'grid', placeItems: 'center',
        fontFamily: 'var(--font-mono)', fontSize: 13, fontWeight: 700,
        border: '2px solid var(--paper-0)',
        boxShadow: 'var(--shadow-1)',
      }}>{name.split(' ').map(n => n[0]).join('')}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13.5, fontWeight: 500, color: 'var(--ink-0)' }}>{name}</div>
        <div className="mono" style={{ fontSize: 10.5, color: 'var(--ink-3)', letterSpacing: '0.02em' }}>
          {role} · {boards} boards · {actions} actions
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { ScreenWorkspace });
