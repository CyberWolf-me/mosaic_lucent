import { randomBytes } from "node:crypto";
import type { OauthConfig } from "./oauth.js";

/**
 * Configuration read from the environment. Centralised so the secure-by-default
 * behaviour (M0.3) is uniform: every env flag is parsed in one place, every
 * default is documented here, and tests can construct a Config directly
 * without touching process.env.
 *
 * Defaults are deliberately conservative everywhere, including dev: a flag
 * whose safe value depends on NODE_ENV is a flag that will one day be wrong in
 * production, because NODE_ENV is the single easiest variable to forget.
 * `LUCENT_REQUIRE_AUTH=0` and `LUCENT_TRUST_PROXY=1` are the explicit,
 * per-deployment escape hatches.
 */

export interface Config {
  host: string;
  port: number;
  webOrigin: string;
  /**
   * Every origin the browser may call from (the CSRF Origin allow-list and any
   * future multi-origin consumer). Vite's dev port auto-increments when the
   * default is taken, so deployments pin several — a single-origin allow-list
   * is how a stale 5174 entry silently 403'd every authenticated POST ("csrf
   * rejected", reason "origin") once Vite drifted back to 5173.
   */
  webOrigins: string[];
  databaseUrl: string | undefined;
  requireAuth: boolean;
  /** True only when explicitly enabled; controls X-Forwarded-For trust. */
  trustProxy: boolean;
  /** Maximum size of a workspace JSON blob accepted on POST /api/boards. */
  maxWorkspaceBytes: number;
  /** When true /metrics includes telemetry message bodies. */
  metricsVerbose: boolean;
  /** Per-IP+email login/signup limiter. */
  authLimiter: { perWindow: number; windowMs: number };
  /** Hard cap on AI provider calls. */
  aiTimeoutMs: number;
  /** Ticket TTL for the WebSocket auth handshake. */
  realtimeTicketTtlMs: number;
  /** M1.3: which Mailer transport to use. */
  mail: {
    transport: MailTransport;
    smtpUrl: string | undefined;
    smtpUser: string | undefined;
    smtpPassword: string | undefined;
    fromAddress: string;
    /** HTTP transport settings; see `email/index.ts` for each default. */
    httpEndpoint: string | undefined;
    httpApiKey: string | undefined;
    httpAuthHeader: string | undefined;
    httpAuthScheme: string | undefined;
    httpTimeoutMs: number | undefined;
  };
  /**
   * M4.3: Stripe billing. Both keys unset means billing stays off: the
   * entitlement gates still run (they read the plan catalogue), but there is
   * no Stripe client, no checkout/portal routes and no webhook receiver. A
   * half configuration is refused at boot rather than half-served.
   */
  billing: {
    stripeSecretKey: string | undefined;
    stripeWebhookSecret: string | undefined;
  };
  /**
   * M5/E1: bring-your-own-key. Off by default — when on, an authenticated
   * caller may present their own provider API key per request (headers
   * x-lucent-provider-key/-provider/-model) and the server routes that one
   * call through it. The key is used once and dropped; it is never persisted
   * or logged.
   */
  allowByoKeys: boolean;
  /**
   * docs/23 S3 / docs/24 Phase C: the operator's DECLARATION that the
   * configured provider runs on infrastructure the customer controls
   * (`LUCENT_AI_SELF_HOSTED=1`). The server cannot probe a provider's
   * endpoint, so self-hostedness is only ever this operator attestation plus
   * the in-process mock; an org's `self-hosted-only` provider policy reads
   * it. Off by default, and a BYO key is never self-hosted regardless — the
   * BYO path targets fixed public cloud endpoints.
   */
  aiSelfHosted: boolean;
  /**
   * M1.8: federated sign-in. A provider is on only when BOTH its client id
   * and secret are set; the routes 503 for anything else. Unset here means
   * the AuthView hides the button entirely — an enabled-but-unconfigured
   * provider is a dead end for the user, so it never renders as one.
   */
  oauth: OauthConfig;
  /**
   * M5/E3: LiveKit voice. All three keys set means `POST /api/livekit/token`
   * mints per-room, per-user access tokens (the client already implements
   * the route contract — see packages/web/src/stt/livekit.ts `fetchToken`).
   * Anything unset means the route answers 503 and the web falls back to
   * on-device STT, which is the no-vendor default the product ships with.
   */
  livekit: {
    apiKey: string | undefined;
    apiSecret: string | undefined;
    url: string | undefined;
    /**
     * The worker name `/api/livekit/dispatch` asks LiveKit for. The worker
     * registers under the same variable. Workers sharing a name share the
     * jobs, so a developer's worker on a shared LiveKit project would take
     * real users' calls unless it runs under its own name.
     */
    agentName: string;
  };
  /**
   * docs/25 V1: server-hosted diarizing STT (the fourth STT slot). Key + URL
   * configured means `POST /api/stt/sessions` serves real transcription
   * through the sidecar contract (`stt.ts`); anything less is the standby
   * mock and the route answers 503 — the same fail-open shape as LiveKit, so
   * a half-configured deployment never swallows speech silently.
   */
  stt: {
    apiKey: string | undefined;
    url: string | undefined;
    name: string | undefined;
  };
  /**
   * docs/25 V7: server voice synthesis (M6.2). Key + URL configured means
   * `POST /api/tts/speak` renders real audio through the sidecar; anything
   * less is the standby mock and the route answers 503, so the client falls
   * back to local speech synthesis instead of faked audio.
   */
  tts: {
    apiKey: string | undefined;
    url: string | undefined;
    name: string | undefined;
    voice: string | undefined;
  };
}

export interface ConfigEnv {
  LUCENT_HOST?: string;
  LUCENT_PORT?: string;
  LUCENT_WEB_ORIGIN?: string;
  /** Comma-separated extension of LUCENT_WEB_ORIGIN; each entry joins the CSRF allow-list. */
  LUCENT_WEB_ORIGINS?: string;
  LUCENT_DATABASE_URL?: string;
  LUCENT_REQUIRE_AUTH?: string;
  LUCENT_TRUST_PROXY?: string;
  LUCENT_MAX_WORKSPACE_BYTES?: string;
  LUCENT_METRICS_VERBOSE?: string;
  LUCENT_AUTH_LIMIT_PER_WINDOW?: string;
  LUCENT_AUTH_LIMIT_WINDOW_MS?: string;
  LUCENT_AI_TIMEOUT_MS?: string;
  LUCENT_REALTIME_TICKET_TTL_MS?: string;
  LUCENT_SESSION_SECRET?: string;
  LUCENT_LIVEKIT_API_KEY?: string;
  LUCENT_LIVEKIT_API_SECRET?: string;
  LUCENT_LIVEKIT_URL?: string;
  LUCENT_VOICE_AGENT_NAME?: string;
  LUCENT_STT_KEY?: string;
  LUCENT_STT_URL?: string;
  LUCENT_STT_NAME?: string;
  LUCENT_STT_PROVIDER?: string;
  LUCENT_DEEPGRAM_MODEL?: string;
  LUCENT_DEEPGRAM_CONTENT_TYPE?: string;
  LUCENT_STT_TIMEOUT_MS?: string;
  LUCENT_TTS_KEY?: string;
  LUCENT_TTS_URL?: string;
  LUCENT_TTS_NAME?: string;
  LUCENT_TTS_VOICE?: string;
  LUCENT_TTS_PROVIDER?: string;
  LUCENT_DEEPGRAM_TTS_MODEL?: string;
  LUCENT_DEEPGRAM_TTS_ENCODING?: string;
  LUCENT_DEEPGRAM_TTS_SAMPLE_RATE?: string;
  LUCENT_OPENAI_STT_MODEL?: string;
  LUCENT_OPENAI_CONTENT_TYPE?: string;
  LUCENT_OPENAI_TTS_MODEL?: string;
  LUCENT_OPENAI_TTS_VOICE?: string;
  LUCENT_TTS_TIMEOUT_MS?: string;
  OPENAI_API_KEY?: string;
  LUCENT_MAIL_TRANSPORT?: string;
  LUCENT_MAIL_ENDPOINT?: string;
  LUCENT_MAIL_API_KEY?: string;
  LUCENT_MAIL_AUTH_HEADER?: string;
  LUCENT_MAIL_AUTH_SCHEME?: string;
  LUCENT_MAIL_TIMEOUT_MS?: string;
  LUCENT_SMTP_URL?: string;
  LUCENT_SMTP_USER?: string;
  LUCENT_SMTP_PASSWORD?: string;
  LUCENT_MAIL_FROM?: string;
  LUCENT_STRIPE_SECRET_KEY?: string;
  LUCENT_STRIPE_WEBHOOK_SECRET?: string;
  LUCENT_OAUTH_GOOGLE_CLIENT_ID?: string;
  LUCENT_OAUTH_GOOGLE_CLIENT_SECRET?: string;
  LUCENT_OAUTH_GITHUB_CLIENT_ID?: string;
  LUCENT_OAUTH_GITHUB_CLIENT_SECRET?: string;
  LUCENT_ALLOW_BYO_KEYS?: string;
  LUCENT_AI_SELF_HOSTED?: string;
  NODE_ENV?: string;
}

/**
 * The mail transports `selectMailer` can build. Anything unrecognised collapses
 * to the console transport, which never leaves the process - a typo in this key
 * must not silently post user email addresses at a provider.
 */
/** The voice-agent worker's name when `LUCENT_VOICE_AGENT_NAME` is unset. */
export const DEFAULT_VOICE_AGENT_NAME = "lucent-voice-agent";

export const MAIL_TRANSPORTS = ["console", "smtp", "http"] as const;
export type MailTransport = (typeof MAIL_TRANSPORTS)[number];

const mailTransport = (value: string | undefined): MailTransport =>
  MAIL_TRANSPORTS.find((transport) => transport === value) ?? "console";

/** Like `num`, but absent or invalid means "let the consumer own the default". */
const optionalNum = (value: string | undefined) => {
  const parsed = Number(value);
  return value !== undefined && Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : undefined;
};

const num = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
};

/** True for any environment where accidentally weak defaults would be a security incident. */
export function isProduction(env: ConfigEnv): boolean {
  return env.NODE_ENV === "production";
}

export function readConfig(env: ConfigEnv = process.env): Config {
  // Authentication is on unless someone switches it off in so many words.
  // This used to key off NODE_ENV, which meant a container started without
  // NODE_ENV=production served every board to anyone who could reach the port
  // - and made the dev and production request paths diverge, so an
  // authorization bug could not show up locally. `LUCENT_REQUIRE_AUTH=0` is
  // the deliberate opt-out for solo localhost work; main.ts logs a warning
  // whenever it is taken.
  const requireAuth = env.LUCENT_REQUIRE_AUTH !== "0";

  return {
    host: env.LUCENT_HOST ?? "127.0.0.1",
    port: num(env.LUCENT_PORT, 4387),
    webOrigin: env.LUCENT_WEB_ORIGIN ?? "http://localhost:5173",
    webOrigins: (() => {
      const primary = env.LUCENT_WEB_ORIGIN ?? "http://localhost:5173";
      const extras = (env.LUCENT_WEB_ORIGINS ?? "")
        .split(",")
        .map((o) => o.trim())
        .filter((o) => o.length > 0 && o !== primary);
      return [primary, ...extras];
    })(),
    databaseUrl: env.LUCENT_DATABASE_URL || undefined,
    requireAuth,
    trustProxy: env.LUCENT_TRUST_PROXY === "1",
    maxWorkspaceBytes: num(env.LUCENT_MAX_WORKSPACE_BYTES, 8 * 1024 * 1024),
    metricsVerbose: env.LUCENT_METRICS_VERBOSE === "1",
    authLimiter: {
      perWindow: num(env.LUCENT_AUTH_LIMIT_PER_WINDOW, 10),
      windowMs: num(env.LUCENT_AUTH_LIMIT_WINDOW_MS, 5 * 60_000),
    },
    // Provider-call ceiling for AI generation. A full-board batch (~50 ops at
    // a 16k output budget) can legitimately take over 90s to write; the old
    // 90s default aborted exactly the large generations the raised output
    // budget was for (M1). The client's per-frame-resetting stream timeout
    // (120s) is the user-side guard, so this only needs to sit above it.
    aiTimeoutMs: num(env.LUCENT_AI_TIMEOUT_MS, 180_000),
    realtimeTicketTtlMs: num(env.LUCENT_REALTIME_TICKET_TTL_MS, 60_000),
    mail: {
      transport: mailTransport(env.LUCENT_MAIL_TRANSPORT),
      smtpUrl: env.LUCENT_SMTP_URL,
      smtpUser: env.LUCENT_SMTP_USER,
      smtpPassword: env.LUCENT_SMTP_PASSWORD,
      fromAddress: env.LUCENT_MAIL_FROM ?? "noreply@lucent.local",
      httpEndpoint: env.LUCENT_MAIL_ENDPOINT,
      httpApiKey: env.LUCENT_MAIL_API_KEY,
      httpAuthHeader: env.LUCENT_MAIL_AUTH_HEADER,
      httpAuthScheme: env.LUCENT_MAIL_AUTH_SCHEME,
      httpTimeoutMs: optionalNum(env.LUCENT_MAIL_TIMEOUT_MS),
    },
    billing: {
      stripeSecretKey: env.LUCENT_STRIPE_SECRET_KEY || undefined,
      stripeWebhookSecret: env.LUCENT_STRIPE_WEBHOOK_SECRET || undefined,
    },
    allowByoKeys: env.LUCENT_ALLOW_BYO_KEYS === "1",
    aiSelfHosted: env.LUCENT_AI_SELF_HOSTED === "1",
    oauth: oauthFromEnv(env),
    livekit: {
      apiKey: env.LUCENT_LIVEKIT_API_KEY || undefined,
      apiSecret: env.LUCENT_LIVEKIT_API_SECRET || undefined,
      url: env.LUCENT_LIVEKIT_URL || undefined,
      agentName: env.LUCENT_VOICE_AGENT_NAME?.trim() || DEFAULT_VOICE_AGENT_NAME,
    },
    stt: {
      apiKey: env.LUCENT_STT_KEY || undefined,
      url: env.LUCENT_STT_URL || undefined,
      name: env.LUCENT_STT_NAME || undefined,
    },
    tts: {
      apiKey: env.LUCENT_TTS_KEY || undefined,
      url: env.LUCENT_TTS_URL || undefined,
      name: env.LUCENT_TTS_NAME || undefined,
      voice: env.LUCENT_TTS_VOICE || undefined,
    },
  };
}

/**
 * A provider exists only when both halves are set. One half alone is worse
 * than none — the button would render and the flow would die at the token
 * exchange — so a half-configuration collapses to "off" and the env var is
 * named loudly here for whoever is debugging why the button is missing.
 */
function oauthFromEnv(env: ConfigEnv): OauthConfig {
  const googleId = env.LUCENT_OAUTH_GOOGLE_CLIENT_ID || undefined;
  const googleSecret = env.LUCENT_OAUTH_GOOGLE_CLIENT_SECRET || undefined;
  const githubId = env.LUCENT_OAUTH_GITHUB_CLIENT_ID || undefined;
  const githubSecret = env.LUCENT_OAUTH_GITHUB_CLIENT_SECRET || undefined;
  const oauth: OauthConfig = {};
  if (googleId && googleSecret) oauth.google = { clientId: googleId, clientSecret: googleSecret };
  else if (googleId || googleSecret) {
    console.error(
      "[lucent] oauth: set BOTH LUCENT_OAUTH_GOOGLE_CLIENT_ID and LUCENT_OAUTH_GOOGLE_CLIENT_SECRET; Google sign-in stays off",
    );
  }
  if (githubId && githubSecret) oauth.github = { clientId: githubId, clientSecret: githubSecret };
  else if (githubId || githubSecret) {
    console.error(
      "[lucent] oauth: set BOTH LUCENT_OAUTH_GITHUB_CLIENT_ID and LUCENT_OAUTH_GITHUB_CLIENT_SECRET; GitHub sign-in stays off",
    );
  }
  return oauth;
}

/** Dev-only fallback for the HMAC secret. Production throws. */
export function sessionSecret(env: ConfigEnv = process.env): string {
  const secret = env.LUCENT_SESSION_SECRET;
  if (secret && secret.length >= 16) return secret;
  if (isProduction(env)) {
    throw new Error(
      "LUCENT_SESSION_SECRET must be set in production (>=16 chars). " +
        "Without it every session token is invalidated on restart.",
    );
  }
  // Dev fallback: tokens won't survive a restart, which is fine locally.
  return randomBytes(32).toString("hex");
}
