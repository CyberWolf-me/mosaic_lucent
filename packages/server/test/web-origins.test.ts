/**
 * The CSRF Origin allow-list is multi-origin (config.webOrigins): Vite's dev
 * port auto-increments when the default is taken, so a deployment legitimately
 * serves from 5173 AND 5174 — a single-origin list is how a stale pin 403'd
 * every authenticated POST ("csrf rejected", reason "origin") once Vite
 * drifted back to the default port. Found live, 2026-09-08.
 */
import { describe, it, expect } from "vitest";
import { readConfig } from "../src/config.js";
import { verifyCsrf } from "../src/csrf.js";

describe("webOrigins — the CSRF allow-list", () => {
  it("readConfig parses a comma-separated extension and keeps the primary first", () => {
    const config = readConfig({
      LUCENT_WEB_ORIGIN: "http://localhost:5174",
      LUCENT_WEB_ORIGINS: "http://localhost:5173, http://127.0.0.1:5173",
    });
    expect(config.webOrigin).toBe("http://localhost:5174");
    expect(config.webOrigins).toEqual([
      "http://localhost:5174",
      "http://localhost:5173",
      "http://127.0.0.1:5173",
    ]);
  });

  it("deduplicates and defaults to the single 5173 origin", () => {
    const config = readConfig({
      LUCENT_WEB_ORIGIN: "http://localhost:5173",
      LUCENT_WEB_ORIGINS: "http://localhost:5173",
    });
    expect(config.webOrigins).toEqual(["http://localhost:5173"]);
  });

  it("a POST from the secondary origin passes the CSRF origin check", () => {
    const config = readConfig({
      LUCENT_WEB_ORIGIN: "http://localhost:5174",
      LUCENT_WEB_ORIGINS: "http://localhost:5173",
    });
    const result = verifyCsrf(
      { secret: "s", allowedOrigins: config.webOrigins },
      "POST",
      "http://localhost:5173",
      "lucent_session=abc",
      "token",
      true,
    );
    // Origin accepted; the pair mismatch below is a DIFFERENT reason — the
    // point is the request got past the origin arm.
    expect(result.reason).not.toBe("origin");
  });

  it("an unknown origin is still refused", () => {
    const config = readConfig({
      LUCENT_WEB_ORIGIN: "http://localhost:5174",
      LUCENT_WEB_ORIGINS: "http://localhost:5173",
    });
    const result = verifyCsrf(
      { secret: "s", allowedOrigins: config.webOrigins },
      "POST",
      "http://evil.example",
      "lucent_session=abc",
      "token",
      true,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("origin");
  });
});
