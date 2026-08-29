// Settings store, profile menu, preferences modal, and shape toolbar.

// ---- Global settings store ------------------------------------------------
// Persisted to localStorage. Any component can subscribe via useSettings().
const SETTINGS_LS = 'lucent.settings';
const DEFAULT_SETTINGS = {
  theme: 'dark',           // 'dark' | 'light' | 'system'
  accent: 'amber',         // 'amber' | 'violet' | 'cyan' | 'rose' | 'mono'
  gridStyle: 'dots',       // 'dots' | 'lines' | 'off'
  motion: 'full',          // 'full' | 'reduced'
  aiSound: true,
  autosave: true,
  activityIndicators: true,
};

const settingsStore = (() => {
  let state = DEFAULT_SETTINGS;
  try {
    const raw = localStorage.getItem(SETTINGS_LS);
    if (raw) state = { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch (_) {}
  const listeners = new Set();
  return {
    get: () => state,
    set: (patch) => {
      state = { ...state, ...patch };
      try { localStorage.setItem(SETTINGS_LS, JSON.stringify(state)); } catch (_) {}
      listeners.forEach(fn => fn(state));
    },
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
  };
})();

function useSettings() {
  const [s, setS] = useState(settingsStore.get());
  useEffect(() => settingsStore.subscribe(setS), []);
  return [s, settingsStore.set];
}

// Applies theme + accent to <html> whenever settings change.
function ThemeRoot() {
  const [s] = useSettings();
  useEffect(() => {
    const html = document.documentElement;
    const resolved = s.theme === 'system'
      ? (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
      : s.theme;
    html.setAttribute('data-theme', resolved);
    html.setAttribute('data-accent', s.accent);
    html.style.setProperty('--transition-motion', s.motion === 'reduced' ? '0.001s' : '');
  }, [s.theme, s.accent, s.motion]);
  return null;
}

// ---- Icons for tools & settings ------------------------------------------
const ToolIco = {
  Select:  (p) => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M5 3l6 16 2-7 7-2z"/></svg>,
  Hand:    (p) => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M9 11V5.5a1.5 1.5 0 1 1 3 0V11"/><path d="M12 11V4.5a1.5 1.5 0 1 1 3 0V11"/><path d="M15 11V6a1.5 1.5 0 1 1 3 0v8a6 6 0 0 1-12 0v-2a1.5 1.5 0 1 1 3 0"/></svg>,
  Rect:    (p) => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" {...p}><rect x="4" y="6" width="16" height="12" rx="1.5"/></svg>,
  Ellipse: (p) => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" {...p}><ellipse cx="12" cy="12" rx="8" ry="6"/></svg>,
  Diamond: (p) => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" {...p}><path d="M12 3l9 9-9 9-9-9z"/></svg>,
  Sticky:  (p) => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M5 4h10l4 4v12H5z"/><path d="M15 4v4h4"/></svg>,
  Text:    (p) => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M4 6h16"/><path d="M12 6v14"/><path d="M9 20h6"/></svg>,
  Arrow:   (p) => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M4 12h16"/><path d="M14 6l6 6-6 6"/></svg>,
  Pen:     (p) => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M15 4l5 5-11 11H4v-5z"/><path d="M13 6l5 5"/></svg>,
  Frame:   (p) => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M6 3v18M18 3v18M3 6h18M3 18h18"/></svg>,
  Comment: (p) => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M4 5h16v11H9l-5 4V5z"/></svg>,
  Connect: (p) => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" {...p}><circle cx="6" cy="12" r="2"/><circle cx="18" cy="12" r="2"/><path d="M8 12h8"/></svg>,
  Settings:(p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...p}><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3h.1a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9v.1a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>,
  Logout:  (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/></svg>,
  Bell:    (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M6 8a6 6 0 0 1 12 0c0 7 3 8 3 8H3s3-1 3-8"/><path d="M10 21a2 2 0 0 0 4 0"/></svg>,
  Kbd:     (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" {...p}><rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M6 14h12"/></svg>,
  Palette: (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M12 3a9 9 0 1 0 3 17.5c1-1 .3-2-.5-2.5-1-.5-1.5-1.5-1-2.5.4-1 1.5-1 2.5-1H18a3 3 0 0 0 3-3 9 9 0 0 0-9-9z"/><circle cx="7.5" cy="10.5" r="1"/><circle cx="12" cy="7.5" r="1"/><circle cx="16.5" cy="10.5" r="1"/></svg>,
  User:    (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...p}><circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/></svg>,
  Team:    (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...p}><circle cx="9" cy="9" r="3"/><path d="M3 20c1-3.5 3-5 6-5s5 1.5 6 5"/><circle cx="17" cy="8" r="2.5"/><path d="M17 12.5c2 0 3.5 1 4.5 3"/></svg>,
  Chevron: (p) => <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M9 18l6-6-6-6"/></svg>,
};

// ---- Profile menu ---------------------------------------------------------
function ProfileMenu({ onOpenSettings, initials='AK' }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (!e.target.closest('.profile-menu') && !e.target.closest('.avatar-btn')) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  return (
    <>
      <button className="avatar-btn" onClick={() => setOpen(v => !v)} title="Profile">
        <div className="avatar">{initials}</div>
      </button>
      {open && (
        <div className="profile-menu">
          <div className="header">
            <div className="avatar" style={{ width: 34, height: 34, fontSize: 12 }}>{initials}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="name">Alex Kim</div>
              <div className="email">alex@lucent.app</div>
            </div>
          </div>
          <button className="menu-item"><ToolIco.User /> Profile <span className="k">↗</span></button>
          <button className="menu-item" onClick={() => { setOpen(false); onOpenSettings(); }}>
            <ToolIco.Settings /> Preferences <span className="k">⌘,</span>
          </button>
          <button className="menu-item"
            onClick={() => { setOpen(false); onOpenSettings('appearance'); }}>
            <ToolIco.Palette /> Theme & appearance
          </button>
          <button className="menu-item"><ToolIco.Bell /> Notifications</button>
          <button className="menu-item"><ToolIco.Team /> Workspace members</button>
          <div className="menu-sep" />
          <button className="menu-item"><ToolIco.Kbd /> Keyboard shortcuts <span className="k">?</span></button>
          <button className="menu-item">Help & feedback</button>
          <div className="menu-sep" />
          <button className="menu-item danger"><ToolIco.Logout /> Sign out</button>
        </div>
      )}
    </>
  );
}

// ---- Settings modal -------------------------------------------------------
function SettingsModal({ initialSection = 'appearance', onClose }) {
  const [section, setSection] = useState(initialSection);
  const [s, setS] = useSettings();

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const sections = [
    { id: 'account',     label: 'Account',      icon: <ToolIco.User /> },
    { id: 'appearance',  label: 'Appearance',   icon: <ToolIco.Palette /> },
    { id: 'canvas',      label: 'Canvas',       icon: <ToolIco.Rect /> },
    { id: 'ai',          label: 'AI & voice',   icon: <ToolIco.Settings /> },
    { id: 'shortcuts',   label: 'Shortcuts',    icon: <ToolIco.Kbd /> },
    { id: 'team',        label: 'Team',         icon: <ToolIco.Team /> },
  ];

  return (
    <>
      <div className="modal-scrim" onClick={onClose} />
      <div className="settings-modal" role="dialog" aria-label="Preferences">
        <nav className="settings-nav">
          <div className="brand-block">
            <div className="logo" style={{
              width: 16, height: 16, borderRadius: 4,
              background: 'linear-gradient(135deg, var(--amber-1), var(--amber-3))',
              position: 'relative', flexShrink: 0,
            }}>
              <div style={{
                position: 'absolute', inset: 3, borderRadius: 2, background: 'var(--canvas-0)',
              }} />
              <div style={{
                position: 'absolute', inset: 6, borderRadius: 1, background: 'var(--amber-1)',
              }} />
            </div>
            Preferences
          </div>
          {sections.map(sec => (
            <button
              key={sec.id}
              className={section === sec.id ? 'active' : ''}
              onClick={() => setSection(sec.id)}
            >
              {sec.icon} {sec.label}
            </button>
          ))}
        </nav>
        <div className="settings-body">
          <button
            onClick={onClose}
            style={{
              position: 'absolute', top: 14, right: 14,
              width: 28, height: 28, borderRadius: 999,
              display: 'grid', placeItems: 'center',
              color: 'var(--ink-2)',
              background: 'var(--canvas-3)',
              border: '1px solid var(--stroke-1)',
              zIndex: 1,
            }}
          >
            <Ico.X />
          </button>

          {section === 'appearance' && <AppearanceSection s={s} setS={setS} />}
          {section === 'account'    && <AccountSection />}
          {section === 'canvas'     && <CanvasSection s={s} setS={setS} />}
          {section === 'ai'         && <AISection s={s} setS={setS} />}
          {section === 'shortcuts'  && <ShortcutsSection />}
          {section === 'team'       && <TeamSection />}
        </div>
      </div>
    </>
  );
}

function AppearanceSection({ s, setS }) {
  const themes = [
    { id: 'dark',   name: 'Dark',   hint: 'Default · Canvas hero' },
    { id: 'light',  name: 'Light',  hint: 'Creamy · Warm luminous' },
    { id: 'system', name: 'System', hint: 'Match device' },
  ];
  const palettes = [
    { id: 'amber',  name: 'Amber',  color: 'linear-gradient(135deg, oklch(0.86 0.14 78), oklch(0.62 0.13 65))' },
    { id: 'violet', name: 'Violet', color: 'linear-gradient(135deg, oklch(0.80 0.16 300), oklch(0.52 0.19 295))' },
    { id: 'cyan',   name: 'Cyan',   color: 'linear-gradient(135deg, oklch(0.85 0.13 215), oklch(0.55 0.14 208))' },
    { id: 'rose',   name: 'Rose',   color: 'linear-gradient(135deg, oklch(0.82 0.14 12), oklch(0.56 0.17 8))' },
    { id: 'mono',   name: 'Mono',   color: 'linear-gradient(135deg, oklch(0.92 0.004 60), oklch(0.55 0.008 60))' },
  ];

  return (
    <>
      <h2>Appearance</h2>
      <div className="subtitle">
        Lucent adapts across dark, light, and your accent of choice. All changes save instantly.
      </div>

      <div className="setting-row">
        <div className="label">Theme</div>
        <div className="desc">Dark keeps the canvas the visual hero. Light uses a warm cream — luminous, not stark.</div>
        <div className="theme-cards">
          {themes.map(t => (
            <button
              key={t.id}
              className={`theme-card ${s.theme === t.id ? 'active' : ''}`}
              onClick={() => setS({ theme: t.id })}
            >
              <div className={`preview ${t.id}`} />
              <div className="name">{t.name}</div>
              <div className="hint">{t.hint}</div>
            </button>
          ))}
        </div>
      </div>

      <div className="setting-row">
        <div className="label">Accent palette</div>
        <div className="desc">Used for AI illumination, selection, and generation states.</div>
        <div className="palette-row">
          {palettes.map(p => (
            <button
              key={p.id}
              className={`swatch ${s.accent === p.id ? 'active' : ''}`}
              onClick={() => setS({ accent: p.id })}
            >
              <span className="dot" style={{ background: p.color }} />
              {p.name}
            </button>
          ))}
        </div>
      </div>

      <div className="setting-row">
        <RowToggle
          label="Reduce motion"
          desc="Minimize entrance animations and transitions."
          value={s.motion === 'reduced'}
          onChange={v => setS({ motion: v ? 'reduced' : 'full' })}
        />
      </div>
    </>
  );
}

function CanvasSection({ s, setS }) {
  const grids = [
    { id: 'dots',  label: 'Dots' },
    { id: 'lines', label: 'Lines' },
    { id: 'off',   label: 'Off' },
  ];
  return (
    <>
      <h2>Canvas</h2>
      <div className="subtitle">How the workspace looks and behaves.</div>
      <div className="setting-row">
        <div className="label">Grid style</div>
        <div className="desc">Applies to every workspace.</div>
        <div className="segmented">
          {grids.map(g => (
            <button
              key={g.id}
              className={s.gridStyle === g.id ? 'active' : ''}
              onClick={() => setS({ gridStyle: g.id })}
            >
              {g.label}
            </button>
          ))}
        </div>
      </div>
      <div className="setting-row">
        <RowToggle
          label="Autosave"
          desc="Persist every change automatically."
          value={s.autosave}
          onChange={v => setS({ autosave: v })}
        />
      </div>
      <div className="setting-row">
        <RowToggle
          label="AI activity indicators"
          desc="Show subtle amber pulse when Lucent is thinking or drawing."
          value={s.activityIndicators}
          onChange={v => setS({ activityIndicators: v })}
        />
      </div>
    </>
  );
}

function AISection({ s, setS }) {
  return (
    <>
      <h2>AI & voice</h2>
      <div className="subtitle">How Lucent listens and responds.</div>
      <div className="setting-row">
        <RowToggle
          label="Voice confirmation sound"
          desc="A soft chime when voice input starts and ends."
          value={s.aiSound}
          onChange={v => setS({ aiSound: v })}
        />
      </div>
      <div className="setting-row">
        <div className="label">Voice language</div>
        <div className="desc">Used for transcription and voice commands.</div>
        <div className="segmented">
          <button className="active">English</button>
          <button>Spanish</button>
          <button>Auto-detect</button>
        </div>
      </div>
      <div className="setting-row">
        <div className="label">Approval threshold</div>
        <div className="desc">When Lucent must ask before applying changes.</div>
        <div className="segmented">
          <button>Always</button>
          <button className="active">Large changes</button>
          <button>Never</button>
        </div>
      </div>
    </>
  );
}

function AccountSection() {
  return (
    <>
      <h2>Account</h2>
      <div className="subtitle">Your Lucent profile and workspace.</div>
      <div className="setting-row" style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <div className="avatar" style={{ width: 56, height: 56, fontSize: 16 }}>AK</div>
        <div style={{ flex: 1 }}>
          <div className="label" style={{ fontSize: 15 }}>Alex Kim</div>
          <div className="desc mono" style={{ marginBottom: 0, fontSize: 11 }}>alex@lucent.app</div>
        </div>
        <button className="btn ghost">Change avatar</button>
      </div>
      <div className="setting-row">
        <div className="label">Display name</div>
        <div className="desc">Shown to collaborators.</div>
        <input
          defaultValue="Alex Kim"
          style={{
            width: '100%', maxWidth: 320,
            padding: '9px 12px',
            background: 'var(--canvas-2)',
            border: '1px solid var(--stroke-1)',
            borderRadius: 8,
            fontSize: 13, color: 'var(--ink-0)',
          }}
        />
      </div>
      <div className="setting-row">
        <div className="label">Workspace</div>
        <div className="desc">Personal · alex-personal.lucent.app</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn ghost">Manage workspace</button>
          <button className="btn ghost">Billing</button>
        </div>
      </div>
    </>
  );
}

function ShortcutsSection() {
  const groups = [
    { title: 'Global', rows: [
      ['Command menu',    ['⌘', 'K']],
      ['Preferences',     ['⌘', ',']],
      ['Voice input',     ['V']],
      ['New workspace',   ['⌘', 'N']],
    ]},
    { title: 'Canvas', rows: [
      ['Select tool',     ['V']],
      ['Hand / pan',      ['H']],
      ['Rectangle',       ['R']],
      ['Ellipse',         ['O']],
      ['Sticky',          ['S']],
      ['Text',            ['T']],
      ['Arrow / connect', ['A']],
      ['Frame',           ['F']],
      ['Comment',         ['C']],
    ]},
    { title: 'AI', rows: [
      ['Send prompt',     ['↩']],
      ['Cancel generation', ['Esc']],
      ['Undo',            ['⌘', 'Z']],
      ['Redo',            ['⌘', '⇧', 'Z']],
    ]},
  ];
  return (
    <>
      <h2>Keyboard shortcuts</h2>
      <div className="subtitle">Muscle memory for people who like it fast.</div>
      {groups.map(g => (
        <div key={g.title} className="setting-row">
          <div className="label" style={{ marginBottom: 12 }}>{g.title}</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '8px 20px' }}>
            {g.rows.map(([label, keys], i) => (
              <React.Fragment key={i}>
                <div style={{ fontSize: 12.5, color: 'var(--ink-1)' }}>{label}</div>
                <div style={{ display: 'flex', gap: 4 }}>
                  {keys.map((k, j) => (
                    <span key={j} style={{
                      padding: '3px 7px', minWidth: 22, textAlign: 'center',
                      fontFamily: 'var(--font-mono)', fontSize: 10.5,
                      color: 'var(--ink-1)',
                      background: 'var(--canvas-3)',
                      border: '1px solid var(--stroke-1)',
                      borderRadius: 4,
                    }}>{k}</span>
                  ))}
                </div>
              </React.Fragment>
            ))}
          </div>
        </div>
      ))}
    </>
  );
}

function TeamSection() {
  const team = [
    { name: 'Alex Kim', email: 'alex@lucent.app', role: 'Owner', color: 'oklch(0.55 0.11 30)' },
    { name: 'Sarah Chen', email: 'sarah@lucent.app', role: 'Editor', color: 'oklch(0.55 0.11 220)' },
    { name: 'John Torres', email: 'john@lucent.app', role: 'Editor', color: 'oklch(0.55 0.11 130)' },
    { name: 'Mia Park', email: 'mia@lucent.app', role: 'Viewer', color: 'oklch(0.55 0.11 300)' },
  ];
  return (
    <>
      <h2>Workspace members</h2>
      <div className="subtitle">4 people in Personal.</div>
      <div className="setting-row">
        <div className="label" style={{ marginBottom: 12 }}>Invite by email</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            placeholder="name@company.com"
            style={{
              flex: 1,
              padding: '9px 12px',
              background: 'var(--canvas-2)',
              border: '1px solid var(--stroke-1)',
              borderRadius: 8,
              fontSize: 13, color: 'var(--ink-0)',
            }}
          />
          <button className="btn primary" style={{ padding: '0 18px' }}>Send invite</button>
        </div>
      </div>
      <div className="setting-row">
        <div className="label" style={{ marginBottom: 12 }}>Members</div>
        {team.map((p, i) => (
          <div key={i} style={{
            display: 'flex', alignItems: 'center', gap: 12,
            padding: '10px 4px',
            borderBottom: i < team.length - 1 ? '1px solid var(--stroke-1)' : 'none',
          }}>
            <div style={{
              width: 32, height: 32, borderRadius: 999,
              background: p.color, display: 'grid', placeItems: 'center',
              fontSize: 11, fontFamily: 'var(--font-mono)',
              color: 'var(--canvas-0)', fontVariationSettings: "'wght' 600",
            }}>{p.name.split(' ').map(s => s[0]).join('')}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, color: 'var(--ink-0)', fontVariationSettings: "'wght' 500" }}>{p.name}</div>
              <div className="mono" style={{ fontSize: 10.5, color: 'var(--ink-3)' }}>{p.email}</div>
            </div>
            <div className="mono" style={{
              fontSize: 10.5, color: 'var(--ink-2)',
              padding: '3px 10px',
              background: 'var(--canvas-3)',
              border: '1px solid var(--stroke-1)',
              borderRadius: 999,
              letterSpacing: '0.02em',
            }}>{p.role}</div>
          </div>
        ))}
      </div>
    </>
  );
}

function RowToggle({ label, desc, value, onChange }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16 }}>
      <div style={{ flex: 1 }}>
        <div className="label">{label}</div>
        <div className="desc" style={{ marginBottom: 0 }}>{desc}</div>
      </div>
      <div
        className={`switch ${value ? 'on' : ''}`}
        onClick={() => onChange(!value)}
        role="switch"
        aria-checked={value}
        tabIndex={0}
      />
    </div>
  );
}

// ---- Figjam-style shape toolbar ------------------------------------------
// Emits `onAddShape({ kind, x, y })` when a shape tool is clicked.
// Screens that mount it manage the list of shapes themselves.
// orientation: 'left' (vertical, Figjam-style) | 'bottom' (horizontal)
function ShapeToolbar({ activeTool = 'select', onSelectTool, onAddShape, orientation = 'left' }) {
  const [tool, setTool] = useState(activeTool);
  useEffect(() => setTool(activeTool), [activeTool]);

  const shapeKinds = new Set(['rect', 'ellipse', 'diamond', 'sticky', 'text']);

  const pick = (id) => {
    setTool(id);
    onSelectTool && onSelectTool(id);
    if (shapeKinds.has(id) && onAddShape) {
      // Drop a shape in a random-ish free area
      const x = 200 + Math.floor(Math.random() * 500);
      const y = 240 + Math.floor(Math.random() * 240);
      onAddShape({ kind: id, x, y });
      // return to select after
      setTimeout(() => { setTool('select'); onSelectTool && onSelectTool('select'); }, 250);
    }
  };

  const T = ({ id, tip, children }) => (
    <button
      className={`tool ${tool === id ? 'active' : ''}`}
      data-tip={tip}
      onClick={() => pick(id)}
    >
      {children}
    </button>
  );

  return (
    <div className={`shape-toolbar ${orientation}`}>
      <T id="select"  tip="Select · V"><ToolIco.Select /></T>
      <T id="hand"    tip="Hand · H"><ToolIco.Hand /></T>
      <div className="divider" />
      <T id="rect"    tip="Rectangle · R"><ToolIco.Rect /></T>
      <T id="ellipse" tip="Ellipse · O"><ToolIco.Ellipse /></T>
      <T id="diamond" tip="Diamond · D"><ToolIco.Diamond /></T>
      <T id="sticky"  tip="Sticky · S"><ToolIco.Sticky /></T>
      <T id="text"    tip="Text · T"><ToolIco.Text /></T>
      <div className="divider" />
      <T id="arrow"   tip="Connect · A"><ToolIco.Connect /></T>
      <T id="pen"     tip="Pen · P"><ToolIco.Pen /></T>
      <div className="divider" />
      <T id="frame"   tip="Frame · F"><ToolIco.Frame /></T>
      <T id="comment" tip="Comment · C"><ToolIco.Comment /></T>
    </div>
  );
}

// A canvas-dropped shape (rect / ellipse / diamond / sticky / text)
function ShapeElement({ kind, x, y, label, color, rotation, w, h }) {
  const cls = ['shape', kind, color].filter(Boolean).join(' ');
  const style = {
    left: x, top: y,
    animation: 'emerge 0.35s var(--e-out) both',
    ...(w ? { width: w } : {}),
    ...(h ? { height: h } : {}),
    ...(rotation ? { transform: `rotate(${rotation}deg)` } : {}),
  };
  if (kind === 'diamond') {
    return (
      <div className={cls} style={{ ...style, width: 100, height: 100 }}>
        <span>{label || 'Decision'}</span>
      </div>
    );
  }
  if (kind === 'text') {
    return <div className={cls} style={style}>{label || 'Double-click to edit'}</div>;
  }
  return (
    <div className={cls} style={style}>
      {label || (kind === 'sticky' ? 'New note' : kind === 'ellipse' ? 'Process' : 'Rectangle')}
    </div>
  );
}

Object.assign(window, {
  useSettings, settingsStore, ThemeRoot,
  ProfileMenu, SettingsModal,
  ShapeToolbar, ShapeElement, ToolIco,
});
