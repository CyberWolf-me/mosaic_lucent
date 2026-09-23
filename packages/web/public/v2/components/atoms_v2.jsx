// Lucent v2 — additional atoms: service icons, sketchy strokes, cursor chips,
// Granola/Otter transcript pieces, minimap, alt/opt frames.

// ==================== Service icons (branded, canvas node badges) ====================
const Svc = {
  postgres: (p) => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" {...p}>
      <path d="M12 3c-3 0-5 1.4-5 4.5 0 2.5 1 6 1.5 8s.5 4 3.5 4 3-2 3.5-4S17 10 17 7.5C17 4.4 15 3 12 3z" fill="#336791" stroke="#1c3d54" strokeWidth="1"/>
      <ellipse cx="10" cy="9" rx="1.2" ry="1.5" fill="#fff"/>
      <ellipse cx="14" cy="9" rx="1.2" ry="1.5" fill="#fff"/>
      <circle cx="10" cy="9" r="0.6" fill="#1c3d54"/>
      <circle cx="14" cy="9" r="0.6" fill="#1c3d54"/>
    </svg>
  ),
  redis: (p) => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" {...p}>
      <ellipse cx="12" cy="7" rx="8" ry="3" fill="#dc382d"/>
      <path d="M4 7v4c0 1.7 3.6 3 8 3s8-1.3 8-3V7" fill="#a41e11"/>
      <path d="M4 11v4c0 1.7 3.6 3 8 3s8-1.3 8-3v-4" fill="#dc382d"/>
      <ellipse cx="12" cy="7" rx="8" ry="3" fill="none" stroke="#7b1a10" strokeWidth="0.6"/>
    </svg>
  ),
  stripe: (p) => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" {...p}>
      <rect x="2" y="4" width="20" height="16" rx="3" fill="#635bff"/>
      <path d="M9.5 10.5c0-.6.5-.9 1.4-.9 1.2 0 2.8.4 4 1v-3.4c-1.3-.5-2.6-.7-4-.7-3.2 0-5.4 1.7-5.4 4.5 0 4.4 6 3.7 6 5.6 0 .7-.6 1-1.5 1-1.4 0-3.2-.6-4.5-1.4v3.5c1.5.7 3 .9 4.5.9 3.3 0 5.6-1.6 5.6-4.5-.1-4.7-6.1-3.9-6.1-5.6z" fill="#fff"/>
    </svg>
  ),
  react: (p) => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" {...p}>
      <circle cx="12" cy="12" r="2" fill="#61dafb"/>
      <ellipse cx="12" cy="12" rx="10" ry="4" stroke="#61dafb" strokeWidth="1.3" fill="none"/>
      <ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(60 12 12)" stroke="#61dafb" strokeWidth="1.3" fill="none"/>
      <ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(120 12 12)" stroke="#61dafb" strokeWidth="1.3" fill="none"/>
    </svg>
  ),
  node: (p) => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" {...p}>
      <path d="M12 2L3 7v10l9 5 9-5V7L12 2z" fill="#68a063" stroke="#3c873a" strokeWidth="0.8"/>
      <text x="12" y="15" textAnchor="middle" fontFamily="monospace" fontSize="7" fontWeight="700" fill="#fff">N</text>
    </svg>
  ),
  s3: (p) => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" {...p}>
      <path d="M4 5h16v14H4z" fill="#e25444"/>
      <path d="M4 5l8-3 8 3v14l-8 3-8-3z" fill="#e25444" stroke="#7b291d" strokeWidth="0.6"/>
      <path d="M12 2v20M4 5l8 3 8-3" stroke="#fff" strokeWidth="0.6" opacity="0.4"/>
      <text x="12" y="15" textAnchor="middle" fontFamily="monospace" fontSize="6" fontWeight="700" fill="#fff">S3</text>
    </svg>
  ),
  nginx: (p) => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" {...p}>
      <path d="M12 2L3 7v10l9 5 9-5V7L12 2z" fill="#009639" stroke="#00622a" strokeWidth="0.8"/>
      <path d="M9 8v9M9 8l6 8V8" stroke="#fff" strokeWidth="1.4" strokeLinecap="round"/>
    </svg>
  ),
  auth: (p) => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" {...p}>
      <rect x="3" y="5" width="18" height="14" rx="3" fill="#eb5424"/>
      <path d="M8 12l2 2 4-4" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
      <circle cx="16" cy="10" r="1.2" fill="#fff"/>
    </svg>
  ),
  queue: (p) => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" {...p}>
      <rect x="3" y="9" width="4" height="6" rx="1" fill="#ff9900"/>
      <rect x="9" y="9" width="4" height="6" rx="1" fill="#ff9900" opacity="0.7"/>
      <rect x="15" y="9" width="4" height="6" rx="1" fill="#ff9900" opacity="0.5"/>
      <path d="M7 12h1M13 12h1" stroke="#7a4600" strokeWidth="1" strokeLinecap="round"/>
    </svg>
  ),
  db: (p) => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" {...p}>
      <ellipse cx="12" cy="6" rx="7" ry="2.5" fill="var(--ink-2)"/>
      <path d="M5 6v12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5V6" fill="var(--ink-1)"/>
      <ellipse cx="12" cy="12" rx="7" ry="2.5" fill="none" stroke="var(--paper-0)" strokeWidth="0.8" opacity="0.5"/>
      <ellipse cx="12" cy="6" rx="7" ry="2.5" fill="none" stroke="var(--ink-0)" strokeWidth="0.8"/>
    </svg>
  ),
  service: (p) => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" {...p}>
      <rect x="3" y="4" width="18" height="16" rx="3" fill="var(--bloom-wash-2)" stroke="var(--bloom-2)" strokeWidth="1.2"/>
      <circle cx="8" cy="10" r="1" fill="var(--bloom-2)"/>
      <path d="M11 10h6M11 14h4" stroke="var(--bloom-2)" strokeWidth="1.2" strokeLinecap="round"/>
      <circle cx="8" cy="14" r="1" fill="var(--bloom-2)"/>
    </svg>
  ),
  cache: (p) => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" {...p}>
      <path d="M12 3L3 8v8l9 5 9-5V8l-9-5z" fill="oklch(0.68 0.17 68)" stroke="oklch(0.45 0.15 60)" strokeWidth="0.8"/>
      <path d="M12 3v9M3 8l9 4 9-4" stroke="#fff" strokeWidth="0.8" opacity="0.5"/>
    </svg>
  ),
  gateway: (p) => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" {...p}>
      <path d="M4 20V8l8-5 8 5v12" fill="oklch(0.55 0.16 148)" stroke="oklch(0.35 0.14 148)" strokeWidth="0.8"/>
      <rect x="10" y="12" width="4" height="8" fill="oklch(0.35 0.14 148)"/>
      <circle cx="8" cy="11" r="1" fill="#fff"/>
      <circle cx="16" cy="11" r="1" fill="#fff"/>
    </svg>
  ),
  client: (p) => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" {...p}>
      <rect x="3" y="4" width="18" height="12" rx="2" fill="var(--paper-0)" stroke="var(--ink-0)" strokeWidth="1.3"/>
      <path d="M9 20h6M12 16v4" stroke="var(--ink-0)" strokeWidth="1.3" strokeLinecap="round"/>
    </svg>
  ),
  mobile: (p) => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" {...p}>
      <rect x="7" y="2" width="10" height="20" rx="2.5" fill="var(--paper-0)" stroke="var(--ink-0)" strokeWidth="1.3"/>
      <circle cx="12" cy="19" r="0.8" fill="var(--ink-0)"/>
      <path d="M10 4h4" stroke="var(--ink-0)" strokeWidth="1" strokeLinecap="round"/>
    </svg>
  ),
};

// ==================== Sketchy Excalidraw-style rectangle ====================
// Renders a wobbly rect + optional diagonal stripe fill using SVG.
function SketchyRect({ w = 200, h = 80, fill = 'none', stroke = 'var(--ink-0)', strokeWidth = 1.8, seed = 1, style }) {
  // Deterministic jitter based on seed
  const j = (n, mag=2) => {
    const s = Math.sin((seed + n) * 12.9898) * 43758.5453;
    return (s - Math.floor(s) - 0.5) * mag;
  };
  const pathBox = (offset=0) => `
    M ${1 + j(1+offset)} ${1 + j(2+offset)}
    L ${w - 1 + j(3+offset)} ${1 + j(4+offset)}
    L ${w - 1 + j(5+offset)} ${h - 1 + j(6+offset)}
    L ${1 + j(7+offset)} ${h - 1 + j(8+offset)}
    Z
  `;
  const patternId = `stripe-${seed}`;
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ position: 'absolute', inset: 0, ...style }}>
      {fill !== 'none' && (
        <defs>
          <pattern id={patternId} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="6" stroke={fill} strokeWidth="1.4" opacity="0.55"/>
          </pattern>
        </defs>
      )}
      {fill !== 'none' && <path d={pathBox(0)} fill={`url(#${patternId})`} />}
      <path d={pathBox(0)} fill="none" stroke={stroke} strokeWidth={strokeWidth} strokeLinejoin="round" strokeLinecap="round"/>
      <path d={pathBox(10)} fill="none" stroke={stroke} strokeWidth={strokeWidth * 0.7} strokeLinejoin="round" strokeLinecap="round" opacity="0.6"/>
    </svg>
  );
}

// A node that uses the sketchy stroke system for that Excalidraw feel.
function SketchyNode({ x, y, w = 200, h = 80, title, meta, icon, color = 'var(--ink-0)', fill = 'none', seed = 1, rot = 0, onClick, children }) {
  return (
    <div
      onClick={onClick}
      style={{
        position: 'absolute',
        left: x, top: y, width: w, height: h,
        transform: `rotate(${rot}deg)`,
        cursor: onClick ? 'pointer' : 'default',
      }}
    >
      <SketchyRect w={w} h={h} fill={fill} stroke={color} seed={seed} />
      <div style={{
        position: 'absolute', inset: 0,
        padding: '10px 14px',
        display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 3,
      }}>
        {meta && (
          <div className="mono-caps" style={{ color: color, opacity: 0.7, fontSize: 9.5 }}>
            {meta}
          </div>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {icon}
          {title && (
            <div style={{
              fontFamily: 'var(--font-serif)',
              fontStyle: 'italic',
              fontSize: 15,
              color: color,
              fontWeight: 500,
              letterSpacing: '-0.005em',
            }}>{title}</div>
          )}
        </div>
        {children}
      </div>
    </div>
  );
}

// ==================== Live cursor chip ====================
function CursorChip({ x, y, name, color = 'oklch(0.55 0.16 25)' }) {
  return (
    <div style={{
      position: 'absolute', left: x, top: y, zIndex: 40,
      pointerEvents: 'none',
    }}>
      <svg width="18" height="20" viewBox="0 0 24 26" fill="none">
        <path d="M4 2l6 20 3-8 8-3z" fill={color} stroke="white" strokeWidth="1.4" strokeLinejoin="round"/>
      </svg>
      <div style={{
        position: 'absolute', left: 18, top: 14,
        padding: '3px 8px',
        background: color,
        color: 'white',
        borderRadius: 6,
        fontFamily: 'var(--font-mono)',
        fontSize: 10.5,
        fontWeight: 600,
        letterSpacing: '0.02em',
        whiteSpace: 'nowrap',
        boxShadow: '0 2px 6px oklch(0 0 0 / 0.16)',
      }}>{name}</div>
    </div>
  );
}

// ==================== Speaker chip + Transcript row (Otter/Granola style) ====================
function SpeakerChip({ initials, name, color, size = 26 }) {
  return (
    <div style={{
      width: size, height: size, borderRadius: 999,
      background: color,
      display: 'grid', placeItems: 'center',
      fontFamily: 'var(--font-mono)',
      fontSize: size * 0.38, fontWeight: 700, color: 'white',
      flexShrink: 0,
      boxShadow: '0 0 0 2px var(--paper-0), 0 1px 2px oklch(0 0 0 / 0.1)',
    }}>{initials}</div>
  );
}

function TranscriptRow({ speaker, initials, color, time, text, active = false, highlight, cited }) {
  return (
    <div style={{
      display: 'flex', gap: 12,
      padding: '10px 14px',
      borderRadius: 10,
      background: active ? 'oklch(from var(--bloom-1) l c h / 0.06)' : 'transparent',
      transition: 'background 0.15s var(--e-out)',
    }}>
      <SpeakerChip initials={initials} name={speaker} color={color} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 2 }}>
          <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--ink-0)' }}>{speaker}</span>
          <span className="mono" style={{ fontSize: 10.5, color: 'var(--ink-3)', letterSpacing: '0.02em' }}>{time}</span>
          {cited && <span className="citation-pill">{cited}</span>}
        </div>
        <div style={{
          fontSize: 13.5, color: 'var(--ink-1)',
          lineHeight: 1.55,
          fontFamily: 'var(--font-serif)',
        }}>
          {highlight ? <HighlightedText text={text} query={highlight} /> : text}
        </div>
      </div>
    </div>
  );
}

function HighlightedText({ text, query }) {
  if (!query) return text;
  const parts = text.split(new RegExp(`(${query})`, 'ig'));
  return parts.map((p, i) =>
    p.toLowerCase() === query.toLowerCase()
      ? <mark key={i} style={{
          background: 'oklch(from var(--saffron) l c h / 0.4)',
          color: 'var(--ink-0)',
          padding: '0 2px', borderRadius: 3,
        }}>{p}</mark>
      : <React.Fragment key={i}>{p}</React.Fragment>
  );
}

// ==================== Citation pill (Granola style) ====================
// Small numbered chip that appears after AI claims and links to a transcript row.
function CitationPill({ n, onClick }) {
  return (
    <button
      onClick={onClick}
      className="citation-pill"
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: 18, height: 18, borderRadius: 999,
        background: 'oklch(from var(--bloom-1) l c h / 0.14)',
        color: 'var(--bloom-2)',
        fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 700,
        border: '1px solid oklch(from var(--bloom-2) l c h / 0.3)',
        marginLeft: 3, verticalAlign: 1,
        transition: 'all 0.12s',
      }}
      onMouseEnter={e => { e.currentTarget.style.background = 'var(--bloom-2)'; e.currentTarget.style.color = 'white'; }}
      onMouseLeave={e => { e.currentTarget.style.background = 'oklch(from var(--bloom-1) l c h / 0.14)'; e.currentTarget.style.color = 'var(--bloom-2)'; }}
    >{n}</button>
  );
}

// ==================== "Ask anything" bar (Granola signature) ====================
function AskAnythingBar({ placeholder = 'Ask anything', context, value, onChange, onSubmit }) {
  const [v, setV] = useState(value || '');
  useEffect(() => { if (value !== undefined) setV(value); }, [value]);
  return (
    <div style={{
      position: 'absolute', bottom: context ? 64 : 30, left: '50%', transform: 'translateX(-50%)',
      zIndex: 40, width: 560, maxWidth: 'calc(100vw - 60px)',
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '10px 14px',
        background: 'oklch(from var(--paper-0) l c h / 0.96)',
        backdropFilter: 'blur(20px)',
        border: '1px solid oklch(from var(--paper-4) l c h / 0.7)',
        borderRadius: 999,
        boxShadow: 'var(--shadow-3)',
      }}>
        <div style={{
          width: 26, height: 26, borderRadius: 999,
          background: 'oklch(from var(--bloom-1) l c h / 0.12)',
          display: 'grid', placeItems: 'center',
          color: 'var(--bloom-2)',
        }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 3v18M8 7h8M6 11h12M8 15h8"/>
          </svg>
        </div>
        <input
          value={v}
          onChange={e => { setV(e.target.value); onChange && onChange(e.target.value); }}
          onKeyDown={e => { if (e.key === 'Enter' && v && onSubmit) onSubmit(v); }}
          placeholder={placeholder}
          style={{ flex: 1, fontSize: 14, color: 'var(--ink-0)', padding: '4px 0' }}
        />
        <button
          disabled={!v}
          onClick={() => onSubmit && onSubmit(v)}
          style={{
            width: 30, height: 30, borderRadius: 999,
            background: v ? 'var(--bloom-2)' : 'var(--paper-3)',
            color: v ? 'white' : 'var(--ink-3)',
            display: 'grid', placeItems: 'center',
            transition: 'all 0.15s var(--e-out)',
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 12h14M13 6l6 6-6 6"/>
          </svg>
        </button>
      </div>
      {context && (
        <div style={{
          display: 'flex', gap: 6, marginTop: 8, justifyContent: 'center',
          fontFamily: 'var(--font-mono)', fontSize: 10.5,
          color: 'var(--ink-3)', letterSpacing: '0.03em',
        }}>
          {context}
        </div>
      )}
    </div>
  );
}

// ==================== Minimap (Miro/Figma style) ====================
function Minimap({ children, w = 180, h = 120 }) {
  return (
    <div style={{
      position: 'absolute', bottom: 24, right: 24, zIndex: 25,
      width: w, height: h,
      background: 'oklch(from var(--paper-0) l c h / 0.92)',
      border: '1px solid oklch(from var(--paper-4) l c h / 0.6)',
      borderRadius: 10,
      overflow: 'hidden',
      boxShadow: 'var(--shadow-2)',
      backdropFilter: 'blur(12px)',
    }}>
      <div style={{
        position: 'absolute', top: 6, left: 8,
        fontFamily: 'var(--font-mono)', fontSize: 9.5,
        color: 'var(--ink-3)', letterSpacing: '0.06em',
      }}>MAP</div>
      <div style={{ position: 'absolute', inset: 0 }}>{children}</div>
      {/* Viewport rect */}
      <div style={{
        position: 'absolute',
        left: '25%', top: '20%', width: '45%', height: '55%',
        border: '1.5px solid var(--bloom-2)',
        background: 'oklch(from var(--bloom-1) l c h / 0.08)',
        borderRadius: 3,
      }} />
    </div>
  );
}

// ==================== Alt/Opt/Loop frame for sequence diagrams (Eraser style) ====================
function SeqFrame({ x, y, w, h, label, kind = 'alt', children }) {
  const colors = {
    alt:  { border: 'oklch(0.68 0.17 68)',  fill: 'oklch(0.68 0.17 68 / 0.06)' },
    opt:  { border: 'var(--moss)',           fill: 'oklch(from var(--moss) l c h / 0.06)' },
    loop: { border: 'var(--bloom-2)',        fill: 'var(--bloom-wash)' },
    par:  { border: 'oklch(0.62 0.18 300)', fill: 'oklch(0.62 0.18 300 / 0.06)' },
  };
  const c = colors[kind] || colors.alt;
  return (
    <div style={{
      position: 'absolute', left: x, top: y, width: w, height: h,
      border: `1.5px solid ${c.border}`,
      background: c.fill,
      borderRadius: 6,
      pointerEvents: 'none',
    }}>
      <div style={{
        position: 'absolute', top: 0, left: 0,
        padding: '2px 10px',
        background: c.border,
        color: 'white',
        fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 700,
        letterSpacing: '0.06em', textTransform: 'uppercase',
        borderRadius: '6px 0 6px 0',
      }}>{kind}</div>
      {label && (
        <div style={{
          position: 'absolute', top: 3, left: 50,
          fontFamily: 'var(--font-mono)', fontSize: 10.5,
          color: c.border, letterSpacing: '0.03em',
        }}>{label}</div>
      )}
      {children}
    </div>
  );
}

// ==================== Container (Miro/Eraser grouping) ====================
function Container({ x, y, w, h, label, kind = 'default', children, style }) {
  const colors = {
    default:    { border: 'var(--ink-3)',   bg: 'oklch(from var(--paper-3) l c h / 0.4)' },
    production: { border: 'var(--madder)',  bg: 'oklch(from var(--madder) l c h / 0.04)' },
    staging:    { border: 'var(--saffron)', bg: 'oklch(from var(--saffron) l c h / 0.05)' },
    data:       { border: 'var(--bloom-2)', bg: 'var(--bloom-wash)' },
    edge:       { border: 'var(--moss)',    bg: 'oklch(from var(--moss) l c h / 0.05)' },
  };
  const c = colors[kind] || colors.default;
  return (
    <div style={{
      position: 'absolute', left: x, top: y, width: w, height: h,
      border: `1.5px dashed ${c.border}`,
      background: c.bg,
      borderRadius: 12,
      ...style,
    }}>
      <div style={{
        position: 'absolute', top: -11, left: 14,
        padding: '2px 10px',
        background: 'var(--paper-1)',
        color: c.border,
        fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 700,
        letterSpacing: '0.08em', textTransform: 'uppercase',
        borderRadius: 4,
      }}>{label}</div>
      {children}
    </div>
  );
}

// ==================== Note block — AI-authored structured note (Granola) ====================
function NoteBlock({ children, tone = 'default' }) {
  return (
    <div style={{
      padding: '2px 0',
      fontFamily: 'var(--font-sans)',
      fontSize: 14.5,
      color: 'var(--ink-0)',
      lineHeight: 1.65,
    }}>
      {children}
    </div>
  );
}

function NoteH2({ children }) {
  return (
    <h2 style={{
      fontFamily: 'var(--font-serif)',
      fontSize: 22, fontWeight: 500,
      letterSpacing: '-0.015em',
      color: 'var(--ink-0)',
      marginTop: 22, marginBottom: 8,
    }}>{children}</h2>
  );
}
function NoteH3({ children }) {
  return (
    <h3 style={{
      fontSize: 15, fontWeight: 600,
      color: 'var(--ink-0)',
      marginTop: 16, marginBottom: 4,
      letterSpacing: '-0.005em',
    }}>{children}</h3>
  );
}
function NoteBullet({ children, indent = 0 }) {
  return (
    <div style={{
      display: 'flex', gap: 10,
      paddingLeft: 4 + indent * 22,
      marginBottom: 8,
      fontSize: 14, color: 'var(--ink-1)', lineHeight: 1.7,
    }}>
      <span style={{
        display: 'inline-block',
        width: 4, height: 4, borderRadius: 999,
        background: indent === 0 ? 'var(--ink-1)' : 'var(--ink-3)',
        marginTop: 10, flexShrink: 0,
      }} />
      <div style={{ minWidth: 0, flex: 1 }}>{children}</div>
    </div>
  );
}

Object.assign(window, {
  Svc, SketchyRect, SketchyNode,
  CursorChip, SpeakerChip, TranscriptRow, CitationPill, AskAnythingBar,
  Minimap, SeqFrame, Container, NoteBlock, NoteH2, NoteH3, NoteBullet,
});
