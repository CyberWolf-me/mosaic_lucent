// Screens 18-19 — Execution · Projects overview + Task detail (Decision → Task chain)

// ============================================================
// Screen 18 — Projects overview
// ============================================================
function ScreenExecProjects() {
  const go = useLucentGo();
  return (
    <AppShell activeArea="exec"
      crumbs={[{ label: 'Personal', screen: 6 }, { label: 'Execution', current: true }]}
    >
      <div style={{ padding: '32px 40px 60px', maxWidth: 1280, margin: '0 auto' }}>
        <SectionHeader
          eyebrow="Fig. 18 · Execution · Projects"
          title="Q4 execution"
          meta="4 projects · 42 open actions · 3 blocked"
          actions={<>
            <button className="icon-btn" onClick={() => go(23)}><LinearMark /> Sync with Linear</button>
            <button className="icon-btn primary"><Ico.Plus /> New project</button>
          </>}
        />

        {/* Stats */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14, marginBottom: 32 }}>
          <StatCard label="Velocity · this week" value="12" delta="+4" sub="tasks shipped" />
          <StatCard label="Blocked" value="3" color="var(--madder)" sub="oldest: 4 days" />
          <StatCard label="Overdue" value="1" color="var(--madder)" sub="Payment /pay route" />
          <StatCard label="On-track projects" value="3 / 4" color="var(--moss)" />
        </div>

        {/* Timeline / Gantt view */}
        <div className="mono-caps" style={{ marginBottom: 12 }}>Timeline · Q4</div>
        <div style={{
          padding: 20,
          borderRadius: 14,
          background: 'var(--paper-0)',
          border: '1px solid oklch(from var(--paper-4) l c h / 0.5)',
          marginBottom: 32,
          overflow: 'hidden',
        }}>
          <GanttTimeline />
        </div>

        {/* Projects grid */}
        <div className="mono-caps" style={{ marginBottom: 12 }}>Projects</div>
        <div style={{ display: 'grid', gap: 14 }}>
          {[
            {
              name: 'Payment Service launch', target: 'Nov 15', progress: 68, blockers: 1,
              streams: [
                { name: 'Backend',  done: 8,  total: 12, blocked: 1 },
                { name: 'Frontend', done: 4,  total: 8 },
                { name: 'Payments', done: 3,  total: 5 },
              ],
              decision: 'Payment Service goes behind the gateway · today',
            },
            {
              name: 'Auth v3 rollout', target: 'Dec 1', progress: 32, blockers: 0,
              streams: [
                { name: 'Backend',   done: 3,  total: 8 },
                { name: 'Migration', done: 1,  total: 4 },
              ],
              decision: 'OAuth over SAML · Sep 5',
            },
            {
              name: 'Onboarding overhaul', target: 'Jan 15', progress: 12, blockers: 0,
              streams: [
                { name: 'Research', done: 2, total: 4 },
              ],
              decision: 'Ship redesigned checkout by Black Friday · Aug 28',
            },
          ].map((p, i) => <ProjectRow key={i} {...p} />)}
        </div>
      </div>
    </AppShell>
  );
}

function ProjectRow({ name, target, progress, blockers, streams, decision }) {
  const go = useLucentGo();
  return (
    <div style={{
      padding: 20,
      borderRadius: 14,
      background: 'var(--paper-0)',
      border: '1px solid oklch(from var(--paper-4) l c h / 0.5)',
      boxShadow: 'var(--shadow-1)',
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 14, marginBottom: 14 }}>
        <div style={{ fontFamily: 'var(--font-serif)', fontSize: 22, fontWeight: 500, letterSpacing: '-0.01em' }}>{name}</div>
        <div style={{ flex: 1 }} />
        {blockers > 0 && (
          <span style={{
            padding: '3px 10px', borderRadius: 999,
            background: 'oklch(from var(--madder) l c h / 0.12)',
            color: 'var(--madder)',
            fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 700, letterSpacing: '0.05em',
          }}>{blockers} BLOCKED</span>
        )}
        <span className="mono" style={{ fontSize: 11, color: 'var(--ink-3)' }}>Target · {target}</span>
        <button className="icon-btn" onClick={() => go(19)} style={{ height: 28, fontSize: 12 }}>Open →</button>
      </div>

      {/* Provenance to decision */}
      {decision && (
        <div style={{ marginBottom: 14 }}>
          <ProvenanceChip icon={<DecisionIcon />} label={decision} />
        </div>
      )}

      {/* Workstream progress */}
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${streams.length}, 1fr)`, gap: 10, marginBottom: 12 }}>
        {streams.map((s, i) => (
          <div key={i} style={{
            padding: '10px 12px',
            borderRadius: 8,
            background: 'oklch(from var(--paper-2) l c h / 0.7)',
            border: '1px solid oklch(from var(--paper-4) l c h / 0.4)',
          }}>
            <div className="mono-caps" style={{ marginBottom: 6 }}>
              {s.name}
              {s.blocked > 0 && <span style={{ marginLeft: 6, color: 'var(--madder)' }}>· {s.blocked} blocked</span>}
            </div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 15, fontWeight: 600, color: 'var(--ink-0)' }}>{s.done}</span>
              <span className="mono" style={{ fontSize: 11, color: 'var(--ink-3)' }}>/ {s.total}</span>
            </div>
            <div style={{ height: 4, borderRadius: 999, background: 'var(--paper-3)', overflow: 'hidden' }}>
              <div style={{
                width: `${(s.done / s.total) * 100}%`, height: '100%',
                background: s.blocked > 0 ? 'var(--madder)' : 'var(--moss)',
                borderRadius: 999,
              }} />
            </div>
          </div>
        ))}
      </div>

      {/* Overall progress */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span className="mono" style={{ fontSize: 11, color: 'var(--ink-2)', minWidth: 40 }}>{progress}%</span>
        <div style={{ flex: 1, height: 6, borderRadius: 999, background: 'var(--paper-3)', overflow: 'hidden' }}>
          <div style={{ width: `${progress}%`, height: '100%', background: blockers > 0 ? 'var(--madder)' : 'var(--moss)' }} />
        </div>
      </div>
    </div>
  );
}

function GanttTimeline() {
  const weeks = ['Oct 1', 'Oct 8', 'Oct 15', 'Oct 22', 'Oct 29', 'Nov 5', 'Nov 12', 'Nov 19', 'Nov 26', 'Dec 3', 'Dec 10'];
  const projects = [
    { name: 'Payment Service launch', color: 'var(--bloom-2)', start: 1, end: 7, done: 0.68 },
    { name: 'Auth v3 rollout',        color: 'var(--moss)',    start: 3, end: 10, done: 0.32 },
    { name: 'Onboarding overhaul',    color: 'var(--saffron)', start: 6, end: 10, done: 0.12 },
    { name: 'Q4 launch marketing',    color: 'oklch(0.55 0.14 200)', start: 0, end: 4, done: 0.88 },
  ];
  const colWidth = 90;
  const totalW = weeks.length * colWidth;
  return (
    <div style={{ overflow: 'auto' }}>
      <div style={{ width: totalW, position: 'relative' }}>
        {/* Week header */}
        <div style={{ display: 'flex', borderBottom: '1px solid oklch(from var(--paper-4) l c h / 0.5)', paddingBottom: 8 }}>
          {weeks.map((w, i) => (
            <div key={i} style={{
              width: colWidth, textAlign: 'center',
              fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--ink-3)',
              letterSpacing: '0.03em',
            }}>{w}</div>
          ))}
        </div>
        {/* Rows */}
        {projects.map((p, i) => (
          <div key={i} style={{ position: 'relative', height: 40, marginTop: 10 }}>
            <div style={{
              position: 'absolute', left: 0, top: 8, bottom: 8,
              width: totalW,
              background: 'oklch(from var(--paper-2) l c h / 0.4)',
              borderRadius: 8,
            }} />
            <div style={{
              position: 'absolute',
              left: p.start * colWidth,
              width: (p.end - p.start) * colWidth,
              top: 8, bottom: 8,
              background: `linear-gradient(90deg, ${p.color}, oklch(from ${p.color} calc(l - 0.05) c h))`,
              borderRadius: 8,
              display: 'flex', alignItems: 'center', padding: '0 12px',
              boxShadow: 'var(--shadow-1)',
            }}>
              <span style={{ fontSize: 11.5, fontWeight: 600, color: 'white', textShadow: '0 1px 2px rgba(0,0,0,0.15)', whiteSpace: 'nowrap' }}>
                {p.name}
              </span>
              <div style={{ flex: 1 }} />
              <span className="mono" style={{ fontSize: 10, color: 'white', opacity: 0.9 }}>
                {Math.round(p.done * 100)}%
              </span>
            </div>
            {/* Progress overlay */}
            <div style={{
              position: 'absolute',
              left: p.start * colWidth,
              width: (p.end - p.start) * colWidth * p.done,
              top: 8, bottom: 8,
              background: 'oklch(1 0 0 / 0.15)',
              borderRadius: '8px 0 0 8px',
            }} />
          </div>
        ))}
        {/* Today marker */}
        <div style={{
          position: 'absolute', left: 2 * colWidth + 20, top: 22, bottom: 0,
          width: 2, background: 'var(--madder)',
        }} />
        <div style={{
          position: 'absolute', left: 2 * colWidth + 8, top: 22,
          padding: '2px 6px', borderRadius: 4,
          background: 'var(--madder)', color: 'white',
          fontFamily: 'var(--font-mono)', fontSize: 9, fontWeight: 700, letterSpacing: '0.05em',
        }}>TODAY</div>
      </div>
    </div>
  );
}

// ============================================================
// Screen 19 — Task detail · the Decision → Action → Task chain
// ============================================================
const TASK_STATUS = {
  todo:    { c: 'var(--ink-3)',   ic: <ActionIcon />, l: 'TODO · P0' },
  doing:   { c: 'var(--bloom-2)', ic: <ActionIcon />, l: 'DOING · P0' },
  blocked: { c: 'var(--madder)',  ic: <RiskIcon />,   l: 'BLOCKED · P0' },
  done:    { c: 'var(--moss)',    ic: <Ico.Check />,  l: 'DONE · P0' },
};

function ScreenExecTask() {
  const go = useLucentGo();
  const [status, setStatus] = useState('blocked');
  const [statusOpen, setStatusOpen] = useState(false);
  const [toast, setToast] = useState(null);
  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(null), 2400); };
  return (
    <AppShell activeArea="exec"
      crumbs={[
        { label: 'Personal', screen: 6 },
        { label: 'Execution', screen: 18 },
        { label: 'Payment Service launch', screen: 18 },
        { label: 'Add /pay route to API Gateway', current: true },
      ]}
    >
      <div style={{ padding: '32px 40px 60px', maxWidth: 1000, margin: '0 auto' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, marginBottom: 8 }}>
          <div style={{
            width: 26, height: 26, borderRadius: 6,
            border: `1.5px solid ${TASK_STATUS[status].c}`,
            display: 'grid', placeItems: 'center',
            color: status === 'done' ? 'white' : TASK_STATUS[status].c, flexShrink: 0, marginTop: 8,
            background: status === 'done' ? TASK_STATUS[status].c : 'transparent',
          }}>
            {TASK_STATUS[status].ic}
          </div>
          <div style={{ flex: 1 }}>
            <div className="mono-caps" style={{ marginBottom: 4, color: TASK_STATUS[status].c }}>{TASK_STATUS[status].l}</div>
            <div style={{
              fontFamily: 'var(--font-serif)', fontSize: 32, fontWeight: 500,
              color: 'var(--ink-0)', letterSpacing: '-0.02em', lineHeight: 1.2,
            }}>
              Add /pay route to API Gateway
            </div>
          </div>
          <button className="icon-btn" onClick={() => showToast('Comment thread opened in inspector')}>
            <Ico.Comment /> Comment
          </button>
          <div style={{ position: 'relative' }}>
            <button className="icon-btn primary" onClick={() => setStatusOpen(o => !o)}>
              Update status
            </button>
            {statusOpen && (
              <>
                <div onClick={() => setStatusOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 30 }} />
                <div style={{
                  position: 'absolute', top: 40, right: 0, zIndex: 40,
                  minWidth: 200, padding: 6,
                  background: 'var(--paper-0)',
                  border: '1px solid oklch(from var(--paper-4) l c h / 0.7)',
                  borderRadius: 10,
                  boxShadow: 'var(--shadow-3)',
                }}>
                  {[
                    { id: 'todo',    label: 'Todo',    color: 'var(--ink-3)' },
                    { id: 'doing',   label: 'Doing',   color: 'var(--bloom-2)' },
                    { id: 'blocked', label: 'Blocked', color: 'var(--madder)' },
                    { id: 'done',    label: 'Done',    color: 'var(--moss)' },
                  ].map(s => (
                    <button key={s.id}
                      onClick={() => { setStatus(s.id); setStatusOpen(false); showToast(`Status set to ${s.label}`); }}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 8,
                        width: '100%', padding: '7px 10px', borderRadius: 6,
                        fontSize: 12.5, color: 'var(--ink-0)', textAlign: 'left',
                        background: status === s.id ? 'var(--paper-2)' : 'transparent',
                      }}
                      onMouseEnter={e => status !== s.id && (e.currentTarget.style.background = 'var(--paper-2)')}
                      onMouseLeave={e => status !== s.id && (e.currentTarget.style.background = 'transparent')}
                    >
                      <span style={{ width: 8, height: 8, borderRadius: 999, background: s.color }} />
                      {s.label}
                      {status === s.id && <span style={{ marginLeft: 'auto', color: s.color }}><Ico.Check /></span>}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
          {toast && (
            <div style={{
              position: 'fixed', bottom: 84, left: '50%', transform: 'translateX(-50%)',
              zIndex: 100,
              padding: '10px 16px',
              background: 'var(--ink-0)', color: 'var(--paper-0)',
              borderRadius: 999,
              fontSize: 12.5, fontFamily: 'var(--font-mono)', letterSpacing: '0.02em',
              boxShadow: 'var(--shadow-3)',
              display: 'inline-flex', alignItems: 'center', gap: 6,
              animation: 'ink-bloom 0.35s var(--e-out) both',
            }}>
              <Ico.Check style={{ color: 'var(--bloom-1)' }} /> {toast}
            </div>
          )}
        </div>

        {/* Meta row */}
        <div style={{ display: 'flex', gap: 14, alignItems: 'center', marginBottom: 32, flexWrap: 'wrap' }}>
          <MetaField label="Owner">
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 13, color: 'var(--ink-0)' }}>
              <span style={{
                width: 18, height: 18, borderRadius: 999,
                background: 'oklch(0.55 0.14 148)', color: 'white',
                fontFamily: 'var(--font-mono)', fontSize: 9, fontWeight: 700,
                display: 'grid', placeItems: 'center',
              }}>J</span>
              John Torres
            </span>
          </MetaField>
          <MetaField label="Due">
            <span className="mono" style={{ fontSize: 13, color: 'var(--madder)', fontWeight: 600 }}>OVERDUE · yesterday</span>
          </MetaField>
          <MetaField label="Priority"><PriorityChip level="P0" /></MetaField>
          <MetaField label="External"><span style={{
            display: 'inline-flex', alignItems: 'center', gap: 4,
            padding: '2px 8px',
            background: 'oklch(0.55 0.14 265 / 0.12)',
            color: 'oklch(0.5 0.14 265)',
            fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 600,
            borderRadius: 4,
          }}><LinearMark /> LIN-476</span></MetaField>
        </div>

        {/* The chain — Meeting → Decision → Action → Task → External → Execution */}
        <div className="mono-caps" style={{ marginBottom: 12 }}>Provenance chain</div>
        <div style={{
          padding: '18px 22px',
          background: 'var(--paper-0)',
          border: '1px solid oklch(from var(--paper-4) l c h / 0.5)',
          borderRadius: 14,
          marginBottom: 32,
        }}>
          <ChainLink icon={<Ico.Present />} kind="MEETING" label="Checkout design review" meta="today · 14:12 – 14:46" color="var(--madder)" onClick={() => go(13)}/>
          <ChainArrow />
          <ChainLink icon={<Ico.Comment />} kind="UTTERANCE" label='"…adding it there now. Route will be /pay."' meta="John · 14:28" color="oklch(0.55 0.14 148)" italic />
          <ChainArrow />
          <ChainLink icon={<DecisionIcon />} kind="DECISION" label="Payment Service goes behind the gateway" meta="today · 14:32 · by Alex" color="var(--bloom-2)" onClick={() => go(14)}/>
          <ChainArrow />
          <ChainLink icon={<ActionIcon />} kind="ACTION" label="Add /pay route to API Gateway" meta="John · P0 · due yesterday" color="var(--moss)" onClick={() => go(15)}/>
          <ChainArrow />
          <ChainLink icon={<LinearMark />} kind="EXTERNAL" label="LIN-476 · Blocked" meta="in Linear · Backend · John" color="oklch(0.5 0.14 265)" />
          <ChainArrow />
          <ChainLink icon={<GithubMark />} kind="COMMIT" label="feat(gateway): add /pay route wiring" meta="PR #482 · draft · 3 commits" color="var(--ink-0)" />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1.6fr 1fr', gap: 24 }}>
          {/* Description + activity */}
          <div>
            <div className="mono-caps" style={{ marginBottom: 10 }}>Description</div>
            <div style={{
              padding: '16px 20px',
              background: 'var(--paper-0)',
              border: '1px solid oklch(from var(--paper-4) l c h / 0.5)',
              borderRadius: 12,
              fontSize: 14, lineHeight: 1.6, color: 'var(--ink-0)',
              fontFamily: 'var(--font-serif)',
              marginBottom: 22,
            }}>
              Route <span className="mono" style={{ fontSize: 12, background: 'var(--paper-2)', padding: '1px 6px', borderRadius: 3 }}>/pay/*</span> from the API Gateway to the new Payment Service.
              Include request signing (see Lucent note on Sep 20) so Stripe webhook callbacks
              can be validated without extra auth exchange.
              <br/><br/>
              Acceptance: gateway rejects unsigned requests, Payment Svc receives forwarded
              body identically to the pre-launch behavior.
            </div>

            <div className="mono-caps" style={{ marginBottom: 10 }}>Blockers</div>
            <div style={{
              padding: '14px 16px',
              background: 'oklch(from var(--madder) l c h / 0.06)',
              border: '1px solid oklch(from var(--madder) l c h / 0.3)',
              borderLeft: '4px solid var(--madder)',
              borderRadius: 8,
              marginBottom: 22,
            }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                <RiskIcon style={{ color: 'var(--madder)', flexShrink: 0, marginTop: 3 }} />
                <div>
                  <div style={{ fontSize: 13.5, fontWeight: 500, color: 'var(--ink-0)', marginBottom: 4 }}>
                    Waiting on 3DS callback validation in Stripe test mode
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--ink-2)', lineHeight: 1.5, marginBottom: 8 }}>
                    Payment Service can't accept webhooks until 3DS is validated. John is
                    waiting on a test-mode API key that requires Stripe support ticket resolution.
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <ProvenanceChip icon={<GithubMark />} label="stripe/stripe-node #482" />
                    <ProvenanceChip icon={<SlackMark />} label="#payments-launch · 2h ago" />
                  </div>
                </div>
              </div>
            </div>

            <div className="mono-caps" style={{ marginBottom: 10 }}>Activity</div>
            <div style={{ display: 'grid', gap: 10 }}>
              {[
                { icon: <LinearMark />, text: <>Marked <b>Blocked</b> in Linear</>,          who: 'John', time: '2h ago', color: 'var(--madder)' },
                { icon: <Ico.Sparkle />, text: <>Lucent linked Stripe support ticket automatically</>, who: 'Lucent', time: '2h ago', color: 'var(--bloom-2)' },
                { icon: <GithubMark />,  text: <>Draft PR opened · <span className="mono">feat(gateway): add /pay route wiring</span></>, who: 'John', time: '5h ago' },
                { icon: <DecisionIcon />, text: <>Action created from decision <span className="mono">D#67</span></>, who: 'Alex',  time: '14:32', color: 'var(--bloom-2)' },
                { icon: <Ico.Present />, text: <>Extracted from Checkout design review</>,    who: 'Lucent', time: '14:28', color: 'var(--bloom-2)' },
              ].map((a, i) => (
                <div key={i} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                  <div style={{
                    width: 22, height: 22, borderRadius: 6,
                    background: `oklch(from ${a.color || 'var(--ink-2)'} l c h / 0.12)`,
                    color: a.color || 'var(--ink-2)',
                    display: 'grid', placeItems: 'center', flexShrink: 0, marginTop: 1,
                  }}>{a.icon}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, color: 'var(--ink-0)' }}>{a.text}</div>
                    <div className="mono" style={{ fontSize: 10.5, color: 'var(--ink-3)', marginTop: 2 }}>
                      {a.who} · {a.time}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Related */}
          <div>
            <div className="mono-caps" style={{ marginBottom: 10 }}>On the board</div>
            <div style={{
              padding: 14, borderRadius: 12,
              background: 'var(--paper-0)',
              border: '1px solid oklch(from var(--paper-4) l c h / 0.5)',
              boxShadow: 'var(--shadow-1)',
              marginBottom: 22,
            }}>
              <div style={{ position: 'relative', height: 140, marginBottom: 10 }}>
                <div className="paper-grid" style={{ position: 'absolute', inset: 0, borderRadius: 6 }} />
                <svg style={{ position: 'absolute', inset: 0 }} viewBox="0 0 300 140">
                  <path d="M60 40 L140 40" stroke="var(--ink-3)" strokeWidth="1"/>
                  <path d="M180 40 L240 70" stroke="var(--madder)" strokeWidth="2" strokeDasharray="4 3"/>
                  <text x="200" y="55" fontFamily="var(--font-mono)" fontSize="9" fill="var(--madder)" fontWeight="600">/pay · missing</text>
                </svg>
                <div style={{ position: 'absolute', left: 20, top: 24, padding: '6px 10px', background: 'var(--paper-0)', border: '1px solid var(--ink-3)', borderRadius: 8, fontSize: 11, fontWeight: 500 }}>Web</div>
                <div style={{ position: 'absolute', left: 140, top: 24, padding: '6px 10px', background: 'var(--paper-0)', border: '2px solid var(--madder)', borderRadius: 8, fontSize: 11, fontWeight: 500 }}>Gateway</div>
                <div style={{ position: 'absolute', left: 220, top: 60, padding: '6px 10px', background: 'var(--paper-0)', border: '1px dashed var(--madder)', borderRadius: 8, fontSize: 11, fontWeight: 500, color: 'var(--madder)' }}>Payment Svc</div>
              </div>
              <button className="btn ghost" style={{ width: '100%', height: 30, fontSize: 12 }} onClick={() => go(3)}>Open on canvas →</button>
            </div>

            <div className="mono-caps" style={{ marginBottom: 10 }}>Related</div>
            <div style={{ display: 'grid', gap: 6 }}>
              <ProvenanceChip icon={<ActionIcon />} label="Sibling: Add /auth route (done)" />
              <ProvenanceChip icon={<QuestionIcon />} label="Q: Retry policy — silent or user?" />
              <ProvenanceChip icon={<Ico.Present />} label="Payment Svc architecture mtg · tomorrow" />
              <ProvenanceChip icon={<DecisionIcon />} label="Silent retry policy · today" />
            </div>
          </div>
        </div>
      </div>
    </AppShell>
  );
}

function MetaField({ label, children }) {
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <span className="mono-caps" style={{ fontSize: 10 }}>{label}</span>
      {children}
    </div>
  );
}

function ChainLink({ icon, kind, label, meta, color, italic, onClick }) {
  return (
    <button onClick={onClick} disabled={!onClick} style={{
      display: 'flex', alignItems: 'flex-start', gap: 12, width: '100%',
      padding: '12px 12px', borderRadius: 8,
      background: 'transparent',
      textAlign: 'left', cursor: onClick ? 'pointer' : 'default',
      transition: 'background 0.12s',
    }}
      onMouseEnter={e => onClick && (e.currentTarget.style.background = 'var(--paper-1)')}
      onMouseLeave={e => onClick && (e.currentTarget.style.background = 'transparent')}
    >
      <div style={{
        width: 30, height: 30, borderRadius: 7,
        background: `oklch(from ${color} l c h / 0.12)`,
        color: color,
        display: 'grid', placeItems: 'center', flexShrink: 0, marginTop: 2,
      }}>{icon}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
          <span className="mono" style={{
            fontSize: 9.5, padding: '2px 7px', borderRadius: 3,
            background: `oklch(from ${color} l c h / 0.15)`, color: color,
            fontWeight: 700, letterSpacing: '0.06em',
          }}>{kind}</span>
          <span className="mono" style={{ fontSize: 10.5, color: 'var(--ink-3)', letterSpacing: '0.02em' }}>{meta}</span>
        </div>
        <div style={{
          fontSize: 13.5, color: 'var(--ink-0)', fontWeight: 500,
          fontStyle: italic ? 'italic' : 'normal',
          fontFamily: italic ? 'var(--font-serif)' : 'var(--font-sans)',
          lineHeight: 1.4,
        }}>{label}</div>
      </div>
      {onClick && <Ico.Arrow style={{ color: 'var(--ink-3)', flexShrink: 0, marginTop: 12 }} />}
    </button>
  );
}
function ChainArrow() {
  return (
    <div style={{
      paddingLeft: 25, height: 12,
      display: 'flex', alignItems: 'center',
      color: 'var(--ink-3)', fontSize: 14,
    }}>↓</div>
  );
}

Object.assign(window, { ScreenExecProjects, ScreenExecTask });
