// Floating AI conversation pill with expandable history

function AIPill({
  placeholder = 'Ask Lucent to build something…',
  status,           // { text, kind } — shown as chip above
  value = '',
  onChange,
  onSubmit,
  listening = false,
  onToggleMic,
  expanded: expandedProp = false,
  history = [],
  onToggleExpand,
}) {
  // Default nav behaviour so the pill feels alive across screens
  const go = (n) => window.__lucentGo && window.__lucentGo(n);
  const defaultToggleMic = () => go(5);
  const defaultSubmit = () => go(2);

  const [expanded, setExpanded] = useState(expandedProp);
  useEffect(() => setExpanded(expandedProp), [expandedProp]);
  const toggleExpand = onToggleExpand || (() => setExpanded(v => !v));

  return (
    <div className="ai-pill-wrap">
      {status && (
        <div className="pill-status">
          <span className="pulse" />
          <span>{status.text}</span>
        </div>
      )}

      {expanded && history.length > 0 && (
        <div className="ai-history-bubble" style={{
          width: 620,
          maxHeight: 320,
          overflowY: 'auto',
          padding: 14,
          backdropFilter: 'blur(24px) saturate(1.5)',
          borderRadius: 'var(--r-xl)',
          boxShadow: 'var(--elev-3)',
          display: 'flex', flexDirection: 'column', gap: 10,
          position: 'relative',
        }}>
          <button
            onClick={toggleExpand}
            title="Collapse"
            style={{
              position: 'absolute', top: 8, right: 8,
              width: 22, height: 22, borderRadius: 999,
              display: 'grid', placeItems: 'center',
              color: 'var(--ink-3)',
              background: 'var(--canvas-2)',
              border: '1px solid var(--stroke-1)',
            }}
          >
            <Ico.Down style={{ transform: 'rotate(180deg)' }} />
          </button>
          {history.map((m, i) => (
            <ConvoTurn key={i} {...m} />
          ))}
        </div>
      )}

      <div className={`ai-pill ${listening ? 'listening' : ''}`}>
        <div className="pill-icon">
          {listening ? <Ico.Mic2 style={{ color: 'var(--amber-1)' }} /> : <Ico.Sparkle />}
        </div>
        {listening ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 12 }}>
            <div className="waveform">
              {Array.from({ length: 14 }, (_, i) => (
                <span key={i} style={{ animationDelay: `${i * 60}ms`, height: `${20 + Math.random() * 60}%` }} />
              ))}
            </div>
            <span style={{ fontSize: 13, color: 'var(--ink-1)', fontStyle: 'italic' }}>
              Listening…
            </span>
          </div>
        ) : (
          <input
            value={value}
            onChange={e => onChange && onChange(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && onSubmit && onSubmit()}
            placeholder={placeholder}
          />
        )}
        <span className="kbd">⌘K</span>
        <button
          className={`mic-btn ${listening ? 'active' : ''}`}
          onClick={onToggleMic || defaultToggleMic}
          title="Voice · Screen 5"
        >
          <Ico.Mic />
        </button>
        <button
          className="send-btn"
          onClick={onSubmit || defaultSubmit}
          title="Send · Watch generation"
        >
          <Ico.Send />
        </button>
      </div>

      {history.length > 0 && !expanded && (
        <button
          onClick={toggleExpand}
          style={{
            fontSize: 11, color: 'var(--ink-2)', fontFamily: 'var(--font-mono)',
            letterSpacing: '0.05em', textTransform: 'uppercase',
            padding: '4px 10px', borderRadius: 999,
            background: 'oklch(from var(--canvas-2) l c h / 0.6)',
            border: '1px solid var(--stroke-1)',
            backdropFilter: 'blur(12px)',
          }}
        >
          {history.length} messages ↑
        </button>
      )}
    </div>
  );
}

function ConvoTurn({ role, content, time }) {
  const isUser = role === 'user';
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
      <div style={{
        width: 22, height: 22, borderRadius: 6, flexShrink: 0,
        display: 'grid', placeItems: 'center',
        background: isUser ? 'var(--canvas-3)' : 'linear-gradient(135deg, var(--amber-2), var(--amber-3))',
        color: isUser ? 'var(--ink-1)' : 'var(--canvas-0)',
      }}>
        {isUser ? <Ico.User /> : <Ico.Sparkle />}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: 10, fontFamily: 'var(--font-mono)', letterSpacing: '0.05em',
          textTransform: 'uppercase', color: 'var(--ink-3)', marginBottom: 3,
          display: 'flex', gap: 8,
        }}>
          <span>{isUser ? 'You' : 'Lucent'}</span>
          {time && <span>· {time}</span>}
        </div>
        <div style={{ fontSize: 13, color: isUser ? 'var(--ink-0)' : 'var(--ink-1)', lineHeight: 1.5 }}>
          {content}
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { AIPill, ConvoTurn });
