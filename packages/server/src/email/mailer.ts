/**
 * Mailer interface (M1.3).
 *
 * Three transports behind one interface:
 *   - Console (default in dev) — logs to stdout, no network.
 *   - SMTP — talks to any RFC 5321 server. Used in production behind a real
 *     transactional provider (Postmark, SES, Mailgun, …).
 *   - HTTP — optional provider with a JSON-over-HTTPS API (Resend, SendGrid
 *     v3, Postmark's HTTP API). Not wired by default; available when the
 *     `LUCENT_MAIL_TRANSPORT=http` env flag is set so a deployment can pick
 *     a vendor without changing the call sites.
 *
 * The interface is small because the templates do the work. Call sites only
 * care that "send succeeded" — they don't see the wire format.
 */

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  /** Optional HTML body; templates always provide both for client compatibility. */
  html?: string;
  /** Optional headers, e.g. List-Unsubscribe. */
  headers?: Record<string, string>;
  /** Optional category for analytics (templated-name, e.g. "verify"). */
  category?: string;
  /** Files sent with the mail — a meeting invite's `.ics` (docs/28 A3.4). */
  attachments?: MailAttachment[];
}

/** A small text file carried by a mail. */
export interface MailAttachment {
  filename: string;
  /** e.g. `text/calendar; charset=utf-8; method=REQUEST`. */
  contentType: string;
  /** The file's text; transports encode it for the wire. */
  content: string;
}

export interface Mailer {
  send(msg: MailMessage): Promise<void>;
  /** Optional flush hook for batching providers. No-op by default. */
  flush?(): Promise<void>;
}
