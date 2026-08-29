// Top bar, left rail, screen switcher

// Global navigation helper — the app exposes window.__lucentGo(screenId) which
// sets the screen and persists it. Any chrome component can call it.
function useLucentGo() {
  return (screenId) => {
    if (typeof window.__lucentGo === 'function') window.__lucentGo(screenId);
  };
}

function TopBar({ crumbs, actions, light }) {
  const go = useLucentGo();
  const [share, setShare] = useState(false);
  const defaultCrumbs = [
    { label: 'Personal', current: false, screen: 6 },
    { label: 'Lucent', current: true },
  ];
  const cs = crumbs || defaultCrumbs;
  return (
    <div className="top-bar" data-screen-label={undefined}>
      <button
        className="brand"
        onClick={() => go(6)}
        title="Home"
        style={{ background: 'none', border: 0, padding: 0, cursor: 'pointer' }}
      >
        <div className="logo" />
        <span>Lucent</span>
      </button>
      <span className="crumb-sep">/</span>
      {cs.map((c, i) => (
        <React.Fragment key={i}>
          {c.screen ? (
            <button
              className={`crumb ${c.current ? 'current' : ''}`}
              onClick={() => go(c.screen)}
              style={{ background: 'none', border: 0, cursor: 'pointer' }}
            >
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
            <button className="icon-btn" onClick={() => setShare(true)}>
              <Ico.Share /> Share
            </button>
            <button className="icon-btn" onClick={() => go(8)} title="Present / Meeting mode">
              <Ico.Present /> Present
            </button>
            <div style={{ width: 8 }} />
            <ProfileMenu
              onOpenSettings={(sec) => window.__lucentOpenSettings && window.__lucentOpenSettings(sec)}
            />
          </>
        )}
      </div>

      {share && <ShareDialog onClose={() => setShare(false)} light={light} />}
    </div>
  );
}

// Small share popover to give the Share button something to do
function ShareDialog({ onClose, light }) {
  const [copied, setCopied] = useState(false);
  return (
    <>
      <div
        onClick={onClose}
        style={{ position: 'fixed', inset: 0, zIndex: 200, background: 'transparent' }}
      />
      <div
        style={{
          position: 'fixed', top: 62, right: 20, zIndex: 201, width: 320,
          padding: 16,
          background: light ? 'var(--paper-0)' : 'oklch(from var(--canvas-2) l c h / 0.95)',
          border: `1px solid ${light ? 'var(--paper-3)' : 'var(--stroke-2)'}`,
          borderRadius: 14,
          boxShadow: 'var(--elev-3)',
          backdropFilter: 'blur(20px)',
          color: light ? 'var(--paper-ink-0)' : 'var(--ink-0)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <Ico.Share />
          <div style={{ fontSize: 13, fontVariationSettings: "'wght' 550" }}>Share workspace</div>
          <div style={{ flex: 1 }} />
          <button onClick={onClose} style={{ padding: 4, color: light ? 'var(--paper-ink-2)' : 'var(--ink-3)' }}>
            <Ico.X />
          </button>
        </div>

        <div style={{
          display: 'flex', gap: 6, alignItems: 'center',
          padding: '8px 10px',
          background: light ? 'var(--paper-1)' : 'var(--canvas-2)',
          border: `1px solid ${light ? 'var(--paper-2)' : 'var(--stroke-1)'}`,
          borderRadius: 6,
          marginBottom: 12,
        }}>
          <span className="mono" style={{
            flex: 1, fontSize: 11,
            color: light ? 'var(--paper-ink-1)' : 'var(--ink-2)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            lucent.app/w/e-commerce-x8j2
          </span>
          <button
            onClick={() => { setCopied(true); setTimeout(() => setCopied(false), 1400); }}
            style={{
              fontSize: 11, padding: '4px 10px', borderRadius: 5,
              background: copied ? 'oklch(0.78 0.11 155 / 0.15)' : (light ? 'var(--paper-ink-0)' : 'var(--ink-0)'),
              color: copied ? 'var(--sig-green)' : (light ? 'var(--paper-0)' : 'var(--canvas-0)'),
              fontVariationSettings: "'wght' 550",
              display: 'inline-flex', alignItems: 'center', gap: 4,
            }}
          >
            {copied ? <><Ico.Check /> Copied</> : 'Copy'}
          </button>
        </div>

        <div className="mono" style={{
          fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase',
          color: light ? 'var(--paper-ink-2)' : 'var(--ink-3)',
          marginBottom: 8,
        }}>
          People with access
        </div>
        {[
          { name: 'Alex Kim', role: 'Owner', color: 'oklch(0.55 0.11 30)' },
          { name: 'Sarah Chen', role: 'Editor', color: 'oklch(0.55 0.11 220)' },
          { name: 'John Torres', role: 'Editor', color: 'oklch(0.55 0.11 130)' },
        ].map((p, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0' }}>
            <div style={{
              width: 24, height: 24, borderRadius: 999,
              background: p.color, display: 'grid', placeItems: 'center',
              fontSize: 10, fontFamily: 'var(--font-mono)',
              color: 'var(--canvas-0)', fontVariationSettings: "'wght' 600",
            }}>{p.name.split(' ').map(s => s[0]).join('')}</div>
            <div style={{ flex: 1, fontSize: 12.5 }}>{p.name}</div>
            <div className="mono" style={{
              fontSize: 10, color: light ? 'var(--paper-ink-2)' : 'var(--ink-3)',
              letterSpacing: '0.03em',
            }}>{p.role}</div>
          </div>
        ))}
      </div>
    </>
  );
}

// Left rail — each button navigates to the most relevant screen.
// Map:
//   Projects   -> 6 (Dashboard)
//   Canvas     -> 3 (Main canvas)
//   Flows      -> 10 (Sequence)
//   Journeys   -> 8 (Meeting mode — story extraction)
//   Wireframes -> 9 (Wireframe)
//   Mind maps  -> 2 (AI generating — brainstorm demo)
//   Plus       -> 1 (Empty canvas / new)
//   History    -> 7 (History timeline)
//   Search     -> opens the command overlay
function LeftRail({ active = 'canvas', side = 'left' }) {
  const go = useLucentGo();
  const [searchOpen, setSearchOpen] = useState(false);

  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setSearchOpen(true);
      }
      if (e.key === 'Escape') setSearchOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const items = [
    { id: 'projects',   icon: <Ico.Folder />, label: 'Projects',    to: 6 },
    { id: 'canvas',     icon: <Ico.Layers />, label: 'Canvas',      to: 3 },
    { id: 'flows',      icon: <Ico.Flow />,   label: 'Sequence',    to: 10 },
    { id: 'journeys',   icon: <Ico.Journey />,label: 'Meeting',     to: 8 },
    { id: 'wireframes', icon: <Ico.Grid />,   label: 'Wireframes',  to: 9 },
    { id: 'mindmaps',   icon: <Ico.Mind />,   label: 'Live AI',     to: 2 },
  ];
  return (
    <>
      <div className={`left-rail ${side === 'right' ? 'on-right' : ''}`}>
        <button className="rail-btn" title="New workspace (1)" onClick={() => go(1)}>
          <Ico.Plus />
        </button>
        <div className="rail-divider" />
        {items.map(it => (
          <button
            key={it.id}
            className={`rail-btn ${active === it.id ? 'active' : ''}`}
            title={it.label}
            onClick={() => go(it.to)}
          >
            {it.icon}
          </button>
        ))}
        <div style={{ flex: 1 }} />
        <button className="rail-btn" title="History" onClick={() => go(7)}>
          <Ico.History />
        </button>
        <button className="rail-btn" title="Search · ⌘K" onClick={() => setSearchOpen(true)}>
          <Ico.Search />
        </button>
      </div>

      {searchOpen && <CommandOverlay onClose={() => setSearchOpen(false)} />}
    </>
  );
}

// Command / search overlay (⌘K)
function CommandOverlay({ onClose }) {
  const go = useLucentGo();
  const [q, setQ] = useState('');
  const inputRef = useRef(null);
  useEffect(() => { inputRef.current && inputRef.current.focus(); }, []);

  const items = [
    { label: 'Go to empty canvas',      hint: 'Screen · New',        icon: <Ico.Plus />,    to: 1 },
    { label: 'Watch AI generate',       hint: 'Demo · Progressive',  icon: <Ico.Sparkle />, to: 2 },
    { label: 'Open E-commerce platform',hint: 'Workspace · 2 min ago', icon: <Ico.Layers />,  to: 3 },
    { label: 'Review proposed changes', hint: '6 pending edits',     icon: <Ico.Sparkle />, to: 4 },
    { label: 'Start voice session',     hint: 'Voice · Listening',   icon: <Ico.Mic />,     to: 5 },
    { label: 'Go to dashboard',         hint: 'Personal · Home',     icon: <Ico.Folder />,  to: 6 },
    { label: 'Open workspace history',  hint: '11 events today',     icon: <Ico.History />, to: 7 },
    { label: 'Start meeting mode',      hint: 'Extract from convo',  icon: <Ico.Present />, to: 8 },
    { label: 'Open Checkout wireframe', hint: 'Wireframe · 1440',    icon: <Ico.Grid />,    to: 9 },
    { label: 'Open Checkout sequence',  hint: 'Sequence · 8 msgs',   icon: <Ico.Flow />,    to: 10 },
  ];
  const filtered = items.filter(i =>
    !q || i.label.toLowerCase().includes(q.toLowerCase()) || i.hint.toLowerCase().includes(q.toLowerCase())
  );

  return (
    <>
      <div
        onClick={onClose}
        style={{
          position: 'fixed', inset: 0, zIndex: 300,
          background: 'oklch(0.10 0.005 60 / 0.55)',
          backdropFilter: 'blur(6px)',
        }}
      />
      <div style={{
        position: 'fixed', top: '18vh', left: '50%', transform: 'translateX(-50%)',
        zIndex: 301, width: 560, maxWidth: 'calc(100vw - 40px)',
        background: 'oklch(from var(--canvas-2) l c h / 0.96)',
        border: '1px solid var(--stroke-2)',
        borderRadius: 16,
        boxShadow: 'var(--elev-3)',
        overflow: 'hidden',
        backdropFilter: 'blur(24px)',
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 12,
          padding: '14px 18px',
          borderBottom: '1px solid var(--stroke-1)',
        }}>
          <Ico.Search style={{ color: 'var(--ink-2)' }} />
          <input
            ref={inputRef}
            value={q}
            onChange={e => setQ(e.target.value)}
            placeholder="Search workspaces or ask Lucent to do something…"
            style={{ flex: 1, fontSize: 14, color: 'var(--ink-0)' }}
            onKeyDown={e => {
              if (e.key === 'Enter' && filtered[0]) { go(filtered[0].to); onClose(); }
            }}
          />
          <span className="kbd" style={{
            fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--ink-3)',
            padding: '3px 6px', border: '1px solid var(--stroke-1)', borderRadius: 4,
          }}>Esc</span>
        </div>
        <div style={{ maxHeight: 380, overflowY: 'auto', padding: 6 }}>
          {filtered.length === 0 && (
            <div style={{
              padding: 24, textAlign: 'center', fontSize: 12.5, color: 'var(--ink-3)',
              fontFamily: 'var(--font-mono)', letterSpacing: '0.03em',
            }}>
              No matches · Press Enter to ask Lucent to build "{q}"
            </div>
          )}
          {filtered.map((it, i) => (
            <button
              key={i}
              onClick={() => { go(it.to); onClose(); }}
              style={{
                display: 'flex', alignItems: 'center', gap: 12, width: '100%',
                padding: '10px 12px', borderRadius: 8,
                textAlign: 'left', transition: 'background 0.1s',
              }}
              onMouseEnter={e => e.currentTarget.style.background = 'var(--canvas-3)'}
              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
            >
              <div style={{
                width: 26, height: 26, borderRadius: 6,
                background: 'var(--canvas-3)',
                display: 'grid', placeItems: 'center',
                color: 'var(--ink-1)',
                flexShrink: 0,
              }}>{it.icon}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, color: 'var(--ink-0)', fontVariationSettings: "'wght' 500" }}>
                  {it.label}
                </div>
                <div className="mono" style={{ fontSize: 10.5, color: 'var(--ink-3)', marginTop: 1, letterSpacing: '0.02em' }}>
                  {it.hint}
                </div>
              </div>
              <span style={{ color: 'var(--ink-3)' }}><Ico.Arrow /></span>
            </button>
          ))}
        </div>
        <div style={{
          padding: '10px 14px', borderTop: '1px solid var(--stroke-1)',
          display: 'flex', alignItems: 'center', gap: 14,
          fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--ink-3)',
          letterSpacing: '0.03em',
        }}>
          <span>↩ Open</span>
          <span>↑↓ Navigate</span>
          <span>Esc Close</span>
          <div style={{ flex: 1 }} />
          <span style={{ whiteSpace: 'nowrap' }}>⌘K anywhere</span>
        </div>
      </div>
    </>
  );
}

// Zoom control bottom-left — arrows control the CanvasViewport if mounted,
// otherwise operate locally as a display value.
function ZoomBadge({ zoom = 100 }) {
  const [z, setZ] = useState(zoom);
  useEffect(() => setZ(zoom), [zoom]);

  const clampZ = (n) => Math.max(25, Math.min(400, n));

  // Subscribe to viewport updates so pinch/wheel keeps this value fresh
  useEffect(() => {
    let raf;
    const tick = () => {
      const vp = window.__lucentViewport;
      if (vp) {
        const current = Math.round(vp.getZoom());
        setZ(prev => (prev !== current ? current : prev));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const bump = (delta) => {
    const vp = window.__lucentViewport;
    if (vp) vp.setZoom(clampZ(vp.getZoom() + delta));
    else setZ(v => clampZ(v + delta));
  };
  const reset = () => {
    const vp = window.__lucentViewport;
    if (vp) vp.resetZoom();
    else setZ(100);
  };

  return (
    <div className="chrome-badge" style={{
      position: 'absolute', bottom: 20, left: 20, zIndex: 25,
      display: 'flex', alignItems: 'center', gap: 6,
      padding: '6px 10px',
      borderRadius: 999,
      fontSize: 11,
      fontFamily: 'var(--font-mono)',
      userSelect: 'none',
    }}>
      <button
        style={{ padding: '0 4px', fontSize: 14, lineHeight: 1 }}
        onClick={() => bump(-10)}
        title="Zoom out · ⌘−"
      >−</button>
      <button
        onClick={reset}
        title="Reset zoom · ⌘0"
        style={{ color: 'var(--ink-1)', minWidth: 42, textAlign: 'center' }}
      >{z}%</button>
      <button
        style={{ padding: '0 4px', fontSize: 14, lineHeight: 1 }}
        onClick={() => bump(10)}
        title="Zoom in · ⌘+"
      >+</button>
    </div>
  );
}

// Selection / status badge bottom-right
function StatusBadge({ children }) {
  return (
    <div className="chrome-badge" style={{
      position: 'absolute', bottom: 20, right: 20, zIndex: 25,
      display: 'flex', alignItems: 'center', gap: 8,
      padding: '6px 12px',
      borderRadius: 999,
      fontSize: 11,
      fontFamily: 'var(--font-mono)',
      letterSpacing: '0.03em',
      whiteSpace: 'nowrap',
    }}>
      {children}
    </div>
  );
}

Object.assign(window, { TopBar, LeftRail, ZoomBadge, StatusBadge, CommandOverlay });
