// Lucent v2 — AI pill (ink input)

function AIPill({ status, listening = false, placeholder = "Tell me what you want to build…", value, onChange, onSubmit, dark = false }) {
  const [v, setV] = useState(value || '');
  const [mic, setMic] = useState(listening);

  useEffect(() => { if (value !== undefined) setV(value); }, [value]);

  return (
    <div className="ai-pill-wrap">
      {status && (
        <div className="pill-status">
          {mic ? <span className="pulse" /> : <Ico.Sparkle style={{ color: 'var(--bloom-2)' }} />}
          {status}
        </div>
      )}
      <div className={`ai-pill ${mic ? 'listening' : ''}`}>
        <span className="pill-icon"><Ico.Sparkle /></span>
        <input
          value={v}
          onChange={e => { setV(e.target.value); onChange && onChange(e.target.value); }}
          onKeyDown={e => { if (e.key === 'Enter' && v && onSubmit) onSubmit(v); }}
          placeholder={placeholder}
        />
        <span className="kbd">⌘K</span>
        <button
          className={`mic-btn ${mic ? 'active' : ''}`}
          onClick={() => setMic(m => !m)}
          title="Voice · Space"
        >
          {mic ? <Waveform bars={7} active={true} /> : <Ico.Mic />}
        </button>
        <button
          className="send-btn"
          disabled={!v}
          onClick={() => onSubmit && onSubmit(v)}
          title="Send · ↵"
        >
          <Ico.Send />
        </button>
      </div>
    </div>
  );
}

Object.assign(window, { AIPill });
