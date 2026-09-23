import { useEffect, useRef, useState } from "react";
import {
  acceptInvite,
  attemptLogin,
  attemptSignup,
  checkSession,
  confirmEmailVerification,
  confirmPasswordReset,
  hasSession,
  requestPasswordReset,
  resolveAuthStatus,
  verifyTwoFactor,
  type AuthStatus,
  type SessionCheck,
} from "../session.js";
import { clearTokenFromUrl, navigate } from "../routes.js";
import { fetchOauthProviders, type OauthProviders } from "../http.js";
import { resolveLocale, t, type Locale } from "@lucent/i18n";

/**
 * The active UI locale, read once per render from the browser's preference.
 * Negotiated per screen rather than stored: there is no settings toggle yet,
 * and a `navigator.language` read is cheap enough that the wrong answer
 * self-corrects when the user changes their browser language. A persisted
 * preference arrives with the settings pane, not before.
 */
function locale(): Locale {
  return resolveLocale(
    typeof navigator === "undefined" ? null : (navigator.languages?.[0] ?? navigator.language),
  );
}

/**
 * The auth screens (M1.8): sign in, sign up, request a reset, and the three
 * screens an emailed link lands on - reset-confirm, verify, invite.
 *
 * Two rules this file exists to enforce:
 *
 *  1. **Persist what the server sent.** These forms used to POST a login and
 *     throw the response away, so the app ran with no session at all: board
 *     calls short-circuited and Settings reported "You're working offline". All
 *     of the network work now lives in `session.ts`, which saves the session as
 *     part of a successful response - a screen can no longer forget to.
 *  2. **No `window.prompt`.** The reset screen prompted for a new password from
 *     a mount effect, before it had even looked for a token, so clicking "Forgot
 *     password?" popped a password box at you. Tokens come from the URL first
 *     (`routes.ts`), and every input is a real field.
 *
 * All markup reuses the existing `.auth-*` classes in `styles.css`; no new CSS.
 */

type Mode = "login" | "signup" | "reset";

/**
 * Back-compat: `authFetch` and the CSRF helpers used to live here. They are now
 * the shared client wrapper (every call in the app goes through it), re-exported
 * under the old names so nothing that imported them from this module breaks.
 */
export { apiFetch as authFetch, getCsrfToken, invalidateCsrfToken } from "../http.js";

/* --------------------------- shared chrome -------------------------------- */

function AuthShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="auth-shell">
      <div className="auth-card">
        <div className="auth-brand">
          <strong>Lucent</strong>
          <span className="auth-tag">Voice &amp; visual workspace</span>
        </div>
        {children}
      </div>
      <footer className="auth-footer">
        <div>By continuing you agree that your data is yours — we never train AI models on it.</div>
        <div
          style={{
            marginTop: 8,
            display: "flex",
            justifyContent: "center",
            alignItems: "center",
            gap: 8,
          }}
        >
          <a
            href="/privacy"
            onClick={(e) => {
              e.preventDefault();
              navigate("/privacy");
            }}
            style={{ color: "var(--accent, #7aa2ff)", textDecoration: "underline" }}
          >
            Privacy Policy
          </a>
          <span style={{ opacity: 0.5 }}>·</span>
          <a
            href="/terms"
            onClick={(e) => {
              e.preventDefault();
              navigate("/terms");
            }}
            style={{ color: "var(--accent, #7aa2ff)", textDecoration: "underline" }}
          >
            Terms of Service
          </a>
        </div>
      </footer>
    </div>
  );
}

function useError(): [string | null, (msg: string | null) => void] {
  const [error, setError] = useState<string | null>(null);
  return [error, (msg: string | null) => setError(msg)];
}

function Field(props: {
  label: string;
  type?: string;
  value: string;
  onChange: (v: string) => void;
  autoComplete?: string;
  required?: boolean;
  minLength?: number;
  disabled?: boolean;
  autoFocus?: boolean;
  inputMode?: "text" | "numeric";
  placeholder?: string;
}) {
  return (
    <label className="auth-field">
      <span>{props.label}</span>
      <input
        type={props.type ?? "text"}
        value={props.value}
        autoComplete={props.autoComplete}
        required={props.required}
        minLength={props.minLength}
        disabled={props.disabled}
        autoFocus={props.autoFocus}
        inputMode={props.inputMode}
        placeholder={props.placeholder}
        onChange={(e) => props.onChange(e.currentTarget.value)}
      />
    </label>
  );
}

function Spinner({ show }: { show: boolean }) {
  if (!show) return null;
  return <span className="auth-spinner" aria-hidden="true" />;
}

/** Shared submit button so every screen reports progress the same way. */
function Submit({ busy, idle, busyLabel }: { busy: boolean; idle: string; busyLabel: string }) {
  return (
    <button type="submit" className="auth-submit" disabled={busy}>
      {busy ? busyLabel : idle} <Spinner show={busy} />
    </button>
  );
}

/* ------------------------- federated sign-in (M1.8) ------------------------ */

/**
 * One button per configured provider, straight from the server's own answer —
 * an unconfigured provider never renders, so no button is a dead end. The
 * flow is a top-level browser redirect, not an API call: the browser leaves
 * for the provider and comes back to `/api/auth/oauth/:provider/callback`,
 * which 302s home with the session cookie set. A full navigation (not SPA
 * pushState) is what makes the cookie-and-redirect round trip work.
 */
function OauthButtons() {
  const [providers, setProviders] = useState<OauthProviders | null>(null);
  useEffect(() => {
    let live = true;
    void fetchOauthProviders().then((p) => {
      if (live) setProviders(p);
    });
    return () => {
      live = false;
    };
  }, []);

  if (!providers || (!providers.google && !providers.github)) return null;
  const start = (provider: "google" | "github") => {
    window.location.assign(`/api/auth/oauth/${provider}/start`);
  };
  return (
    <div className="auth-oauth">
      {providers.google && (
        <button type="button" className="auth-oauth-button" onClick={() => start("google")}>
          Continue with Google
        </button>
      )}
      {providers.github && (
        <button type="button" className="auth-oauth-button" onClick={() => start("github")}>
          Continue with GitHub
        </button>
      )}
    </div>
  );
}

/** The callback's failure channel: `?oauth_error=<reason>` on the login URL. */
function useOauthError(): string | null {
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    const reason = url.searchParams.get("oauth_error");
    if (!reason) return;
    setError(
      reason === "provider_denied"
        ? "Sign-in was cancelled at the provider."
        : reason === "state_mismatch" || reason === "state_invalid"
          ? "That sign-in link has expired — start again."
          : "Sign-in with the provider failed. Try again, or use a password.",
    );
    url.searchParams.delete("oauth_error");
    window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
  }, []);
  return error;
}

/* --------------------------- login / signup / reset ----------------------- */

interface AuthViewProps {
  /** Which form to show. Owned by `App`, which derives it from the path. */
  mode: Mode;
  /** Switch form *and* path, so Back works and a reload stays put. */
  onMode: (mode: Mode) => void;
  /** A session now exists - re-check auth and land in the workspace. */
  onSuccess: () => void;
}

export function AuthView({ mode, onMode, onSuccess }: AuthViewProps) {
  return (
    <AuthShell>
      {mode === "signup" && <SignupForm onMode={onMode} onDone={onSuccess} />}
      {mode === "login" && <LoginForm onMode={onMode} onDone={onSuccess} />}
      {mode === "reset" && <ResetRequestForm onMode={onMode} />}
    </AuthShell>
  );
}

function SignupForm(props: { onMode: (m: Mode) => void; onDone: () => void }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useError();
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const result = await attemptSignup(name, email, password);
    // `attemptSignup` has already stored the session on success; the only thing
    // left for the screen to do is leave.
    if (result.kind === "error") {
      setError(result.message);
      setBusy(false);
      return;
    }
    props.onDone();
  }

  return (
    <form onSubmit={submit} className="auth-form">
      <h1>Create your account</h1>
      <Field label="Name" value={name} onChange={setName} autoComplete="name" required autoFocus />
      <Field
        label="Email"
        type="email"
        value={email}
        onChange={setEmail}
        autoComplete="email"
        required
      />
      <Field
        label="Password"
        type="password"
        value={password}
        onChange={setPassword}
        autoComplete="new-password"
        required
        minLength={8}
      />
      {error && <p className="auth-error">{error}</p>}
      <Submit busy={busy} idle="Create account" busyLabel="Creating account…" />
      <OauthButtons />
      <p className="auth-switch">
        Already have an account?{" "}
        <button type="button" onClick={() => props.onMode("login")}>
          Sign in
        </button>
      </p>
    </form>
  );
}

/**
 * Sign in, with the second factor as a second step in the same card rather than
 * a `window.prompt`: a native prompt can't be styled, can't show a spinner or an
 * error, is blocked by some browsers, and loses the whole login if dismissed.
 */
function LoginForm(props: { onMode: (m: Mode) => void; onDone: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  /** Set once the password is accepted but the account has 2FA enabled. */
  const [loginToken, setLoginToken] = useState<string | null>(null);
  const [error, setError] = useError();
  const [busy, setBusy] = useState(false);
  // The OAuth callback lands back here on failure (`?oauth_error=…`).
  const oauthError = useOauthError();

  async function submitPassword(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const result = await attemptLogin(email, password);
    if (result.kind === "error") {
      setError(result.message);
      setBusy(false);
      return;
    }
    if (result.kind === "2fa") {
      // Hold the one-shot login token in state; it is useless without the code.
      setLoginToken(result.loginToken);
      setBusy(false);
      return;
    }
    props.onDone();
  }

  async function submitCode(e: React.FormEvent) {
    e.preventDefault();
    if (loginToken === null) return;
    setBusy(true);
    setError(null);
    const result = await verifyTwoFactor(loginToken, code);
    if (result.kind === "error") {
      setError(result.message);
      setCode("");
      setBusy(false);
      return;
    }
    props.onDone();
  }

  if (loginToken !== null) {
    return (
      <form onSubmit={submitCode} className="auth-form">
        <h1>Two-factor code</h1>
        <p className="auth-help">
          Enter the 6-digit code from your authenticator app for {email}, or one of your recovery
          codes.
        </p>
        <Field
          label="Code"
          value={code}
          onChange={setCode}
          autoComplete="one-time-code"
          inputMode="numeric"
          placeholder="123456"
          required
          autoFocus
          disabled={busy}
        />
        {error && <p className="auth-error">{error}</p>}
        <Submit busy={busy} idle="Verify" busyLabel="Verifying…" />
        <p className="auth-switch">
          <button
            type="button"
            onClick={() => {
              // Abandon the challenge: the login token stays unused and expires.
              setLoginToken(null);
              setCode("");
              setPassword("");
              setError(null);
            }}
          >
            Use a different account
          </button>
        </p>
      </form>
    );
  }

  async function demoLogin() {
    setBusy(true);
    setError(null);
    let result = await attemptLogin("alex@northbeam.co", "Password123!");
    if (result.kind === "error") {
      await attemptSignup("Alex Kim", "alex@northbeam.co", "Password123!");
      result = await attemptLogin("alex@northbeam.co", "Password123!");
    }
    if (result.kind === "error") {
      setError(result.message);
      setBusy(false);
      return;
    }
    props.onDone();
  }

  return (
    <form onSubmit={submitPassword} className="auth-form">
      <h1>{t("auth.signin.title", locale())}</h1>
      <button
        type="button"
        onClick={demoLogin}
        disabled={busy}
        style={{
          width: "100%",
          padding: "10px 14px",
          borderRadius: 8,
          background: "var(--bloom-2, #3b82f6)",
          color: "white",
          fontWeight: 600,
          fontSize: 13,
          border: "none",
          cursor: "pointer",
          marginBottom: 14,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
        }}
      >
        <span>✦</span> Continue as Alex Kim (Demo)
      </button>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          margin: "4px 0 14px",
          color: "var(--ink-3)",
          fontSize: 11,
          letterSpacing: "0.06em",
        }}
      >
        <div style={{ flex: 1, height: 1, background: "oklch(from var(--paper-4) l c h / 0.6)" }} />
        <span>OR PASSWORD</span>
        <div style={{ flex: 1, height: 1, background: "oklch(from var(--paper-4) l c h / 0.6)" }} />
      </div>
      <Field
        label={t("auth.email.label", locale())}
        type="email"
        value={email}
        onChange={setEmail}
        autoComplete="email"
        required
        autoFocus
      />
      <Field
        label={t("auth.password.label", locale())}
        type="password"
        value={password}
        onChange={setPassword}
        autoComplete="current-password"
        required
      />
      {error && <p className="auth-error">{error}</p>}
      {oauthError && <p className="auth-error">{oauthError}</p>}
      <Submit busy={busy} idle={t("auth.submit.signin", locale())} busyLabel="Signing in…" />
      <OauthButtons />
      <p className="auth-switch">
        <button type="button" onClick={() => props.onMode("reset")}>
          Forgot password?
        </button>
        {" · "}
        <button type="button" onClick={() => props.onMode("signup")}>
          {t("auth.signup.title", locale())}
        </button>
      </p>
    </form>
  );
}

/* --------------------------- password reset ------------------------------- */

/** "Email me a link". Never reports whether the address exists (server 204s). */
function ResetRequestForm(props: { onMode: (m: Mode) => void }) {
  const [email, setEmail] = useState("");
  const [error, setError] = useError();
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setInfo(null);
    const result = await requestPasswordReset(email);
    if (result.kind === "error") setError(result.message);
    else setInfo("If an account exists for that email, a reset link is on its way.");
    setBusy(false);
  }

  return (
    <form onSubmit={submit} className="auth-form">
      <h1>Reset your password</h1>
      <p className="auth-help">Enter your email and we'll send a link to pick a new password.</p>
      <Field
        label="Email"
        type="email"
        value={email}
        onChange={setEmail}
        autoComplete="email"
        required
        autoFocus
      />
      {error && <p className="auth-error">{error}</p>}
      {info && <p className="auth-info">{info}</p>}
      <Submit busy={busy} idle="Send reset link" busyLabel="Sending…" />
      <p className="auth-switch">
        <button type="button" onClick={() => props.onMode("login")}>
          Back to sign in
        </button>
      </p>
    </form>
  );
}

/**
 * `/reset?token=…` - the screen the emailed link lands on. The token is read
 * from the URL by `routes.ts` *before* this renders, which is the fix for the
 * old flow: it prompted for a password on mount and only then looked for a
 * token, so "Forgot password?" opened a password box for no reason.
 */
export function ResetConfirmView({ token }: { token: string }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useError();
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirm) {
      setError("Those passwords don't match.");
      return;
    }
    if (password.length < 8) {
      // Mirrors the server rule so the round-trip isn't needed to say so.
      setError("Password must be at least 8 characters.");
      return;
    }
    setBusy(true);
    setError(null);
    const result = await confirmPasswordReset(token, password);
    setBusy(false);
    if (result.kind === "error") {
      setError(result.message);
      return;
    }
    // The token is spent and every session for the account was revoked. Take it
    // out of the address bar so a reload doesn't retry a dead token.
    clearTokenFromUrl();
    setDone(true);
  }

  if (done) {
    return (
      <AuthShell>
        <div className="auth-form">
          <h1>Password updated</h1>
          <p className="auth-info">
            Your password has been changed and every other session was signed out.
          </p>
          <p className="auth-switch">
            <button type="button" onClick={() => navigate("/login")}>
              Sign in
            </button>
          </p>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <form onSubmit={submit} className="auth-form">
        <h1>Pick a new password</h1>
        <p className="auth-help">This link works once and expires an hour after it was sent.</p>
        <Field
          label="New password"
          type="password"
          value={password}
          onChange={setPassword}
          autoComplete="new-password"
          required
          minLength={8}
          autoFocus
          disabled={busy}
        />
        <Field
          label="Confirm password"
          type="password"
          value={confirm}
          onChange={setConfirm}
          autoComplete="new-password"
          required
          minLength={8}
          disabled={busy}
        />
        {error && <p className="auth-error">{error}</p>}
        <Submit busy={busy} idle="Update password" busyLabel="Updating…" />
        <p className="auth-switch">
          <button type="button" onClick={() => navigate("/login")}>
            Back to sign in
          </button>
        </p>
      </form>
    </AuthShell>
  );
}

/* --------------------------- one-shot token screens ----------------------- */

type RedeemState = { kind: "working" } | { kind: "ok" } | { kind: "error"; message: string };

/**
 * Redeem a single-use token from an email link, exactly once.
 *
 * The ref guard is not decoration: React 18 StrictMode double-invokes effects in
 * development, and these tokens are consumed server-side on first use, so
 * without it the second call always reports "invalid link" for a link that just
 * worked.
 */
function useRedeem(
  token: string | null,
  redeem: (token: string) => Promise<{ kind: "ok" } | { kind: "error"; message: string }>,
): RedeemState {
  const [state, setState] = useState<RedeemState>({ kind: "working" });
  const started = useRef(false);

  useEffect(() => {
    if (token === null || started.current) return;
    started.current = true;
    void (async () => {
      const result = await redeem(token);
      if (result.kind === "ok") {
        // The token is spent; don't leave a credential in the address bar.
        clearTokenFromUrl();
        setState({ kind: "ok" });
      } else {
        setState({ kind: "error", message: result.message });
      }
    })();
  }, [token, redeem]);

  return state;
}

/** `/verify?token=…` - confirm an email address. Works signed out by design. */
export function VerifyView({ token }: { token: string | null }) {
  const state = useRedeem(token, confirmEmailVerification);
  const signedIn = hasSession();

  return (
    <AuthShell>
      <div className="auth-form">
        <h1>Verify your email</h1>
        {token === null && (
          <p className="auth-error">
            This link is missing its token. Open the most recent verification email, or request a
            new link from Settings → Account.
          </p>
        )}
        {token !== null && state.kind === "working" && (
          <p className="auth-help">
            Confirming your email address… <Spinner show />
          </p>
        )}
        {state.kind === "ok" && <p className="auth-info">Your email address is verified.</p>}
        {state.kind === "error" && <p className="auth-error">{state.message}</p>}
        <p className="auth-switch">
          <button type="button" onClick={() => navigate(signedIn ? "/" : "/login")}>
            {signedIn ? "Back to Lucent" : "Sign in"}
          </button>
        </p>
      </div>
    </AuthShell>
  );
}

/**
 * `/invite?token=…` - join the org that invited you. Unlike verify this needs a
 * session, so `App` only routes here once the visitor is signed in; the token
 * survives the detour through sign-in because it stays in the URL.
 */
export function InviteView({ token }: { token: string | null }) {
  const state = useRedeem(token, acceptInvite);

  return (
    <AuthShell>
      <div className="auth-form">
        <h1>Accept invitation</h1>
        {token === null && (
          <p className="auth-error">
            This invite link is missing its token. Ask whoever invited you to send a new one.
          </p>
        )}
        {token !== null && state.kind === "working" && (
          <p className="auth-help">
            Joining… <Spinner show />
          </p>
        )}
        {state.kind === "ok" && (
          <p className="auth-info">You're in. The shared boards are on your dashboard.</p>
        )}
        {state.kind === "error" && <p className="auth-error">{state.message}</p>}
        <p className="auth-switch">
          <button type="button" onClick={() => navigate("/")}>
            Open Lucent
          </button>
        </p>
      </div>
    </AuthShell>
  );
}

/* --------------------------- session gate --------------------------------- */

/**
 * Ask the server who we are. `tick` is how a screen says "I just changed the
 * session, look again" - without it the hook's empty dependency list meant the
 * status never left "anon" after a successful login and the user sat on a blank
 * form.
 *
 * The three-way decision itself is `resolveAuthStatus` in `session.ts`, which is
 * pure and unit-tested: "loading" must not collapse into "authed" (a signed-out
 * visitor would see the workspace flash) nor "unreachable" into "anon" (a
 * backend restart would sign a working user out of the offline flow).
 */
export function useAuthStatus(tick = 0): AuthStatus {
  const [check, setCheck] = useState<SessionCheck | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Re-checking: report "loading" again rather than answering from the
    // previous result, which is what turns a sign-out into a visible state.
    setCheck(null);
    void (async () => {
      const result = await checkSession();
      if (!cancelled) setCheck(result);
    })();
    return () => {
      cancelled = true;
    };
  }, [tick]);

  return resolveAuthStatus(check, hasSession());
}
