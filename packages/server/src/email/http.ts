import type { Mailer, MailMessage } from "./mailer.js";

/**
 * HTTP mail transport — the third leg `mailer.ts` documents and that did not
 * exist, so `LUCENT_MAIL_TRANSPORT=http` silently fell through to the console
 * mailer and a "production" deployment sent nothing.
 *
 * Provider-agnostic by construction: the endpoint, the auth header and the
 * auth scheme are all configuration, so moving between providers that accept a
 * flat JSON message is an env change, not a code change. `fetch` is used
 * directly (Node 22 has it global) — no SDK, matching the dependency stance
 * that produced the hand-rolled SMTP transport next door.
 *
 * ASSUMPTION: the default wire format is Resend's
 * (`POST https://api.resend.com/emails`, `Authorization: Bearer <key>`, a flat
 * `{from, to, subject, text, html}` JSON body). It was picked because it is the
 * simplest of the mainstream shapes and Postmark's and Mailgun's JSON APIs
 * accept the same fields under different names, so the body needs no
 * restructuring for them — only `LUCENT_MAIL_ENDPOINT` and, for Postmark,
 * `LUCENT_MAIL_AUTH_HEADER=X-Postmark-Server-Token` with an empty
 * `LUCENT_MAIL_AUTH_SCHEME`. SendGrid v3 is the exception: it nests recipients
 * under `personalizations`, so it needs a body adapter rather than an env
 * change — see `bodyFor` for where that would hook in.
 *
 * Deliberately no retry queue, matching `SmtpMailer`: the call sites treat a
 * transactional send as best-effort (signup logs and continues, the user can
 * resend), and a retry loop inside a request handler is a latency trap. A
 * durable outbox is the right answer and belongs with the job runner, not
 * here.
 */

export interface HttpMailerOptions {
  /** Absolute https:// endpoint that accepts the JSON message. */
  endpoint: string;
  /** Provider API key / server token. */
  apiKey: string;
  /** The From address. Must be a domain the provider has verified. */
  from: string;
  /** Header the key travels in. Default `Authorization`. */
  authHeader?: string;
  /** Prefix before the key, e.g. `Bearer`. Empty for token-style headers. */
  authScheme?: string;
  /** Request timeout in ms. Default 10s — the same budget SMTP connect uses. */
  timeoutMs?: number;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

/** How much of a provider error body is quoted in the thrown message. */
const ERROR_BODY_CHARS = 300;

export class HttpMailer implements Mailer {
  constructor(private readonly opts: HttpMailerOptions) {
    if (!opts.endpoint) throw new Error("http mail: endpoint is required");
    if (!opts.apiKey) throw new Error("http mail: apiKey is required");
  }

  async send(msg: MailMessage): Promise<void> {
    const doFetch = this.opts.fetchImpl ?? fetch;
    const authHeader = this.opts.authHeader ?? "Authorization";
    const scheme = this.opts.authScheme ?? "Bearer";
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json",
      [authHeader]: scheme ? `${scheme} ${this.opts.apiKey}` : this.opts.apiKey,
    };

    let res: Response;
    try {
      res = await doFetch(this.opts.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(this.bodyFor(msg)),
        // A hung provider must not hold a request handler open. Same shape as
        // the AI providers' timeout.
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10_000),
      });
    } catch (err) {
      // Network failure, DNS, TLS or the abort above. Normalised to the same
      // error shape a provider rejection produces: a plain Error whose message
      // names the transport, so a caller's log line reads the same either way.
      throw new Error(`http mail: request to ${this.opts.endpoint} failed: ${describe(err)}`);
    }

    if (!res.ok) {
      // Quote a bounded slice of the body: providers put the actionable detail
      // there ("domain is not verified", "from address invalid") and a status
      // code alone sends the operator to the docs for nothing.
      const detail = await readBodySnippet(res);
      throw new Error(
        `http mail: ${res.status} ${res.statusText || "error"} from ${this.opts.endpoint}${detail ? ` — ${detail}` : ""}`,
      );
    }
  }

  /**
   * Map the internal message onto the provider's JSON body. The one place a
   * non-conforming provider (SendGrid v3's `personalizations`) would need an
   * adapter; everything else in this class is provider-neutral.
   */
  private bodyFor(msg: MailMessage): Record<string, unknown> {
    const body: Record<string, unknown> = {
      from: this.opts.from,
      // Array form: every provider that accepts a flat body accepts a list,
      // and a list keeps a comma in a display name from being read as a
      // second recipient.
      to: [msg.to],
      subject: msg.subject,
      text: msg.text,
    };
    if (msg.html) body.html = msg.html;
    if (msg.headers && Object.keys(msg.headers).length > 0) body.headers = msg.headers;
    // Category/tag naming differs per provider; `tags` is the Resend spelling
    // and unknown fields are ignored by the others rather than rejected.
    if (msg.category) body.tags = [{ name: "category", value: msg.category }];
    // Resend's spelling: base64 content with a filename.
    if (msg.attachments && msg.attachments.length > 0) {
      body.attachments = msg.attachments.map((a) => ({
        filename: a.filename,
        content: Buffer.from(a.content, "utf8").toString("base64"),
        content_type: a.contentType,
      }));
    }
    return body;
  }
}

/** Best-effort body read. A failure to read must not mask the status code. */
async function readBodySnippet(res: Response): Promise<string> {
  try {
    const text = await res.text();
    const oneLine = text.replace(/\s+/g, " ").trim();
    return oneLine.length > ERROR_BODY_CHARS ? `${oneLine.slice(0, ERROR_BODY_CHARS)}…` : oneLine;
  } catch {
    return "";
  }
}

function describe(err: unknown): string {
  if (err instanceof Error) {
    // AbortSignal.timeout rejects with a TimeoutError whose message is
    // unhelpful on its own ("The operation was aborted").
    return err.name === "TimeoutError" ? "timed out" : err.message;
  }
  return String(err);
}
