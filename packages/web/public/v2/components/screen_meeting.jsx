// Screen 08 — Meeting mode · Granola-style structured notes + transcript

function ScreenMeeting() {
  const [tab, setTab] = useState('notes'); // notes / transcript / chat
  const speakers = {
    'Sarah':  { color: 'oklch(0.55 0.11 220)' },
    'John':   { color: 'oklch(0.55 0.14 148)' },
    'Alex':   { color: 'oklch(0.55 0.16 25)' },
    'Lucent': { color: 'var(--bloom-2)' },
  };
  const transcript = [
    { s: 'Sarah', i: 'S', t: '00:12:04', txt: 'For the checkout, I think we need a cart review step first, then an address form. People forget what\'s in their cart.' },
    { s: 'John',  i: 'J', t: '00:12:18', txt: 'Payment should support Apple Pay and Klarna, not just cards. Klarna alone lifted conversion 8% at Northbeam.' },
    { s: 'Alex',  i: 'A', t: '00:12:34', txt: 'Let\'s make sure guest checkout works too. No forced signup — that\'s the biggest drop-off in the funnel.' },
    { s: 'Sarah', i: 'S', t: '00:13:02', txt: 'Add a gift wrapping option somewhere in the cart review. It\'s a small feature but drives AOV around holidays.' },
    { s: 'John',  i: 'J', t: '00:13:18', txt: 'On payment errors — we should retry twice silently before showing the user anything. Stripe intermittency is real.' },
    { s: 'Alex',  i: 'A', t: '00:13:36', txt: 'One more thing — confirmation email needs to include a tracking link once fulfillment picks it up, not immediately.' },
  ];

  return (
    <>
      <PaperBackdrop grid={false} />
      <GlobalRail active="meeting" />

      {/* Minimal top strip — Granola-like */}
      <div style={{
        position: 'absolute', top: 0, left: 0, right: 0, height: 48,
        display: 'flex', alignItems: 'center', gap: 12,
        padding: '0 20px', zIndex: 20,
        background: 'oklch(from var(--paper-1) l c h / 0.9)',
        backdropFilter: 'blur(20px)',
        borderBottom: '1px solid oklch(from var(--paper-4) l c h / 0.4)',
      }}>
        <button className="brand" style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: 'var(--font-serif)', fontSize: 14, fontWeight: 500, whiteSpace: 'nowrap' }}>
          <div className="brand-mark" style={{ width: 22, height: 22 }} />
          Lucent
        </button>
        <span style={{ color: 'var(--ink-3)' }}>·</span>
        <button className="crumb" style={{ whiteSpace: 'nowrap' }}>Personal</button>
        <span className="crumb-sep">/</span>
        <button className="crumb" style={{ whiteSpace: 'nowrap' }}>Meetings</button>
        <span className="crumb-sep">/</span>
        <span className="crumb current" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 220 }}>Checkout design review</span>
        <div style={{ flex: 1 }} />

        {/* REC pill */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '5px 12px 5px 8px',
          background: 'oklch(from var(--madder) l c h / 0.1)',
          border: '1px solid oklch(from var(--madder) l c h / 0.3)',
          borderRadius: 999,
          fontFamily: 'var(--font-mono)', fontSize: 11,
          color: 'var(--madder)', letterSpacing: '0.03em', fontWeight: 600,
        }}>
          <span style={{
            width: 8, height: 8, borderRadius: 999,
            background: 'var(--madder)',
            animation: 'pulse-bloom 1.4s ease-in-out infinite',
          }} />
          REC · 00:14:32
        </div>

        {/* Attendee stack */}
        <div style={{ display: 'flex', marginLeft: 4 }}>
          {['A', 'S', 'J'].map((x, i) => (
            <div key={i} style={{
              width: 26, height: 26, borderRadius: 999,
              background: ['oklch(0.55 0.16 25)', 'oklch(0.55 0.11 220)', 'oklch(0.55 0.14 148)'][i],
              border: '2px solid var(--paper-0)',
              marginLeft: i === 0 ? 0 : -8,
              display: 'grid', placeItems: 'center',
              fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 700, color: 'white',
              zIndex: 3 - i,
            }}>{x}</div>
          ))}
        </div>

        <button className="icon-btn" style={{ marginLeft: 4 }} title="Share this meeting doc">
          <Ico.Share /> Share
        </button>
        <button
          className="icon-btn primary"
          onClick={() => window.__lucentGo && window.__lucentGo(22)}
          title="End meeting · review extractions"
        ><Ico.X /> End</button>
      </div>

      {/* Main content: notes (LEFT) + transcript (RIGHT) */}
      <div style={{ position: 'absolute', top: 48, bottom: 0, left: 84, right: 0, display: 'flex' }}>

        {/* --- Notes column (Granola-style structured AI notes) --- */}
        <div style={{ flex: 1, overflowY: 'auto', position: 'relative' }}>
          <div style={{ maxWidth: 720, margin: '0 auto', padding: '52px 60px 180px' }}>

            {/* Meta chips */}
            <div style={{ display: 'flex', gap: 8, marginBottom: 24, flexWrap: 'wrap' }}>
              <MetaChip icon={<CalendarSm />} label="Today · Sep 20" />
              <MetaChip icon={<PeopleSm />} label="3 people" />
              <MetaChip icon={<FolderSm />} label="Product / Q4" />
              <MetaChip icon={<Ico.Sparkle />} label="Auto template · Product review" bloom />
            </div>

            {/* Title */}
            <h1 style={{
              fontFamily: 'var(--font-serif)',
              fontSize: 40, fontWeight: 400,
              letterSpacing: '-0.025em',
              color: 'var(--ink-0)',
              lineHeight: 1.1,
              marginBottom: 8,
            }}>
              Checkout design review
            </h1>
            <div style={{
              fontFamily: 'var(--font-serif)',
              fontStyle: 'italic',
              fontSize: 16, color: 'var(--ink-2)', lineHeight: 1.5,
              marginBottom: 32,
            }}>
              Team walkthrough of the checkout redesign — cart review, payments, guest flow.
            </div>

            {/* AI-authored notes */}
            <NoteBlock>
              <NoteH2>Summary</NoteH2>
              <p style={{ color: 'var(--ink-1)', fontSize: 14.5, lineHeight: 1.65, marginBottom: 4 }}>
                The team aligned on a four-step checkout — <b>Cart → Address → Payment → Confirmation</b> — with guest checkout as the default path
                <CitationPill n="3" />. Payment must support Apple Pay and Klarna in addition to cards
                <CitationPill n="2" />, and errors should be retried silently before surfacing
                <CitationPill n="5" />.
              </p>

              <NoteH2>Decisions</NoteH2>
              <NoteBullet><span style={{ fontWeight: 600 }}>4-step checkout flow.</span> Cart review first — people forget what's in their cart <CitationPill n="1" /></NoteBullet>
              <NoteBullet><span style={{ fontWeight: 600 }}>Guest checkout is the default.</span> No forced signup, biggest funnel drop <CitationPill n="3" /></NoteBullet>
              <NoteBullet><span style={{ fontWeight: 600 }}>Payment methods.</span> Cards, Apple Pay, Klarna — Klarna alone lifted conversion +8% at Northbeam <CitationPill n="2" /></NoteBullet>
              <NoteBullet><span style={{ fontWeight: 600 }}>Silent retry policy.</span> Two retries on Stripe intermittency before surfacing an error <CitationPill n="5" /></NoteBullet>

              <NoteH2>Action items</NoteH2>
              <ActionItem owner="Alex" color="oklch(0.55 0.16 25)">
                Draft the wireframes for cart review + address (screens 1–2) by <b>Fri</b>
              </ActionItem>
              <ActionItem owner="John" color="oklch(0.55 0.14 148)">
                Integrate Klarna sandbox and confirm 3DS callback in staging by <b>Mon</b>
              </ActionItem>
              <ActionItem owner="Sarah" color="oklch(0.55 0.11 220)">
                Add gift wrapping micro-flow spec to the cart review PRD <CitationPill n="4" />
              </ActionItem>

              <NoteH2>Open questions</NoteH2>
              <NoteBullet>Should the confirmation email include tracking immediately, or wait for fulfillment? <CitationPill n="6" /></NoteBullet>
              <NoteBullet>What's the deadline for the Klarna rollout — before Black Friday?</NoteBullet>

              <NoteH2>Related canvas</NoteH2>
              <div
                onClick={() => window.__lucentGo && window.__lucentGo(3)}
                style={{
                  marginTop: 10, padding: 14,
                  borderRadius: 12,
                  background: 'oklch(from var(--paper-0) l c h / 0.7)',
                  border: '1px solid oklch(from var(--paper-4) l c h / 0.5)',
                  display: 'flex', alignItems: 'center', gap: 12,
                  cursor: 'pointer',
                  transition: 'all 0.12s var(--e-out)',
                }}
                onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--ink-3)'; e.currentTarget.style.transform = 'translateY(-1px)'; }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = 'oklch(from var(--paper-4) l c h / 0.5)'; e.currentTarget.style.transform = 'translateY(0)'; }}
              >
                <div style={{
                  width: 40, height: 40, borderRadius: 8,
                  background: 'var(--bloom-wash)',
                  border: '1px solid var(--bloom-wash-2)',
                  display: 'grid', placeItems: 'center',
                  color: 'var(--bloom-2)',
                }}><Ico.Journey /></div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 500 }}>User journey · Checkout v3</div>
                  <div className="mono" style={{ fontSize: 10.5, color: 'var(--ink-3)', marginTop: 2 }}>
                    lucent · 4 steps · updated by AI · 12s ago
                  </div>
                </div>
                <Ico.Arrow style={{ color: 'var(--ink-3)' }} />
              </div>
            </NoteBlock>
          </div>

          {/* Ask anything bar */}
          <AskAnythingBar
            placeholder="Ask about this meeting — or ask Lucent to draft…"
            context={<>
              <span>SCOPE · <span style={{ color: 'var(--ink-1)' }}>this note</span></span>
              <span>·</span>
              <span>AUTO · <span style={{ color: 'var(--ink-1)' }}>context aware</span></span>
            </>}
          />
        </div>

        {/* --- Transcript column --- */}
        <div style={{
          width: 400,
          borderLeft: '1px solid oklch(from var(--paper-4) l c h / 0.5)',
          background: 'oklch(from var(--paper-0) l c h / 0.55)',
          display: 'flex', flexDirection: 'column',
        }}>
          {/* Tabs */}
          <div style={{
            display: 'flex', gap: 4, padding: '12px 12px 0',
            borderBottom: '1px solid oklch(from var(--paper-4) l c h / 0.4)',
          }}>
            {[
              { id: 'transcript', label: 'Transcript', count: transcript.length },
              { id: 'chat',       label: 'Chat',       count: 4 },
              { id: 'clips',      label: 'Clips',      count: 2 },
            ].map(t => (
              <button key={t.id}
                onClick={() => setTab(t.id)}
                style={{
                  padding: '8px 12px 10px',
                  fontSize: 12.5, fontWeight: 500,
                  color: tab === t.id ? 'var(--ink-0)' : 'var(--ink-2)',
                  borderBottom: `2px solid ${tab === t.id ? 'var(--ink-0)' : 'transparent'}`,
                  marginBottom: -1,
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                }}
              >
                {t.label}
                <span className="mono" style={{
                  fontSize: 10, color: 'var(--ink-3)',
                  padding: '1px 5px', borderRadius: 4,
                  background: 'oklch(from var(--paper-3) l c h / 0.7)',
                }}>{t.count}</span>
              </button>
            ))}
          </div>

          {tab === 'chat' ? (
            <ChatColumn speakers={speakers} />
          ) : tab === 'clips' ? (
            <ClipsColumn />
          ) : (
            <div style={{ flex: 1, overflowY: 'auto', padding: '12px 8px 20px' }}>
              {/* Search bar */}
              <div style={{
                margin: '6px 6px 12px',
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '7px 12px',
                background: 'oklch(from var(--paper-2) l c h / 0.7)',
                border: '1px solid oklch(from var(--paper-4) l c h / 0.5)',
                borderRadius: 8,
              }}>
                <Ico.Search style={{ color: 'var(--ink-3)' }} />
                <input placeholder="Search transcript…" style={{ flex: 1, fontSize: 12.5 }} />
                <span className="mono" style={{ fontSize: 10, color: 'var(--ink-3)' }}>⌘F</span>
              </div>

              {transcript.map((row, i) => (
                <TranscriptRow
                  key={i}
                  speaker={row.s}
                  initials={row.i}
                  color={speakers[row.s].color}
                  time={row.t}
                  text={row.txt}
                  active={i === 2}
                  cited={i === 2 ? '3' : i === 1 ? '2' : null}
                />
              ))}

              {/* Live typing indicator */}
              <div style={{ display: 'flex', gap: 12, padding: '10px 14px' }}>
                <div style={{ width: 26, height: 26 }} />
                <div style={{
                  display: 'inline-flex', alignItems: 'center', gap: 4,
                  padding: '6px 12px',
                  background: 'oklch(from var(--paper-2) l c h / 0.6)',
                  border: '1px solid oklch(from var(--paper-4) l c h / 0.4)',
                  borderRadius: 999,
                }}>
                  {[0, 1, 2].map(d => (
                    <span key={d} style={{
                      width: 4, height: 4, borderRadius: 999,
                      background: 'var(--ink-3)',
                      animation: `pulse-bloom 1.2s ease-in-out ${d * 200}ms infinite`,
                    }} />
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function MetaChip({ icon, label, bloom }) {
  return (
    <div style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      padding: '5px 10px 5px 8px',
      borderRadius: 999,
      background: bloom ? 'oklch(from var(--bloom-1) l c h / 0.08)' : 'oklch(from var(--paper-2) l c h / 0.7)',
      border: `1px solid ${bloom ? 'var(--bloom-wash-2)' : 'oklch(from var(--paper-4) l c h / 0.4)'}`,
      fontSize: 12,
      color: bloom ? 'var(--bloom-2)' : 'var(--ink-1)',
      fontWeight: 500,
    }}>
      {icon}
      {label}
    </div>
  );
}
function CalendarSm() { return <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>; }
function PeopleSm()   { return <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><circle cx="9" cy="8" r="3"/><circle cx="17" cy="10" r="2.5"/><path d="M3 20c1-3 3.5-5 6-5s5 2 6 5M14 20c1-2.5 2-3.5 3-4"/></svg>; }
function FolderSm()   { return <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6z"/></svg>; }

function ActionItem({ owner, color, children }) {
  return (
    <div style={{
      display: 'flex', gap: 10, alignItems: 'flex-start',
      padding: '8px 0',
      fontSize: 14, color: 'var(--ink-1)', lineHeight: 1.55,
    }}>
      <div style={{
        width: 16, height: 16, borderRadius: 4,
        border: '1.5px solid var(--ink-3)',
        marginTop: 3, flexShrink: 0,
        transition: 'all 0.12s',
      }} />
      <div style={{ flex: 1 }}>
        {children}
        {' '}
        <span style={{
          display: 'inline-flex', alignItems: 'center', gap: 5,
          marginLeft: 6,
          padding: '1px 8px 1px 3px',
          background: `oklch(from ${color} l c h / 0.14)`,
          borderRadius: 999,
          fontSize: 11.5, fontWeight: 500,
          color: color,
          verticalAlign: 1,
        }}>
          <span style={{
            width: 14, height: 14, borderRadius: 999,
            background: color, color: 'white',
            fontFamily: 'var(--font-mono)', fontSize: 8, fontWeight: 700,
            display: 'grid', placeItems: 'center',
          }}>{owner[0]}</span>
          {owner}
        </span>
      </div>
    </div>
  );
}

function ChatColumn({ speakers }) {
  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '16px 14px' }}>
      <div className="mono-caps" style={{ marginBottom: 8 }}>You asked</div>
      <div style={{
        padding: '10px 12px', borderRadius: 12,
        background: 'oklch(from var(--paper-2) l c h / 0.7)',
        fontSize: 13.5, color: 'var(--ink-0)', marginBottom: 14,
      }}>
        What are the biggest risks in the payment integration?
      </div>
      <div className="mono-caps" style={{ marginBottom: 8, color: 'var(--bloom-2)' }}>
        <Ico.Sparkle style={{ display: 'inline', verticalAlign: -2, marginRight: 4 }} />
        Lucent
      </div>
      <div style={{
        padding: '12px 14px', borderRadius: 12,
        background: 'oklch(from var(--bloom-1) l c h / 0.05)',
        border: '1px solid var(--bloom-wash-2)',
        fontSize: 13.5, color: 'var(--ink-0)', lineHeight: 1.6,
        fontFamily: 'var(--font-serif)',
      }}>
        Two concerns surfaced in this meeting: Stripe intermittency without a retry policy
        <CitationPill n="5" />, and the Klarna 3DS callback in staging<CitationPill n="2" />.
        The team has assigned John to validate the callback by Monday. No one raised PCI scope
        or webhook signing — you may want to add those to the action items.
      </div>
    </div>
  );
}
function ClipsColumn() {
  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '16px 14px' }}>
      {[
        { time: '00:12:34', label: 'Guest checkout decision', dur: '32s' },
        { time: '00:13:18', label: 'Silent retry policy',     dur: '18s' },
      ].map((c, i) => (
        <div key={i} style={{
          padding: 12, marginBottom: 10,
          borderRadius: 10,
          background: 'oklch(from var(--paper-2) l c h / 0.6)',
          border: '1px solid oklch(from var(--paper-4) l c h / 0.4)',
        }}>
          <div className="mono" style={{ fontSize: 10.5, color: 'var(--ink-3)', marginBottom: 4 }}>
            {c.time} · {c.dur}
          </div>
          <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--ink-0)' }}>{c.label}</div>
          <div style={{ display: 'flex', gap: 4, marginTop: 8 }}>
            <button className="icon-btn" style={{ height: 26, fontSize: 11 }}><Ico.Play /> Play</button>
            <button className="icon-btn" style={{ height: 26, fontSize: 11 }}><Ico.Share /> Share</button>
          </div>
        </div>
      ))}
    </div>
  );
}

Object.assign(window, { ScreenMeeting });
