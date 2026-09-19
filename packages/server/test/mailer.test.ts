import { describe, it, expect, vi } from "vitest";
import { ConsoleMailer } from "../src/email/console.js";
import { SmtpMailer } from "../src/email/smtp.js";
import { DEFAULT_HTTP_MAIL_ENDPOINT, HttpMailer, selectMailer } from "../src/email/index.js";
import {
  boardInviteEmail,
  passwordResetEmail,
  receiptEmail,
  verificationEmail,
} from "../src/email/templates.js";

/**
 * Mailer surface (M1.3). The console transport is the dev/test default; the
 * SMTP transport has its own protocol suite in smtp.test.ts. The
 * templates are pure so they're tested here without mocking — the only
 * property under test is that untrusted strings (user names, board names,
 * tokens) cannot escape the HTML or the URL.
 */

describe("ConsoleMailer", () => {
  it("logs each message as a single parseable line", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const m = new ConsoleMailer();
      await m.send({
        to: "ana@example.com",
        subject: "Verify your Lucent account",
        text: "Click the link to verify.",
      });
      expect(spy).toHaveBeenCalledTimes(1);
      const line = spy.mock.calls[0]?.[0] as string;
      expect(line).toMatch(/^\[mail\] to=ana@example\.com subject=/);
      expect(line).toContain("Click the link to verify.");
    } finally {
      spy.mockRestore();
    }
  });

  it("truncates long bodies but keeps the prefix parseable", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const m = new ConsoleMailer();
      await m.send({
        to: "x@y.z",
        subject: "s",
        text: "x".repeat(500),
      });
      const line = spy.mock.calls[0]?.[0] as string;
      expect(line).toContain("…");
    } finally {
      spy.mockRestore();
    }
  });

  it("always logs action URLs in full, even past the preview cut", async () => {
    // A truncated verify link once cost a live run its mailbox confirmations:
    // readability must never eat the one string the developer needs.
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const m = new ConsoleMailer();
      const token = "A".repeat(43);
      await m.send({
        to: "long-address-for-truncation@example.com",
        subject: "Verify your Lucent account",
        text: `Hi, confirm your email (long-address-for-truncation@example.com) here: http://localhost:5173/verify?token=${token} done. ${"Some preamble that pushes this body well past the preview cut. ".repeat(6)}`,
      });
      const line = spy.mock.calls[0]?.[0] as string;
      expect(line).toContain("…");
      expect(line).toContain(`http://localhost:5173/verify?token=${token}`);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("selectMailer", () => {
  it("returns the console mailer when no SMTP env is set", () => {
    expect(selectMailer({}, {})).toBeInstanceOf(ConsoleMailer);
    expect(selectMailer({ transport: "console" }, {})).toBeInstanceOf(ConsoleMailer);
  });

  it("returns the SMTP mailer when transport=smtp with a URL", () => {
    const m = selectMailer(
      {
        transport: "smtp",
        smtpUrl: "smtp.example.com:587",
        smtpUser: "user",
        smtpPassword: "pass",
        fromAddress: "no-reply@lucent.local",
      },
      {},
    );
    expect(m).toBeInstanceOf(SmtpMailer);
    expect(m).not.toBeInstanceOf(ConsoleMailer);
  });

  it("falls back to console when transport=smtp but no URL is set", () => {
    // Misconfiguration is safer than a crash — a deploy that forgot
    // LUCENT_SMTP_URL still boots and logs to stdout.
    expect(selectMailer({ transport: "smtp" }, {})).toBeInstanceOf(ConsoleMailer);
  });
});

describe("templates: escaping", () => {
  it("escapes the user's email in the verification email", () => {
    const t = verificationEmail(
      { siteOrigin: "http://localhost:5173" },
      "abc123",
      "ana@example.com",
    );
    expect(t.html).toContain("<code>ana@example.com</code>");
    expect(t.html).not.toContain('ana@example.com"');
  });

  it("URL-encodes the token so a base64url token with + or / still works", () => {
    const t = verificationEmail({ siteOrigin: "http://localhost:5173" }, "abc+/=def", "a@b.co");
    expect(t.html).toContain("token=abc%2B%2F%3Ddef");
    expect(t.text).toContain("token=abc%2B%2F%3Ddef");
  });

  it("escapes HTML metacharacters in board names and inviter names", () => {
    const t = boardInviteEmail(
      { siteOrigin: "http://localhost:5173" },
      {
        inviterName: "<script>",
        boardName: 'Q&A "important" board',
        token: "tok",
        role: "editor",
      },
    );
    expect(t.html).not.toContain("<script>");
    expect(t.html).toContain("&lt;script&gt;");
    expect(t.html).toContain("Q&amp;A");
  });

  it("strips control characters from plain-text fields", () => {
    const t = receiptEmail(
      { siteOrigin: "http://localhost:5173" },
      { amount: "$10", plan: "Pro\u0007", periodEnd: "2027-01-01" },
    );
    expect(t.text).not.toContain("\u0007");
  });

  it("includes the configured site origin in the link", () => {
    const t = passwordResetEmail({ siteOrigin: "https://lucent.app" }, "xyz");
    expect(t.html).toContain("https://lucent.app/reset?token=xyz");
    expect(t.text).toContain("https://lucent.app/reset?token=xyz");
  });

  it("uses 'Lucent' as the product name when none is configured", () => {
    const t = verificationEmail({ siteOrigin: "http://x" }, "t", "a@b.co");
    expect(t.subject).toBe("Verify your Lucent account");
  });

  it("honours a custom product name", () => {
    const t = verificationEmail({ siteOrigin: "http://x", productName: "Acme" }, "t", "a@b.co");
    expect(t.subject).toBe("Verify your Acme account");
    expect(t.html).toContain("Welcome to Acme");
  });
});

/* ───────────────────────── HTTP transport (M1.3) ──────────────────────────── */

/**
 * A stub with the shape `HttpMailer` needs from `fetch`, so the transport can
 * be tested without a network or a provider account. `HttpMailerOptions`
 * carries `fetchImpl` for exactly this reason.
 */
function stubFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>): {
  impl: typeof fetch;
  calls: Array<{ url: string; init: RequestInit }>;
} {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    return handler(url, init ?? {});
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function headersOf(init: RequestInit): Record<string, string> {
  return init.headers as Record<string, string>;
}

function bodyOf(init: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

describe("HttpMailer", () => {
  const opts = {
    endpoint: "https://api.example.com/emails",
    apiKey: "key_123",
    from: "noreply@lucent.app",
  };

  it("POSTs a flat JSON message with a bearer key", async () => {
    const { impl, calls } = stubFetch(() => new Response("{}", { status: 200 }));
    const m = new HttpMailer({ ...opts, fetchImpl: impl });
    await m.send({
      to: "ana@example.com",
      subject: "Verify your Lucent account",
      text: "click",
      html: "<p>click</p>",
      category: "verify",
      headers: { "List-Unsubscribe": "<mailto:x@y.z>" },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(opts.endpoint);
    const init = calls[0]!.init;
    expect(init.method).toBe("POST");
    expect(headersOf(init)["Authorization"]).toBe("Bearer key_123");
    expect(headersOf(init)["content-type"]).toBe("application/json");

    const body = bodyOf(init);
    expect(body.from).toBe(opts.from);
    // A list rather than a bare string: a display name containing a comma must
    // not be read as a second recipient.
    expect(body.to).toEqual(["ana@example.com"]);
    expect(body.subject).toBe("Verify your Lucent account");
    expect(body.html).toBe("<p>click</p>");
    expect(body.headers).toEqual({ "List-Unsubscribe": "<mailto:x@y.z>" });
    expect(body.tags).toEqual([{ name: "category", value: "verify" }]);
  });

  it("omits optional fields the message didn't carry", async () => {
    const { impl, calls } = stubFetch(() => new Response("{}", { status: 202 }));
    await new HttpMailer({ ...opts, fetchImpl: impl }).send({
      to: "x@y.z",
      subject: "s",
      text: "t",
    });
    const body = bodyOf(calls[0]!.init);
    expect("html" in body).toBe(false);
    expect("headers" in body).toBe(false);
    expect("tags" in body).toBe(false);
  });

  it("supports a token-style auth header with no scheme (Postmark)", async () => {
    const { impl, calls } = stubFetch(() => new Response("{}", { status: 200 }));
    const m = new HttpMailer({
      ...opts,
      endpoint: "https://api.postmarkapp.com/email",
      authHeader: "X-Postmark-Server-Token",
      // An explicitly empty scheme is meaningful, so it must not be replaced
      // with the "Bearer" default.
      authScheme: "",
      fetchImpl: impl,
    });
    await m.send({ to: "x@y.z", subject: "s", text: "t" });
    expect(headersOf(calls[0]!.init)["X-Postmark-Server-Token"]).toBe("key_123");
    expect(headersOf(calls[0]!.init)["Authorization"]).toBeUndefined();
  });

  it("throws with the status and the provider's own detail on a rejection", async () => {
    const { impl } = stubFetch(
      () =>
        new Response(JSON.stringify({ message: "The lucent.app domain is not verified" }), {
          status: 422,
          statusText: "Unprocessable Entity",
        }),
    );
    const m = new HttpMailer({ ...opts, fetchImpl: impl });
    const err = await m.send({ to: "x@y.z", subject: "s", text: "t" }).then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(Error);
    // The actionable part lives in the body; a bare status sends the operator
    // to the provider docs for nothing.
    expect(err!.message).toContain("http mail: 422");
    expect(err!.message).toContain("domain is not verified");
    expect(err!.message).toContain(opts.endpoint);
  });

  it("bounds how much of a huge error body it quotes", async () => {
    const { impl } = stubFetch(() => new Response("x".repeat(5000), { status: 500 }));
    const m = new HttpMailer({ ...opts, fetchImpl: impl });
    const err = await m.send({ to: "x@y.z", subject: "s", text: "t" }).then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(err!.message.length).toBeLessThan(500);
    expect(err!.message).toContain("…");
  });

  it("normalises a network failure into the same error shape", async () => {
    const { impl } = stubFetch(() => {
      throw new Error("getaddrinfo ENOTFOUND api.example.com");
    });
    const m = new HttpMailer({ ...opts, fetchImpl: impl });
    const err = await m.send({ to: "x@y.z", subject: "s", text: "t" }).then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    // Same plain-Error shape a provider rejection produces, so a caller's log
    // line reads the same either way.
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain("http mail: request to");
    expect(err!.message).toContain("ENOTFOUND");
  });

  it("reports an aborted request as a timeout rather than 'aborted'", async () => {
    const { impl } = stubFetch(() => {
      const e = new Error("The operation was aborted");
      e.name = "TimeoutError";
      throw e;
    });
    const m = new HttpMailer({ ...opts, fetchImpl: impl, timeoutMs: 5 });
    const err = await m.send({ to: "x@y.z", subject: "s", text: "t" }).then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(err!.message).toContain("timed out");
  });

  it("refuses to construct without an endpoint or a key", () => {
    expect(() => new HttpMailer({ endpoint: "", apiKey: "k", from: "a@b.co" })).toThrow(
      /endpoint is required/,
    );
    expect(() => new HttpMailer({ endpoint: "https://x/y", apiKey: "", from: "a@b.co" })).toThrow(
      /apiKey is required/,
    );
  });
});

describe("selectMailer: http transport", () => {
  /**
   * The env is injected rather than read from `process.env` so these are
   * deterministic on a developer machine that happens to have mail configured.
   */
  it("selects the HTTP transport from the env", () => {
    const m = selectMailer({}, { LUCENT_MAIL_TRANSPORT: "http", LUCENT_MAIL_API_KEY: "k" });
    expect(m).toBeInstanceOf(HttpMailer);
  });

  it("is reachable even though loadConfig collapses the transport to console", () => {
    // config.ts's `mail.transport` union predates this transport and maps every
    // unrecognised value to "console", so a deployment that sets
    // LUCENT_MAIL_TRANSPORT=http arrives here as "console". Until that union is
    // widened, the env var is the only way through — which is the whole reason
    // `selectMailer` reads it.
    const m = selectMailer(
      { transport: "console" },
      { LUCENT_MAIL_TRANSPORT: "http", LUCENT_MAIL_API_KEY: "k" },
    );
    expect(m).toBeInstanceOf(HttpMailer);
  });

  it("falls back to console when the transport is set but the key is missing", () => {
    // Same precedent as SMTP without a URL: a deploy that forgot one env var
    // still boots and logs its mail to stdout.
    expect(selectMailer({ transport: "http" }, {})).toBeInstanceOf(ConsoleMailer);
    expect(selectMailer({}, { LUCENT_MAIL_TRANSPORT: "http" })).toBeInstanceOf(ConsoleMailer);
  });

  it("defaults the endpoint to the documented provider and honours an override", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));
    try {
      const env = { LUCENT_MAIL_TRANSPORT: "http", LUCENT_MAIL_API_KEY: "k" };
      await selectMailer({}, env).send({ to: "a@b.co", subject: "s", text: "t" });
      expect(spy.mock.calls[0]![0]).toBe(DEFAULT_HTTP_MAIL_ENDPOINT);

      await selectMailer({}, { ...env, LUCENT_MAIL_ENDPOINT: "https://mail.internal/send" }).send({
        to: "a@b.co",
        subject: "s",
        text: "t",
      });
      expect(spy.mock.calls[1]![0]).toBe("https://mail.internal/send");
    } finally {
      spy.mockRestore();
    }
  });

  it("takes the From address and the auth header from the env", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));
    try {
      await selectMailer(
        {},
        {
          LUCENT_MAIL_TRANSPORT: "http",
          LUCENT_MAIL_API_KEY: "server-token",
          LUCENT_MAIL_FROM: "hello@lucent.app",
          LUCENT_MAIL_AUTH_HEADER: "X-Postmark-Server-Token",
          LUCENT_MAIL_AUTH_SCHEME: "",
        },
      ).send({ to: "a@b.co", subject: "s", text: "t" });
      const init = spy.mock.calls[0]![1] as RequestInit;
      expect((init.headers as Record<string, string>)["X-Postmark-Server-Token"]).toBe(
        "server-token",
      );
      expect(JSON.parse(String(init.body)).from).toBe("hello@lucent.app");
    } finally {
      spy.mockRestore();
    }
  });

  it("prefers explicit config over the env", () => {
    const m = selectMailer(
      { transport: "http", httpApiKey: "from-config" },
      { LUCENT_MAIL_TRANSPORT: "smtp" },
    );
    expect(m).toBeInstanceOf(HttpMailer);
  });
});
