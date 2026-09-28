import { describe, expect, it } from "vitest";
import { aiTimeout, readConfig } from "../src/config.js";

/**
 * How long one model call may take (LUCENT_AI_TIMEOUT_MS). `0`, `off` or
 * `none` turn the limit off — a slow gateway's generation then runs until it
 * answers or the person cancels — and anything unreadable keeps the default.
 */
describe("LUCENT_AI_TIMEOUT_MS", () => {
  it("0, off and none mean no limit", () => {
    for (const v of ["0", "off", "OFF", " none "]) expect(aiTimeout(v), v).toBe(0);
    expect(readConfig({ LUCENT_AI_TIMEOUT_MS: "0" }).aiTimeoutMs).toBe(0);
  });

  it("a number is a limit; unset or junk keeps the 180 s default", () => {
    expect(aiTimeout("5000")).toBe(5000);
    expect(aiTimeout(undefined)).toBe(180_000);
    expect(aiTimeout("soon")).toBe(180_000);
    expect(aiTimeout("-5")).toBe(180_000);
  });
});
