import { ConsoleMailer } from "./console.js";
import { SmtpMailer } from "./smtp.js";
import { HttpMailer } from "./http.js";
import type { Mailer } from "./mailer.js";

export type { Mailer, MailMessage } from "./mailer.js";
export { ConsoleMailer } from "./console.js";
export { SmtpMailer } from "./smtp.js";
export { HttpMailer, type HttpMailerOptions } from "./http.js";
export {
  verificationEmail,
  passwordResetEmail,
  boardInviteEmail,
  orgInviteEmail,
  inviteEmail,
  receiptEmail,
  escapeHtml,
  escapeText,
  type TemplateContext,
  type InviteTemplateParams,
} from "./templates.js";

/**
 * Pick a Mailer implementation based on the environment.
 *
 * Resolution order:
 *   1. `LUCENT_MAIL_TRANSPORT=http` + `LUCENT_MAIL_API_KEY` → HttpMailer
 *   2. `LUCENT_MAIL_TRANSPORT=smtp` + `LUCENT_SMTP_URL`     → SmtpMailer
 *   3. Otherwise → ConsoleMailer (dev/test default)
 *
 * A real production deployment will run with SMTP or a provider's HTTP API;
 * the console mailer is the default so `npm run dev` boots without a mail
 * provider configured. A half-configured transport (transport set, credential
 * missing) also falls back to console rather than throwing: a deploy that
 * forgot one env var should still boot and log its mail to stdout, which is
 * both diagnosable and non-destructive.
 */
export interface MailerConfig {
  transport?: string;
  smtpUrl?: string;
  smtpUser?: string;
  smtpPassword?: string;
  fromAddress?: string;
  /** HTTP transport: absolute endpoint. Defaults to the provider below. */
  httpEndpoint?: string;
  /** HTTP transport: API key / server token. */
  httpApiKey?: string;
  /** HTTP transport: header the key travels in. Default `Authorization`. */
  httpAuthHeader?: string;
  /** HTTP transport: prefix before the key. Default `Bearer`; may be empty. */
  httpAuthScheme?: string;
  /** HTTP transport: request timeout in ms. Default 10s. */
  httpTimeoutMs?: number;
}

/**
 * The env keys the HTTP transport reads. Passed in rather than read from
 * `process.env` at the point of use so the selection is testable, matching
 * `config.ts`'s `ConfigEnv` shape.
 */
export interface MailerEnv {
  LUCENT_MAIL_TRANSPORT?: string;
  LUCENT_MAIL_ENDPOINT?: string;
  LUCENT_MAIL_API_KEY?: string;
  LUCENT_MAIL_AUTH_HEADER?: string;
  LUCENT_MAIL_AUTH_SCHEME?: string;
  LUCENT_MAIL_TIMEOUT_MS?: string;
  LUCENT_MAIL_FROM?: string;
}

/**
 * ASSUMPTION: Resend's endpoint is the default. Overridable by
 * `LUCENT_MAIL_ENDPOINT` (or `config.httpEndpoint`) so switching providers is
 * configuration, not a code change — see `http.ts` for what each mainstream
 * provider needs.
 */
export const DEFAULT_HTTP_MAIL_ENDPOINT = "https://api.resend.com/emails";

export function selectMailer(config: MailerConfig, env: MailerEnv = process.env): Mailer {
  // `config.transport` comes from `loadConfig`, whose union predates the HTTP
  // transport and collapses every unrecognised value to "console". Reading the
  // env var here keeps `LUCENT_MAIL_TRANSPORT=http` reachable without a config
  // change; once that union is widened, `config.transport` carries "http" on
  // its own and this fallback becomes inert.
  const transport =
    config.transport === "http" || env.LUCENT_MAIL_TRANSPORT === "http"
      ? "http"
      : (config.transport ?? env.LUCENT_MAIL_TRANSPORT);
  const from = config.fromAddress ?? env.LUCENT_MAIL_FROM ?? "noreply@lucent.local";

  if (transport === "http") {
    const apiKey = config.httpApiKey ?? env.LUCENT_MAIL_API_KEY;
    if (apiKey) {
      const timeoutMs = config.httpTimeoutMs ?? numeric(env.LUCENT_MAIL_TIMEOUT_MS);
      return new HttpMailer({
        endpoint: config.httpEndpoint ?? env.LUCENT_MAIL_ENDPOINT ?? DEFAULT_HTTP_MAIL_ENDPOINT,
        apiKey,
        from,
        authHeader: config.httpAuthHeader ?? env.LUCENT_MAIL_AUTH_HEADER,
        // An explicitly empty scheme is meaningful (Postmark's token header
        // carries no prefix), so `??` rather than `||`.
        authScheme: config.httpAuthScheme ?? env.LUCENT_MAIL_AUTH_SCHEME,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      });
    }
  }
  if (transport === "smtp" && config.smtpUrl) {
    return new SmtpMailer({
      url: config.smtpUrl,
      username: config.smtpUser ?? "",
      password: config.smtpPassword ?? "",
      from,
    });
  }
  return new ConsoleMailer();
}

function numeric(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}
