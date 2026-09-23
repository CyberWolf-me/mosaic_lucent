// Lucent v2 — atoms_v3: intelligence, execution, meeting overlays, cross-cutting

// =================================================================
// DECISION CARD — a first-class intelligence artifact with provenance
// =================================================================
function DecisionCard({ title, status = 'active', owner, ownerColor, date, evidence, from, superseded, compact, onClick }) {
  const statusStyle = {
    active:      { bg: 'oklch(from var(--moss) l c h / 0.10)',    fg: 'var(--moss)',    label: 'Active' },
    superseded:  { bg: 'oklch(from var(--ink-3) l c h / 0.10)',   fg: 'var(--ink-2)',   label: 'Superseded' },
    review:      { bg: 'var(--bloom-wash)',                       fg: 'var(--bloom-2)', label: 'In review' },
    pending:     { bg: 'oklch(from var(--saffron) l c h / 0.15)', fg: 'oklch(0.5 0.14 65)', label: 'Pending' },
  }[status] || { bg: 'var(--paper-2)', fg: 'var(--ink-2)', label: status };

  return (
    <div
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      style={{
        padding: compact ? '12px 14px' : '16px 18px',
        borderRadius: 12,
        background: 'var(--paper-0)',
        border: '1px solid oklch(from var(--paper-4) l c h / 0.5)',
        boxShadow: 'var(--shadow-1)',
        transition: 'all 0.15s var(--e-out)',
        cursor: onClick ? 'pointer' : 'default',
      }}
      onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-1px)'; e.currentTarget.style.boxShadow = 'var(--shadow-2)'; e.currentTarget.style.borderColor = 'var(--ink-3)'; }}
      onMouseLeave={e => { e.currentTarget.style.transform = 'translateY(0)'; e.currentTarget.style.boxShadow = 'var(--shadow-1)'; e.currentTarget.style.borderColor = 'oklch(from var(--paper-4) l c h / 0.5)'; }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span style={{
          padding: '2px 8px',
          borderRadius: 4,
          fontFamily: 'var(--font-mono)', fontSize: 9.5, fontWeight: 700, letterSpacing: '0.08em',
          background: statusStyle.bg,
          color: statusStyle.fg,
          textTransform: 'uppercase',
        }}>{statusStyle.label}</span>
        {superseded && (
          <span className="mono" style={{ fontSize: 10, color: 'var(--ink-3)' }}>
            → superseded by <a style={{ color: 'var(--bloom-2)', textDecoration: 'underline', textDecorationStyle: 'dotted' }}>{superseded}</a>
          </span>
        )}
        <div style={{ flex: 1 }} />
        <span className="mono" style={{ fontSize: 10, color: 'var(--ink-3)', letterSpacing: '0.02em' }}>{date}</span>
      </div>
      <div style={{
        fontFamily: 'var(--font-serif)',
        fontSize: compact ? 15 : 17,
        fontWeight: 500,
        color: 'var(--ink-0)',
        letterSpacing: '-0.01em',
        marginBottom: compact ? 6 : 10,
        textDecoration: status === 'superseded' ? 'line-through' : 'none',
        textDecorationColor: 'var(--ink-3)',
        opacity: status === 'superseded' ? 0.7 : 1,
      }}>{title}</div>
      {evidence && (
        <div style={{
          fontSize: 12.5, color: 'var(--ink-2)', lineHeight: 1.5,
          fontFamily: 'var(--font-serif)', fontStyle: 'italic',
          padding: '8px 10px 8px 12px',
          borderLeft: '2px solid var(--bloom-2)',
          background: 'oklch(from var(--bloom-1) l c h / 0.04)',
          borderRadius: '0 4px 4px 0',
          marginBottom: 10,
        }}>"{evidence}"</div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        {owner && (
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 5,
            fontSize: 11.5, color: 'var(--ink-1)',
          }}>
            <span style={{
              width: 16, height: 16, borderRadius: 999,
              background: ownerColor || 'var(--ink-2)',
              color: 'white',
              fontFamily: 'var(--font-mono)', fontSize: 8, fontWeight: 700,
              display: 'grid', placeItems: 'center',
            }}>{owner[0]}</span>
            {owner}
          </span>
        )}
        {from && (
          <ProvenanceChip icon={from.icon} label={from.label} />
        )}
      </div>
    </div>
  );
}

// =================================================================
// PROVENANCE CHIP — "where did this come from?" tag
// =================================================================
function ProvenanceChip({ icon, label, onClick }) {
  return (
    <button onClick={onClick} style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      padding: '3px 8px 3px 4px',
      background: 'oklch(from var(--paper-2) l c h / 0.7)',
      border: '1px solid oklch(from var(--paper-4) l c h / 0.5)',
      borderRadius: 999,
      fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--ink-2)',
      letterSpacing: '0.02em',
      cursor: 'pointer',
    }}
      onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--ink-3)'; e.currentTarget.style.color = 'var(--ink-0)'; }}
      onMouseLeave={e => { e.currentTarget.style.borderColor = 'oklch(from var(--paper-4) l c h / 0.5)'; e.currentTarget.style.color = 'var(--ink-2)'; }}
    >
      {icon && <span style={{ display: 'grid', placeItems: 'center' }}>{icon}</span>}
      {label}
    </button>
  );
}

// =================================================================
// ACTION / TASK CARD
// =================================================================
function ActionCard({ title, owner, ownerColor, due, status = 'todo', priority, project, decision, external, compact }) {
  const statusMap = {
    todo:    { icon: '○', color: 'var(--ink-3)' },
    doing:   { icon: '◐', color: 'var(--bloom-2)' },
    done:    { icon: '●', color: 'var(--moss)' },
    blocked: { icon: '⚠', color: 'var(--madder)' },
  };
  const s = statusMap[status] || statusMap.todo;
  const overdue = due && due.startsWith('OVERDUE');
  return (
    <div style={{
      padding: compact ? '10px 12px' : '14px 16px',
      borderRadius: 10,
      background: 'var(--paper-0)',
      border: `1px solid ${overdue ? 'oklch(from var(--madder) l c h / 0.4)' : 'oklch(from var(--paper-4) l c h / 0.5)'}`,
      display: 'flex',
      gap: 12,
      alignItems: 'flex-start',
      transition: 'all 0.15s var(--e-out)',
      cursor: 'pointer',
    }}
      onMouseEnter={e => { e.currentTarget.style.background = 'var(--paper-1)'; }}
      onMouseLeave={e => { e.currentTarget.style.background = 'var(--paper-0)'; }}
    >
      <div style={{
        width: 18, height: 18, borderRadius: 4,
        border: `1.5px solid ${s.color}`,
        display: 'grid', placeItems: 'center',
        flexShrink: 0, marginTop: 1,
        background: status === 'done' ? s.color : 'transparent',
        color: status === 'done' ? 'white' : 'transparent',
      }}>
        {status === 'done' && <Ico.Check style={{ width: 12, height: 12 }} />}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: compact ? 13 : 14, fontWeight: 500, color: 'var(--ink-0)',
          textDecoration: status === 'done' ? 'line-through' : 'none',
          opacity: status === 'done' ? 0.6 : 1,
          marginBottom: 4,
        }}>{title}</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          {owner && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--ink-2)' }}>
              <span style={{
                width: 14, height: 14, borderRadius: 999,
                background: ownerColor, color: 'white',
                fontFamily: 'var(--font-mono)', fontSize: 8, fontWeight: 700,
                display: 'grid', placeItems: 'center',
              }}>{owner[0]}</span>
              {owner}
            </span>
          )}
          {due && (
            <span className="mono" style={{
              fontSize: 10.5,
              color: overdue ? 'var(--madder)' : 'var(--ink-3)',
              fontWeight: overdue ? 600 : 400,
            }}>{due}</span>
          )}
          {priority && <PriorityChip level={priority} />}
          {project && <ProvenanceChip icon={<Ico.Folder />} label={project} />}
          {decision && <ProvenanceChip icon={<DecisionIcon />} label={decision} />}
          {external && (
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              padding: '2px 7px',
              background: 'oklch(0.55 0.14 265 / 0.12)',
              color: 'oklch(0.5 0.14 265)',
              fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 600,
              borderRadius: 4,
            }}>
              <LinearMark /> {external}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function PriorityChip({ level }) {
  const c = { P0: 'var(--madder)', P1: 'oklch(0.55 0.16 40)', P2: 'oklch(0.55 0.14 78)', P3: 'var(--ink-3)' }[level] || 'var(--ink-3)';
  return (
    <span style={{
      padding: '1px 6px', borderRadius: 3,
      fontFamily: 'var(--font-mono)', fontSize: 9.5, fontWeight: 700,
      color: 'white', background: c,
    }}>{level}</span>
  );
}

function DecisionIcon() { return <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3L21 12 12 21 3 12z"/></svg>; }
function RiskIcon()     { return <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3l9 16H3z"/><path d="M12 10v4M12 17v0.5"/></svg>; }
function QuestionIcon() { return <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9"/><path d="M9 9c.5-2 5-2 5 0 0 2-3 2-3 4M11 17v0.5"/></svg>; }
function ActionIcon()   { return <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M4 5h16M4 12h10M4 19h16"/><path d="M18 10l3 2-3 2"/></svg>; }
function LinearMark() { return <svg width="11" height="11" viewBox="0 0 100 100" fill="currentColor"><path d="M3.4 63.7c-.2 1 .3 2 1.1 2.7L34 95.6c.7.8 1.7 1.3 2.7 1.1C58.1 93 74.8 76.3 78.9 55.1c.2-1-.3-2-1.1-2.7L48.3 22.9c-.7-.8-1.7-1.3-2.7-1.1C24.4 25.9 7.7 42.6 3.4 63.7z"/><path d="M8.5 41.5c-.5.9-.4 2 .3 2.8l46.9 46.9c.8.7 1.9.8 2.8.3 5.6-3.3 10.6-7.5 14.7-12.6.6-.8.6-2-.2-2.7L23.4 26.9c-.7-.7-1.9-.8-2.7-.2-5.1 4.1-9.3 9.1-12.2 14.8z"/><path d="M25 15.5l59.5 59.5c.6.6 1.7.6 2.2-.1 2-2.5 3.7-5.2 5.2-8 .5-1 .3-2.2-.5-3L36.6 10.3c-.8-.8-2-1-3-.5-2.8 1.4-5.5 3.2-8 5.2-.7.5-.7 1.5-.6 1.5z"/><ellipse cx="50" cy="50" rx="41" ry="41" transform="rotate(-45 50 50)" fill="none" stroke="currentColor" strokeWidth="4" opacity="0"/></svg>; }
function JiraMark()   { return <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M11.53 2C11.53 4.62 13.66 6.75 16.28 6.75H18.20V8.61C18.21 11.24 20.34 13.37 22.97 13.37V2.71C22.97 2.32 22.65 2 22.26 2H11.53M6.77 6.8C6.77 9.42 8.9 11.55 11.53 11.55H13.44V13.41C13.45 16.04 15.58 18.17 18.21 18.17V7.5C18.21 7.11 17.89 6.79 17.5 6.79H6.77M2 11.6C2 14.22 4.13 16.35 6.75 16.35H8.67V18.21C8.68 20.84 10.81 22.97 13.44 22.97V12.3C13.44 11.91 13.12 11.6 12.73 11.6H2Z"/></svg>; }
function GithubMark() { return <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M12 .3a12 12 0 0 0-3.8 23.4c.6.1.8-.3.8-.6v-2c-3.3.7-4-1.6-4-1.6-.6-1.4-1.4-1.8-1.4-1.8-1-.7.1-.7.1-.7 1.2 0 1.9 1.2 1.9 1.2 1 1.8 2.8 1.3 3.5 1 0-.8.4-1.3.7-1.6-2.7-.3-5.5-1.3-5.5-6 0-1.2.5-2.3 1.3-3.1-.2-.4-.6-1.6 0-3.2 0 0 1-.3 3.4 1.2a11.5 11.5 0 0 1 6 0c2.3-1.5 3.3-1.2 3.3-1.2.7 1.6.2 2.8.1 3.2.9.8 1.3 1.9 1.3 3.1 0 4.6-2.8 5.6-5.5 5.9.5.4.9 1 .9 2.2v3.3c0 .3.1.7.8.6A12 12 0 0 0 12 .3"/></svg>; }
function SlackMark() { return <svg width="11" height="11" viewBox="0 0 24 24" fill="none"><rect x="10" y="2" width="4" height="12" rx="2" fill="#e01e5a"/><rect x="10" y="14" width="4" height="8" rx="2" fill="#e01e5a"/><rect x="2" y="10" width="12" height="4" rx="2" fill="#36c5f0"/><rect x="14" y="10" width="8" height="4" rx="2" fill="#36c5f0"/></svg>; }
function FigmaMark() { return <svg width="11" height="11" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4" fill="#1abcfe"/><path d="M8 4h4v8H8a4 4 0 010-8z" fill="#f24e1e"/><path d="M12 4h4a4 4 0 010 8h-4V4z" fill="#ff7262"/><path d="M8 12h4v8a4 4 0 01-4-4v-4z" fill="#0acf83"/><path d="M8 12a4 4 0 100 8" fill="#a259ff"/></svg>; }
function NotionMark() { return <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M3.5 3.7L15.5 3l6 3v13.5l-6 1.5-12-1.5V3.7z" fillOpacity="0.05" stroke="currentColor" strokeWidth="1.5"/><path d="M8 8v8M8 8l6 8V8" strokeWidth="1.8" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round"/></svg>; }
function ZoomMark() { return <svg width="11" height="11" viewBox="0 0 24 24" fill="#0b5cff"><rect x="2" y="6" width="16" height="12" rx="2"/><path d="M18 10l4-2v8l-4-2z"/></svg>; }
function DriveMark() { return <svg width="11" height="11" viewBox="0 0 24 24"><path d="M6 20l3-5h12l-3 5H6z" fill="#4285f4"/><path d="M9 3l-6 12 3 5 6-12-3-5z" fill="#0f9d58"/><path d="M9 3h6l6 12h-6z" fill="#f4b400"/></svg>; }

// =================================================================
// RISK CHIP + QUESTION CARD
// =================================================================
function RiskChip({ severity = 'med', probability = 'med', title, owner, ownerColor }) {
  const sevColor = { high: 'var(--madder)', med: 'oklch(0.55 0.16 40)', low: 'var(--ink-3)' }[severity];
  return (
    <div style={{
      padding: '12px 14px',
      borderRadius: 10,
      background: 'var(--paper-0)',
      border: `1px solid oklch(from ${sevColor} l c h / 0.4)`,
      borderLeft: `4px solid ${sevColor}`,
      display: 'flex', gap: 12, alignItems: 'center',
    }}>
      <div style={{ color: sevColor, flexShrink: 0 }}><RiskIcon /></div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13.5, fontWeight: 500, color: 'var(--ink-0)', marginBottom: 3 }}>{title}</div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <span className="mono" style={{ fontSize: 10, color: sevColor, fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase' }}>
            {severity} sev · {probability} prob
          </span>
          {owner && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--ink-2)' }}>
              <span style={{ width: 14, height: 14, borderRadius: 999, background: ownerColor, color: 'white', fontFamily: 'var(--font-mono)', fontSize: 8, fontWeight: 700, display: 'grid', placeItems: 'center' }}>{owner[0]}</span>
              {owner}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

// =================================================================
// VIDEO TILE (for meeting overlays)
// =================================================================
function VideoTile({ name, initials, color, muted, speaking, camera = true, size = 'md', tag }) {
  const sizes = { sm: { w: 120, h: 78 }, md: { w: 180, h: 110 }, lg: { w: 260, h: 150 } };
  const s = sizes[size];
  return (
    <div style={{
      position: 'relative',
      width: s.w, height: s.h,
      borderRadius: 12,
      background: camera
        ? `radial-gradient(circle at 30% 40%, ${color}, oklch(from ${color} calc(l - 0.2) c h))`
        : 'oklch(0.14 0.014 55)',
      border: speaking ? '2px solid var(--bloom-1)' : '1.5px solid oklch(from var(--paper-4) l c h / 0.6)',
      boxShadow: speaking ? '0 0 0 3px var(--bloom-wash), var(--shadow-2)' : 'var(--shadow-2)',
      overflow: 'hidden',
      transition: 'all 0.2s var(--e-out)',
    }}>
      {!camera && (
        <div style={{
          position: 'absolute', inset: 0, display: 'grid', placeItems: 'center',
          color: 'oklch(0.7 0.01 60)', fontFamily: 'var(--font-mono)', fontSize: 24, fontWeight: 700,
        }}>{initials}</div>
      )}
      {camera && (
        <div style={{
          position: 'absolute', inset: 0, display: 'grid', placeItems: 'center',
          color: 'white', fontFamily: 'var(--font-mono)', fontSize: 32, fontWeight: 700,
          textShadow: '0 2px 8px rgba(0,0,0,0.3)',
        }}>{initials}</div>
      )}
      {/* Bottom bar */}
      <div style={{
        position: 'absolute', bottom: 0, left: 0, right: 0,
        padding: '20px 10px 8px',
        background: 'linear-gradient(180deg, transparent, rgba(0,0,0,0.55))',
        display: 'flex', alignItems: 'center', gap: 6,
      }}>
        <span style={{
          fontSize: 11.5, fontWeight: 600, color: 'white',
          textShadow: '0 1px 2px rgba(0,0,0,0.5)',
          flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{name}</span>
        {muted && (
          <div style={{ background: 'rgba(0,0,0,0.5)', padding: 4, borderRadius: 999, color: 'white' }}>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 1l22 22M9 9v3a3 3 0 0 0 5.1 2.1M9 5V3a3 3 0 0 1 6 0v6M5 11a7 7 0 0 0 12 5"/></svg>
          </div>
        )}
      </div>
      {tag && (
        <div style={{
          position: 'absolute', top: 6, left: 6,
          padding: '2px 7px', borderRadius: 4,
          background: 'rgba(0,0,0,0.55)',
          color: 'white', fontFamily: 'var(--font-mono)', fontSize: 9, fontWeight: 700, letterSpacing: '0.06em',
        }}>{tag}</div>
      )}
    </div>
  );
}

// =================================================================
// APPROVAL CARD (Review Queue) — AI-proposed change awaiting human OK
// =================================================================
function ApprovalCard({ kind = 'decision', title, summary, from, when, changes, onApprove, onReject, onEdit }) {
  const kindMap = {
    decision: { icon: <DecisionIcon />, label: 'Decision', color: 'var(--bloom-2)' },
    action:   { icon: <ActionIcon />,   label: 'Action',   color: 'var(--moss)' },
    risk:     { icon: <RiskIcon />,     label: 'Risk',     color: 'var(--madder)' },
    question: { icon: <QuestionIcon />, label: 'Question', color: 'oklch(0.55 0.16 40)' },
    edit:     { icon: <Ico.Pen />,      label: 'Canvas edit', color: 'var(--saffron)' },
  }[kind] || { icon: <Ico.Sparkle />, label: kind, color: 'var(--ink-2)' };

  return (
    <div style={{
      padding: 18,
      borderRadius: 14,
      background: 'var(--paper-0)',
      border: '1px solid oklch(from var(--paper-4) l c h / 0.6)',
      boxShadow: 'var(--shadow-1)',
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 12 }}>
        <div style={{
          width: 32, height: 32, borderRadius: 8,
          background: `oklch(from ${kindMap.color} l c h / 0.12)`,
          color: kindMap.color,
          display: 'grid', placeItems: 'center',
          flexShrink: 0,
        }}>{kindMap.icon}</div>
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <span className="mono-caps" style={{ color: kindMap.color, fontSize: 10, letterSpacing: '0.08em' }}>
              PROPOSED · {kindMap.label}
            </span>
            <span className="mono" style={{ fontSize: 10, color: 'var(--ink-3)' }}>· {when}</span>
          </div>
          <div style={{
            fontFamily: 'var(--font-serif)', fontSize: 17, fontWeight: 500,
            color: 'var(--ink-0)', letterSpacing: '-0.01em', lineHeight: 1.3,
          }}>{title}</div>
          {summary && (
            <div style={{ fontSize: 13, color: 'var(--ink-2)', lineHeight: 1.5, marginTop: 6 }}>{summary}</div>
          )}
        </div>
      </div>

      {changes && (
        <div style={{
          padding: '10px 12px',
          background: 'oklch(from var(--paper-2) l c h / 0.6)',
          borderRadius: 8,
          marginBottom: 12,
          display: 'flex', gap: 14, flexWrap: 'wrap',
        }}>
          {changes.map((c, i) => (
            <span key={i} style={{
              fontFamily: 'var(--font-mono)', fontSize: 10.5, color: c.color || 'var(--ink-2)',
              letterSpacing: '0.02em',
            }}>
              <span style={{ fontWeight: 700 }}>{c.count}</span> {c.label}
            </span>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        {from && <ProvenanceChip icon={from.icon} label={from.label} />}
        <div style={{ flex: 1 }} />
        <button className="btn ghost" style={{ height: 30, fontSize: 12 }} onClick={onEdit}>
          <Ico.Pen /> Edit
        </button>
        <button className="btn ghost danger" style={{ height: 30, fontSize: 12 }} onClick={onReject}>
          <Ico.X /> Reject
        </button>
        <button className="btn bloom" style={{ height: 30, fontSize: 12, flex: 'none', padding: '0 14px' }} onClick={onApprove}>
          <Ico.Check /> Approve
        </button>
      </div>
    </div>
  );
}

// =================================================================
// LENS SWITCHER — swap board representation
// =================================================================
function LensSwitcher({ current = 'freeform', onChange }) {
  const lenses = [
    { id: 'freeform',   label: 'Freeform',    icon: <Ico.Cursor /> },
    { id: 'mindmap',    label: 'Mind map',    icon: <Ico.Mind /> },
    { id: 'flow',       label: 'Flowchart',   icon: <Ico.Flow /> },
    { id: 'arch',       label: 'Architecture',icon: <Ico.Layers /> },
    { id: 'journey',    label: 'Journey',     icon: <Ico.Journey /> },
    { id: 'decision',   label: 'Decision',    icon: <DecisionIcon /> },
    { id: 'execution',  label: 'Execution',   icon: <ActionIcon /> },
    { id: 'timeline',   label: 'Timeline',    icon: <Ico.History /> },
  ];
  return (
    <div style={{
      display: 'inline-flex',
      padding: 3,
      background: 'oklch(from var(--paper-0) l c h / 0.9)',
      border: '1px solid oklch(from var(--paper-4) l c h / 0.6)',
      borderRadius: 999,
      backdropFilter: 'blur(20px)',
      boxShadow: 'var(--shadow-1)',
      gap: 1,
    }}>
      {lenses.map(l => (
        <button
          key={l.id}
          onClick={() => onChange && onChange(l.id)}
          title={l.label}
          style={{
            padding: '5px 10px',
            borderRadius: 999,
            display: 'inline-flex', alignItems: 'center', gap: 5,
            fontSize: 11.5, fontWeight: 500,
            background: current === l.id ? 'var(--ink-0)' : 'transparent',
            color: current === l.id ? 'var(--paper-0)' : 'var(--ink-2)',
            transition: 'all 0.12s var(--e-out)',
          }}
        >
          {l.icon}
          <span>{l.label}</span>
        </button>
      ))}
    </div>
  );
}

// =================================================================
// SECTION HEADER — used across intel / exec screens
// =================================================================
function SectionHeader({ eyebrow, title, meta, actions }) {
  return (
    <div style={{ marginBottom: 22 }}>
      {eyebrow && <div className="mono-caps" style={{ marginBottom: 6 }}>{eyebrow}</div>}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 14 }}>
        <div style={{
          fontFamily: 'var(--font-serif)', fontSize: 34, fontWeight: 400,
          color: 'var(--ink-0)', letterSpacing: '-0.02em', lineHeight: 1.1,
        }}>{title}</div>
        {meta && <div style={{ fontFamily: 'var(--font-serif)', fontStyle: 'italic', fontSize: 15, color: 'var(--ink-2)' }}>{meta}</div>}
        <div style={{ flex: 1 }} />
        {actions}
      </div>
    </div>
  );
}

// =================================================================
// FILTER BAR — reusable pill filters
// =================================================================
function FilterBar({ filters, active, onChange, extra }) {
  return (
    <div style={{ display: 'flex', gap: 6, marginBottom: 20, alignItems: 'center', flexWrap: 'wrap' }}>
      {filters.map(f => (
        <button key={f.id}
          onClick={() => onChange && onChange(f.id)}
          style={{
            padding: '6px 12px',
            borderRadius: 999,
            fontSize: 12.5, fontWeight: 500,
            background: active === f.id ? 'var(--ink-0)' : 'oklch(from var(--paper-2) l c h / 0.6)',
            color: active === f.id ? 'var(--paper-0)' : 'var(--ink-1)',
            border: `1px solid ${active === f.id ? 'var(--ink-0)' : 'oklch(from var(--paper-4) l c h / 0.5)'}`,
            transition: 'all 0.12s var(--e-out)',
            display: 'inline-flex', alignItems: 'center', gap: 6,
          }}
        >
          {f.label}
          {f.count !== undefined && (
            <span className="mono" style={{
              fontSize: 10,
              padding: '1px 6px',
              borderRadius: 999,
              background: active === f.id ? 'oklch(from var(--paper-0) l c h / 0.2)' : 'oklch(from var(--paper-3) l c h / 0.9)',
              color: active === f.id ? 'var(--paper-0)' : 'var(--ink-2)',
            }}>{f.count}</span>
          )}
        </button>
      ))}
      <div style={{ flex: 1 }} />
      {extra}
    </div>
  );
}

// =================================================================
// GLOBAL RAIL — the 7 top-level product areas
// =================================================================
// Shared notif count — reads from localStorage, listens for updates via a custom event
function useNotifCount() {
  const read = () => {
    try {
      const v = localStorage.getItem('lucent.v2.notifCount');
      return v === null ? 3 : parseInt(v, 10);
    } catch (e) { return 3; }
  };
  const [n, setN] = useState(read());
  useEffect(() => {
    const onChange = () => setN(read());
    window.addEventListener('lucent:notif-count', onChange);
    window.addEventListener('storage', onChange);
    return () => {
      window.removeEventListener('lucent:notif-count', onChange);
      window.removeEventListener('storage', onChange);
    };
  }, []);
  return n;
}
function setNotifCount(n) {
  try { localStorage.setItem('lucent.v2.notifCount', String(n)); } catch (e) {}
  window.dispatchEvent(new CustomEvent('lucent:notif-count'));
}

function GlobalRail({ active = 'board' }) {
  const go = useLucentGo();
  const notifCount = useNotifCount();
  const items = [
    { id: 'home',      icon: <HomeIcon />,    label: 'Home',         to: 11 },
    { id: 'workspace', icon: <Ico.Folder />,  label: 'Workspace',    to: 12 },
    { id: 'board',     icon: <Ico.Layers />,  label: 'Board',        to: 3 },
    { id: 'meeting',   icon: <Ico.Present />, label: 'Meeting',      to: 13 },
    { id: 'intel',     icon: <IntelIcon />,   label: 'Intelligence', to: 14 },
    { id: 'exec',      icon: <ActionIcon />,  label: 'Execution',    to: 18 },
    { id: 'history',   icon: <Ico.History />, label: 'History',      to: 7 },
  ];
  const bottom = [
    { id: 'ask',   icon: <Ico.Search />,   label: 'Ask · Search',  to: 16 },
    { id: 'notif', icon: <BellIcon />,     label: 'Notifications', to: 21, badge: notifCount > 0 ? notifCount : null },
    { id: 'admin', icon: <Ico.Settings />, label: 'Admin',         to: 24 },
  ];
  return (
    <div style={{
      position: 'absolute',
      top: 68, bottom: 56, left: 12,
      width: 60,
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', gap: 4,
      padding: '10px 0',
      background: 'oklch(from var(--paper-0) l c h / 0.85)',
      border: '1px solid oklch(from var(--paper-4) l c h / 0.5)',
      borderRadius: 18,
      backdropFilter: 'blur(20px)',
      zIndex: 30,
      boxShadow: 'var(--shadow-2)',
    }}>
      <button
        style={{
          width: 42, height: 42, borderRadius: 12,
          background: 'var(--bloom-2)',
          color: 'white',
          display: 'grid', placeItems: 'center',
          boxShadow: '0 4px 12px -3px var(--bloom-glow)',
          marginBottom: 6,
        }}
        title="New · ⌘N"
        onClick={() => go(1)}
      ><Ico.Plus /></button>

      {items.map(it => (
        <RailItem key={it.id} item={it} active={active === it.id} onClick={() => go(it.to)} />
      ))}

      <div style={{ flex: 1 }} />

      {bottom.map(it => (
        <RailItem key={it.id} item={it} active={active === it.id} onClick={() => go(it.to)} />
      ))}
    </div>
  );
}
function RailItem({ item, active, onClick }) {
  return (
    <button
      onClick={onClick}
      title={item.label}
      style={{
        width: 42, height: 42, borderRadius: 12,
        display: 'grid', placeItems: 'center',
        color: active ? 'var(--paper-0)' : 'var(--ink-2)',
        background: active ? 'var(--ink-0)' : 'transparent',
        transition: 'all 0.12s var(--e-out)',
        position: 'relative',
      }}
      onMouseEnter={e => !active && (e.currentTarget.style.background = 'var(--paper-2)')}
      onMouseLeave={e => !active && (e.currentTarget.style.background = 'transparent')}
    >
      {item.icon}
      {item.badge && (
        <span style={{
          position: 'absolute', top: 4, right: 4,
          minWidth: 15, height: 15, borderRadius: 999,
          background: 'var(--madder)', color: 'white',
          fontFamily: 'var(--font-mono)', fontSize: 9, fontWeight: 700,
          padding: '0 4px',
          display: 'grid', placeItems: 'center',
          border: '2px solid var(--paper-0)',
        }}>{item.badge}</span>
      )}
    </button>
  );
}
function HomeIcon()   { return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12l9-9 9 9M5 10v10h14V10"/></svg>; }
function IntelIcon()  { return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><circle cx="7" cy="7" r="2.5"/><circle cx="17" cy="7" r="2.5"/><circle cx="12" cy="17" r="2.5"/><path d="M7 9.5L11 15M17 9.5L13 15M9 7h6"/></svg>; }
function BellIcon()   { return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0"/></svg>; }

// =================================================================
// APP SHELL — persistent GlobalRail + TopBar + content area
// =================================================================
function AppShell({ activeArea = 'board', crumbs, actions, children, hideRail }) {
  return (
    <>
      <PaperBackdrop grid={false} />
      <TopBar crumbs={crumbs} actions={actions} />
      {!hideRail && <GlobalRail active={activeArea} />}
      <div style={{
        position: 'absolute',
        top: 56,
        left: hideRail ? 0 : 84,
        right: 0, bottom: 0,
        overflow: 'auto',
      }}>
        {children}
      </div>
    </>
  );
}

// =================================================================
// STAT CARD — small metric block
// =================================================================
function StatCard({ label, value, delta, color = 'var(--ink-0)', sub }) {
  return (
    <div style={{
      padding: '16px 18px',
      borderRadius: 12,
      background: 'var(--paper-0)',
      border: '1px solid oklch(from var(--paper-4) l c h / 0.5)',
    }}>
      <div className="mono-caps" style={{ marginBottom: 8 }}>{label}</div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <div style={{
          fontFamily: 'var(--font-serif)', fontSize: 30, fontWeight: 400,
          color: color, letterSpacing: '-0.02em', lineHeight: 1,
        }}>{value}</div>
        {delta && (
          <span className="mono" style={{ fontSize: 11, color: delta.startsWith('+') ? 'var(--moss)' : delta.startsWith('-') ? 'var(--madder)' : 'var(--ink-3)' }}>
            {delta}
          </span>
        )}
      </div>
      {sub && <div style={{ fontSize: 11.5, color: 'var(--ink-3)', marginTop: 6 }}>{sub}</div>}
    </div>
  );
}

// Export
Object.assign(window, {
  DecisionCard, ProvenanceChip, ActionCard, PriorityChip, RiskChip,
  DecisionIcon, RiskIcon, QuestionIcon, ActionIcon,
  LinearMark, JiraMark, GithubMark, SlackMark, FigmaMark, NotionMark, ZoomMark, DriveMark,
  VideoTile, ApprovalCard, LensSwitcher,
  SectionHeader, FilterBar, StatCard,
  GlobalRail, AppShell,
  HomeIcon, IntelIcon, BellIcon,
  useNotifCount, setNotifCount,
});
