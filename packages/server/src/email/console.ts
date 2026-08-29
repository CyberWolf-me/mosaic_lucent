import type { Mailer, MailMessage } from "./mailer.js";

/**
 * Console transport — logs the message to stdout in a stable, parseable
 * shape. The dev default and the test fixture. Nothing leaves the process.
 *
 * The format is line-oriented so a tail -f on the server output reads as a
 * mailbox during local dev:
 *
 *   [mail] to=ana@example.com subject="Verify your Lucent account"
 *
 * Bodies longer than ~200 chars are truncated with an ellipsis to keep the
 * dev console readable; the full text is still on the same line so a script
 * can parse it.
 */
export class ConsoleMailer implements Mailer {
  constructor(private readonly opts: { prefix?: string } = {}) {}

  async send(msg: MailMessage): Promise<void> {
    const prefix = this.opts.prefix ?? "mail";
    const bodyPreview = msg.text.length > 200 ? `${msg.text.slice(0, 197)}…` : msg.text;
    const singleLine = bodyPreview.replace(/\n+/g, " ");

    console.log(
      `[${prefix}] to=${msg.to} subject=${JSON.stringify(msg.subject)} body=${JSON.stringify(singleLine)}`,
    );
  }
}
