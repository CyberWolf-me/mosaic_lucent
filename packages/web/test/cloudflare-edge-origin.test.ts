import { describe, expect, it } from "vitest";
import { resolveEdgeOrigin } from "../functions/_origin.js";

describe("Cloudflare Edge Origin Resolution & Fail-Closed Guarantee", () => {
  it("normalizes configured LUCENT_ORIGIN by removing trailing slashes", () => {
    const res = resolveEdgeOrigin({
      LUCENT_ORIGIN: "https://api.lucent.dev///",
      ENVIRONMENT: "production",
    });
    expect("origin" in res).toBe(true);
    if ("origin" in res) {
      expect(res.origin).toBe("https://api.lucent.dev");
    }
  });

  it("falls back to local loopback when LUCENT_ORIGIN is omitted in development mode", () => {
    const res = resolveEdgeOrigin({
      ENVIRONMENT: "development",
    });
    expect("origin" in res).toBe(true);
    if ("origin" in res) {
      expect(res.origin).toBe("http://127.0.0.1:4387");
    }
  });

  it("fails closed (502 Bad Gateway) when LUCENT_ORIGIN is missing in production (ENVIRONMENT='production')", async () => {
    const res = resolveEdgeOrigin({
      ENVIRONMENT: "production",
    });
    expect("errorResponse" in res).toBe(true);
    if ("errorResponse" in res) {
      expect(res.errorResponse.status).toBe(502);
      expect(res.errorResponse.headers.get("Content-Type")).toBe("application/json");
      const body = await res.errorResponse.json();
      expect(body.error).toBe("misconfigured_origin");
      expect(body.message).toMatch(/LUCENT_ORIGIN environment variable is required in production/i);
    }
  });

  it("fails closed when LUCENT_ORIGIN is missing in production (NODE_ENV='production')", async () => {
    const res = resolveEdgeOrigin({
      NODE_ENV: "production",
    });
    expect("errorResponse" in res).toBe(true);
    if ("errorResponse" in res) {
      expect(res.errorResponse.status).toBe(502);
      const body = await res.errorResponse.json();
      expect(body.error).toBe("misconfigured_origin");
    }
  });

  it("fails closed when LUCENT_ORIGIN contains only whitespace in production", async () => {
    const res = resolveEdgeOrigin({
      LUCENT_ORIGIN: "    ",
      ENVIRONMENT: "production",
    });
    expect("errorResponse" in res).toBe(true);
    if ("errorResponse" in res) {
      expect(res.errorResponse.status).toBe(502);
      const body = await res.errorResponse.json();
      expect(body.error).toBe("misconfigured_origin");
    }
  });
});
