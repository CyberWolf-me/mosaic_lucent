// Screen 05 — Voice listening · Otter-style live transcript + live AI extraction

function ScreenVoice() {
  const speakers = {
    'Alex':   { color: 'oklch(0.55 0.16 25)',  i: 'A' },
    'Sarah':  { color: 'oklch(0.55 0.11 220)', i: 'S' },
    'Lucent': { color: 'var(--bloom-2)',       i: 'L' },
  };

  const history = [
    { s: 'Alex',   t: '00:00:14', txt: 'Let\'s pick up where we left off. I want to add a payment service between checkout and the orders database.' },
    { s: 'Sarah',  t: '00:00:28', txt: 'Makes sense. Should we put it behind the API gateway or run it as its own edge service?' },
    { s: 'Alex',   t: '00:00:42', txt: 'Behind the gateway. Keep the routing consistent with everything else.' },
  ];

  const [transcript, setTranscript] = useState('');
  const target = "add a payment service between checkout and the orders database";
  useEffect(() => {
    let i = 0, timer;
    const step = () => {
      if (i <= target.length) {
        setTranscript(target.slice(0, i));
        i++;
        timer = setTimeout(step, 55 + Math.random() * 30);
      } else {
        timer = setTimeout(() => { i = 0; setTranscript(''); step(); }, 3000);
      }
    };
    step();
    return () => clearTimeout(timer);
  }, []);

  return (
    <>
      <PaperBackdrop grid={false} />
      <GlobalRail active="meeting" />

      {/* Slim top bar */}
      <div style={{
        position: 'absolute', top: 0, left: 0, right: 0, height: 48,
        display: 'flex', alignItems: 'center', gap: 12,
        padding: '0 20px', zIndex: 40,
        background: 'oklch(from var(--paper-1) l c h / 0.9)',
        backdropFilter: 'blur(20px)',
        borderBottom: '1px solid oklch(from var(--paper-4) l c h / 0.4)',
      }}>
        <div className="brand" style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: 'var(--font-serif)', fontSize: 14, fontWeight: 500, whiteSpace: 'nowrap' }}>
          <div className="brand-mark" style={{ width: 22, height: 22 }} />
          Lucent
        </div>
        <span style={{ color: 'var(--ink-3)' }}>·</span>
        <button className="crumb" style={{ whiteSpace: 'nowrap' }}>E-commerce</button>
        <span className="crumb-sep">/</span>
        <span className="crumb current" style={{ whiteSpace: 'nowrap' }}>Voice</span>
        <div style={{ flex: 1 }} />

        {/* Recording state */}
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
          LIVE · 00:01:24
        </div>

        <button
          className="icon-btn"
          onClick={() => window.__lucentGo && window.__lucentGo(22)}
          title="Stop voice session · review extractions"
        ><Ico.X /> Stop</button>
      </div>

      {/* Body: transcript left, live extraction right */}
      <div style={{ position: 'absolute', top: 48, bottom: 0, left: 84, right: 0, display: 'flex' }}>

        {/* Left — live transcript */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          {/* Attendees */}
          <div style={{
            padding: '20px 40px 12px',
            display: 'flex', alignItems: 'center', gap: 10,
            borderBottom: '1px solid oklch(from var(--paper-4) l c h / 0.3)',
          }}>
            <div className="mono-caps">In this session</div>
            <div style={{ flex: 1 }} />
            {Object.entries(speakers).slice(0, 2).map(([name, sp]) => (
              <div key={name} style={{
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '3px 10px 3px 3px',
                background: 'oklch(from var(--paper-2) l c h / 0.7)',
                borderRadius: 999,
                fontSize: 12, fontWeight: 500,
              }}>
                <SpeakerChip initials={sp.i} name={name} color={sp.color} size={22} />
                {name}
                <span style={{
                  width: 5, height: 5, borderRadius: 999,
                  background: 'var(--moss)',
                  marginLeft: 4,
                }} />
              </div>
            ))}
            <button className="icon-btn" style={{ height: 26, fontSize: 11.5 }}><Ico.Plus /> Invite</button>
          </div>

          {/* Scrolling transcript */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '20px 30px 40px' }}>
            <div style={{ maxWidth: 720, margin: '0 auto' }}>
              <div className="mono-caps" style={{ marginBottom: 10, color: 'var(--ink-3)' }}>
                Live transcript · 3 utterances so far
              </div>

              {history.map((row, i) => (
                <TranscriptRow
                  key={i}
                  speaker={row.s}
                  initials={speakers[row.s].i}
                  color={speakers[row.s].color}
                  time={row.t}
                  text={row.txt}
                />
              ))}

              {/* Active utterance being transcribed */}
              <div style={{
                display: 'flex', gap: 12,
                padding: '10px 14px',
                borderRadius: 10,
                background: 'oklch(from var(--bloom-1) l c h / 0.06)',
                border: '1px dashed var(--bloom-wash-2)',
                marginTop: 4,
              }}>
                <SpeakerChip initials="A" name="Alex" color={speakers['Alex'].color} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 2 }}>
                    <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--ink-0)' }}>Alex</span>
                    <span className="mono" style={{ fontSize: 10.5, color: 'var(--ink-3)' }}>00:01:22 · speaking</span>
                    <div style={{ marginLeft: 6 }}>
                      <Waveform bars={5} />
                    </div>
                  </div>
                  <div style={{
                    fontSize: 15.5, color: 'var(--ink-0)',
                    lineHeight: 1.55,
                    fontFamily: 'var(--font-serif)',
                    fontStyle: 'italic',
                  }}>
                    "{transcript}<span style={{
                      display: 'inline-block',
                      width: 2, height: 20, background: 'var(--bloom-2)',
                      marginLeft: 2, verticalAlign: -3,
                      animation: 'pulse-bloom 1s ease-in-out infinite',
                    }} />"
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Right — live AI extraction */}
        <div style={{
          width: 380,
          borderLeft: '1px solid oklch(from var(--paper-4) l c h / 0.4)',
          background: 'oklch(from var(--paper-0) l c h / 0.55)',
          display: 'flex', flexDirection: 'column',
        }}>
          <div style={{
            padding: '16px 18px 12px',
            borderBottom: '1px solid oklch(from var(--paper-4) l c h / 0.4)',
            display: 'flex', alignItems: 'center', gap: 10,
          }}>
            <span style={{
              width: 8, height: 8, borderRadius: 999,
              background: 'var(--bloom-1)',
              boxShadow: '0 0 10px var(--bloom-glow)',
              animation: 'pulse-bloom 1.4s ease-in-out infinite',
            }} />
            <div style={{ fontSize: 13.5, fontWeight: 500, fontFamily: 'var(--font-serif)' }}>Live AI extraction</div>
            <div style={{ flex: 1 }} />
            <span className="mono" style={{ fontSize: 10, color: 'var(--ink-3)' }}>0.94 conf</span>
          </div>

          <div style={{ flex: 1, overflowY: 'auto', padding: 18 }}>
            {/* Intent card */}
            <div style={{
              padding: 14, marginBottom: 14,
              background: 'oklch(from var(--bloom-1) l c h / 0.05)',
              border: '1px solid var(--bloom-wash-2)',
              borderRadius: 12,
            }}>
              <div style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center' }}>
                <span className="mono-caps" style={{ color: 'var(--bloom-2)' }}>INTENT</span>
                <span className="mono" style={{
                  fontSize: 10, padding: '2px 6px', borderRadius: 4,
                  background: 'var(--bloom-2)', color: 'white', fontWeight: 700,
                }}>ADD</span>
              </div>
              <div style={{ fontSize: 13.5, color: 'var(--ink-0)', lineHeight: 1.5, fontFamily: 'var(--font-serif)' }}>
                Add a payment service between checkout and orders DB, routed behind the API gateway.
              </div>
            </div>

            {/* Entities */}
            <div className="mono-caps" style={{ marginBottom: 8 }}>Entities detected</div>
            {[
              { kind: 'SERVICE', label: 'Payment Service', status: 'new' },
              { kind: 'SERVICE', label: 'Checkout',        status: 'known' },
              { kind: 'DATA',    label: 'Orders DB',       status: 'known' },
              { kind: 'EDGE',    label: 'API Gateway',     status: 'known' },
            ].map((e, i) => (
              <div key={i} style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '9px 12px', marginBottom: 6,
                borderRadius: 10,
                background: 'oklch(from var(--paper-1) l c h / 0.7)',
                border: '1px solid oklch(from var(--paper-4) l c h / 0.4)',
              }}>
                <span className="mono" style={{
                  fontSize: 9.5, padding: '2px 6px', borderRadius: 3,
                  background: e.status === 'new' ? 'var(--bloom-wash)' : 'oklch(from var(--paper-3) l c h / 0.8)',
                  color: e.status === 'new' ? 'var(--bloom-2)' : 'var(--ink-2)',
                  fontWeight: 600, letterSpacing: '0.05em',
                }}>{e.kind}</span>
                <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--ink-0)' }}>{e.label}</span>
                <div style={{ flex: 1 }} />
                {e.status === 'new' && (
                  <span className="mono" style={{
                    fontSize: 9.5, color: 'var(--bloom-2)',
                    letterSpacing: '0.06em', fontWeight: 600,
                  }}>NEW</span>
                )}
              </div>
            ))}

            {/* Proposed action */}
            <div className="mono-caps" style={{ marginBottom: 8, marginTop: 18 }}>Proposed change</div>
            <div style={{
              padding: 12,
              borderRadius: 10,
              background: 'oklch(from var(--paper-1) l c h / 0.7)',
              border: '1px solid oklch(from var(--paper-4) l c h / 0.5)',
              display: 'flex', gap: 10,
              alignItems: 'flex-start',
            }}>
              <span className="change-op add">Add</span>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 500 }}>Payment Service</div>
                <div style={{ fontSize: 11.5, color: 'var(--ink-2)', marginTop: 3, lineHeight: 1.4 }}>
                  Between Checkout and Orders DB, routed via /pay on API Gateway.
                </div>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
              <button className="btn ghost" style={{ height: 30, fontSize: 12, flex: 1, cursor: 'pointer' }}>Discard</button>
              <button
                className="btn bloom"
                onClick={() => window.__lucentGo && window.__lucentGo(3)}
                style={{ height: 30, fontSize: 12, flex: 1, cursor: 'pointer' }}
              ><Ico.Check /> Apply on board</button>
            </div>
          </div>

          {/* Waveform footer */}
          <div style={{
            padding: '14px 18px',
            borderTop: '1px solid oklch(from var(--paper-4) l c h / 0.4)',
            display: 'flex', alignItems: 'center', gap: 12,
          }}>
            <button style={{
              width: 40, height: 40, borderRadius: 999,
              background: 'var(--bloom-2)', color: 'white',
              display: 'grid', placeItems: 'center',
              boxShadow: '0 4px 16px -4px var(--bloom-glow), 0 0 0 4px var(--bloom-wash)',
            }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>
            </button>
            <div style={{ flex: 1 }}>
              <div style={{ height: 26 }}>
                <BigMiniWave />
              </div>
              <div className="mono" style={{ fontSize: 9.5, color: 'var(--ink-3)', marginTop: 2, letterSpacing: '0.05em' }}>
                42 dB · –18 dBFS · 00:01:24
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function BigMiniWave() {
  const bars = 42;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 2, height: '100%' }}>
      {Array.from({ length: bars }).map((_, i) => {
        const dist = Math.abs(i - bars / 2) / (bars / 2);
        const base = 1 - dist * dist;
        return (
          <span key={i} style={{
            flex: 1,
            height: `${20 + base * 70}%`,
            background: 'var(--bloom-2)',
            borderRadius: 1.5,
            opacity: 0.5 + base * 0.5,
            animation: `wave ${0.9 + (i % 5) * 0.14}s ease-in-out infinite`,
            animationDelay: `${(i * 40) % 900}ms`,
          }} />
        );
      })}
    </div>
  );
}

Object.assign(window, { ScreenVoice });
