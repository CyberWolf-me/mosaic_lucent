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
 * Bodies longer than ~200 chars are previewed with an ellipsis to keep the
 * dev console readable — but action URLs (verify/reset/invite links) are
 * ALWAYS logged in full on the same line. A truncated token link once cost
 * a live verification run its mailbox confirmations: readability must never
 * eat the one string the developer actually needs from the line.
 */
export class ConsoleMailer implements Mailer {
  constructor(private readonly opts: { prefix?: string } = {}) {}

  async send(msg: MailMessage): Promise<void> {
    const prefix = this.opts.prefix ?? "mail";
    const bodyPreview = msg.text.length > 200 ? `${msg.text.slice(0, 197)}…` : msg.text;
    const singleLine = bodyPreview.replace(/\n+/g, " ");
    const urls = uniqueUrls(msg.text).filter((url) => !singleLine.includes(url));

    const files = (msg.attachments ?? []).map((a) => `${a.filename} (${a.content.length} chars)`);
    console.log(
      `[${prefix}] to=${msg.to} subject=${JSON.stringify(msg.subject)} body=${JSON.stringify(singleLine)}${
        urls.length > 0 ? ` urls=${JSON.stringify(urls)}` : ""
      }${files.length > 0 ? ` attachments=${JSON.stringify(files)}` : ""}`,
    );
  }
}

/** http(s) URLs in reading order, deduplicated. */
function uniqueUrls(text: string): string[] {
  const found = text.match(/https?:\/\/[^\s"')\]]+/g) ?? [];
  return [...new Set(found)];
}
