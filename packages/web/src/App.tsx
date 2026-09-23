import { useEffect, useMemo, useState } from "react";
import { resolveLocale, t } from "@lucent/i18n";
import { ThemeRoot } from "./settings.js";
import { WorkspaceProvider, useWorkspace, type CanvasLens, type View } from "./workspace.js";
import { ToastProvider } from "./ui/Toast.js";
import { SettingsModal } from "./ui/Settings.js";
import { CanvasView } from "./views/CanvasView.js";
import { DashboardView } from "./views/DashboardView.js";
import { HistoryView } from "./views/HistoryView.js";
import { AdminView } from "./views/AdminView.js";
import { AnalyticsView } from "./views/AnalyticsView.js";
import { MobileGate } from "./views/MobileBoardView.js";
import { MeetingView } from "./views/MeetingView.js";
import { IntelligenceView } from "./views/IntelligenceView.js";
import { ExecutionView } from "./views/ExecutionView.js";
import { WireframeView } from "./views/WireframeView.js";
import { SequenceView } from "./views/SequenceView.js";
import { ErView } from "./views/ErView.js";
import { BoardView } from "./views/BoardView.js";
import { DocumentView } from "./views/DocumentView.js";
import { HomeView } from "./views/HomeView.js";
import { WorkspaceView } from "./views/WorkspaceView.js";
import { ReviewQueueView } from "./views/ReviewQueueView.js";
import { IntegrationsView } from "./views/IntegrationsView.js";
import { NotificationsView } from "./views/NotificationsView.js";
import { VoiceView } from "./views/VoiceView.js";
import { IAView } from "./views/IAView.js";
import { DesignSystemView } from "./views/DesignSystemView.js";
import { CommandOverlay } from "./ui/CommandOverlay.js";
import { ScreenSwitcher } from "./ui/ScreenSwitcher.js";
import { TweaksPanel } from "./ui/TweaksPanel.js";
import { AtelierScreenFrame } from "./ui/AtelierScreenFrame.js";
import { MeetingSessionProvider } from "./meeting-room/MeetingSessionContext.js";
import { MeetingHuddleDock } from "./meeting-room/MeetingHuddleDock.js";
import { LegalView } from "./views/LegalView.js";
import {
  AuthView,
  InviteView,
  ResetConfirmView,
  VerifyView,
  useAuthStatus,
} from "./views/AuthView.js";
import {
  UPGRADE_PATH,
  currentRoute,
  decideScreen,
  getViewQuery,
  navigate,
  normalizePath,
  replacePath,
  setViewQuery,
  subscribeToRoute,
  type Route,
} from "./routes.js";
import { primeCsrfToken } from "./http.js";

/**
 * Two independent axes decide what is on screen, and they are deliberately not
 * merged:
 *
 *  - `Router` below switches on the workspace's `view` state - the in-app
 *    surfaces (canvas, dashboard, history, …) that the toolbar swaps between.
 *  - `decideScreen` (routes.ts) switches on `location.pathname` + auth status -
 *    the shell-level screens. This axis did not exist before: every email link
 *    (`/verify?token=`, `/reset?token=`, `/invite?token=`) landed on the canvas
 *    with its token ignored, which made verification, password reset and org
 *    invites dead ends in a build that otherwise sent all three emails.
 */
const VALID_VIEWS: ReadonlySet<string> = new Set([
  "home",
  "workspace",
  "review",
  "integrations",
  "dashboard",
  "canvas",
  "canvas-live",
  "legacy",
  "main",
  "knowledge",
  "history",
  "meeting",
  "intelligence",
  "execution",
  "wireframe",
  "sequence",
  "er",
  "board",
  "document",
  "admin",
  "analytics",
  "system",
  "ia",
  "empty",
  "generating",
  "proposing",
  "meeting_board",
  "voice",
  "decisions",
  "actions",
  "projects",
  "task",
  "ask",
  "notif",
]);
const VALID_LENSES: ReadonlySet<string> = new Set([
  "visual",
  "kanban",
  "document",
  "wireframe",
  "sequence",
  "er",
]);

function Router({ onOpenSettings }: { onOpenSettings: (section?: string) => void }) {
  const { view, setView, lens, setLens } = useWorkspace();
  // UX-1 & UX-P1-002: initial deep-link read + browser Back/Forward popstate synchronization.
  useEffect(() => {
    const syncFromLocation = () => {
      const q = getViewQuery();
      const hasBoard = typeof window !== "undefined" && new URLSearchParams(window.location.search).has("board");
      const targetView = q.view ?? (hasBoard ? "main" : "home");
      if (VALID_VIEWS.has(targetView)) {
        setView(targetView as View);
      }
      if (q.lens && VALID_LENSES.has(q.lens)) {
        setLens(q.lens as CanvasLens);
      }
    };
    syncFromLocation();
    window.addEventListener("popstate", syncFromLocation);
    return () => window.removeEventListener("popstate", syncFromLocation);
  }, [setView, setLens]);

  // Write view/lens back to the URL. Pushes history on user navigation between
  // views, while reusing replaceState on initial mount or no-op when URL already matches.
  useEffect(() => {
    setViewQuery(view, (view === "canvas" || view === "main") ? lens : undefined, true);
  }, [view, lens]);
  // Org pages sit *on top of* the board, so their Back returns to the canvas
  // — the surface the user came from. It deliberately does NOT touch the
  // browser history stack: views are React state and never push history
  // entries, so `window.history.back()` stepped out of the app entirely (to
  // the sign-in page or off the site), which is what users saw.
  const backFromOrgPage = () => setView("main");
  switch (view) {
    case "main":
    case "board":
    case "canvas":
    case "empty":
    case "canvas-live":
    case "legacy":
      return <MobileGate desktop={<CanvasView onOpenSettings={onOpenSettings} />} />;
    case "home":
      return <HomeView onOpenSettings={onOpenSettings} />;
    case "workspace":
      return <WorkspaceView onOpenSettings={onOpenSettings} />;
    case "admin":
      return <AdminView onBack={backFromOrgPage} />;
    case "analytics":
      return <AnalyticsView onBack={backFromOrgPage} />;
    case "review":
      return <ReviewQueueView onOpenSettings={onOpenSettings} />;
    case "integrations":
      return <IntegrationsView onOpenSettings={onOpenSettings} />;
    case "notif":
      return <NotificationsView onOpenSettings={onOpenSettings} />;
    case "voice":
      return <VoiceView onOpenSettings={onOpenSettings} />;
    case "ia":
      return <IAView onOpenSettings={onOpenSettings} />;
    case "system":
      return <DesignSystemView onOpenSettings={onOpenSettings} />;
    case "meeting":
    case "meeting_board":
      return <MeetingView onOpenSettings={onOpenSettings} />;
    case "intelligence":
    case "decisions":
    case "actions":
    case "knowledge":
    case "ask":
      return <IntelligenceView onOpenSettings={onOpenSettings} />;
    case "execution":
    case "projects":
    case "task":
      return <ExecutionView onOpenSettings={onOpenSettings} />;
    case "history":
      return <HistoryView onOpenSettings={onOpenSettings} />;
    case "dashboard":
      return <DashboardView onOpenSettings={onOpenSettings} />;
    case "wireframe":
      return <WireframeView onOpenSettings={onOpenSettings} />;
    case "sequence":
      return <SequenceView onOpenSettings={onOpenSettings} />;
    case "er":
      return <ErView onOpenSettings={onOpenSettings} />;
    case "document":
      return <DocumentView onOpenSettings={onOpenSettings} />;
    default:
      return <AtelierScreenFrame screenKey={view} />;
  }
}

/** Track the address bar. One `popstate` listener covers Back and `navigate`. */
function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => currentRoute());
  useEffect(() => subscribeToRoute(() => setRoute(currentRoute())), []);
  return route;
}

const MODE_PATHS = { login: "/login", signup: "/signup", reset: "/reset" } as const;

/**
 * Shown while `/api/auth/me` is in flight. It has to exist: the gate used to
 * test only for "anon", so during the check a signed-out visitor was served the
 * authenticated shell - a flash of someone else's workspace, plus a burst of
 * board requests that were always going to 401.
 */
function SessionBoot() {
  return (
    <div className="auth-shell">
      <div className="auth-card">
        <div className="auth-brand">
          <strong>Lucent</strong>
          <span className="auth-tag">Voice &amp; visual workspace</span>
        </div>
        <p className="auth-help">
          Checking your session… <span className="auth-spinner" aria-hidden="true" />
        </p>
      </div>
    </div>
  );
}

function AtelierGlobalChrome() {
  const { view, setView } = useWorkspace();
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [tweaksOpen, setTweaksOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const inInput =
        (e.target as HTMLElement)?.tagName === "INPUT" ||
        (e.target as HTMLElement)?.tagName === "TEXTAREA";
      if ((e.metaKey || e.ctrlKey) && (e.key === "j" || e.key === "J")) {
        e.preventDefault();
        setSwitcherOpen((o) => !o);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "/") {
        e.preventDefault();
        setTweaksOpen((o) => !o);
        return;
      }
      if (inInput) return;
      if (e.key === "Escape") {
        setSwitcherOpen(false);
        setTweaksOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <>
      <ScreenSwitcher
        currentKey={view}
        open={switcherOpen}
        setOpen={setSwitcherOpen}
        onGo={(key) => setView(key as View)}
      />
      <TweaksPanel open={tweaksOpen} setOpen={setTweaksOpen} />
    </>
  );
}

export function App() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState("appearance");
  const [commandOverlayOpen, setCommandOverlayOpen] = useState(false);
  /** Bumped after a sign-in / sign-up so the session check runs again. */
  const [authTick, setAuthTick] = useState(0);
  const locale = useMemo(() => resolveLocale(navigator.language), []);

  const route = useRoute();
  const auth = useAuthStatus(authTick);
  const screen = decideScreen(route, auth);

  const openSettings = (section?: string) => {
    if (section) setSettingsSection(section);
    setSettingsOpen(true);
  };

  // Warm the CSRF pair once per page load. Every mutating call needs the header
  // (the server 403s without it) and the raw token only exists in this page's
  // memory, so fetching it up front keeps it off the critical path of the user's
  // first action. `apiFetch` self-heals if something beats it.
  useEffect(() => {
    primeCsrfToken();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === ",") {
        e.preventDefault();
        setSettingsOpen(true);
      }
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setCommandOverlayOpen((o) => !o);
      }
    };
    const onTriggerSearch = () => setCommandOverlayOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("lucent:open-command-overlay", onTriggerSearch);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("lucent:open-command-overlay", onTriggerSearch);
    };
  }, []);

  // A 402 from the server hands the client an upgradeUrl of /settings/billing,
  // and a customer who clicks it arrives here. There is no billing *screen* to
  // route to -- the plan and usage view is a pane in the settings modal -- so the
  // path is spent on arrival: open the pane, then rewrite the URL to "/" so a
  // reload or a Back press does not reopen a modal the user has closed.
  //
  // Mount-only, because that is the whole lifetime of an inbound link. Opening
  // the pane from inside the app goes through onOpenSettings, not the address bar.
  useEffect(() => {
    if (normalizePath(window.location.pathname) !== UPGRADE_PATH) return;
    setSettingsSection("billing");
    setSettingsOpen(true);
    replacePath("/");
  }, []);

  // A signed-in visitor on /login (or straight after signing in) is done with
  // the auth path: rewrite it so Back and reload don't return to a form that
  // would only bounce them here again. `replaceState`, so no history entry.
  useEffect(() => {
    if (screen.kind === "app" && route.kind !== "app") replacePath("/");
  }, [screen.kind, route.kind]);

  switch (screen.kind) {
    case "loading":
      return (
        <>
          <ThemeRoot />
          <SessionBoot />
        </>
      );
    case "auth":
      return (
        <>
          <ThemeRoot />
          <AuthView
            mode={screen.mode}
            // Navigate rather than swapping local state: the form the user is
            // looking at and the URL they could bookmark stay the same thing.
            onMode={(mode) => navigate(MODE_PATHS[mode])}
            onSuccess={() => setAuthTick((t) => t + 1)}
          />
        </>
      );
    case "reset-confirm":
      return (
        <>
          <ThemeRoot />
          <ResetConfirmView token={screen.token} />
        </>
      );
    case "verify":
      return (
        <>
          <ThemeRoot />
          <VerifyView token={screen.token} />
        </>
      );
    case "invite":
      return (
        <>
          <ThemeRoot />
          <InviteView token={screen.token} />
        </>
      );
    case "privacy":
      return (
        <>
          <ThemeRoot />
          <LegalView mode="privacy" />
        </>
      );
    case "terms":
      return (
        <>
          <ThemeRoot />
          <LegalView mode="terms" />
        </>
      );
    case "app":
      return (
        <>
          <ThemeRoot />
          <a href="#main-content" className="skip-link">
            {t("a11y.skip.link", locale)}
          </a>
          <ToastProvider>
            <WorkspaceProvider>
              <MeetingSessionProvider>
                <main id="main-content">
                  <Router onOpenSettings={openSettings} />
                </main>
                <AtelierGlobalChrome />
                <MeetingHuddleDock />
                {commandOverlayOpen && (
                  <CommandOverlay
                    onClose={() => setCommandOverlayOpen(false)}
                    onOpenSettings={openSettings}
                  />
                )}
              </MeetingSessionProvider>
            </WorkspaceProvider>
          </ToastProvider>
          {settingsOpen && (
            <SettingsModal
              initialSection={settingsSection}
              onClose={() => setSettingsOpen(false)}
            />
          )}
        </>
      );
  }
}
