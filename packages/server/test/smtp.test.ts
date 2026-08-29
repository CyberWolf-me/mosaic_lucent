import { describe, it, expect } from "vitest";
import { createServer, type AddressInfo, type Socket } from "node:net";
import { SmtpMailer } from "../src/email/smtp.js";

/**
 * The SMTP transport against a scripted server on 127.0.0.1.
 *
 * src/email/smtp.ts speaks the protocol by hand, so the protocol is what needs
 * testing — not that a library was called. The fake below is deliberately
 * hostile in the ways real servers are: it answers EHLO with a multi-line reply
 * written in a *single* write(), which is how the reply arrives off a real TCP
 * connection and which is exactly what broke the previous per-read-buffer
 * implementation — every byte after the first newline was dropped, so the next
 * read waited forever for data the kernel had already delivered. One test
 * dribbles replies a byte at a time to pin the opposite case.
 *
 * Not covered, and said plainly: the successful STARTTLS handshake. Completing
 * one needs a certificate and a TLS-capable fake. What is covered is that the
 * client attempts STARTTLS when the server advertises it, and that it never
 * sends credentials over a connection the server refused to secure.
 */

interface FakeOptions {
  /** EHLO reply lines. Written as one chunk unless dribble. Default: no STARTTLS. */
  ehlo?: string[];
  /** Reply to STARTTLS. Only reachable when ehlo advertises it. */
  starttls?: string;
  /** Reply to AUTH. Default 235. */
  auth?: string;
  /** Reply to RCPT TO. Default 250 — override to test a refusal. */
  rcpt?: string;
  /** Write every reply one byte per write(), to exercise partial-line buffering. */
  dribble?: boolean;
  /** Accept the connection and then say nothing, forcing the read timeout. */
  silent?: boolean;
}

interface FakeSmtp {
  readonly port: number;
  /** Every command line received, in order, without its CRLF. */
  readonly commands: string[];
  /** The DATA payload, up to but excluding the final dot terminator line. */
  readonly payload: string;
  close(): Promise<void>;
}

async function startFakeSmtp(opts: FakeOptions = {}): Promise<FakeSmtp> {
  const commands: string[] = [];
  let payload = "";
  const ehlo = opts.ehlo ?? [
    "250-fake.test greets localhost",
    "250-SIZE 10485760",
    "250-8BITMIME",
    "250 AUTH PLAIN LOGIN",
  ];
  const live = new Set<Socket>();

  const server = createServer((socket) => {
    live.add(socket);
    socket.on("close", () => live.delete(socket));
    // Every test ends by destroying the connection; a reset reaching us is
    // expected and must not surface as an unhandled error event.
    socket.on("error", () => undefined);

    const reply = (text: string): void => {
      if (!opts.dribble) {
        socket.write(text);
        return;
      }
      for (const byte of Buffer.from(text, "utf8")) socket.write(Buffer.from([byte]));
    };

    if (opts.silent) return;
    reply("220 fake.test ESMTP ready\r\n");

    let buf = "";
    let inData = false;
    socket.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      for (;;) {
        if (inData) {
          // A lone dot on its own line ends DATA. Reaching it early is exactly
          // the truncation the client's dot-stuffing exists to prevent, so the
          // captured payload is the evidence for that test.
          const end = buf.indexOf("\r\n.\r\n");
          if (end < 0) return;
          payload = buf.slice(0, end + 2);
          buf = buf.slice(end + 5);
          inData = false;
          reply("250 2.0.0 Ok: queued as 7F3A1\r\n");
          continue;
        }
        const nl = buf.indexOf("\r\n");
        if (nl < 0) return;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        commands.push(line);
        const verb = (line.split(" ")[0] ?? "").toUpperCase();
        if (verb === "EHLO") reply(`${ehlo.join("\r\n")}\r\n`);
        else if (verb === "STARTTLS")
          reply(`${opts.starttls ?? "220 2.0.0 Ready to start TLS"}\r\n`);
        else if (verb === "AUTH")
          reply(`${opts.auth ?? "235 2.7.0 Authentication successful"}\r\n`);
        else if (verb === "MAIL") reply("250 2.1.0 Ok\r\n");
        else if (verb === "RCPT") reply(`${opts.rcpt ?? "250 2.1.5 Ok"}\r\n`);
        else if (verb === "DATA") {
          inData = true;
          reply("354 End data with <CR><LF>.<CR><LF>\r\n");
        } else if (verb === "QUIT") reply("221 2.0.0 Bye\r\n");
        else reply("502 5.5.2 Command not implemented\r\n");
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;

  return {
    port: address.port,
    commands,
    // A getter, because payload is reassigned when DATA completes and a copied
    // value would freeze at "".
    get payload() {
      return payload;
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of live) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

function mailerFor(fake: FakeSmtp, timeoutMs?: number): SmtpMailer {
  return new SmtpMailer({
    url: `127.0.0.1:${fake.port}`,
    username: "user",
    password: "pa:ss",
    from: "no-reply@lucent.test",
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}

/** The AUTH argument the client sent, decoded back to its NUL-delimited form. */
function decodeAuth(commands: string[]): string {
  const line = commands.find((c) => c.startsWith("AUTH PLAIN ")) ?? "";
  return Buffer.from(line.slice("AUTH PLAIN ".length), "base64").toString("utf8");
}

describe("SmtpMailer", () => {
  it("drives the envelope in order and authenticates with PLAIN", async () => {
    const fake = await startFakeSmtp();
    try {
      await mailerFor(fake).send({
        to: "ana@example.com",
        subject: "Verify your Lucent account",
        text: "Click the link to verify.",
      });
      expect(fake.commands.map((c) => (c.split(" ")[0] ?? "").toUpperCase())).toEqual([
        "EHLO",
        "AUTH",
        "MAIL",
        "RCPT",
        "DATA",
        "QUIT",
      ]);
      expect(fake.commands[0]).toBe("EHLO localhost");
      expect(fake.commands[2]).toBe("MAIL FROM:<no-reply@lucent.test>");
      expect(fake.commands[3]).toBe("RCPT TO:<ana@example.com>");
      // The colon in the password is why PLAIN is NUL-delimited rather than
      // split on punctuation: decoding must return the exact secret.
      expect(decodeAuth(fake.commands)).toBe("\0user\0pa:ss");
    } finally {
      await fake.close();
    }
  });

  it("reads a multi-line EHLO reply that arrives as one chunk", async () => {
    // Four 250- lines in a single write: the shape that used to hang forever.
    const fake = await startFakeSmtp();
    try {
      await mailerFor(fake).send({ to: "a@b.test", subject: "s", text: "t" });
      expect(fake.commands).toContain("QUIT");
      expect(fake.payload).toContain("Subject: s");
    } finally {
      await fake.close();
    }
  });

  it("reads replies delivered one byte at a time", async () => {
    const fake = await startFakeSmtp({ dribble: true });
    try {
      await mailerFor(fake).send({ to: "a@b.test", subject: "s", text: "t" });
      expect(fake.commands).toContain("QUIT");
    } finally {
      await fake.close();
    }
  });

  it("sends the HTML body with its content type and extra headers", async () => {
    const fake = await startFakeSmtp();
    try {
      await mailerFor(fake).send({
        to: "ana@example.com",
        subject: "You were invited",
        text: "plain fallback",
        html: "<p>Open the board</p>",
        headers: { "List-Unsubscribe": "<https://lucent.test/u/abc>" },
      });
      expect(fake.payload).toContain("Content-Type: text/html; charset=utf-8");
      expect(fake.payload).toContain("List-Unsubscribe: <https://lucent.test/u/abc>");
      expect(fake.payload).toContain("<p>Open the board</p>");
      // One body per message: the HTML wins and the plain text is not appended.
      expect(fake.payload).not.toContain("plain fallback");
      // Headers, blank line, body — the MIME shape, not just the bytes.
      expect(fake.payload).toMatch(/\r\n\r\n<p>Open the board<\/p>\r\n$/);
    } finally {
      await fake.close();
    }
  });

  it("stuffs leading dots and writes CRLF line endings only", async () => {
    const fake = await startFakeSmtp();
    try {
      await mailerFor(fake).send({
        to: "a@b.test",
        subject: "dots",
        text: "first\n.\n.hidden\nlast",
      });
      // A lone "." would have terminated DATA early and truncated the mail;
      // ".hidden" would have arrived as "hidden". Both are doubled on the wire.
      expect(fake.payload).toContain("first\r\n..\r\n..hidden\r\nlast\r\n");
      // No bare LF anywhere: every newline in the payload is preceded by CR.
      expect(/[^\r]\n/.test(fake.payload)).toBe(false);
    } finally {
      await fake.close();
    }
  });

  it("surfaces the server's own text when a recipient is refused", async () => {
    const fake = await startFakeSmtp({
      rcpt: "550 5.1.1 <nobody@example.com>: Recipient address rejected: User unknown",
    });
    try {
      await expect(
        mailerFor(fake).send({ to: "nobody@example.com", subject: "s", text: "t" }),
      ).rejects.toThrow(/smtp expected 250, got: 550 5\.1\.1 .*Recipient address rejected/);
      // The send stops where it failed: DATA was never opened.
      expect(fake.commands).not.toContain("DATA");
    } finally {
      await fake.close();
    }
  });

  it("attempts STARTTLS when the server advertises it", async () => {
    const fake = await startFakeSmtp({
      ehlo: ["250-fake.test greets localhost", "250-STARTTLS", "250 AUTH PLAIN"],
      starttls: "454 4.7.0 TLS not available due to temporary reason",
    });
    try {
      await expect(
        mailerFor(fake).send({ to: "a@b.test", subject: "s", text: "t" }),
      ).rejects.toThrow(/smtp expected 220, got: 454 4\.7\.0 TLS not available/);
      expect(fake.commands).toContain("STARTTLS");
      // Credentials must not cross a connection the server just refused to secure.
      expect(fake.commands.some((c) => c.startsWith("AUTH"))).toBe(false);
    } finally {
      await fake.close();
    }
  });

  it("refuses a recipient containing a line break before opening a connection", async () => {
    const fake = await startFakeSmtp();
    try {
      await expect(
        mailerFor(fake).send({
          to: "ana@example.com>\r\nRCPT TO:<victim@example.com",
          subject: "s",
          text: "t",
        }),
      ).rejects.toThrow(/recipient contains a line break/);
      // Validation before the socket, not after: nothing reached the server, so
      // the injected second RCPT never existed on the wire.
      expect(fake.commands).toEqual([]);
    } finally {
      await fake.close();
    }
  });

  it("refuses a line break in the subject or in a header value", async () => {
    const fake = await startFakeSmtp();
    try {
      await expect(
        mailerFor(fake).send({
          to: "a@b.test",
          subject: "hi\r\nBcc: victim@example.com",
          text: "t",
        }),
      ).rejects.toThrow(/subject contains a line break/);
      await expect(
        mailerFor(fake).send({
          to: "a@b.test",
          subject: "s",
          text: "t",
          headers: { "X-Campaign": "spring\nBcc: victim@example.com" },
        }),
      ).rejects.toThrow(/header X-Campaign contains a line break/);
      expect(fake.commands).toEqual([]);
    } finally {
      await fake.close();
    }
  });

  it("fails a read with a bounded timeout instead of hanging", async () => {
    const fake = await startFakeSmtp({ silent: true });
    try {
      await expect(
        mailerFor(fake, 150).send({ to: "a@b.test", subject: "s", text: "t" }),
      ).rejects.toThrow(/smtp read timeout after 150ms/);
    } finally {
      await fake.close();
    }
  });
});
