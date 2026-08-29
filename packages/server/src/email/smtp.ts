import { connect, type Socket } from "node:net";
import { connect as createTlsConnection, type TLSSocket } from "node:tls";
import type { Mailer, MailMessage } from "./mailer.js";

/**
 * Minimal SMTP transport — direct, dependency-free, no retry queue.
 *
 * Built because the dependency surface matters: a small SMTP envelope
 * (EHLO, MAIL FROM, RCPT TO, DATA, QUIT) is ~200 lines, and the npm SMTP
 * libraries are either thin wrappers around the same protocol or carry
 * features we don't need (DKIM signing, MIME building). The templates do
 * MIME here so the wire payload is one DATA block.
 *
 * STARTTLS is attempted opportunistically when the server advertises it; if it
 * doesn't, the connection stays plaintext (a misconfiguration — most providers
 * require TLS in 2026). Auth is PLAIN only; LOGIN is not implemented because
 * every modern provider supports PLAIN over TLS.
 *
 * The line protocol lives in `SmtpSession` rather than in a per-read promise,
 * which is the correction this file needed most. Reading a line by attaching a
 * fresh `data` handler with its own buffer loses every byte after the first
 * newline in the chunk that satisfied it — and a server's multi-line EHLO reply
 * arrives as *one* chunk in practice, so the second read then waits forever for
 * data the kernel already delivered. One buffer per connection, one handler per
 * socket, and a bounded read timeout so no protocol surprise can hang a send.
 *
 * Driven end to end by packages/server/test/smtp.test.ts against a scripted
 * server on 127.0.0.1 (plaintext; the STARTTLS branch still needs a manual run
 * against a real server, since testing it needs a certificate).
 */

export interface SmtpOptions {
  /** host:port or host. Default port 587 (STARTTLS submission). */
  url: string;
  username: string;
  password: string;
  /** The From address used in the envelope. */
  from: string;
  /** Connect and per-read timeout in ms. Default 10s. */
  timeoutMs?: number;
}

export class SmtpMailer implements Mailer {
  private readonly host: string;
  private readonly port: number;
  constructor(private readonly opts: SmtpOptions) {
    const parsed = new URL(`smtp://${opts.url.replace(/^smtp:\/\//, "")}`);
    this.host = parsed.hostname;
    this.port = parsed.port ? Number(parsed.port) : 587;
  }

  async send(msg: MailMessage): Promise<void> {
    // Last check before the wire. `msg.to` is user input (the address someone
    // typed at signup), and a CR or LF inside `RCPT TO:<…>` injects a second
    // SMTP command; inside a header it injects headers, `Bcc:` being the
    // obvious one. Refusing beats escaping: no legitimate address or subject
    // contains a line break.
    assertNoCrlf("recipient", msg.to);
    assertNoCrlf("subject", msg.subject);
    for (const [name, value] of Object.entries(msg.headers ?? {})) {
      assertNoCrlf(`header name ${JSON.stringify(name)}`, name);
      assertNoCrlf(`header ${name}`, value);
    }

    const timeoutMs = this.opts.timeoutMs ?? 10_000;
    const session = new SmtpSession(await this.connect(timeoutMs), timeoutMs);
    try {
      await session.expect(220);
      const greeting = await session.command(`EHLO localhost\r\n`, 250);
      if (/^250[\s-]STARTTLS\b/im.test(greeting)) {
        await session.command("STARTTLS\r\n", 220);
        await session.startTls(this.host);
        // RFC 3207 §4.2: re-issue EHLO, because the capability list the server
        // gave in the clear is not evidence of anything.
        await session.command(`EHLO localhost\r\n`, 250);
      }
      await session.command(
        `AUTH PLAIN ${plainAuth(this.opts.username, this.opts.password)}\r\n`,
        235,
      );
      await session.command(`MAIL FROM:<${this.opts.from}>\r\n`, 250);
      await session.command(`RCPT TO:<${msg.to}>\r\n`, 250);
      await session.command(`DATA\r\n`, 354);
      await session.write(dataPayload(msg, this.opts.from));
      await session.expect(250);
      await session.command(`QUIT\r\n`, 221);
    } finally {
      session.close();
    }
  }

  private connect(timeoutMs: number): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const socket = connect({ host: this.host, port: this.port });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`smtp connect timeout (${this.host}:${this.port})`));
      }, timeoutMs);
      const onError = (err: Error) => {
        clearTimeout(timer);
        reject(err);
      };
      socket.once("connect", () => {
        clearTimeout(timer);
        socket.off("error", onError);
        resolve(socket);
      });
      socket.once("error", onError);
    });
  }
}

/**
 * One SMTP conversation: the socket, the read buffer, and the reply parser.
 *
 * Owning the buffer here is what makes multi-line replies work. A reply line is
 * `250-text` while more follow and `250 text` on the last one (RFC 5321 §4.2.1),
 * and servers routinely put the whole set in one TCP segment, so "read a line"
 * has to mean "take a line out of the bytes we already hold" rather than "wait
 * for the next chunk".
 */
class SmtpSession {
  private socket: Socket | TLSSocket;
  private buf = Buffer.alloc(0);
  /** FIFO of readers waiting for a line; drained in arrival order. */
  private readers: {
    resolve: (line: string) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }[] = [];
  /** First fatal socket event, latched so later reads fail the same way. */
  private failure: Error | null = null;

  // Arrow-function fields on purpose: they keep `this` bound *and* give `off()`
  // the same reference `on()` got, which a `.bind(this)` at each call site does
  // not. Detaching cleanly is the whole point during the TLS swap.
  private readonly onData = (chunk: Buffer): void => {
    this.buf = Buffer.concat([this.buf, chunk]);
    this.drain();
  };
  private readonly onError = (err: Error): void => {
    this.fail(err);
  };
  private readonly onClose = (): void => {
    this.fail(new Error("smtp: server closed the connection"));
  };

  constructor(
    socket: Socket | TLSSocket,
    private readonly timeoutMs: number,
  ) {
    this.socket = socket;
    this.attach();
  }

  private attach(): void {
    this.socket.on("data", this.onData);
    this.socket.on("error", this.onError);
    this.socket.on("close", this.onClose);
  }

  private detach(): void {
    this.socket.off("data", this.onData);
    this.socket.off("error", this.onError);
    this.socket.off("close", this.onClose);
  }

  /** Hand buffered lines to waiting readers, oldest first. */
  private drain(): void {
    while (this.readers.length > 0) {
      const idx = this.buf.indexOf(0x0a);
      if (idx < 0) return;
      const line = this.buf.subarray(0, idx).toString("utf8").replace(/\r$/, "");
      this.buf = this.buf.subarray(idx + 1);
      const reader = this.readers.shift()!;
      clearTimeout(reader.timer);
      reader.resolve(line);
    }
  }

  private fail(err: Error): void {
    this.failure ??= err;
    const waiting = this.readers;
    this.readers = [];
    for (const reader of waiting) {
      clearTimeout(reader.timer);
      reader.reject(this.failure);
    }
  }

  private readLine(): Promise<string> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise<string>((resolve, reject) => {
      // A read timeout is the backstop for every "the server said something we
      // don't parse" case. Without it an unexpected reply shape means a promise
      // that never settles, which surfaces as a request that hangs until the
      // client gives up rather than as an error anyone can act on.
      const timer = setTimeout(() => {
        this.readers = this.readers.filter((r) => r.timer !== timer);
        reject(new Error(`smtp read timeout after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      this.readers.push({ resolve, reject, timer });
      this.drain();
    });
  }

  /** Read one complete reply, following `nnn-` continuation lines. */
  private async reply(): Promise<{ code: number; text: string }> {
    const lines: string[] = [];
    for (;;) {
      const line = await this.readLine();
      lines.push(line);
      // `nnn ` (or a bare `nnn`) ends the reply; `nnn-` continues it. Anything
      // else is not a reply line, and stopping beats reading until the timeout.
      if (!/^\d{3}-/.test(line)) break;
    }
    const first = lines[0] ?? "";
    const code = Number.parseInt(first.slice(0, 3), 10);
    return { code: Number.isNaN(code) ? 0 : code, text: lines.join("\n") };
  }

  /** Read a reply and require the code, returning the full text. */
  async expect(code: number): Promise<string> {
    const reply = await this.reply();
    if (reply.code !== code) {
      throw new Error(`smtp expected ${code}, got: ${reply.text}`);
    }
    return reply.text;
  }

  /**
   * Write one chunk and wait for it to reach the kernel.
   *
   * `socket.write()` answers a *boolean* — false meaning "buffered, wait for
   * 'drain'" — so `await socket.write(...)` awaits a boolean and waits for
   * nothing, and a write error then surfaces only as an 'error' event detached
   * from the command that caused it. The callback form resolves once the chunk
   * is flushed and hands us the error, so a failed write rejects at the
   * statement that caused it instead of leaving us in a read.
   */
  write(data: string): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      this.socket.write(data, (err) => (err ? reject(err) : resolve()));
    });
  }

  async command(cmd: string, expected: number): Promise<string> {
    await this.write(cmd);
    return this.expect(expected);
  }

  /** Wrap the live socket in TLS and continue the session over it. */
  async startTls(host: string): Promise<void> {
    const raw = this.socket;
    this.detach();
    // RFC 3207 §4.2: discard everything learned before the handshake. Bytes
    // still buffered arrived in the clear, so a MITM could have written them.
    this.buf = Buffer.alloc(0);
    const tls = await new Promise<TLSSocket>((resolve, reject) => {
      const upgraded = createTlsConnection({ socket: raw, host, servername: host });
      const onFail = (err: Error): void => reject(err);
      upgraded.once("secureConnect", () => {
        upgraded.off("error", onFail);
        resolve(upgraded);
      });
      upgraded.once("error", onFail);
    });
    this.socket = tls;
    this.attach();
  }

  close(): void {
    this.detach();
    for (const reader of this.readers) clearTimeout(reader.timer);
    this.readers = [];
    this.socket.end();
  }
}

/**
 * The DATA payload: MIME headers, a blank line, the body, and the terminator.
 *
 * Two transformations that are not optional. CRLF is mandatory on the wire (RFC
 * 5321 §2.3.8) and the templates write "\n". And a line consisting of a single
 * "." ends the message, so every line that starts with one is doubled — without
 * that, a body line of "." truncates the mail and any other leading "." is
 * eaten by the server (RFC 5321 §4.5.2).
 */
function dataPayload(msg: MailMessage, from: string): string {
  const headers = [
    `From: ${from}`,
    `To: ${msg.to}`,
    `Subject: ${msg.subject}`,
    `MIME-Version: 1.0`,
    msg.html ? `Content-Type: text/html; charset=utf-8` : `Content-Type: text/plain; charset=utf-8`,
    `Content-Transfer-Encoding: 8bit`,
    ...Object.entries(msg.headers ?? {}).map(([name, value]) => `${name}: ${value}`),
  ].join("\r\n");
  const body = msg.html ?? msg.text;
  const wire = `${headers}\r\n\r\n${body}`.replace(/\r\n|\r|\n/g, "\r\n").replace(/^\./gm, "..");
  return `${wire}\r\n.\r\n`;
}

function assertNoCrlf(field: string, value: string): void {
  if (value.includes("\r") || value.includes("\n")) {
    throw new Error(`smtp: refusing to send, ${field} contains a line break`);
  }
}

function plainAuth(user: string, pass: string): string {
  return Buffer.from(`\0${user}\0${pass}`, "utf8").toString("base64");
}
