import { apiFetch, invalidateCsrfToken, primeCsrfToken } from "./http.js";
import { setPersistenceScope } from "./persistence.js";
import { identify, resetUser } from "./analytics/posthog.js";

/**
 * Client-side session (M1): where the browser's idea of "who am I" lives, plus
 * the auth endpoints the UI calls.
 *
 * The server now authenticates browsers with the httpOnly `lucent_session`
 * cookie, so the bearer token below is no longer the primary credential — it is
 * the fallback for a client that is not same-origin with the API, and it is
 * what pre-cookie sessions in users' localStorage still carry. The user record
 * is cached in localStorage because several components need "am I signed in?"
 * synchronously during render (`ui/Chrome.tsx`, `ui/Settings.tsx`,
 * `board/comments.ts`); `/api/auth/me` is the authority and refreshes that
 * cache on every app boot.
 *
 * Every auth request lives here rather than in the screens, because the screen
 * that posted a login and then forgot to persist the response is precisely how
 * the app ended up "signed in" with no session at all: boards fell back to
 * offline mode and Settings reported "You're working offline".
 */

const TOKEN_KEY = "lucent.token";
const USER_KEY = "lucent.user";

export interface SessionUser {
  id: string;
  email: string;
  name: string;
}

/** The pre-cookie response shape, kept for `ui/ProfileMenu.tsx`. */
export interface AuthResponse {
  token: string;
  user: SessionUser;
}

/** Where the session check landed. "unreachable" is not "signed out". */
export type SessionCheck =
  | { kind: "authed"; user: SessionUser }
  | { kind: "anon" }
  | { kind: "unreachable" };

export type AuthStatus = "loading" | "authed" | "anon";

/* --------------------------- local storage -------------------------------- */

/**
 * Remember a session. `token` is nullable because a cookie-only session has no
 * bearer token to keep — the user record alone is what the synchronous callers
 * need.
 */
export function saveSession(token: string | null, user: SessionUser): void {
  try {
    if (token !== null && token.length > 0) localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  } catch {
    /* storage unavailable - the session just won't outlive this page */
  }
  // Every per-account localStorage namespace (projects, org selection, the
  // shared-board pointer) hangs off the signed-in user. This is the one seam
  // every auth success flows through.
  setPersistenceScope(user.id);
  identify(user.id, { email: user.email, name: user.name });
}

export function getToken(): string | null {
  try {
    // Normalise "" to null: the legacy `{token, user}` shape carries an empty
    // string for a cookie-only session, and `Authorization: Bearer ` is worse
    // than no header at all.
    const raw = localStorage.getItem(TOKEN_KEY);
    return raw !== null && raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

export function getSessionUser(): SessionUser | null {
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw !== null ? (JSON.parse(raw) as SessionUser) : null;
  } catch {
    return null;
  }
}

/**
 * Whether this client believes it has a session at all. A cookie session has no
 * readable token, so the cached user is what stands in for it; `/api/auth/me`
 * populates that cache at boot, which is why board calls can trust it.
 */
export function hasSession(): boolean {
  return getToken() !== null || getSessionUser() !== null;
}

/** Drop the local copy of the session without telling the server. */
function forgetLocalSession(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  } catch {
    /* ignore */
  }
  // Back to the legacy/global namespace: the signed-out view sees only what
  // was never account-scoped, never another account's boards.
  setPersistenceScope(null);
  resetUser();
}

/**
 * Sign out. Clearing localStorage used to be the whole job, but the session now
 * lives in an httpOnly cookie the client cannot delete: without the revoke
 * below, `/api/auth/me` still reports the user as signed in and the next reload
 * silently puts them back into the workspace. Fire-and-forget on purpose - the
 * menu should close immediately, and a failed revoke still leaves the local
 * session gone.
 */
export function clearSession(): void {
  forgetLocalSession();
  void apiFetch("/api/auth/logout", { method: "POST" }).catch(() => {
    /* offline: the cookie will expire on its own */
  });
}

/* --------------------------- result shapes -------------------------------- */

export interface AuthOk {
  kind: "ok";
  user: SessionUser;
  /** Bearer token when the server issued one; null for cookie-only sessions. */
  token: string | null;
}
export interface AuthErr {
  kind: "error";
  message: string;
}
/** Password was right but the account has TOTP enabled (M1.6). */
export interface TwoFactorChallenge {
  kind: "2fa";
  loginToken: string;
}
export type SignupResult = AuthOk | AuthErr;
export type LoginResult = AuthOk | TwoFactorChallenge | AuthErr;
export type ActionResult = { kind: "ok" } | AuthErr;

/* --------------------------- parsing helpers ------------------------------ */

/** Only accept a user we can actually render; a half-shaped one is a failure. */
function readUser(value: unknown): SessionUser | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as { id?: unknown; email?: unknown; name?: unknown };
  if (typeof raw.id !== "string" || typeof raw.email !== "string" || typeof raw.name !== "string") {
    return null;
  }
  return { id: raw.id, email: raw.email, name: raw.name };
}

/**
 * Persist a successful auth response. This is the step the login screen used to
 * skip; keeping it next to the request makes it impossible to forget.
 */
function persistAuth(body: unknown): AuthOk | null {
  const source = (body ?? {}) as { token?: unknown; user?: unknown };
  const user = readUser(source.user);
  if (user === null) return null;
  const token = typeof source.token === "string" && source.token.length > 0 ? source.token : null;
  saveSession(token, user);
  // The session cookie was just replaced. The CSRF cookie is only an HMAC of
  // its own token, so the pair minted before the login is still valid - but not
  // carrying a pair across a privilege change costs one GET, and warming the
  // replacement now keeps it off the critical path of the user's next click.
  invalidateCsrfToken();
  primeCsrfToken();
  return { kind: "ok", user, token };
}

interface FieldError {
  field: string;
  message: string;
}

function isFieldError(value: unknown): value is FieldError {
  if (typeof value !== "object" || value === null) return false;
  const raw = value as { field?: unknown; message?: unknown };
  return typeof raw.field === "string" && typeof raw.message === "string";
}

/**
 * Turn a failed response into something worth showing a user. Signup validation
 * arrives as a per-field list, everything else as a single `error` string.
 */
async function failureMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: unknown; errors?: unknown };
  if (Array.isArray(body.errors)) {
    const parts = body.errors.filter(isFieldError).map((e) => `${e.field}: ${e.message}`);
    if (parts.length > 0) return parts.join("; ");
  }
  if (typeof body.error === "string" && body.error.length > 0) return body.error;
  return `${fallback} (${res.status}).`;
}

/** A transport failure means the server, not the credentials, is the problem. */
function transportError(): AuthErr {
  return {
    kind: "error",
    message: "Can't reach the Lucent server. Start it with: npm run start -w @lucent/server",
  };
}

/* --------------------------- auth endpoints ------------------------------- */

async function postJson(path: string, body: unknown): Promise<Response> {
  return apiFetch(path, { method: "POST", body: JSON.stringify(body) });
}

/** Create an account. The response sets the session cookie and returns it too. */
export async function attemptSignup(
  name: string,
  email: string,
  password: string,
): Promise<SignupResult> {
  let res: Response;
  try {
    res = await postJson("/api/auth/signup", { name, email, password });
  } catch {
    return transportError();
  }
  if (!res.ok) return { kind: "error", message: await failureMessage(res, "Signup failed") };
  const ok = persistAuth(await res.json().catch(() => ({})));
  return ok ?? { kind: "error", message: "Signup succeeded but the server sent no account back." };
}

/**
 * Sign in. Two success shapes: a full session, or a 2FA challenge carrying a
 * one-shot login token to exchange for the session.
 */
export async function attemptLogin(email: string, password: string): Promise<LoginResult> {
  let res: Response;
  try {
    res = await postJson("/api/auth/login", { email, password });
  } catch {
    return transportError();
  }
  if (!res.ok) return { kind: "error", message: await failureMessage(res, "Login failed") };
  const body = (await res.json().catch(() => ({}))) as {
    requires2fa?: unknown;
    loginToken?: unknown;
  };
  if (body.requires2fa === true && typeof body.loginToken === "string") {
    return { kind: "2fa", loginToken: body.loginToken };
  }
  const ok = persistAuth(body);
  return ok ?? { kind: "error", message: "Signed in but the server sent no account back." };
}

/** Finish a 2FA login with a TOTP or recovery code (M1.6). */
export async function verifyTwoFactor(loginToken: string, code: string): Promise<SignupResult> {
  let res: Response;
  try {
    res = await postJson("/api/auth/2fa/verify", { loginToken, code: code.trim() });
  } catch {
    return transportError();
  }
  if (!res.ok) return { kind: "error", message: await failureMessage(res, "Two-factor failed") };
  const ok = persistAuth(await res.json().catch(() => ({})));
  return (
    ok ?? { kind: "error", message: "Two-factor accepted but the server sent no account back." }
  );
}

/** Ask for a reset email. Always 204, so a typo looks like a real address. */
export async function requestPasswordReset(email: string): Promise<ActionResult> {
  let res: Response;
  try {
    res = await postJson("/api/auth/reset/request", { email });
  } catch {
    return transportError();
  }
  if (!res.ok) return { kind: "error", message: await failureMessage(res, "Request failed") };
  return { kind: "ok" };
}

/**
 * Redeem a reset token from an email link. The server revokes every live
 * session for that user, so the visitor still has to sign in afterwards.
 */
export async function confirmPasswordReset(token: string, password: string): Promise<ActionResult> {
  let res: Response;
  try {
    res = await postJson("/api/auth/reset/confirm", { token, password });
  } catch {
    return transportError();
  }
  if (!res.ok) return { kind: "error", message: await failureMessage(res, "Reset failed") };
  // Every session for this user was just revoked server-side; a stale cached
  // one here would make the app claim to be signed in.
  clearSession();
  return { kind: "ok" };
}

/**
 * Redeem an email-verification token. Deliberately does not cache the returned
 * user: verifying an address does not create a session, and pretending it did
 * would show a signed-out visitor the authenticated shell.
 */
export async function confirmEmailVerification(token: string): Promise<ActionResult> {
  let res: Response;
  try {
    res = await postJson("/api/auth/verify/confirm", { token });
  } catch {
    return transportError();
  }
  if (!res.ok) return { kind: "error", message: await failureMessage(res, "Verification failed") };
  return { kind: "ok" };
}

/** Redeem an org invite (M2.4). Requires a session, hence the 401 wording. */
export async function acceptInvite(token: string): Promise<ActionResult> {
  let res: Response;
  try {
    res = await postJson("/api/invites/accept", { token });
  } catch {
    return transportError();
  }
  if (res.status === 401) return { kind: "error", message: "Sign in to accept this invitation." };
  if (!res.ok) return { kind: "error", message: await failureMessage(res, "Invite failed") };
  return { kind: "ok" };
}

/* --------------------------- session check -------------------------------- */

/** Refresh the cached user without disturbing a bearer token we may hold. */
function cacheSessionUser(user: SessionUser): void {
  try {
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  } catch {
    /* ignore */
  }
  // Cookie-only sessions never call saveSession on this page load — the boot
  // /api/auth/me check is what re-aims the account namespace at the right user.
  setPersistenceScope(user.id);
}

/**
 * Ask the server who we are. Three outcomes, not two: a 5xx or a dead socket
 * means "don't know", and treating that as "signed out" would bounce a working
 * user to the login screen every time the backend restarted.
 */
export async function checkSession(): Promise<SessionCheck> {
  let res: Response;
  try {
    res = await apiFetch("/api/auth/me");
  } catch {
    return { kind: "unreachable" };
  }
  if (res.status === 401 || res.status === 403) {
    // The credential is genuinely dead - forget it rather than retrying it on
    // every later request.
    forgetLocalSession();
    return { kind: "anon" };
  }
  if (!res.ok) return { kind: "unreachable" };
  const body = (await res.json().catch(() => ({}))) as { user?: unknown };
  const user = readUser(body.user);
  if (user === null) return { kind: "unreachable" };
  cacheSessionUser(user);
  return { kind: "authed", user };
}

/**
 * The whole auth gate decision, as a pure function so it can be tested without
 * a DOM. `loading` is a real state: rendering the authenticated shell while the
 * check is still in flight flashes the workspace at signed-out visitors.
 */
export function resolveAuthStatus(
  check: SessionCheck | null,
  hasCachedSession: boolean,
): AuthStatus {
  if (check === null) return "loading";
  switch (check.kind) {
    case "authed":
      return "authed";
    case "anon":
      return "anon";
    case "unreachable":
      // Offline: trust what we last knew. A previously signed-in user keeps the
      // workspace (boards fall back to localStorage); a visitor still sees auth.
      return hasCachedSession ? "authed" : "anon";
  }
}

/* --------------------------- legacy wrappers ------------------------------- */

/**
 * Throwing wrappers kept for `ui/ProfileMenu.tsx`'s inline mini-form, which
 * predates the result unions above. New code should call `attemptLogin` /
 * `attemptSignup` and switch on the result instead of catching.
 */
function authResponseOrThrow(result: SignupResult): AuthResponse {
  if (result.kind === "error") throw new Error(result.message);
  // The cookie is the credential now; "" keeps the old `{token, user}` shape
  // for callers that pass it straight back to `saveSession`.
  return { token: result.token ?? "", user: result.user };
}

export async function signUp(email: string, password: string, name: string): Promise<AuthResponse> {
  return authResponseOrThrow(await attemptSignup(name, email, password));
}

export async function logIn(email: string, password: string): Promise<AuthResponse> {
  const result = await attemptLogin(email, password);
  if (result.kind === "2fa") {
    // The mini-form has nowhere to put a 6-digit code; the full screen does.
    throw new Error("This account uses two-factor auth - sign in from the sign-in screen.");
  }
  return authResponseOrThrow(result);
}

/** `null` only when we know we're signed out; an unreachable server keeps the cached user. */
export async function fetchMe(): Promise<SessionUser | null> {
  const check = await checkSession();
  if (check.kind === "authed") return check.user;
  if (check.kind === "unreachable") return getSessionUser();
  return null;
}
