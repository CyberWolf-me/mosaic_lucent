// Screen 8 — Meeting mode
// Canvas shows extracted problems/hypotheses/solutions; left sidebar shows live transcript
// with color-coded highlights of what was extracted.

function ScreenMeeting() {
  const transcript = [
    { speaker: 'Sarah',   t: '00:12', text: 'Customers are dropping during checkout.', extract: 'problem' },
    { speaker: 'John',    t: '00:24', text: "Maybe the payment flow is too complicated. We ask for too much upfront.", extract: 'hypothesis' },
    { speaker: 'Sarah',   t: '00:41', text: 'What about mobile? The keyboard covers the field.', extract: 'hypothesis' },
    { speaker: 'Alex',    t: '00:58', text: 'We should try one-click checkout with Apple Pay.', extract: 'solution' },
    { speaker: 'John',    t: '01:16', text: 'Or a magic link for returning customers.',       extract: 'solution' },
    { speaker: 'Sarah',   t: '01:28', text: 'For enterprise, we probably need SSO too.',     extract: 'requirement' },
    { speaker: 'Alex',    t: '01:42', text: "Let's decide on one-click checkout as the priority.", extract: 'decision' },
    { speaker: 'John',    t: '01:55', text: 'I can prototype it by Thursday.',               extract: 'action' },
  ];

  const extractColor = {
    problem:      { c: 'var(--sig-red)',    label: 'Problem'     },
    hypothesis:   { c: 'var(--amber-1)',    label: 'Hypothesis'  },
    solution:     { c: 'var(--sig-green)',  label: 'Solution'    },
    decision:     { c: 'var(--sig-violet)', label: 'Decision'    },
    action:       { c: 'var(--sig-blue)',   label: 'Action'      },
    requirement:  { c: 'var(--amber-2)',    label: 'Requirement' },
  };

  const boardCols = [
    {
      title: 'Problems', key: 'problem',
      cards: [{ title: 'Checkout abandonment', sub: 'Sarah · 00:12' }],
    },
    {
      title: 'Hypotheses', key: 'hypothesis',
      cards: [
        { title: 'Payment flow too complex', sub: 'John · 00:24' },
        { title: 'Mobile keyboard covers field', sub: 'Sarah · 00:41' },
      ],
    },
    {
      title: 'Solutions', key: 'solution',
      cards: [
        { title: 'One-click checkout · Apple Pay', sub: 'Alex · 00:58' },
        { title: 'Magic link for returning users', sub: 'John · 01:16' },
      ],
    },
    {
      title: 'Decisions', key: 'decision',
      cards: [{ title: 'One-click checkout priority', sub: 'Alex · 01:42' }],
    },
    {
      title: 'Actions', key: 'action',
      cards: [{ title: 'Prototype by Thursday', sub: 'John · 01:55' }],
    },
  ];

  return (
    <div data-screen-label="08 Meeting mode" style={{ position: 'absolute', inset: 0 }}>
      <CanvasBackdrop />
      <TopBar
        crumbs={[
          { label: 'Personal', current: false },
          { label: 'Checkout redesign', current: false },
          { label: 'Meeting · Tue 2:14 PM', current: true },
        ]}
        actions={
          <>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '5px 12px',
              background: 'oklch(0.72 0.15 25 / 0.12)',
              border: '1px solid oklch(0.72 0.15 25 / 0.3)',
              borderRadius: 999,
              fontSize: 11.5, color: 'var(--sig-red)',
              fontFamily: 'var(--font-mono)',
              letterSpacing: '0.03em',
            }}>
              <span style={{
                width: 7, height: 7, borderRadius: 999, background: 'var(--sig-red)',
                animation: 'pulse-amber 1.2s ease-in-out infinite',
              }} />
              REC · 02:14
            </div>
            <div style={{ width: 8 }} />
            <div style={{ display: 'flex' }}>
              {['SM', 'JT', 'AK'].map((a, i) => (
                <div key={i} style={{
                  width: 24, height: 24, borderRadius: 999,
                  background: i === 0 ? 'linear-gradient(135deg, oklch(0.75 0.09 200), oklch(0.55 0.11 220))'
                    : i === 1 ? 'linear-gradient(135deg, oklch(0.75 0.09 100), oklch(0.55 0.11 130))'
                    : 'linear-gradient(135deg, oklch(0.75 0.09 55), oklch(0.55 0.11 30))',
                  display: 'grid', placeItems: 'center',
                  fontSize: 9, fontFamily: 'var(--font-mono)', color: 'var(--canvas-0)',
                  fontVariationSettings: "'wght' 600",
                  border: '2px solid var(--canvas-1)',
                  marginLeft: i > 0 ? -6 : 0,
                }}>{a}</div>
              ))}
            </div>
            <button className="icon-btn"><Ico.X /> Stop</button>
          </>
        }
      />
      <LeftRail active="canvas" />

      {/* Main area: transcript left, kanban board center */}
      <div style={{
        position: 'absolute', top: 76, bottom: 30, left: 76, right: 30,
        display: 'grid', gridTemplateColumns: '340px 1fr', gap: 18,
      }}>
        {/* Live transcript */}
        <div style={{
          background: 'oklch(from var(--canvas-2) l c h / 0.75)',
          border: '1px solid var(--stroke-1)',
          borderRadius: 16,
          display: 'flex', flexDirection: 'column', overflow: 'hidden',
        }}>
          <div style={{
            padding: '14px 18px',
            borderBottom: '1px solid var(--stroke-1)',
            display: 'flex', alignItems: 'center', gap: 8,
          }}>
            <span style={{
              width: 6, height: 6, borderRadius: 999,
              background: 'var(--amber-1)',
              boxShadow: '0 0 6px var(--amber-glow)',
              animation: 'pulse-amber 1.2s ease-in-out infinite',
            }} />
            <div style={{ fontSize: 13, fontVariationSettings: "'wght' 550" }}>Live transcript</div>
            <div style={{ flex: 1 }} />
            <span className="mono" style={{ fontSize: 10, color: 'var(--ink-3)' }}>8 extracts</span>
          </div>

          <div style={{ flex: 1, overflowY: 'auto', padding: '10px 14px 20px' }} className="panel-body">
            {transcript.map((line, i) => {
              const ex = extractColor[line.extract];
              return (
                <div key={i} style={{ marginBottom: 14 }}>
                  <div style={{
                    display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 3,
                  }}>
                    <span style={{ fontSize: 12, color: 'var(--ink-0)', fontVariationSettings: "'wght' 550" }}>
                      {line.speaker}
                    </span>
                    <span className="mono" style={{ fontSize: 10, color: 'var(--ink-3)' }}>{line.t}</span>
                  </div>
                  <div style={{
                    fontSize: 12.5, lineHeight: 1.5,
                    color: 'var(--ink-1)',
                    padding: '4px 8px',
                    marginLeft: -8,
                    background: ex ? `${ex.c.replace('var(--', 'oklch(').replace(')', ' / 0.06)')}` : 'transparent',
                    borderLeft: ex ? `2px solid ${ex.c}` : '2px solid transparent',
                    borderRadius: '0 4px 4px 0',
                  }}>
                    {line.text}
                    {ex && (
                      <div className="mono" style={{
                        marginTop: 4,
                        fontSize: 9.5, letterSpacing: '0.08em',
                        textTransform: 'uppercase',
                        color: ex.c,
                      }}>
                        → {ex.label}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
            {/* Live line at bottom */}
            <div style={{
              display: 'flex', alignItems: 'baseline', gap: 8,
              padding: '6px 8px',
              opacity: 0.7,
            }}>
              <span style={{ fontSize: 12, color: 'var(--amber-1)', fontVariationSettings: "'wght' 550" }}>Sarah</span>
              <span className="mono" style={{ fontSize: 10, color: 'var(--ink-3)' }}>02:14</span>
              <span style={{ fontSize: 12.5, color: 'var(--ink-2)', fontStyle: 'italic', flex: 1 }}>
                So the next step is<span style={{
                  display: 'inline-block', width: 2, height: 12, background: 'var(--amber-1)',
                  verticalAlign: 'text-bottom', marginLeft: 2,
                  animation: 'blink 1s steps(2) infinite',
                }} />
              </span>
            </div>
          </div>
        </div>

        {/* Extraction board */}
        <div style={{
          background: 'oklch(from var(--canvas-1) l c h / 0.6)',
          border: '1px solid var(--stroke-1)',
          borderRadius: 16,
          overflow: 'hidden',
          display: 'flex', flexDirection: 'column',
        }}>
          <div style={{
            padding: '14px 18px',
            borderBottom: '1px solid var(--stroke-1)',
            display: 'flex', alignItems: 'center', gap: 10,
          }}>
            <div style={{ fontSize: 13, fontVariationSettings: "'wght' 550" }}>Meeting workspace</div>
            <span className="mono" style={{ fontSize: 10, color: 'var(--ink-3)', letterSpacing: '0.03em' }}>
              Auto-extracted · Sync to workspace when done
            </span>
            <div style={{ flex: 1 }} />
            <button className="icon-btn" style={{ height: 26, fontSize: 11 }}><Ico.Layers /> Layout</button>
            <button className="icon-btn" style={{ height: 26, fontSize: 11 }}><Ico.Sparkle /> Summarize</button>
          </div>
          <div style={{
            flex: 1, padding: 16, overflow: 'auto',
            display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 12,
          }}>
            {boardCols.map((col, i) => {
              const ex = extractColor[col.key];
              return (
                <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{
                    display: 'flex', alignItems: 'center', gap: 6,
                    padding: '4px 8px',
                    borderRadius: 6,
                  }}>
                    <span style={{
                      width: 6, height: 6, borderRadius: 999, background: ex.c,
                      boxShadow: `0 0 6px ${ex.c}`,
                    }} />
                    <div style={{ fontSize: 11.5, color: 'var(--ink-1)', fontVariationSettings: "'wght' 550" }}>
                      {col.title}
                    </div>
                    <span className="mono" style={{ fontSize: 10, color: 'var(--ink-3)', marginLeft: 'auto' }}>
                      {col.cards.length}
                    </span>
                  </div>
                  {col.cards.map((card, j) => (
                    <div key={j} className="emerge" style={{
                      padding: '10px 12px',
                      background: 'var(--canvas-2)',
                      border: '1px solid var(--stroke-1)',
                      borderRadius: 8,
                      animationDelay: `${(i * 100) + (j * 60)}ms`,
                    }}>
                      <div style={{ fontSize: 12, color: 'var(--ink-0)', lineHeight: 1.4, fontVariationSettings: "'wght' 500" }}>
                        {card.title}
                      </div>
                      <div className="mono" style={{ fontSize: 10, color: 'var(--ink-3)', marginTop: 6, letterSpacing: '0.02em' }}>
                        {card.sub}
                      </div>
                    </div>
                  ))}
                  <button style={{
                    padding: '10px 12px',
                    fontSize: 11.5, color: 'var(--ink-3)',
                    border: '1px dashed var(--stroke-1)',
                    borderRadius: 8,
                    textAlign: 'left',
                    fontFamily: 'var(--font-mono)',
                  }}>
                    +
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { ScreenMeeting });
