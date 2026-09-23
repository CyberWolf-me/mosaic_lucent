// Lucent v2 — App shell (with grouped switcher for the full product IA)

// Screens are attached to window by their own script files. Pull them in here so the SCREENS array below can reference them without triggering a bare-identifier ReferenceError.
const {
  ScreenDesignSystem, ScreenIA,
  ScreenHome, ScreenWorkspace,
  ScreenEmpty, ScreenGenerating, ScreenMain, ScreenProposing,
  ScreenMeetingBoard, ScreenVoice, ScreenMeeting,
  ScreenIntelDecisions, ScreenIntelActions, ScreenIntelKnowledge,
  ScreenExecProjects, ScreenExecTask,
  ScreenHistory,
  ScreenAsk, ScreenNotifications, ScreenReviewQueue, ScreenIntegrations, ScreenAdmin,
  ScreenWireframe, ScreenSequence, ScreenDashboard,
} = window;

const SCREENS = [
  // -- Reference / meta --
  { id: 0,  key: 'system',     label: 'Design system',     group: 'REF',    Comp: ScreenDesignSystem },
  { id: 25, key: 'ia',         label: 'Information architecture', group: 'REF', Comp: ScreenIA },

  // -- Global / product --
  { id: 11, key: 'home',       label: 'Home',              group: 'GLOBAL', Comp: ScreenHome },
  { id: 12, key: 'workspace',  label: 'Workspace',         group: 'GLOBAL', Comp: ScreenWorkspace },

  // -- Board (the canvas) --
  { id: 1,  key: 'empty',      label: 'Board · empty',     group: 'BOARD',  Comp: ScreenEmpty },
  { id: 2,  key: 'generating', label: 'Board · AI drafting',group: 'BOARD', Comp: ScreenGenerating },
  { id: 3,  key: 'main',       label: 'Board · active',    group: 'BOARD',  Comp: ScreenMain },
  { id: 4,  key: 'proposing',  label: 'Board · proposing', group: 'BOARD',  Comp: ScreenProposing },

  // -- Meeting --
  { id: 13, key: 'meeting_board', label: 'Meeting · on board', group: 'MEETING', Comp: ScreenMeetingBoard },
  { id: 5,  key: 'voice',      label: 'Voice',              group: 'MEETING', Comp: ScreenVoice },
  { id: 8,  key: 'meeting',    label: 'Meeting · doc',      group: 'MEETING', Comp: ScreenMeeting },

  // -- Intelligence --
  { id: 14, key: 'decisions',  label: 'Decisions',         group: 'INTEL',  Comp: ScreenIntelDecisions },
  { id: 15, key: 'actions',    label: 'Actions',           group: 'INTEL',  Comp: ScreenIntelActions },
  { id: 16, key: 'knowledge',  label: 'Knowledge · Ask',   group: 'INTEL',  Comp: ScreenIntelKnowledge },

  // -- Execution --
  { id: 18, key: 'projects',   label: 'Projects',          group: 'EXEC',   Comp: ScreenExecProjects },
  { id: 19, key: 'task',       label: 'Task detail',       group: 'EXEC',   Comp: ScreenExecTask },

  // -- History / cross-cutting --
  { id: 7,  key: 'history',    label: 'History',           group: 'GLOBAL', Comp: ScreenHistory },
  { id: 20, key: 'ask',        label: 'Ask',               group: 'X-CUT',  Comp: ScreenAsk },
  { id: 21, key: 'notif',      label: 'Notifications',     group: 'X-CUT',  Comp: ScreenNotifications },
  { id: 22, key: 'review',     label: 'Review queue',      group: 'X-CUT',  Comp: ScreenReviewQueue },
  { id: 23, key: 'integrations', label: 'Integrations',    group: 'X-CUT',  Comp: ScreenIntegrations },
  { id: 24, key: 'admin',      label: 'Admin',             group: 'X-CUT',  Comp: ScreenAdmin },

  // -- Diagram lenses --
  { id: 9,  key: 'wireframe',  label: 'Wireframe',         group: 'LENS',   Comp: ScreenWireframe },
  { id: 10, key: 'sequence',   label: 'Sequence',          group: 'LENS',   Comp: ScreenSequence },
  { id: 6,  key: 'dashboard',  label: 'Dashboard (legacy)',group: 'LENS',   Comp: ScreenDashboard },
];

const SCREEN_BY_ID = Object.fromEntries(SCREENS.map(s => [s.id, s]));
const LS_KEY = 'lucent.v2.screen';

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "theme": "light",
  "accent": "bloom",
  "density": "regular",
  "radius": "soft",
  "grain": true
}/*EDITMODE-END*/;

function App() {
  const [idx, setIdx] = useState(() => {
    try {
      const q = new URLSearchParams(window.location.search).get('screen');
      if (q) {
        const num = parseInt(q, 10);
        if (!isNaN(num) && SCREEN_BY_ID[num]) return num;
        const found = SCREENS.find(s => s.key === q);
        if (found) return found.id;
      }
    } catch {}
    const s = parseInt(localStorage.getItem(LS_KEY) || '11', 10);
    return SCREEN_BY_ID[s] ? s : 11;
  });
  const [tweaks, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

  useEffect(() => {
    localStorage.setItem(LS_KEY, String(idx));
    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({ type: 'lucent:v2-screen', id: idx, key: SCREEN_BY_ID[idx]?.key }, '*');
      }
    } catch {}
  }, [idx]);

  useEffect(() => {
    const onMsg = (e) => {
      if (e.data && e.data.type === 'lucent:set-screen') {
        const target = e.data.id ?? (e.data.key ? SCREENS.find(s => s.key === e.data.key)?.id : undefined);
        if (target !== undefined && SCREEN_BY_ID[target]) setIdx(target);
      }
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, []);

  useEffect(() => {
    window.__lucentGo = (n) => { if (SCREEN_BY_ID[n]) setIdx(n); };
    return () => { delete window.__lucentGo; };
  }, []);

  // Apply tweaks
  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute('data-theme', tweaks.theme);
    if (tweaks.accent && tweaks.accent !== 'bloom') root.setAttribute('data-accent', tweaks.accent);
    else root.removeAttribute('data-accent');
    if (tweaks.density !== 'regular') root.setAttribute('data-density', tweaks.density);
    else root.removeAttribute('data-density');
    if (tweaks.radius !== 'soft') root.setAttribute('data-radius', tweaks.radius);
    else root.removeAttribute('data-radius');
    root.style.setProperty('--grain-opacity', tweaks.grain ? '0.4' : '0');
  }, [tweaks]);

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e) => {
      const inInput = e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA';
      // ⌘K opens the command palette (works even inside inputs)
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setPaletteOpen(o => !o);
        return;
      }
      // ⌘J opens the screen switcher (dev / power user)
      if ((e.metaKey || e.ctrlKey) && e.key === 'j') {
        e.preventDefault();
        setSwitcherOpen(o => !o);
        return;
      }
      if (inInput) return;
      if (e.key === 'Escape') { setSwitcherOpen(false); setPaletteOpen(false); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const current = SCREEN_BY_ID[idx] || SCREENS[0];
  const CurrentComp = current.Comp;

  return (
    <>
      <CurrentComp onStart={() => setIdx(2)} />

      {/* Screen switcher — compact button + expandable grouped panel */}
      <ScreenSwitcher
        current={current}
        screens={SCREENS}
        open={switcherOpen}
        setOpen={setSwitcherOpen}
        onGo={setIdx}
      />

      {/* Global command palette — ⌘K */}
      {paletteOpen && <CommandOverlay onClose={() => setPaletteOpen(false)} />}

      <TweaksPanel title="Tweaks">
        <TweakSection label="Theme">
          <TweakRadio value={tweaks.theme} onChange={v => setTweak('theme', v)}
            options={[
              { value: 'light', label: 'Paper' },
              { value: 'dark',  label: 'Charcoal' },
            ]} />
        </TweakSection>
        <TweakSection label="Accent">
          <TweakColor
            value={tweaks.accent}
            onChange={v => setTweak('accent', v)}
            options={[
              { value: 'bloom',    color: 'oklch(0.48 0.22 260)', label: 'Cobalt' },
              { value: 'madder',   color: 'oklch(0.55 0.22 20)',  label: 'Madder' },
              { value: 'moss',     color: 'oklch(0.52 0.16 148)', label: 'Moss' },
              { value: 'saffron',  color: 'oklch(0.68 0.17 68)',  label: 'Saffron' },
              { value: 'graphite', color: 'oklch(0.42 0.010 60)', label: 'Graphite' },
            ]}
          />
        </TweakSection>
        <TweakSection label="Density">
          <TweakRadio value={tweaks.density} onChange={v => setTweak('density', v)}
            options={[
              { value: 'compact', label: 'Compact' },
              { value: 'regular', label: 'Regular' },
              { value: 'cozy',    label: 'Cozy' },
            ]} />
        </TweakSection>
        <TweakSection label="Radius">
          <TweakRadio value={tweaks.radius} onChange={v => setTweak('radius', v)}
            options={[
              { value: 'sharp',   label: 'Sharp' },
              { value: 'soft',    label: 'Soft' },
              { value: 'pillowy', label: 'Pillowy' },
            ]} />
        </TweakSection>
        <TweakSection label="Paper grain">
          <TweakToggle value={tweaks.grain} onChange={v => setTweak('grain', v)} label="Show grain overlay" />
        </TweakSection>
        <TweakSuggestionBar suggestions={[
          "Show me the Information Architecture (screen 25)",
          "Open the Meeting on Board (screen 13)",
          "Try charcoal theme on the knowledge graph",
          "Set radius to pillowy",
        ]} />
      </TweaksPanel>
    </>
  );
}

// ============================================================
// Screen switcher — small pill at bottom-left, expandable grid grouped by area
// ============================================================
function ScreenSwitcher({ current, screens, open, setOpen, onGo }) {
  const groups = {
    REF:     { label: 'Reference',        color: 'var(--ink-1)' },
    GLOBAL:  { label: 'Global',           color: 'oklch(0.55 0.14 148)' },
    BOARD:   { label: 'Board · canvas',   color: 'var(--bloom-2)' },
    MEETING: { label: 'Meeting',          color: 'var(--madder)' },
    INTEL:   { label: 'Intelligence',     color: 'oklch(0.55 0.16 300)' },
    EXEC:    { label: 'Execution',        color: 'oklch(0.55 0.14 200)' },
    'X-CUT': { label: 'Cross-cutting',    color: 'var(--saffron)' },
    LENS:    { label: 'Diagram lenses',   color: 'oklch(0.55 0.14 42)' },
  };
  const grouped = {};
  screens.forEach(s => { (grouped[s.group] ||= []).push(s); });

  return (
    <>
      {/* Trigger */}
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          position: 'fixed',
          bottom: 12, left: 12,
          zIndex: 100,
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '6px 12px 6px 8px',
          background: 'oklch(from var(--paper-0) l c h / 0.94)',
          border: '1px solid oklch(from var(--paper-4) l c h / 0.6)',
          borderRadius: 999,
          boxShadow: 'var(--shadow-2)',
          backdropFilter: 'blur(20px)',
          fontFamily: 'var(--font-mono)', fontSize: 11,
          color: 'var(--ink-0)',
          maxWidth: 320,
        }}
      >
        <span style={{
          display: 'inline-grid', placeItems: 'center',
          width: 22, height: 22, borderRadius: 999,
          background: groups[current.group].color,
          color: 'white', fontSize: 10, fontWeight: 700,
        }}>{current.id === 0 || current.id === 25 ? (current.id === 25 ? '★' : '◎') : current.id}</span>
        <span style={{ letterSpacing: '0.05em', color: 'var(--ink-3)' }}>{groups[current.group].label}</span>
        <span style={{ color: 'var(--ink-3)' }}>·</span>
        <span style={{
          fontFamily: 'var(--font-sans)', fontWeight: 500, letterSpacing: '-0.005em',
          maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{current.label}</span>
        <span style={{ color: 'var(--ink-3)', marginLeft: 4 }}>⌘J</span>
      </button>

      {open && (
        <>
          <div
            onClick={() => setOpen(false)}
            style={{
              position: 'fixed', inset: 0, zIndex: 200,
              background: 'oklch(0.2 0.02 60 / 0.35)',
              backdropFilter: 'blur(8px)',
            }}
          />
          <div style={{
            position: 'fixed', zIndex: 201,
            top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
            width: 780, maxWidth: 'calc(100vw - 40px)',
            maxHeight: 'calc(100vh - 80px)',
            background: 'oklch(from var(--paper-0) l c h / 0.98)',
            border: '1px solid oklch(from var(--paper-4) l c h / 0.7)',
            borderRadius: 18,
            boxShadow: 'var(--shadow-3)',
            overflow: 'hidden',
            display: 'flex', flexDirection: 'column',
          }}>
            <div style={{
              padding: '18px 24px 14px',
              borderBottom: '1px solid oklch(from var(--paper-4) l c h / 0.5)',
              display: 'flex', alignItems: 'baseline', gap: 12,
            }}>
              <div style={{
                fontFamily: 'var(--font-serif)', fontSize: 22, fontWeight: 500,
                letterSpacing: '-0.015em',
              }}>Jump to screen</div>
              <span className="mono" style={{ fontSize: 10.5, color: 'var(--ink-3)' }}>
                {screens.length} screens · grouped by product area
              </span>
              <div style={{ flex: 1 }} />
              <span className="mono" style={{
                fontSize: 10, padding: '3px 8px',
                background: 'var(--paper-2)', borderRadius: 5, color: 'var(--ink-2)',
              }}>Esc</span>
            </div>
            <div style={{ padding: 20, overflow: 'auto' }}>
              {Object.entries(grouped).map(([g, list]) => (
                <div key={g} style={{ marginBottom: 22 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                    <span style={{ width: 8, height: 8, borderRadius: 2, background: groups[g].color }} />
                    <span className="mono-caps" style={{ letterSpacing: '0.08em' }}>{groups[g].label}</span>
                    <span className="mono" style={{ fontSize: 10, color: 'var(--ink-3)' }}>· {list.length}</span>
                  </div>
                  <div style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
                    gap: 6,
                  }}>
                    {list.map(s => (
                      <button
                        key={s.id}
                        onClick={() => { onGo(s.id); setOpen(false); }}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 10,
                          padding: '9px 12px',
                          borderRadius: 8,
                          background: s.id === current.id ? 'var(--paper-2)' : 'transparent',
                          border: `1px solid ${s.id === current.id ? 'var(--ink-3)' : 'transparent'}`,
                          textAlign: 'left', cursor: 'pointer',
                          transition: 'all 0.1s',
                        }}
                        onMouseEnter={e => s.id !== current.id && (e.currentTarget.style.background = 'var(--paper-2)')}
                        onMouseLeave={e => s.id !== current.id && (e.currentTarget.style.background = 'transparent')}
                      >
                        <span className="mono" style={{
                          width: 24, textAlign: 'right',
                          fontSize: 10, color: 'var(--ink-3)', letterSpacing: '0.02em',
                        }}>{String(s.id).padStart(2, '0')}</span>
                        <span style={{ fontSize: 12.5, color: 'var(--ink-0)', fontWeight: s.id === current.id ? 500 : 400 }}>
                          {s.label}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </>
  );
}

const root = ReactDOM.createRoot(document.getElementById('app'));
root.render(<App />);
