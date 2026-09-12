import { useEffect, useState } from "react";
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
function Router({ onOpenSettings }: { onOpenSettings: (section?: string) => void }) {
  const { view, setView, lens, setLens } = useWorkspace();
  // UX-1: deep-link ?view=canvas&lens=kanban. Mount-only read so the browser's
  // Back stays browser-owned; every write below uses replaceState (no entry).
  useEffect(() => {
    const q = getViewQuery();
    if (!q.view) return;
    const validViews: ReadonlySet<string> = new Set([
      "dashboard",
      "canvas",
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
    ]);
    const validLenses: ReadonlySet<string> = new Set([
      "visual",
      "kanban",
      "document",
      "wireframe",
      "sequence",
      "er",
    ]);
    if (!validViews.has(q.view)) return;
    // setView folds legacy board-like views into canvas+lens; when both view
    // and lens are present the explicit lens wins (setView("canvas") resets
    // to visual, so lens applies after).
    setView(q.view as View);
    if (q.lens && validLenses.has(q.lens)) setLens(q.lens as CanvasLens);
    // Mount-only: view/lens are the source of truth afterwards.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Write view/lens back to the URL. replaceState keeps ?board=/?invite= and
  // never adds a history entry, so Back is not broken. No popstate dispatch,
  // so this cannot loop with the route listener.
  useEffect(() => {
    setViewQuery(view, view === "canvas" ? lens : undefined);
  }, [view, lens]);
  // Org pages sit *on top of* the board, so their Back returns to the canvas
  // — the surface the user came from. It deliberately does NOT touch the
  // browser history stack: views are React state and never push history
  // entries, so `window.history.back()` stepped out of the app entirely (to
  // the sign-in page or off the site), which is what users saw.
  const backFromOrgPage = () => setView("canvas");
  switch (view) {
    case "dashboard":
      return <DashboardView onOpenSettings={onOpenSettings} />;
    case "history":
      return <HistoryView onOpenSettings={onOpenSettings} />;
    case "meeting":
      return <MeetingView onOpenSettings={onOpenSettings} />;
    case "intelligence":
      return <IntelligenceView onOpenSettings={onOpenSettings} />;
    case "execution":
      return <ExecutionView onOpenSettings={onOpenSettings} />;
    case "wireframe":
      return <WireframeView onOpenSettings={onOpenSettings} />;
    case "sequence":
      return <SequenceView onOpenSettings={onOpenSettings} />;
    case "er":
      return <ErView onOpenSettings={onOpenSettings} />;
    case "board":
      return <BoardView onOpenSettings={onOpenSettings} />;
    case "document":
      return <DocumentView onOpenSettings={onOpenSettings} />;
    case "admin":
      return <AdminView onBack={backFromOrgPage} />;
    case "analytics":
      return <AnalyticsView onBack={backFromOrgPage} />;
    case "canvas":
    default:
      // G2: a phone-shaped viewport with content gets the read-only mobile
      // view instead of the desktop canvas. The gate (not the route) makes
      // the choice, so one board URL serves both, and the empty-board case
      // falls through to the hero prompt because describing-by-keyboard is
      // fine on mobile.
      return <MobileGate desktop={<CanvasView onOpenSettings={onOpenSettings} />} />;
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

export function App() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState("appearance");
  /** Bumped after a sign-in / sign-up so the session check runs again. */
  const [authTick, setAuthTick] = useState(0);

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
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
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
    case "app":
      return (
        <>
          <ThemeRoot />
          <ToastProvider>
            <WorkspaceProvider>
              <Router onOpenSettings={openSettings} />
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
