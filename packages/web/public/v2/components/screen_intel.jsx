// Screens 14-16 — Intelligence · Decisions, Actions, Knowledge (graph + Ask)

// ============================================================
// Screen 14 — Decisions log
// ============================================================
function ScreenIntelDecisions() {
  const go = useLucentGo();
  const [filter, setFilter] = useState('all');
  const [detail, setDetail] = useState(null);

  const decisions = [
    { title: 'Payment Service goes behind the API gateway', status: 'active', owner: 'Alex', ownerColor: 'oklch(0.55 0.16 25)', date: '14:32 today', evidence: 'Behind the gateway — same as everything else.', from: { icon: <Ico.Present />, label: 'Checkout review · today' } },
    { title: 'Guest checkout is the default checkout path',  status: 'active', owner: 'Alex', ownerColor: 'oklch(0.55 0.16 25)', date: '14:32 today', evidence: 'No forced signup — biggest drop-off in the funnel.', from: { icon: <Ico.Present />, label: 'Checkout review · today' } },
    { title: 'Support Klarna as a payment method at launch', status: 'review', owner: 'John', ownerColor: 'oklch(0.55 0.14 148)', date: '14:34 today', evidence: 'Klarna alone lifted conversion 8% at Northbeam.', from: { icon: <Ico.Present />, label: 'Checkout review · today' } },
    { title: 'Silent retry policy on Stripe intermittency',  status: 'active', owner: 'John', ownerColor: 'oklch(0.55 0.14 148)', date: '14:36 today', evidence: 'Two retries before showing an error.', from: { icon: <Ico.Present />, label: 'Checkout review · today' } },

    { title: 'Defer Klarna support to Q1 2027', status: 'superseded', owner: 'Alex', ownerColor: 'oklch(0.55 0.16 25)', date: 'Sep 12', superseded: 'today\'s decision', evidence: 'Not enough eng bandwidth for Q4.', from: { icon: <Ico.Present />, label: 'Product review · Sep 12' } },
    { title: 'Standardize on Postgres 16 for all services', status: 'active', owner: 'Kim', ownerColor: 'oklch(0.55 0.16 300)', date: 'Sep 8', from: { icon: <Ico.Present />, label: 'Data platform review' } },
    { title: 'OAuth over SAML for enterprise auth in v3',   status: 'active', owner: 'John', ownerColor: 'oklch(0.55 0.14 148)', date: 'Sep 5', evidence: 'SAML complexity not worth it for our tier.', from: { icon: <Ico.Present />, label: 'Auth v3 kickoff' } },
    { title: 'Ship redesigned checkout by Black Friday',    status: 'active', owner: 'Alex', ownerColor: 'oklch(0.55 0.16 25)', date: 'Aug 28', from: { icon: <Ico.Present />, label: 'Q4 planning' } },
    { title: 'Move analytics to ClickHouse',                status: 'pending', owner: 'Marco', ownerColor: 'oklch(0.55 0.14 200)', date: 'Aug 22', evidence: 'Query latency has become untenable.', from: { icon: <Ico.Present />, label: 'Data platform' } },
  ];

  const filters = [
    { id: 'all',        label: 'All',        count: decisions.length },
    { id: 'active',     label: 'Active',     count: decisions.filter(d => d.status === 'active').length },
    { id: 'review',     label: 'In review',  count: decisions.filter(d => d.status === 'review').length },
    { id: 'pending',    label: 'Pending',    count: decisions.filter(d => d.status === 'pending').length },
    { id: 'superseded', label: 'Superseded', count: decisions.filter(d => d.status === 'superseded').length },
  ];
  const shown = filter === 'all' ? decisions : decisions.filter(d => d.status === filter);

  return (
    <AppShell activeArea="intel"
      crumbs={[{ label: 'Personal', screen: 6 }, { label: 'Intelligence', current: false }, { label: 'Decisions', current: true }]}
    >
      <IntelSubnav active="decisions" />
      <div style={{ padding: '20px 40px 60px', maxWidth: 1240, margin: '0 auto' }}>
        <SectionHeader
          eyebrow="Fig. 14 · Intelligence · Decisions"
          title="Decisions log"
          meta={`${decisions.length} decisions · 4 today`}
          actions={<>
            <button className="icon-btn"><Ico.Search /> Search…</button>
            <button className="icon-btn primary"><Ico.Plus /> New decision</button>
          </>}
        />
        <FilterBar filters={filters} active={filter} onChange={setFilter} />
        <div style={{ display: 'grid', gap: 12 }}>
          {shown.map((d, i) => <DecisionCard key={i} {...d} onClick={() => setDetail(d)} />)}
        </div>
      </div>
      {detail && <DecisionDetail decision={detail} onClose={() => setDetail(null)} onGoMeeting={() => { setDetail(null); go(8); }} onGoAction={() => { setDetail(null); go(15); }} onGoBoard={() => { setDetail(null); go(3); }} />}
    </AppShell>
  );
}

function DecisionDetail({ decision, onClose, onGoMeeting, onGoAction, onGoBoard }) {
  return (
    <>
      <div onClick={onClose} style={{
        position: 'fixed', inset: 0, zIndex: 200,
        background: 'oklch(0.20 0.02 60 / 0.35)',
        backdropFilter: 'blur(8px)',
      }} />
      <div style={{
        position: 'fixed', zIndex: 201,
        top: '10vh', left: '50%', transform: 'translateX(-50%)',
        width: 640, maxWidth: 'calc(100vw - 40px)',
        maxHeight: '80vh', overflow: 'auto',
        background: 'var(--paper-0)',
        border: '1px solid oklch(from var(--paper-4) l c h / 0.7)',
        borderRadius: 16,
        boxShadow: 'var(--shadow-3)',
        padding: '28px 32px 24px',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
          <span className="mono-caps" style={{ color: 'var(--bloom-2)' }}>DECISION · {decision.date}</span>
          <div style={{ flex: 1 }} />
          <button onClick={onClose} style={{ padding: 6, color: 'var(--ink-3)' }} title="Close"><Ico.X /></button>
        </div>
        <div style={{
          fontFamily: 'var(--font-serif)', fontSize: 30, fontWeight: 500,
          letterSpacing: '-0.02em', lineHeight: 1.15,
          color: 'var(--ink-0)',
          textDecoration: decision.status === 'superseded' ? 'line-through' : 'none',
          marginBottom: 18,
        }}>{decision.title}</div>

        {decision.evidence && (
          <>
            <div className="mono-caps" style={{ marginBottom: 8 }}>Evidence · from transcript</div>
            <div style={{
              padding: '12px 14px 12px 16px',
              borderLeft: '3px solid var(--bloom-2)',
              background: 'oklch(from var(--bloom-1) l c h / 0.05)',
              borderRadius: '0 8px 8px 0',
              fontFamily: 'var(--font-serif)', fontStyle: 'italic',
              fontSize: 15, lineHeight: 1.55, color: 'var(--ink-0)',
              marginBottom: 20,
            }}>"{decision.evidence}"</div>
          </>
        )}

        <div className="mono-caps" style={{ marginBottom: 8 }}>Metadata</div>
        <div style={{ display: 'grid', gap: 8, marginBottom: 22 }}>
          <MetaRow k="Status" v={<StatusPill status={decision.status} />} />
          {decision.owner && <MetaRow k="Owner" v={<OwnerChip name={decision.owner} color={decision.ownerColor}/>} />}
          {decision.from && <MetaRow k="Extracted from" v={<button onClick={onGoMeeting} style={{ color: 'var(--bloom-2)', textDecoration: 'underline dotted', cursor: 'pointer', fontFamily: 'var(--font-mono)', fontSize: 12 }}>{decision.from.label}</button>} />}
          {decision.superseded && <MetaRow k="Superseded by" v={<span style={{ color: 'var(--bloom-2)' }}>{decision.superseded}</span>} />}
        </div>

        <div className="mono-caps" style={{ marginBottom: 8 }}>Related</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 22 }}>
          <button onClick={onGoAction} style={chipStyle}><ActionIcon /> 2 actions from this decision</button>
          <button onClick={onGoBoard} style={chipStyle}><Ico.Layers /> Referenced on 1 board</button>
        </div>

        <div style={{ display: 'flex', gap: 8, borderTop: '1px solid oklch(from var(--paper-4) l c h / 0.5)', paddingTop: 16 }}>
          <button className="btn ghost" onClick={onClose} style={{ flex: 1 }}>Close</button>
          <button className="btn primary" style={{ flex: 1 }} onClick={onGoBoard}>
            <Ico.Layers /> Open on board
          </button>
        </div>
      </div>
    </>
  );
}
const chipStyle = {
  display: 'inline-flex', alignItems: 'center', gap: 5,
  padding: '5px 10px 5px 8px',
  background: 'oklch(from var(--paper-2) l c h / 0.7)',
  border: '1px solid oklch(from var(--paper-4) l c h / 0.5)',
  borderRadius: 999,
  fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--ink-1)',
  cursor: 'pointer',
};
function MetaRow({ k, v }) {
  return (
    <div style={{ display: 'flex', gap: 14, alignItems: 'center', fontSize: 13 }}>
      <span className="mono-caps" style={{ width: 120, flexShrink: 0 }}>{k}</span>
      <span>{v}</span>
    </div>
  );
}
function StatusPill({ status }) {
  const m = {
    active:     { c: 'var(--moss)',      l: 'Active' },
    review:     { c: 'var(--bloom-2)',   l: 'In review' },
    pending:    { c: 'oklch(0.5 0.14 65)', l: 'Pending' },
    superseded: { c: 'var(--ink-3)',     l: 'Superseded' },
  }[status] || { c: 'var(--ink-3)', l: status };
  return (
    <span className="mono" style={{
      padding: '2px 8px', borderRadius: 4,
      background: `oklch(from ${m.c} l c h / 0.15)`, color: m.c,
      fontSize: 10.5, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase',
    }}>{m.l}</span>
  );
}
function OwnerChip({ name, color }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--ink-0)' }}>
      <span style={{
        width: 18, height: 18, borderRadius: 999,
        background: color, color: 'white',
        fontFamily: 'var(--font-mono)', fontSize: 9, fontWeight: 700,
        display: 'grid', placeItems: 'center',
      }}>{name[0]}</span>
      {name}
    </span>
  );
}

// ============================================================
// Screen 15 — Actions inbox
// ============================================================
function ScreenIntelActions() {
  const go = useLucentGo();
  const [scope, setScope] = useState('mine');

  const actions = [
    { title: 'Draft cart-review wireframes (screens 1–2)', owner: 'Alex',  ownerColor: 'oklch(0.55 0.16 25)',  due: 'Fri', priority: 'P1', project: 'Payment launch', decision: 'Guest checkout default' },
    { title: 'Integrate Klarna sandbox in staging',        owner: 'John',  ownerColor: 'oklch(0.55 0.14 148)', due: 'Mon', priority: 'P0', project: 'Payment launch', external: 'LIN-482', decision: 'Klarna at launch', status: 'doing' },
    { title: 'Add /pay route to API Gateway',              owner: 'John',  ownerColor: 'oklch(0.55 0.14 148)', due: 'OVERDUE · yesterday', priority: 'P0', project: 'Payment launch', external: 'LIN-476', status: 'blocked' },
    { title: 'Spec gift-wrapping micro-flow',              owner: 'Sarah', ownerColor: 'oklch(0.55 0.11 220)', due: 'Wed', priority: 'P2', project: 'Payment launch' },
    { title: 'Validate 3DS callback in Stripe test mode',  owner: 'John',  ownerColor: 'oklch(0.55 0.14 148)', due: 'Tomorrow', priority: 'P1', project: 'Payment launch', decision: 'Silent retry policy' },
    { title: 'Announce checkout redesign in #product',     owner: 'Alex',  ownerColor: 'oklch(0.55 0.16 25)',  due: 'Next Mon', priority: 'P3', project: 'Payment launch' },
    { title: 'Migrate users table to Postgres 16',         owner: 'Kim',   ownerColor: 'oklch(0.55 0.16 300)', due: 'Oct 15', priority: 'P1', project: 'DB migration', decision: 'Postgres 16 standard', status: 'done' },
    { title: 'Deprecate legacy auth endpoints',            owner: 'John',  ownerColor: 'oklch(0.55 0.14 148)', due: 'Nov 1', priority: 'P2', project: 'Auth v3', decision: 'OAuth over SAML', status: 'done' },
  ];

  const scopes = [
    { id: 'mine',    label: 'Mine',    count: actions.filter(a => a.owner === 'Alex').length },
    { id: 'team',    label: 'Team',    count: actions.length },
    { id: 'blocked', label: 'Blocked', count: actions.filter(a => a.status === 'blocked').length },
    { id: 'overdue', label: 'Overdue', count: actions.filter(a => a.due && a.due.startsWith('OVERDUE')).length },
    { id: 'done',    label: 'Done',    count: actions.filter(a => a.status === 'done').length },
  ];
  const shown =
    scope === 'mine'    ? actions.filter(a => a.owner === 'Alex') :
    scope === 'blocked' ? actions.filter(a => a.status === 'blocked') :
    scope === 'overdue' ? actions.filter(a => a.due && a.due.startsWith('OVERDUE')) :
    scope === 'done'    ? actions.filter(a => a.status === 'done') :
    actions;

  return (
    <AppShell activeArea="intel"
      crumbs={[{ label: 'Personal', screen: 6 }, { label: 'Intelligence', current: false }, { label: 'Actions', current: true }]}
    >
      <IntelSubnav active="actions" />
      <div style={{ padding: '20px 40px 60px', maxWidth: 1240, margin: '0 auto' }}>
        <SectionHeader
          eyebrow="Fig. 15 · Intelligence · Actions"
          title="Actions"
          meta={`${actions.length} across 3 projects · 1 blocked · 1 overdue`}
          actions={<>
            <button className="icon-btn" onClick={() => go(23)}><LinearMark /> Sync with Linear</button>
            <button className="icon-btn primary"><Ico.Plus /> New action</button>
          </>}
        />
        <FilterBar filters={scopes} active={scope} onChange={setScope} />
        <div style={{ display: 'grid', gap: 8 }}>
          {shown.map((a, i) => <ActionCard key={i} {...a} />)}
        </div>
      </div>
    </AppShell>
  );
}

// ============================================================
// Screen 16 — Knowledge graph + Ask Lucent
// ============================================================
function ScreenIntelKnowledge() {
  const [q, setQ] = useState(() => {
    try {
      const stored = localStorage.getItem('lucent.v2.askInitial');
      if (stored) { localStorage.removeItem('lucent.v2.askInitial'); return stored; }
    } catch (e) {}
    return 'Which decisions have we made about payments?';
  });
  return (
    <AppShell activeArea="intel"
      crumbs={[{ label: 'Personal', screen: 6 }, { label: 'Intelligence', current: false }, { label: 'Knowledge · Ask', current: true }]}
    >
      <IntelSubnav active="knowledge" />
      <div style={{ padding: '20px 40px 60px', maxWidth: 1240, margin: '0 auto' }}>
        <SectionHeader
          eyebrow="Fig. 16 · Intelligence · Knowledge"
          title="Ask Lucent"
          meta="Reasoning over everything · with evidence"
        />

        {/* Ask input */}
        <div style={{
          padding: '18px 22px',
          background: 'var(--paper-0)',
          border: '1px solid oklch(from var(--paper-4) l c h / 0.7)',
          borderRadius: 16,
          marginBottom: 24,
          boxShadow: 'var(--shadow-2)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
            <div style={{
              width: 32, height: 32, borderRadius: 10,
              background: 'var(--bloom-wash)', border: '1px solid var(--bloom-wash-2)',
              display: 'grid', placeItems: 'center', color: 'var(--bloom-2)',
            }}><Ico.Sparkle /></div>
            <input
              value={q}
              onChange={e => setQ(e.target.value)}
              style={{
                flex: 1, fontSize: 17, color: 'var(--ink-0)',
                fontFamily: 'var(--font-serif)', fontStyle: 'italic',
              }}
            />
            <button className="btn bloom" style={{ height: 36, padding: '0 16px', flex: 'none' }}>
              Ask · ↵
            </button>
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', paddingLeft: 44 }}>
            <span className="mono-caps" style={{ marginRight: 4 }}>Scope</span>
            <ScopeChip active label="This workspace" />
            <ScopeChip label="This project" />
            <ScopeChip label="Last 30 days" />
            <ScopeChip label="From @Sarah" />
            <div style={{ flex: 1 }} />
            <span className="mono" style={{ fontSize: 10, color: 'var(--ink-3)' }}>16 boards · 42 decisions · 208 utterances</span>
          </div>
        </div>

        {/* Answer */}
        <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 24 }}>
          {/* Answer with evidence */}
          <div style={{
            padding: '22px 26px',
            background: 'var(--paper-0)',
            border: '1px solid oklch(from var(--paper-4) l c h / 0.5)',
            borderRadius: 14,
          }}>
            <div className="mono-caps" style={{ marginBottom: 12, color: 'var(--bloom-2)' }}>
              <Ico.Sparkle style={{ display: 'inline', verticalAlign: -2, marginRight: 4 }} />
              Answer · confidence 0.91
            </div>
            <div style={{
              fontFamily: 'var(--font-serif)', fontSize: 16, lineHeight: 1.6,
              color: 'var(--ink-0)', marginBottom: 20,
            }}>
              You've made <b>four active decisions</b> about payments in the last month,
              plus one that was superseded today.
              <br/><br/>
              Today's Checkout review established that the Payment Service will sit behind
              the API gateway<CitationPill n="1" />, guest checkout is the default flow
              <CitationPill n="2" />, and Stripe intermittency is handled by a silent
              two-retry policy<CitationPill n="3" />. Klarna support at launch is
              <em> in review</em>: it supersedes the Sep 12 decision to defer it to Q1
              <CitationPill n="4" />.
              <br/><br/>
              Also relevant: the OAuth-over-SAML choice from Sep 5 is what makes guest
              checkout viable — you don't need enterprise SSO for the checkout path
              <CitationPill n="5" />.
            </div>

            <div className="mono-caps" style={{ marginBottom: 10 }}>Related decisions</div>
            <div style={{ display: 'grid', gap: 8 }}>
              {[
                { n: 1, t: 'Payment Service goes behind the API gateway', from: 'Checkout review · today · 14:32', by: 'Alex' },
                { n: 2, t: 'Guest checkout is the default checkout path',  from: 'Checkout review · today · 14:32', by: 'Alex' },
                { n: 3, t: 'Silent retry policy on Stripe intermittency', from: 'Checkout review · today · 14:36', by: 'John' },
                { n: 4, t: 'Support Klarna at launch',                     from: 'Checkout review · today · 14:34', by: 'John', status: 'review' },
                { n: 5, t: 'OAuth over SAML for enterprise auth',          from: 'Auth v3 kickoff · Sep 5',           by: 'John' },
              ].map(e => (
                <div key={e.n} style={{
                  display: 'flex', alignItems: 'flex-start', gap: 10,
                  padding: '10px 12px',
                  background: 'oklch(from var(--paper-2) l c h / 0.6)',
                  border: '1px solid oklch(from var(--paper-4) l c h / 0.4)',
                  borderRadius: 8,
                }}>
                  <span style={{
                    width: 20, height: 20, borderRadius: 999,
                    background: 'var(--bloom-2)', color: 'white',
                    fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 700,
                    display: 'grid', placeItems: 'center', flexShrink: 0,
                  }}>{e.n}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--ink-0)', marginBottom: 2 }}>
                      {e.t}
                      {e.status === 'review' && (
                        <span style={{
                          marginLeft: 8,
                          padding: '1px 6px', borderRadius: 3,
                          background: 'var(--bloom-wash)', color: 'var(--bloom-2)',
                          fontFamily: 'var(--font-mono)', fontSize: 9.5, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase',
                        }}>REVIEW</span>
                      )}
                    </div>
                    <div className="mono" style={{ fontSize: 10.5, color: 'var(--ink-3)', letterSpacing: '0.02em' }}>
                      {e.from} · {e.by}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Knowledge graph preview */}
          <div>
            <div className="mono-caps" style={{ marginBottom: 10 }}>Knowledge graph · payment topic</div>
            <div style={{
              padding: 20, borderRadius: 14,
              background: 'var(--paper-0)',
              border: '1px solid oklch(from var(--paper-4) l c h / 0.5)',
              boxShadow: 'var(--shadow-1)',
              height: 360, position: 'relative', overflow: 'hidden',
            }}>
              <KnowledgeGraph />
            </div>

            {/* Suggested follow-ups */}
            <div className="mono-caps" style={{ marginTop: 22, marginBottom: 10 }}>Follow-ups</div>
            <div style={{ display: 'grid', gap: 6 }}>
              {[
                'What assumptions is the Klarna decision based on?',
                'Show me every action still open for the Payment launch',
                'Which meetings mentioned PostgreSQL last month?',
                'Whose approval is needed for the Klarna decision?',
              ].map((s, i) => (
                <button key={i}
                  onClick={() => setQ(s)}
                  style={{
                    padding: '9px 12px', borderRadius: 8,
                    background: 'oklch(from var(--paper-2) l c h / 0.5)',
                    border: '1px solid oklch(from var(--paper-4) l c h / 0.4)',
                    fontSize: 12.5, color: 'var(--ink-1)',
                    fontFamily: 'var(--font-serif)', fontStyle: 'italic',
                    textAlign: 'left',
                    display: 'flex', alignItems: 'center', gap: 8,
                    transition: 'all 0.12s',
                    cursor: 'pointer',
                  }}
                  onMouseEnter={e => { e.currentTarget.style.background = 'var(--paper-2)'; e.currentTarget.style.borderColor = 'var(--ink-3)'; }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'oklch(from var(--paper-2) l c h / 0.5)'; e.currentTarget.style.borderColor = 'oklch(from var(--paper-4) l c h / 0.4)'; }}
                >
                  <Ico.Sparkle style={{ color: 'var(--bloom-2)', flexShrink: 0 }} />
                  <span>{s}</span>
                  <div style={{ flex: 1 }}/>
                  <Ico.Arrow style={{ color: 'var(--ink-3)' }} />
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </AppShell>
  );
}

function IntelSubnav({ active }) {
  const go = useLucentGo();
  const items = [
    { id: 'decisions', label: 'Decisions', to: 14, icon: <DecisionIcon /> },
    { id: 'actions',   label: 'Actions',   to: 15, icon: <ActionIcon /> },
    { id: 'questions', label: 'Questions', to: 15, icon: <QuestionIcon /> },
    { id: 'risks',     label: 'Risks',     to: 15, icon: <RiskIcon /> },
    { id: 'knowledge', label: 'Knowledge · Ask', to: 16, icon: <Ico.Sparkle /> },
  ];
  return (
    <div style={{
      display: 'flex', gap: 4,
      padding: '12px 40px 0',
      borderBottom: '1px solid oklch(from var(--paper-4) l c h / 0.5)',
      maxWidth: 1240, margin: '0 auto', width: '100%',
    }}>
      {items.map(it => (
        <button key={it.id} onClick={() => go(it.to)} style={{
          padding: '10px 14px 12px',
          display: 'inline-flex', alignItems: 'center', gap: 6,
          fontSize: 13, fontWeight: 500,
          color: active === it.id ? 'var(--ink-0)' : 'var(--ink-2)',
          borderBottom: `2px solid ${active === it.id ? 'var(--ink-0)' : 'transparent'}`,
          marginBottom: -1,
        }}>
          {it.icon}
          {it.label}
        </button>
      ))}
    </div>
  );
}

function ScopeChip({ label, active }) {
  return (
    <button style={{
      padding: '3px 10px', borderRadius: 999,
      background: active ? 'var(--ink-0)' : 'oklch(from var(--paper-2) l c h / 0.7)',
      color: active ? 'var(--paper-0)' : 'var(--ink-1)',
      border: `1px solid ${active ? 'var(--ink-0)' : 'oklch(from var(--paper-4) l c h / 0.5)'}`,
      fontSize: 11.5, fontWeight: 500,
    }}>{label}</button>
  );
}

// Simplified knowledge graph — nodes + edges
function KnowledgeGraph() {
  const nodes = [
    { x: 200, y: 30,  label: 'Payments', kind: 'topic',    hi: true },
    { x: 60,  y: 130, label: 'Stripe',   kind: 'system' },
    { x: 200, y: 150, label: 'Klarna',   kind: 'system' },
    { x: 340, y: 130, label: 'Gateway',  kind: 'system' },
    { x: 100, y: 240, label: 'D#42',     kind: 'decision' },
    { x: 200, y: 280, label: 'D#67',     kind: 'decision',  hi: true },
    { x: 300, y: 240, label: 'D#69',     kind: 'decision' },
    { x: 60,  y: 320, label: 'Checkout', kind: 'meeting' },
    { x: 340, y: 320, label: 'John',     kind: 'person' },
  ];
  const edges = [
    { a: 0, b: 1, label: 'uses' },
    { a: 0, b: 2, label: 'via' },
    { a: 0, b: 3, label: 'routes' },
    { a: 1, b: 4, label: 'decided' },
    { a: 2, b: 5, label: 'decided' },
    { a: 3, b: 6, label: 'decided' },
    { a: 4, b: 7, label: 'in' },
    { a: 5, b: 7, label: 'in' },
    { a: 6, b: 8, label: 'by' },
  ];
  const kindColor = {
    topic: 'var(--ink-0)',
    system: 'var(--moss)',
    decision: 'var(--bloom-2)',
    meeting: 'var(--madder)',
    person: 'oklch(0.55 0.14 200)',
  };
  return (
    <svg width="100%" height="100%" viewBox="0 0 400 360">
      <defs>
        <marker id="kg-arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
          <path d="M0 0 L10 5 L0 10z" fill="var(--ink-3)"/>
        </marker>
      </defs>
      {edges.map((e, i) => {
        const a = nodes[e.a], b = nodes[e.b];
        return (
          <g key={i}>
            <path d={`M ${a.x} ${a.y} L ${b.x} ${b.y}`}
              stroke="var(--ink-3)" strokeWidth="1"
              fill="none" markerEnd="url(#kg-arr)" opacity="0.5"/>
          </g>
        );
      })}
      {nodes.map((n, i) => (
        <g key={i}>
          <circle cx={n.x} cy={n.y} r={n.hi ? 22 : 16}
            fill={n.hi ? kindColor[n.kind] : 'var(--paper-0)'}
            stroke={kindColor[n.kind]} strokeWidth="1.8"/>
          <text x={n.x} y={n.y + 4} textAnchor="middle"
            fontFamily="var(--font-mono)" fontSize={n.hi ? 10 : 9}
            fontWeight={n.hi ? 700 : 500}
            fill={n.hi ? 'white' : kindColor[n.kind]}
          >{n.label}</text>
        </g>
      ))}
    </svg>
  );
}

Object.assign(window, { ScreenIntelDecisions, ScreenIntelActions, ScreenIntelKnowledge });
