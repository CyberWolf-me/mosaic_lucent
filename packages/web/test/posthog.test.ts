import { beforeEach, describe, expect, it } from "vitest";
import {
  configurePostHog,
  getSessionReplayUrl,
  identify,
  isFeatureEnabled,
  isPostHogEnabled,
  pageview,
  resetUser,
  track,
  trackAiAccepted,
  trackAiFeedback,
  trackAiGeneration,
  trackAiPrompt,
  trackAiUndone,
} from "../src/analytics/posthog.js";

describe("PostHog Web Analytics", () => {
  beforeEach(() => {
    configurePostHog({
      key: "phc_web_test_token",
      host: "https://us.i.posthog.com",
    });
    resetUser();
  });

  it("is enabled when configured", () => {
    expect(isPostHogEnabled()).toBe(true);
  });

  it("tracks custom events with sanitized properties", () => {
    const calls: Array<{ url: string; body: any }> = [];
    const mockFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(url),
        body: JSON.parse(String(init?.body)),
      });
      return new Response(JSON.stringify({ status: "Ok" }), { status: 200 });
    }) as unknown as typeof fetch;

    track(
      "board_exported",
      {
        format: "svg",
        nodeCount: 25,
        // sensitive properties that MUST be stripped:
        prompt: "secret architectural design",
        nodes: [{ id: "n1", text: "secret password" }],
      },
      mockFetch,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://us.i.posthog.com/capture/");
    expect(calls[0]!.body.api_key).toBe("phc_web_test_token");
    expect(calls[0]!.body.event).toBe("board_exported");
    expect(calls[0]!.body.properties.format).toBe("svg");
    expect(calls[0]!.body.properties.nodeCount).toBe(25);
    // Verified stripped
    expect(calls[0]!.body.properties.prompt).toBeUndefined();
    expect(calls[0]!.body.properties.nodes).toBeUndefined();
  });

  it("records pageviews", () => {
    const calls: Array<{ url: string; body: any }> = [];
    const mockFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(url),
        body: JSON.parse(String(init?.body)),
      });
      return new Response(JSON.stringify({ status: "Ok" }), { status: 200 });
    }) as unknown as typeof fetch;

    pageview("analytics", { orgId: "org_123" }, mockFetch);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.body.event).toBe("$pageview");
    expect(calls[0]!.body.properties.view).toBe("analytics");
    expect(calls[0]!.body.properties.orgId).toBe("org_123");
  });

  it("identifies users with sanitized traits", () => {
    const calls: Array<{ url: string; body: any }> = [];
    const mockFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(url),
        body: JSON.parse(String(init?.body)),
      });
      return new Response(JSON.stringify({ status: "Ok" }), { status: 200 });
    }) as unknown as typeof fetch;

    identify("user_456", { email: "user@example.com", name: "Alice" }, mockFetch);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.body.event).toBe("$identify");
    expect(calls[0]!.body.distinct_id).toBe("user_456");
    expect(calls[0]!.body.properties.$set).toEqual({
      email: "user@example.com",
      name: "Alice",
    });
  });

  it("tracks AI activation funnel steps cleanly", () => {
    // trackAiPrompt, trackAiGeneration, trackAiAccepted, trackAiUndone, trackAiFeedback
    expect(() => {
      trackAiPrompt("voice", "create");
      trackAiGeneration("success", 1200, 15);
      trackAiAccepted("gen_1");
      trackAiUndone(15, "gen_1");
      trackAiFeedback("positive", "clean layout");
    }).not.toThrow();
  });

  it("evaluates feature flags with fallback defaults", () => {
    expect(isFeatureEnabled("elk-layout", false)).toBe(false);
    expect(isFeatureEnabled("elk-layout", true)).toBe(true);
  });

  it("provides session replay url when available without throwing", () => {
    expect(() => getSessionReplayUrl()).not.toThrow();
  });

  it("handles network failure without throwing", () => {
    const failingFetch = (async () => {
      throw new Error("Network offline");
    }) as unknown as typeof fetch;

    expect(() => {
      track("canvas_pan", {}, failingFetch);
    }).not.toThrow();
  });
});
