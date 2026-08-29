import { useEffect, useState } from "react";
import { Ico, ToolIco } from "./icons.js";
import {
  clearSession,
  fetchMe,
  getSessionUser,
  logIn,
  saveSession,
  signUp,
  type SessionUser,
} from "../session.js";

/**
 * The real account menu. Replaces the prototype's hardcoded "Alex Kim" with the
 * actual session: sign in / sign up when logged out, profile and sign out when
 * logged in. Dead menu items (Notifications, Workspace members) are gone rather
 * than pretending to work.
 */
export function ProfileMenu({ onOpenSettings }: { onOpenSettings: (section?: string) => void }) {
  const [user, setUser] = useState<SessionUser | null>(getSessionUser());
  const [open, setOpen] = useState(false);

  // Pick up a session saved in another tab, and drop an expired one.
  useEffect(() => {
    void fetchMe().then((fresh) => setUser(fresh ?? null));
    const onStorage = (e: StorageEvent) => {
      if (e.key === "lucent.token") setUser(getSessionUser());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const signOut = () => {
    clearSession();
    setUser(null);
    setOpen(false);
  };

  const initials = user
    ? user.name
        .split(/\s+/)
        .map((p) => p[0])
        .slice(0, 2)
        .join("")
        .toUpperCase() || "U"
    : "?";

  const onAuthenticated = (u: SessionUser) => {
    setUser(u);
    setOpen(false);
  };

  return (
    <>
      <button
        className="avatar-btn"
        onClick={() => setOpen((v) => !v)}
        title={user ? "Account" : "Sign in"}
      >
        <div className="avatar">{initials}</div>
      </button>
      {open && (
        <div className="profile-menu">
          {user ? (
            <>
              <div className="header">
                <div className="avatar" style={{ width: 34, height: 34, fontSize: 12 }}>
                  {initials}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="name">{user.name}</div>
                  <div className="email">{user.email}</div>
                </div>
              </div>
              <button
                className="menu-item"
                onClick={() => {
                  setOpen(false);
                  onOpenSettings();
                }}
              >
                <ToolIco.Settings /> Preferences <span className="k">⌘,</span>
              </button>
              <button
                className="menu-item"
                onClick={() => {
                  setOpen(false);
                  onOpenSettings("appearance");
                }}
              >
                <ToolIco.Palette /> Theme &amp; appearance
              </button>
              {/* Same icon the settings sidebar uses for this pane, so the two
                  entry points read as one destination. */}
              <button
                className="menu-item"
                onClick={() => {
                  setOpen(false);
                  onOpenSettings("billing");
                }}
              >
                <Ico.Book /> Plan &amp; usage
              </button>
              <div className="menu-sep" />
              <button className="menu-item">
                <ToolIco.Kbd /> Keyboard shortcuts <span className="k">?</span>
              </button>
              <div className="menu-sep" />
              <button className="menu-item danger" onClick={signOut}>
                <ToolIco.Logout /> Sign out
              </button>
            </>
          ) : (
            <AuthForms onAuthenticated={onAuthenticated} onClose={() => setOpen(false)} />
          )}
        </div>
      )}
    </>
  );
}

function AuthForms({
  onAuthenticated,
  onClose,
}: {
  onAuthenticated: (user: SessionUser) => void;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const res =
        mode === "signup" ? await signUp(email, password, name) : await logIn(email, password);
      saveSession(res.token, res.user);
      onAuthenticated(res.user);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="header">
        <div className="avatar" style={{ width: 34, height: 34, fontSize: 12 }}>
          ?
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="name">{mode === "login" ? "Welcome back" : "Create account"}</div>
          <div className="email">Boards sync to your account</div>
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "10px 12px 4px" }}>
        {mode === "signup" && (
          <>
            <label className="sr-only" htmlFor="auth-name">
              Name
            </label>
            <input
              id="auth-name"
              className="auth-input"
              placeholder="Name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoComplete="name"
            />
          </>
        )}
        <label className="sr-only" htmlFor="auth-email">
          Email
        </label>
        <input
          id="auth-email"
          className="auth-input"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          type="email"
          autoComplete="email"
        />
        <label className="sr-only" htmlFor="auth-password">
          Password
        </label>
        <input
          id="auth-password"
          className="auth-input"
          placeholder="Password (8+ characters)"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void submit();
          }}
          type="password"
          autoComplete={mode === "signup" ? "new-password" : "current-password"}
        />
        {error && <div className="auth-error">{error}</div>}
        <button className="menu-item auth-submit" onClick={() => void submit()} disabled={busy}>
          {busy ? "…" : mode === "login" ? "Sign in" : "Create account"}
        </button>
        <button
          className="menu-item"
          onClick={() => {
            setMode(mode === "login" ? "signup" : "login");
            setError(null);
          }}
        >
          {mode === "login" ? "No account? Sign up" : "Have an account? Sign in"}
        </button>
        {mode === "signup" && (
          <p
            style={{ fontSize: 10.5, color: "var(--ink-3)", lineHeight: 1.5, padding: "2px 2px 0" }}
          >
            By creating an account you agree to our Terms and Privacy Policy. Your boards live on
            this Lucent server; how prompts are handled depends on the AI provider it's configured
            with.
          </p>
        )}
      </div>
      <div className="menu-sep" />
      <button className="menu-item" onClick={onClose}>
        Skip for now — stay offline
      </button>
    </>
  );
}
