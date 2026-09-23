// Screen 13 — Meeting on Board
// Uses the SAME BoardCanvas as screen 3, with meeting overlays added around it.

function ScreenMeetingBoard() {
  const [selected, setSelected] = useState('pay');
  const [transcript, setTranscript] = useState('');
  const target = "so if we add the payment service here, it needs to route through the gateway";
  useEffect(() => {
    let i = 0, t;
    const type = () => {
      if (i <= target.length) {
        setTranscript(target.slice(0, i));
        i++;
        t = setTimeout(type, 55 + Math.random() * 40);
      } else {
        t = setTimeout(() => { i = 0; setTranscript(''); type(); }, 3200);
      }
    };
    type();
    return () => clearTimeout(t);
  }, []);

  return (
    <>
      <PaperBackdrop />
      <GlobalRail active="meeting" />

      {/* Meeting top bar — sits on top of the board */}
      <MeetingTopBar />

      {/* The board — SAME canvas as the main board screen, but with meeting overlays */}
      <BoardScrollFrame style={{ top: 52, bottom: 96, left: 84, right: 340 }}>
        <BoardCanvas
          selected={selected}
          onSelect={setSelected}
          meetingMode
          presenterHighlight={{ nodeId: 'pay', name: 'John', color: 'oklch(0.55 0.14 148)' }}
          liveCursors={[
            { x: 620, y: 280, name: 'John',  color: 'oklch(0.55 0.14 148)' },
            { x: 420, y: 180, name: 'Sarah', color: 'oklch(0.55 0.11 220)' },
          ]}
        />
      </BoardScrollFrame>

      {/* "John is presenting · following" chip — top-left over the board */}
      <div style={{
        position: 'absolute', top: 68, left: 100, zIndex: 25,
        padding: '5px 12px 5px 10px',
        background: 'var(--paper-0)',
        border: '1px solid var(--bloom-wash-2)',
        borderRadius: 999,
        display: 'inline-flex', alignItems: 'center', gap: 6,
        fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--bloom-2)',
        fontWeight: 600, letterSpacing: '0.02em',
        boxShadow: 'var(--shadow-1)',
      }}>
        <SpeakerChip initials="J" name="John" color="oklch(0.55 0.14 148)" size={16} />
        John is presenting · following
      </div>

      {/* Video tiles — floating stack in bottom-left corner of board area */}
      <div style={{
        position: 'absolute', bottom: 110, left: 96, zIndex: 26,
        display: 'flex', gap: 8, flexDirection: 'column',
      }}>
        <VideoTile name="Alex Kim" initials="AK" color="oklch(0.55 0.16 25)"  size="sm" tag="YOU" />
        <VideoTile name="Sarah Chen" initials="SC" color="oklch(0.55 0.11 220)" size="sm" />
        <VideoTile name="John Torres" initials="JT" color="oklch(0.55 0.14 148)" size="sm" speaking tag="PRESENTING" />
      </div>

      {/* Right transcript / extraction panel */}
      <MeetingTranscriptPanel transcript={transcript} />

      {/* Bottom lens switcher — lets you swap board representation live during a meeting */}
      <div style={{
        position: 'absolute', bottom: 0, left: 84, right: 340,
        height: 96,
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 16,
        padding: '0 20px',
        background: 'linear-gradient(0deg, oklch(from var(--paper-1) l c h / 0.95), oklch(from var(--paper-1) l c h / 0.5))',
        backdropFilter: 'blur(20px)',
        zIndex: 25,
      }}>
        <LensSwitcher current="arch" />
      </div>
    </>
  );
}

function MeetingTopBar() {
  return (
    <div style={{
      position: 'absolute', top: 0, left: 0, right: 0, height: 52,
      background: 'oklch(0.14 0.014 55 / 0.94)',
      backdropFilter: 'blur(20px)',
      borderBottom: '1px solid oklch(0.28 0.014 55)',
      display: 'flex', alignItems: 'center', gap: 14,
      padding: '0 20px',
      zIndex: 40,
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '6px 14px 6px 10px',
        background: 'oklch(from var(--madder) l c h / 0.15)',
        border: '1px solid oklch(from var(--madder) l c h / 0.4)',
        borderRadius: 999,
        fontFamily: 'var(--font-mono)', fontSize: 11.5,
        color: '#ff8b7a', fontWeight: 700, letterSpacing: '0.03em',
      }}>
        <span style={{
          width: 8, height: 8, borderRadius: 999,
          background: '#ff5a44',
          animation: 'pulse-bloom 1.2s ease-in-out infinite',
        }} />
        REC · 00:14:32
      </div>

      <div style={{ fontFamily: 'var(--font-serif)', fontSize: 14, fontWeight: 500, color: 'oklch(0.94 0.008 82)' }}>
        Checkout design review
      </div>
      <span style={{ color: 'oklch(0.55 0.01 60)' }}>·</span>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'oklch(0.68 0.008 82)', letterSpacing: '0.02em' }}>
        3 participants · E-commerce platform · board active
      </div>

      <div style={{ flex: 1 }} />

      <MeetingControls />

      <div style={{ width: 1, height: 24, background: 'oklch(0.28 0.014 55)', margin: '0 4px' }} />

      <button
        onClick={() => window.__lucentGo && window.__lucentGo(8)}
        title="Leave meeting · open meeting summary"
        style={{
          padding: '8px 16px', borderRadius: 10,
          background: 'var(--madder)', color: 'white',
          fontSize: 13, fontWeight: 600,
          display: 'inline-flex', alignItems: 'center', gap: 6,
          cursor: 'pointer',
        }}
      >
        <Ico.X style={{ width: 12, height: 12 }} /> Leave
      </button>
    </div>
  );
}

function MeetingControls() {
  const [mic, setMic] = useState(true);
  const [cam, setCam] = useState(false);
  const [share, setShare] = useState(false);
  const [hand, setHand] = useState(false);
  const [react, setReact] = useState(false);
  return (
    <>
      <MeetingControlBtn icon={mic ? <Ico.Mic /> : <MicOffIcon />} label={mic ? 'Mic on · click to mute' : 'Muted · click to unmute'} onClick={() => setMic(m => !m)} muted={!mic} />
      <MeetingControlBtn icon={cam ? <CameraIcon /> : <CameraOffIcon />} label={cam ? 'Camera on' : 'Camera off'} onClick={() => setCam(c => !c)} muted={!cam} />
      <MeetingControlBtn icon={<ScreenShareIcon />} label={share ? 'Sharing screen' : 'Share your screen'} onClick={() => setShare(s => !s)} active={share} />
      <MeetingControlBtn icon={<ReactionIcon />} label="Send a reaction" onClick={() => { setReact(true); setTimeout(() => setReact(false), 1500); }} active={react} />
      <MeetingControlBtn icon={<HandIcon />} label={hand ? 'Hand raised' : 'Raise hand'} onClick={() => setHand(h => !h)} active={hand} />
    </>
  );
}

function MeetingControlBtn({ icon, label, active, muted, danger, onClick }) {
  return (
    <button
      title={label}
      onClick={onClick}
      style={{
        width: 40, height: 36, borderRadius: 8,
        display: 'grid', placeItems: 'center',
        background: danger ? 'var(--madder)' : muted ? 'oklch(from var(--madder) l c h / 0.25)' : active ? 'var(--bloom-2)' : 'oklch(1 0 0 / 0.06)',
        color: muted ? '#ff8b7a' : (active || danger) ? 'white' : 'oklch(0.9 0.008 82)',
        border: `1px solid ${muted ? 'oklch(from var(--madder) l c h / 0.5)' : active ? 'var(--bloom-2)' : 'oklch(1 0 0 / 0.1)'}`,
        transition: 'all 0.12s',
        cursor: 'pointer',
      }}
      onMouseEnter={e => !danger && !active && !muted && (e.currentTarget.style.background = 'oklch(1 0 0 / 0.14)')}
      onMouseLeave={e => !danger && !active && !muted && (e.currentTarget.style.background = 'oklch(1 0 0 / 0.06)')}
    >{icon}</button>
  );
}
function MicOffIcon()    { return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M1 1l22 22"/><path d="M9 9v3a3 3 0 0 0 5.1 2.1M9 5V3a3 3 0 0 1 6 0v6M5 11a7 7 0 0 0 12 5M12 18v3"/></svg>; }
function CameraOffIcon() { return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M1 1l22 22"/><path d="M14 14v3H2V7h3M8 7h6l1 3M22 7l-8 5v-.5"/></svg>; }
function CameraIcon()    { return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M2 7h12v10H2z"/><path d="M22 7l-8 5 8 5z"/></svg>; }
function ScreenShareIcon() { return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="4" width="20" height="14" rx="2"/><path d="M8 22h8M12 18v4M12 8v6M9 11l3-3 3 3"/></svg>; }
function ReactionIcon()  { return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9"/><path d="M8 14a4 4 0 0 0 8 0M9 9v.5M15 9v.5"/></svg>; }
function HandIcon()      { return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M7 11V5a1.5 1.5 0 013 0v6M10 11V3.5a1.5 1.5 0 013 0V11M13 11V4.5a1.5 1.5 0 013 0V13M16 13V8.5a1.5 1.5 0 013 0v6a6 6 0 01-6 6h-2a6 6 0 01-5-2.7L4 15a1.6 1.6 0 012.3-2.2l1 1"/></svg>; }

function MeetingTranscriptPanel({ transcript }) {
  return (
    <div style={{
      position: 'absolute', top: 52, bottom: 0, right: 0,
      width: 340,
      background: 'var(--paper-0)',
      borderLeft: '1px solid oklch(from var(--paper-4) l c h / 0.6)',
      display: 'flex', flexDirection: 'column',
      zIndex: 20,
    }}>
      <div style={{
        display: 'flex', gap: 4, padding: '12px 12px 0',
        borderBottom: '1px solid oklch(from var(--paper-4) l c h / 0.4)',
      }}>
        {[
          { id: 'transcript', label: 'Transcript', count: 24 },
          { id: 'notes',      label: 'Notes',      dot: true },
          { id: 'people',     label: 'People',     count: 3 },
          { id: 'chat',       label: 'Chat',       count: 2 },
        ].map((t, i) => (
          <button key={t.id} style={{
            padding: '8px 12px 10px',
            fontSize: 12.5, fontWeight: 500,
            color: i === 0 ? 'var(--ink-0)' : 'var(--ink-2)',
            borderBottom: `2px solid ${i === 0 ? 'var(--ink-0)' : 'transparent'}`,
            marginBottom: -1,
            display: 'inline-flex', alignItems: 'center', gap: 5,
          }}>
            {t.label}
            {t.count !== undefined && (
              <span className="mono" style={{
                fontSize: 10, padding: '1px 5px', borderRadius: 4,
                background: 'oklch(from var(--paper-3) l c h / 0.9)', color: 'var(--ink-2)',
              }}>{t.count}</span>
            )}
            {t.dot && <span style={{ width: 5, height: 5, borderRadius: 999, background: 'var(--bloom-1)', boxShadow: '0 0 6px var(--bloom-glow)' }} />}
          </button>
        ))}
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '10px 6px' }}>
        <TranscriptRow speaker="Alex" initials="A" color="oklch(0.55 0.16 25)" time="14:12" text="Let's walk through where the payment service fits." />
        <TranscriptRow speaker="Sarah" initials="S" color="oklch(0.55 0.11 220)" time="14:19" text="Should it live inside the edge, or behind the gateway?" />
        <TranscriptRow speaker="Alex" initials="A" color="oklch(0.55 0.16 25)" time="14:24" text="Behind the gateway — same as everything else." />
        <TranscriptRow speaker="John" initials="J" color="oklch(0.55 0.14 148)" time="14:28" text="Adding it there now. Route will be /pay." active cited="4" />

        <div style={{
          display: 'flex', gap: 12,
          padding: '10px 14px',
          borderRadius: 10,
          background: 'oklch(from var(--bloom-1) l c h / 0.06)',
          border: '1px dashed var(--bloom-wash-2)',
          margin: '4px 8px',
        }}>
          <SpeakerChip initials="J" name="John" color="oklch(0.55 0.14 148)" />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 3 }}>
              <span style={{ fontSize: 12, fontWeight: 600 }}>John · speaking</span>
              <Waveform bars={4} />
            </div>
            <div style={{ fontSize: 13, fontFamily: 'var(--font-serif)', fontStyle: 'italic', color: 'var(--ink-0)', lineHeight: 1.5 }}>
              "{transcript}<span style={{ display: 'inline-block', width: 2, height: 14, background: 'var(--bloom-2)', marginLeft: 2, verticalAlign: -2, animation: 'pulse-bloom 1s ease-in-out infinite' }}/>"
            </div>
          </div>
        </div>

        <div style={{
          margin: '10px 8px 0',
          padding: 12,
          borderRadius: 10,
          background: 'oklch(from var(--bloom-1) l c h / 0.05)',
          border: '1px solid var(--bloom-wash-2)',
        }}>
          <div className="mono-caps" style={{ color: 'var(--bloom-2)', marginBottom: 8 }}>
            <Ico.Sparkle style={{ display: 'inline', verticalAlign: -2, marginRight: 4 }} />
            Extracted from this meeting
          </div>
          <div style={{ display: 'grid', gap: 6 }}>
            <MiniIntelChip icon={<DecisionIcon />} kind="decision" text="Payment Service goes behind the gateway" color="var(--bloom-2)" />
            <MiniIntelChip icon={<ActionIcon />}   kind="action"   text="John: add /pay route to gateway" color="var(--moss)" />
            <MiniIntelChip icon={<QuestionIcon />} kind="question" text="Retries — silent or surface to user?" color="oklch(0.55 0.16 40)" />
          </div>
          <button
            className="btn ghost"
            onClick={() => window.__lucentGo && window.__lucentGo(22)}
            style={{ marginTop: 10, height: 28, fontSize: 12, width: '100%', cursor: 'pointer' }}
          >
            Review 3 extractions →
          </button>
        </div>
      </div>
    </div>
  );
}

function MiniIntelChip({ icon, kind, text, color }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 8,
      padding: '7px 10px',
      background: 'var(--paper-0)',
      border: '1px solid oklch(from var(--paper-4) l c h / 0.5)',
      borderRadius: 8,
      cursor: 'pointer',
    }}>
      <span style={{
        width: 20, height: 20, borderRadius: 5,
        background: `oklch(from ${color} l c h / 0.15)`, color: color,
        display: 'grid', placeItems: 'center', flexShrink: 0,
      }}>{icon}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="mono" style={{ fontSize: 9, color: color, letterSpacing: '0.06em', textTransform: 'uppercase', fontWeight: 700, marginBottom: 2 }}>
          {kind}
        </div>
        <div style={{ fontSize: 12, color: 'var(--ink-0)', lineHeight: 1.4 }}>{text}</div>
      </div>
    </div>
  );
}

Object.assign(window, { ScreenMeetingBoard });
