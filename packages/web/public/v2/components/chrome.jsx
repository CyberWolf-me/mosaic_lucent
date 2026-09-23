// Lucent v2 — chrome: top bar, left rail, command palette, badges

function useLucentGo() {
  return (n) => { if (typeof window.__lucentGo === 'function') window.__lucentGo(n); };
}

function TopBar({ crumbs, actions }) {
  const go = useLucentGo();
  const [share, setShare] = useState(false);
  const [profile, setProfile] = useState(false);
  const defaultCrumbs = [
    { label: 'Personal', screen: 11 },
    { label: 'Lucent', current: true },
  ];
  const cs = crumbs || defaultCrumbs;
  return (
    <div className="top-bar">
      <button className="brand" onClick={() => go(11)} title="Home">
        <div className="brand-mark" />
        <span>Lucent</span>
      </button>
      <span className="crumb-sep">·</span>
      {cs.map((c, i) => (
        <React.Fragment key={i}>
          {c.screen ? (
            <button className={`crumb ${c.current ? 'current' : ''}`} onClick={() => go(c.screen)}>
              {c.label}
            </button>
          ) : (
            <span className={`crumb ${c.current ? 'current' : ''}`}>{c.label}</span>
          )}
          {i < cs.length - 1 && <span className="crumb-sep">/</span>}
        </React.Fragment>
      ))}
      <div className="spacer" />
      <div className="actions">
        {actions || (
          <>
            <button className="icon-btn" onClick={() => setShare(true)} title="Share this workspace">
              <Ico.Share /> Share
            </button>
            <button className="icon-btn" onClick={() => go(13)} title="Present · start meeting on this board">
              <Ico.Present /> Present
            </button>
            <div style={{ width: 8 }} />
            <button className="avatar" onClick={() => setProfile(p => !p)} title="Profile">AK</button>
          </>
        )}
      </div>
      {share && <SharePopover onClose={() => setShare(false)} />}
      {profile && <ProfileMenu onClose={() => setProfile(false)} />}
    </div>
  );
}

function SharePopover({ onClose }) {
  const [copied, setCopied] = useState(false);
  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 200 }} />
      <div style={{
        position: 'fixed', top: 62, right: 20, zIndex: 201, width: 340,
        padding: 18,
        background: 'oklch(from var(--paper-0) l c h / 0.98)',
        border: '1px solid oklch(from var(--paper-4) l c h / 0.7)',
        borderRadius: 14,
        boxShadow: 'var(--shadow-3)',
        backdropFilter: 'blur(24px)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <Ico.Share />
          <div style={{ fontSize: 13.5, fontWeight: 500 }}>Share workspace</div>
          <div style={{ flex: 1 }} />
          <button onClick={onClose} style={{ padding: 4, color: 'var(--ink-3)' }}><Ico.X /></button>
        </div>
        <div style={{
          display: 'flex', gap: 6, alignItems: 'center',
          padding: '8px 10px',
          background: 'var(--paper-2)',
          border: '1px solid oklch(from var(--paper-4) l c h / 0.6)',
          borderRadius: 8, marginBottom: 12,
        }}>
          <span className="mono" style={{ flex: 1, fontSize: 11.5, color: 'var(--ink-1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            lucent.app/w/e-commerce-x8j2
          </span>
          <button
            onClick={() => { setCopied(true); setTimeout(() => setCopied(false), 1400); }}
            style={{
              fontSize: 11.5, padding: '5px 12px', borderRadius: 6,
              background: copied ? 'oklch(from var(--moss) l c h / 0.15)' : 'var(--ink-0)',
              color: copied ? 'var(--moss)' : 'var(--paper-0)',
              fontWeight: 500,
              display: 'inline-flex', alignItems: 'center', gap: 5,
            }}
          >
            {copied ? <><Ico.Check /> Copied</> : 'Copy'}
          </button>
        </div>
        <div className="mono-caps" style={{ marginBottom: 8 }}>People with access · 3</div>
        {[
          { name: 'Alex Kim', role: 'Owner', color: 'oklch(0.55 0.16 25)' },
          { name: 'Sarah Chen', role: 'Editor', color: 'oklch(0.55 0.11 220)' },
          { name: 'John Torres', role: 'Editor', color: 'oklch(0.55 0.14 148)' },
        ].map(p => (
          <div key={p.name} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0' }}>
            <div style={{
              width: 24, height: 24, borderRadius: 999,
              background: p.color, color: 'white',
              display: 'grid', placeItems: 'center',
              fontSize: 10, fontFamily: 'var(--font-mono)', fontWeight: 700,
            }}>{p.name.split(' ').map(s => s[0]).join('')}</div>
            <div style={{ flex: 1, fontSize: 12.5 }}>{p.name}</div>
            <div className="mono" style={{ fontSize: 10, color: 'var(--ink-3)' }}>{p.role}</div>
          </div>
        ))}
        <div style={{ marginTop: 12, display: 'flex', gap: 6 }}>
          <button className="btn ghost" style={{ height: 32, fontSize: 12, flex: 1 }}><Ico.Plus /> Invite</button>
          <button className="btn ghost" style={{ height: 32, fontSize: 12 }}>Anyone with link</button>
        </div>
      </div>
    </>
  );
}

function ProfileMenu({ onClose }) {
  const go = useLucentGo();
  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 200 }} />
      <div style={{
        position: 'fixed', top: 56, right: 20, zIndex: 201, width: 260,
        padding: 6,
        background: 'oklch(from var(--paper-0) l c h / 0.98)',
        border: '1px solid oklch(from var(--paper-4) l c h / 0.7)',
        borderRadius: 12,
        boxShadow: 'var(--shadow-3)',
        backdropFilter: 'blur(24px)',
        overflow: 'hidden',
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '10px 10px 12px',
          borderBottom: '1px solid oklch(from var(--paper-4) l c h / 0.4)',
          marginBottom: 4,
        }}>
          <div className="avatar" style={{ width: 32, height: 32 }}>AK</div>
          <div>
            <div style={{ fontSize: 13, fontWeight: 500 }}>Alex Kim</div>
            <div className="mono" style={{ fontSize: 10, color: 'var(--ink-3)' }}>alex@northbeam.co</div>
          </div>
        </div>
        {[
          { icon: <HomeIcon />, label: 'Home', to: 11 },
          { icon: <BellIcon />, label: 'Notifications', to: 21, k: '⌘I' },
          { icon: <Ico.Sparkle />, label: 'Review queue', to: 22, k: '⌘R' },
          { icon: <Ico.Settings />, label: 'Admin · settings', to: 24, k: '⌘,' },
        ].map(m => (
          <button key={m.label} onClick={() => { go(m.to); onClose(); }} style={{
            display: 'flex', alignItems: 'center', gap: 10,
            width: '100%', padding: '8px 10px', borderRadius: 7,
            color: 'var(--ink-1)', fontSize: 12.5, textAlign: 'left',
          }}
            onMouseEnter={e => e.currentTarget.style.background = 'var(--paper-2)'}
            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
          >
            <span style={{ color: 'var(--ink-3)', display: 'grid', placeItems: 'center' }}>{m.icon}</span>
            <span style={{ flex: 1 }}>{m.label}</span>
            {m.k && <span className="mono" style={{ fontSize: 10, color: 'var(--ink-3)' }}>{m.k}</span>}
          </button>
        ))}
        <div style={{ height: 1, background: 'oklch(from var(--paper-4) l c h / 0.4)', margin: '4px 0' }} />
        <button style={{
          display: 'flex', alignItems: 'center', gap: 10,
          width: '100%', padding: '8px 10px', borderRadius: 7,
          color: 'var(--madder)', fontSize: 12.5, textAlign: 'left',
        }}
          onMouseEnter={e => e.currentTarget.style.background = 'oklch(from var(--madder) l c h / 0.08)'}
          onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
        >
          <Ico.X />
          Sign out
        </button>
      </div>
    </>
  );
}

function LeftRail({ active = 'canvas' }) {
  const go = useLucentGo();
  const [searchOpen, setSearchOpen] = useState(false);

  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); setSearchOpen(true); }
      if (e.key === 'Escape') setSearchOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const items = [
    { id: 'projects',   icon: <Ico.Folder />, label: 'Projects',   to: 6 },
    { id: 'canvas',     icon: <Ico.Layers />, label: 'Canvas',     to: 3 },
    { id: 'flows',      icon: <Ico.Flow />,   label: 'Sequence',   to: 10 },
    { id: 'journeys',   icon: <Ico.Journey />,label: 'Meeting',    to: 8 },
    { id: 'wireframes', icon: <Ico.Grid />,   label: 'Wireframes', to: 9 },
    { id: 'mindmaps',   icon: <Ico.Mind />,   label: 'Live AI',    to: 2 },
  ];
  return (
    <>
      <div className="left-rail">
        <button className="rail-btn" title="New" onClick={() => go(1)}><Ico.Plus /></button>
        <div className="rail-divider" />
        {items.map(it => (
          <button
            key={it.id}
            className={`rail-btn ${active === it.id ? 'active' : ''}`}
            title={it.label}
            onClick={() => go(it.to)}
          >{it.icon}</button>
        ))}
        <div style={{ flex: 1 }} />
        <button className="rail-btn" title="History" onClick={() => go(7)}><Ico.History /></button>
        <button className="rail-btn" title="Search · ⌘K" onClick={() => setSearchOpen(true)}><Ico.Search /></button>
      </div>
      {searchOpen && <CommandOverlay onClose={() => setSearchOpen(false)} />}
    </>
  );
}

function CommandOverlay({ onClose }) {
  const go = useLucentGo();
  const [q, setQ] = useState('');
  const inputRef = useRef(null);
  useEffect(() => { inputRef.current && inputRef.current.focus(); }, []);

  const items = [
    { label: 'Go to empty canvas',      hint: 'Screen · New',          icon: <Ico.Plus />,    to: 1 },
    { label: 'Watch AI generate',       hint: 'Demo · Progressive',    icon: <Ico.Sparkle />, to: 2 },
    { label: 'Open E-commerce platform',hint: 'Workspace · 2 min ago', icon: <Ico.Layers />,  to: 3 },
    { label: 'Review proposed changes', hint: '6 pending edits',       icon: <Ico.Sparkle />, to: 4 },
    { label: 'Start voice session',     hint: 'Voice · Listening',     icon: <Ico.Mic />,     to: 5 },
    { label: 'Go to dashboard',         hint: 'Personal · Home',       icon: <Ico.Folder />,  to: 6 },
    { label: 'Open workspace history',  hint: '11 events today',       icon: <Ico.History />, to: 7 },
    { label: 'Start meeting mode',      hint: 'Extract from convo',    icon: <Ico.Present />, to: 8 },
    { label: 'Open Checkout wireframe', hint: 'Wireframe · 1440',      icon: <Ico.Grid />,    to: 9 },
    { label: 'Open Checkout sequence',  hint: 'Sequence · 8 msgs',     icon: <Ico.Flow />,    to: 10 },
  ];
  const filtered = items.filter(i => !q || i.label.toLowerCase().includes(q.toLowerCase()) || i.hint.toLowerCase().includes(q.toLowerCase()));

  return (
    <>
      <div className="cmd-scrim" onClick={onClose} />
      <div className="cmd-modal">
        <div style={{
          display: 'flex', alignItems: 'center', gap: 12,
          padding: '16px 20px',
          borderBottom: '1px solid oklch(from var(--paper-4) l c h / 0.5)',
        }}>
          <Ico.Search style={{ color: 'var(--ink-2)' }} />
          <input
            ref={inputRef} value={q} onChange={e => setQ(e.target.value)}
            placeholder="Search workspaces, or ask Lucent to draft something…"
            style={{ flex: 1, fontSize: 14.5 }}
            onKeyDown={e => { if (e.key === 'Enter' && filtered[0]) { go(filtered[0].to); onClose(); } }}
          />
          <span className="mono" style={{
            fontSize: 10, color: 'var(--ink-3)',
            padding: '4px 7px',
            border: '1px solid oklch(from var(--paper-4) l c h / 0.6)',
            borderRadius: 5,
            background: 'oklch(from var(--paper-2) l c h / 0.7)',
          }}>Esc</span>
        </div>
        <div style={{ maxHeight: 380, overflowY: 'auto', padding: 8 }}>
          {filtered.length === 0 && (
            <div style={{
              padding: 26, textAlign: 'center', fontSize: 13, color: 'var(--ink-3)',
              fontFamily: 'var(--font-serif)', fontStyle: 'italic',
            }}>
              No matches. Press ↵ to ask Lucent to build "{q}"
            </div>
          )}
          {filtered.map((it, i) => (
            <button
              key={i}
              onClick={() => { go(it.to); onClose(); }}
              style={{
                display: 'flex', alignItems: 'center', gap: 12, width: '100%',
                padding: '11px 12px', borderRadius: 10,
                textAlign: 'left', transition: 'background 0.1s',
              }}
              onMouseEnter={e => e.currentTarget.style.background = 'var(--paper-2)'}
              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
            >
              <div style={{
                width: 30, height: 30, borderRadius: 8,
                background: 'var(--paper-2)',
                border: '1px solid oklch(from var(--paper-4) l c h / 0.5)',
                display: 'grid', placeItems: 'center',
                color: 'var(--ink-1)', flexShrink: 0,
              }}>{it.icon}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13.5, color: 'var(--ink-0)', fontWeight: 500 }}>{it.label}</div>
                <div className="mono" style={{ fontSize: 10.5, color: 'var(--ink-3)', marginTop: 2, letterSpacing: '0.02em' }}>{it.hint}</div>
              </div>
              <span style={{ color: 'var(--ink-3)' }}><Ico.Arrow /></span>
            </button>
          ))}
        </div>
        <div className="mono" style={{
          padding: '10px 16px',
          borderTop: '1px solid oklch(from var(--paper-4) l c h / 0.5)',
          display: 'flex', alignItems: 'center', gap: 14,
          fontSize: 10, color: 'var(--ink-3)', letterSpacing: '0.03em',
        }}>
          <span>↩ Open</span>
          <span>↑↓ Navigate</span>
          <span>Esc Close</span>
          <div style={{ flex: 1 }} />
          <span>⌘K anywhere</span>
        </div>
      </div>
    </>
  );
}

function ZoomBadge({ zoom = 100 }) {
  const [z, setZ] = useState(zoom);
  return (
    <div className="chrome-badge" style={{
      position: 'absolute', bottom: 12, right: 20, zIndex: 25,
      display: 'flex', alignItems: 'center', gap: 4,
      padding: '6px 8px', borderRadius: 999,
      fontSize: 11, userSelect: 'none',
    }}>
      <button style={{ padding: '2px 8px', fontSize: 14, lineHeight: 1 }} onClick={() => setZ(v => Math.max(25, v - 10))}>−</button>
      <button className="mono" style={{ minWidth: 44, textAlign: 'center', color: 'var(--ink-0)' }} onClick={() => setZ(100)}>{z}%</button>
      <button style={{ padding: '2px 8px', fontSize: 14, lineHeight: 1 }} onClick={() => setZ(v => Math.min(400, v + 10))}>+</button>
    </div>
  );
}

function StatusBadge({ children }) {
  return (
    <div className="chrome-badge mono" style={{
      position: 'absolute', bottom: 12, right: 130, zIndex: 25,
      display: 'flex', alignItems: 'center', gap: 8,
      padding: '6px 12px', borderRadius: 999,
      fontSize: 11, letterSpacing: '0.03em', whiteSpace: 'nowrap',
    }}>
      {children}
    </div>
  );
}

// Shape toolbar (FigJam-like left floating)
function ShapeToolbar({ side = 'bottom' }) {
  const [tool, setTool] = useState('select');
  const items = [
    { id: 'select', icon: <Ico.Cursor />, tip: 'Select · V' },
    { id: 'hand',   icon: <Ico.Hand />,   tip: 'Hand · H' },
    'div',
    { id: 'rect',   icon: <Ico.Rect />,   tip: 'Rectangle · R' },
    { id: 'circle', icon: <Ico.Circle />, tip: 'Ellipse · O' },
    { id: 'diamond',icon: <Ico.Diamond />,tip: 'Diamond · D' },
    { id: 'line',   icon: <Ico.Line />,   tip: 'Line · L' },
    'div',
    { id: 'text',   icon: <Ico.Type />,   tip: 'Text · T' },
    { id: 'sticky', icon: <Ico.Sticky />, tip: 'Sticky · S' },
    { id: 'pen',    icon: <Ico.Pen />,    tip: 'Pen · P' },
  ];
  return (
    <div className="chrome-badge" style={{
      position: 'absolute',
      bottom: side === 'bottom' ? 96 : 'auto',
      left: side === 'bottom' ? '50%' : 20,
      top: side === 'bottom' ? 'auto' : '50%',
      transform: side === 'bottom' ? 'translateX(-50%)' : 'translateY(-50%)',
      display: 'flex',
      flexDirection: side === 'bottom' ? 'row' : 'column',
      gap: 2, padding: 5, borderRadius: 14, zIndex: 22,
      boxShadow: 'var(--shadow-2)',
    }}>
      {items.map((it, i) => it === 'div' ? (
        <div key={i} style={{
          [side === 'bottom' ? 'width' : 'height']: 1,
          [side === 'bottom' ? 'height' : 'width']: 20,
          background: 'oklch(from var(--paper-4) l c h / 0.6)',
          margin: side === 'bottom' ? '0 4px' : '4px 0',
        }} />
      ) : (
        <button
          key={it.id}
          onClick={() => setTool(it.id)}
          title={it.tip}
          style={{
            width: 34, height: 34, borderRadius: 9,
            display: 'grid', placeItems: 'center',
            background: tool === it.id ? 'var(--ink-0)' : 'transparent',
            color: tool === it.id ? 'var(--paper-0)' : 'var(--ink-2)',
            transition: 'all 0.12s var(--e-out)',
          }}
          onMouseEnter={e => tool !== it.id && (e.currentTarget.style.background = 'var(--paper-2)')}
          onMouseLeave={e => tool !== it.id && (e.currentTarget.style.background = 'transparent')}
        >{it.icon}</button>
      ))}
    </div>
  );
}

// Presence stack — used to show collaborators on the canvas
function PresenceStack({ people = [] }) {
  return (
    <div style={{
      position: 'absolute', top: 12, right: 20, zIndex: 22,
      display: 'flex', alignItems: 'center', gap: -6,
    }}>
      {people.map((p, i) => (
        <div key={i} style={{
          width: 28, height: 28, borderRadius: 999,
          background: p.color,
          border: '2px solid var(--paper-0)',
          display: 'grid', placeItems: 'center',
          fontFamily: 'var(--font-mono)',
          fontSize: 10, fontWeight: 600, color: 'white',
          marginLeft: i === 0 ? 0 : -8,
          boxShadow: 'var(--shadow-1)',
          zIndex: people.length - i,
        }}>{p.initials}</div>
      ))}
    </div>
  );
}

Object.assign(window, { TopBar, LeftRail, CommandOverlay, ZoomBadge, StatusBadge, ShapeToolbar, PresenceStack, useLucentGo });
