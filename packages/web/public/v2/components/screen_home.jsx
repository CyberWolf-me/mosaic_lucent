// Screen 11 — Home · "Today's canvas"

function ScreenHome() {
  const go = useLucentGo();
  return (
    <AppShell activeArea="home"
      crumbs={[{ label: 'Personal', current: true }, { label: 'Home' }]}
    >
      <div style={{ padding: '40px 40px 60px', maxWidth: 1240, margin: '0 auto' }}>

        {/* Greeting */}
        <div style={{ marginBottom: 32 }}>
          <div className="mono-caps" style={{ marginBottom: 8, color: 'var(--ink-3)' }}>Wednesday · Sep 20 · 9:14 AM</div>
          <div style={{
            fontFamily: 'var(--font-serif)', fontSize: 44, letterSpacing: '-0.025em',
            fontWeight: 400, color: 'var(--ink-0)', lineHeight: 1.1,
          }}>
            Good morning, Alex.
          </div>
          <div style={{
            marginTop: 8,
            fontFamily: 'var(--font-serif)', fontStyle: 'italic', fontSize: 17,
            color: 'var(--ink-2)',
          }}>
            You have a meeting in 46 minutes and 3 things waiting for review.
          </div>
        </div>

        {/* Ask bar — always available */}
        <HomeAskBar go={go} />


        {/* Stats row — each drills into the relevant screen */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14, marginBottom: 32 }}>
          <ClickableStat onClick={() => go(14)} label="Decisions this week" value="14" delta="+3" sub="2 awaiting review" />
          <ClickableStat onClick={() => go(15)} label="My open actions" value="7" delta="−2" color="var(--bloom-2)" sub="1 overdue" />
          <ClickableStat onClick={() => go(18)} label="Blocked work" value="3" color="var(--madder)" sub="on Payment Svc launch" />
          <ClickableStat onClick={() => go(12)} label="Meetings extracted" value="8" sub="6 hours of transcript" />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 24 }}>
          {/* LEFT: Upcoming + Inbox */}
          <div>
            {/* Upcoming */}
            <div className="mono-caps" style={{ marginBottom: 10 }}>Upcoming · today</div>
            <div style={{ display: 'grid', gap: 10, marginBottom: 32 }}>
              <UpcomingMeeting
                time="10:00" duration="30m" title="Checkout design review"
                participants={[{i: 'S', c: 'oklch(0.55 0.11 220)'}, {i: 'J', c: 'oklch(0.55 0.14 148)'}]}
                board="E-commerce platform"
                inMinutes={46} live
                onOpen={() => go(13)}
              />
              <UpcomingMeeting
                time="13:30" duration="45m" title="Payment Service architecture"
                participants={[{i: 'J', c: 'oklch(0.55 0.14 148)'}, {i: 'K', c: 'oklch(0.55 0.16 300)'}, {i: 'M', c: 'oklch(0.55 0.14 200)'}]}
                board="E-commerce platform"
                inMinutes={266}
              />
              <UpcomingMeeting
                time="15:00" duration="15m" title="1:1 with Sarah"
                participants={[{i: 'S', c: 'oklch(0.55 0.11 220)'}]}
                inMinutes={356}
              />
            </div>

            {/* Inbox */}
            <div className="mono-caps" style={{ marginBottom: 10 }}>Inbox · needs you</div>
            <div style={{ display: 'grid', gap: 8, marginBottom: 32 }}>
              <InboxRow
                kind="approval" title="Approve 6 decisions from yesterday's meeting"
                meta="Payment strategy · from Lucent" time="2h ago"
                onClick={() => go(22)}
              />
              <InboxRow
                kind="mention" title="Sarah mentioned you in Checkout wireframe"
                meta='"@Alex — should we support Klarna at launch?"' time="4h ago"
                onClick={() => go(9)}
              />
              <InboxRow
                kind="assignment" title="You were assigned an action"
                meta="Integrate Klarna sandbox by Mon · from Checkout review" time="Yesterday"
                onClick={() => go(15)}
              />
              <InboxRow
                kind="blocked" title="Payment Service task is blocked"
                meta="Waiting on 3DS callback validation · John" time="Yesterday"
                onClick={() => go(19)}
              />
            </div>
          </div>

          {/* RIGHT: Pinned + Recent + What Lucent noticed */}
          <div>
            <div className="mono-caps" style={{ marginBottom: 10 }}>Pinned</div>
            <div style={{ display: 'grid', gap: 8, marginBottom: 28 }}>
              <PinnedBoard name="E-commerce platform" meta="12 nodes · 2 recent decisions" color="var(--bloom-2)" onClick={() => go(3)}/>
              <PinnedBoard name="Q4 roadmap"          meta="24 workstreams" color="var(--moss)"     onClick={() => go(18)}/>
              <PinnedBoard name="Auth architecture v3" meta="8 nodes · settled"  color="var(--saffron)"  onClick={() => go(3)}/>
            </div>

            {/* What Lucent noticed */}
            <div className="mono-caps" style={{ marginBottom: 10, color: 'var(--bloom-2)' }}>
              <Ico.Sparkle style={{ display: 'inline', verticalAlign: -2, marginRight: 4 }} />
              What Lucent noticed
            </div>
            <div style={{
              padding: 18,
              borderRadius: 14,
              background: 'oklch(from var(--bloom-1) l c h / 0.05)',
              border: '1px solid var(--bloom-wash-2)',
            }}>
              <div style={{
                fontFamily: 'var(--font-serif)', fontSize: 15, lineHeight: 1.55,
                color: 'var(--ink-0)', marginBottom: 12,
              }}>
                Yesterday's Checkout meeting mentioned <b>Klarna support at launch</b>, but
                Decision #42 (from Sep 12) explicitly deferred Klarna to Q1. Might be worth
                clarifying before John integrates.
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <ProvenanceChip icon={<DecisionIcon />} label="Decision #42 · superseded?" />
                <ProvenanceChip icon={<Ico.Present />} label="Checkout review · 14:32" />
              </div>
              <div style={{ display: 'flex', gap: 6, marginTop: 14 }}>
                <button className="btn ghost" onClick={() => go(21)} style={{ height: 30, fontSize: 12 }}>Dismiss</button>
                <button className="btn bloom" onClick={() => go(14)} style={{ height: 30, fontSize: 12, flex: 'none', padding: '0 14px' }}>Review decision</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </AppShell>
  );
}

function ClickableStat({ onClick, ...props }) {
  return (
    <div onClick={onClick} style={{ cursor: 'pointer', transition: 'transform 0.14s var(--e-out)' }}
      onMouseEnter={e => e.currentTarget.style.transform = 'translateY(-2px)'}
      onMouseLeave={e => e.currentTarget.style.transform = 'translateY(0)'}
    >
      <StatCard {...props} />
    </div>
  );
}

function HomeAskBar({ go }) {
  const [v, setV] = useState('');
  const submit = () => {
    if (!v.trim()) return;
    // Persist last question so Ask screen can pick it up
    try { localStorage.setItem('lucent.v2.askInitial', v); } catch (e) {}
    go(16);
  };
  return (
    <div style={{
      padding: '14px 18px',
      background: 'var(--paper-0)',
      border: '1px solid oklch(from var(--paper-4) l c h / 0.7)',
      borderRadius: 14,
      display: 'flex', gap: 12, alignItems: 'center',
      marginBottom: 32,
      boxShadow: 'var(--shadow-1)',
    }}>
      <div style={{
        width: 30, height: 30, borderRadius: 8,
        background: 'var(--bloom-wash)', border: '1px solid var(--bloom-wash-2)',
        display: 'grid', placeItems: 'center', color: 'var(--bloom-2)',
      }}><Ico.Sparkle /></div>
      <input
        value={v}
        onChange={e => setV(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') submit(); }}
        placeholder="Ask Lucent anything — or describe a new workspace to draft…"
        style={{ flex: 1, fontSize: 15, color: 'var(--ink-0)', fontFamily: 'var(--font-serif)' }}
      />
      <span className="mono" style={{ fontSize: 10.5, color: 'var(--ink-3)', padding: '4px 8px', background: 'var(--paper-2)', borderRadius: 5 }}>↵</span>
      <button
        className="icon-btn"
        onClick={submit}
        style={{ height: 32 }}
        disabled={!v.trim()}
        title="Ask Lucent"
      >Ask</button>
      <div style={{ width: 6 }} />
      <button className="icon-btn primary" onClick={() => go(1)} style={{ height: 32 }}>
        <Ico.Plus /> New
      </button>
    </div>
  );
}

function UpcomingMeeting({ time, duration, title, participants, board, inMinutes, live, onOpen }) {
  return (
    <button onClick={onOpen} style={{
      padding: '14px 16px',
      borderRadius: 12,
      background: 'var(--paper-0)',
      border: `1px solid ${live ? 'var(--madder)' : 'oklch(from var(--paper-4) l c h / 0.5)'}`,
      display: 'flex', alignItems: 'center', gap: 16,
      textAlign: 'left',
      cursor: 'pointer',
      transition: 'all 0.15s var(--e-out)',
      boxShadow: live ? '0 0 0 3px oklch(from var(--madder) l c h / 0.08)' : 'var(--shadow-1)',
    }}
      onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-1px)'; }}
      onMouseLeave={e => { e.currentTarget.style.transform = 'translateY(0)'; }}
    >
      <div style={{
        width: 56, textAlign: 'right',
        fontFamily: 'var(--font-mono)',
        color: 'var(--ink-0)', fontWeight: 600,
      }}>
        <div style={{ fontSize: 15 }}>{time}</div>
        <div style={{ fontSize: 10, color: 'var(--ink-3)', marginTop: 2 }}>{duration}</div>
      </div>
      <div style={{ width: 1, height: 32, background: 'oklch(from var(--paper-4) l c h / 0.6)' }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 500, color: 'var(--ink-0)', marginBottom: 3 }}>{title}</div>
        {board && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: 'var(--ink-2)' }}>
            <Ico.Layers style={{ width: 11, height: 11 }} />
            <span>{board}</span>
          </div>
        )}
      </div>
      <div style={{ display: 'flex' }}>
        {participants.map((p, i) => (
          <div key={i} style={{
            width: 22, height: 22, borderRadius: 999,
            background: p.c, color: 'white',
            border: '2px solid var(--paper-0)',
            fontFamily: 'var(--font-mono)', fontSize: 9, fontWeight: 700,
            display: 'grid', placeItems: 'center',
            marginLeft: i === 0 ? 0 : -6,
          }}>{p.i}</div>
        ))}
      </div>
      {live ? (
        <span className="mono" style={{
          padding: '5px 10px 5px 8px', borderRadius: 999,
          background: 'var(--madder)', color: 'white',
          fontSize: 10, fontWeight: 700, letterSpacing: '0.04em',
          display: 'inline-flex', alignItems: 'center', gap: 5,
        }}>
          <span style={{ width: 6, height: 6, borderRadius: 999, background: 'white', animation: 'pulse-bloom 1.4s ease-in-out infinite' }} />
          IN {inMinutes}m
        </span>
      ) : (
        <span className="mono" style={{ fontSize: 10.5, color: 'var(--ink-3)', letterSpacing: '0.03em' }}>
          in {inMinutes < 60 ? `${inMinutes}m` : `${Math.floor(inMinutes/60)}h ${inMinutes%60}m`}
        </span>
      )}
    </button>
  );
}

function InboxRow({ kind, title, meta, time, onClick }) {
  const kindMap = {
    approval:  { icon: <Ico.Sparkle />, color: 'var(--bloom-2)', bg: 'var(--bloom-wash)' },
    mention:   { icon: <Ico.Comment />, color: 'oklch(0.55 0.11 220)', bg: 'oklch(0.55 0.11 220 / 0.1)' },
    assignment:{ icon: <ActionIcon />,  color: 'var(--moss)', bg: 'oklch(from var(--moss) l c h / 0.1)' },
    blocked:   { icon: <RiskIcon />,    color: 'var(--madder)', bg: 'oklch(from var(--madder) l c h / 0.1)' },
  }[kind];
  return (
    <button onClick={onClick} style={{
      padding: '12px 14px',
      borderRadius: 10,
      background: 'var(--paper-0)',
      border: '1px solid oklch(from var(--paper-4) l c h / 0.5)',
      display: 'flex', alignItems: 'flex-start', gap: 12,
      textAlign: 'left', cursor: 'pointer',
      transition: 'all 0.12s',
    }}
      onMouseEnter={e => { e.currentTarget.style.background = 'var(--paper-1)'; }}
      onMouseLeave={e => { e.currentTarget.style.background = 'var(--paper-0)'; }}
    >
      <div style={{
        width: 26, height: 26, borderRadius: 7,
        background: kindMap.bg, color: kindMap.color,
        display: 'grid', placeItems: 'center', flexShrink: 0,
      }}>{kindMap.icon}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13.5, fontWeight: 500, color: 'var(--ink-0)', marginBottom: 3 }}>{title}</div>
        <div style={{ fontSize: 12, color: 'var(--ink-2)', lineHeight: 1.4, fontFamily: 'var(--font-serif)', fontStyle: 'italic' }}>{meta}</div>
      </div>
      <span className="mono" style={{ fontSize: 10.5, color: 'var(--ink-3)', whiteSpace: 'nowrap' }}>{time}</span>
    </button>
  );
}

function PinnedBoard({ name, meta, color, onClick }) {
  return (
    <button onClick={onClick} style={{
      padding: '12px 14px',
      borderRadius: 10,
      background: 'var(--paper-0)',
      border: '1px solid oklch(from var(--paper-4) l c h / 0.5)',
      borderLeft: `4px solid ${color}`,
      display: 'flex', alignItems: 'center', gap: 12,
      textAlign: 'left', cursor: 'pointer',
      transition: 'all 0.12s',
    }}
      onMouseEnter={e => { e.currentTarget.style.transform = 'translateX(2px)'; }}
      onMouseLeave={e => { e.currentTarget.style.transform = 'translateX(0)'; }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--ink-0)', marginBottom: 2 }}>{name}</div>
        <div className="mono" style={{ fontSize: 10.5, color: 'var(--ink-3)', letterSpacing: '0.02em' }}>{meta}</div>
      </div>
      <Ico.Arrow style={{ color: 'var(--ink-3)' }} />
    </button>
  );
}

Object.assign(window, { ScreenHome });
