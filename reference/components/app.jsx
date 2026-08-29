// App shell — screen switcher + persistence

const SCREENS = [
  { id: 1,  key: 'empty',       label: 'Empty canvas',       light: false, Comp: ScreenEmpty },
  { id: 2,  key: 'generating',  label: 'AI generating',      light: false, Comp: ScreenGenerating },
  { id: 3,  key: 'main',        label: 'Main canvas',        light: false, Comp: ScreenMain },
  { id: 4,  key: 'proposing',   label: 'Proposing changes',  light: false, Comp: ScreenProposing },
  { id: 5,  key: 'voice',       label: 'Voice listening',    light: false, Comp: ScreenVoice },
  { id: 6,  key: 'dashboard',   label: 'Dashboard',          light: false, Comp: ScreenDashboard },
  { id: 7,  key: 'history',     label: 'History',            light: false, Comp: ScreenHistory },
  { id: 8,  key: 'meeting',     label: 'Meeting mode',       light: false, Comp: ScreenMeeting },
  { id: 9,  key: 'wireframe',   label: 'Wireframe',          light: false, Comp: ScreenWireframe },
  { id: 10, key: 'sequence',    label: 'Sequence diagram',   light: false, Comp: ScreenSequence },
];

const LS_KEY = 'lucent.currentScreen';

function App() {
  const [idx, setIdx] = useState(() => {
    const stored = parseInt(localStorage.getItem(LS_KEY) || '1', 10);
    return Number.isFinite(stored) && stored >= 1 && stored <= SCREENS.length ? stored : 2; // default to the "magic moment" screen 2
  });

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState('appearance');

  useEffect(() => {
    localStorage.setItem(LS_KEY, String(idx));
  }, [idx]);

  // Expose global nav helper so any chrome component can call __lucentGo(n)
  useEffect(() => {
    window.__lucentGo = (n) => {
      if (Number.isFinite(n) && n >= 1 && n <= SCREENS.length) setIdx(n);
    };
    window.__lucentOpenSettings = (section) => {
      if (typeof section === 'string') setSettingsSection(section);
      setSettingsOpen(true);
    };
    return () => {
      delete window.__lucentGo;
      delete window.__lucentOpenSettings;
    };
  }, []);

  // Cmd+, opens settings globally
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === ',') {
        e.preventDefault();
        setSettingsOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    const onKey = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if (e.key === 'ArrowRight' || e.key === ']') setIdx(i => Math.min(SCREENS.length, i + 1));
      if (e.key === 'ArrowLeft'  || e.key === '[') setIdx(i => Math.max(1, i - 1));
      const n = parseInt(e.key, 10);
      if (Number.isFinite(n) && n >= 1 && n <= 9 && !e.metaKey && !e.ctrlKey) {
        setIdx(n);
      }
      if (e.key === '0') setIdx(10);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const current = SCREENS.find(s => s.id === idx) || SCREENS[0];
  const CurrentComp = current.Comp;

  const goEmptyToGenerating = () => setIdx(2);

  return (
    <>
      <ThemeRoot />
      {/* Only render current — screens are heavy */}
      <CurrentComp active={true} onStart={goEmptyToGenerating} />

      {settingsOpen && (
        <SettingsModal
          initialSection={settingsSection}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      {/* Screen switcher (top-right) */}
      <div className={`screen-switcher ${current.light ? 'light' : ''}`}>
        <button
          className="arrow"
          onClick={() => setIdx(i => Math.max(1, i - 1))}
          title="Previous (←)"
        >
          <Ico.Left />
        </button>
        <span className="screen-name mono">
          {String(current.id).padStart(2, '0')} · {current.label}
        </span>
        <div style={{ display: 'flex', gap: 3 }}>
          {SCREENS.map(s => (
            <button
              key={s.id}
              className={`dot ${s.id === idx ? 'active' : ''}`}
              onClick={() => setIdx(s.id)}
              title={`${s.id}. ${s.label}`}
            >
              {s.id === 10 ? '0' : s.id}
            </button>
          ))}
        </div>
        <button
          className="arrow"
          onClick={() => setIdx(i => Math.min(SCREENS.length, i + 1))}
          title="Next (→)"
        >
          <Ico.Right />
        </button>
      </div>
    </>
  );
}

const root = ReactDOM.createRoot(document.getElementById('app'));
root.render(<App />);
