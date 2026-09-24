import { describe, expect, it, vi } from "vitest";
import { MockVectorProvider, RecraftVectorProvider, briefFor } from "../src/vector.js";

/**
 * docs/26 §6.3 V3: the Recraft transport. No network — a stub fetch pins the
 * request we send and how the answer is read. The SVG it returns is untrusted
 * by design; sanitizing is the server's job (server/test/vector-route.test.ts).
 */

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><path d="M0 0h8v8z"/></svg>';
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

describe("RecraftVectorProvider", () => {
  it("asks for vector output, inline, with the style in the prompt", async () => {
    const fetchSpy = vi.fn(async () =>
      Response.json({ data: [{ b64_json: b64(SVG) }, { b64_json: b64(SVG) }], credits: 160 }),
    );
    const p = new RecraftVectorProvider({
      apiKey: "rk_test",
      fetch: fetchSpy as unknown as typeof fetch,
    });
    const r = await p.generateVectors({ prompt: "a rocket", style: "icon", n: 2 });
    expect(r).toEqual({ svgs: [SVG, SVG], credits: 160 });
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://external.api.recraft.ai/v1/images/generations");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer rk_test");
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({
      model: "recraftv4_1_vector",
      n: 2,
      size: "1:1",
      response_format: "b64_json",
    });
    expect(body.prompt).toMatch(/^A simple flat vector icon of a rocket\./);
  });

  it("caps variations at 4 and honours a model override", async () => {
    const fetchSpy = vi.fn(async () => Response.json({ data: [] }));
    const p = new RecraftVectorProvider({
      apiKey: "k",
      model: "recraftv2_vector",
      fetch: fetchSpy as unknown as typeof fetch,
    });
    await p.generateVectors({ prompt: "x", style: "line", n: 9 });
    const body = JSON.parse(
      String((fetchSpy.mock.calls[0] as unknown as [string, RequestInit])[1].body),
    );
    expect(body).toMatchObject({ n: 4, model: "recraftv2_vector", size: "4:3" });
  });

  it("falls back to the documented URL form", async () => {
    const fetchSpy = vi.fn(async (url: string) =>
      url.endsWith("/images/generations")
        ? Response.json({ data: [{ url: "https://img.recraft.ai/signed/abc" }] })
        : new Response(SVG),
    );
    const p = new RecraftVectorProvider({
      apiKey: "k",
      fetch: fetchSpy as unknown as typeof fetch,
    });
    expect((await p.generateVectors({ prompt: "x", style: "icon", n: 1 })).svgs).toEqual([SVG]);
  });

  it("surfaces a vendor error with its status, and never the key", async () => {
    const fetchSpy = vi.fn(async () =>
      Response.json(
        { code: "not_enough_credits", message: "Insufficient credits" },
        { status: 402 },
      ),
    );
    const p = new RecraftVectorProvider({
      apiKey: "rk_secret_value",
      fetch: fetchSpy as unknown as typeof fetch,
    });
    const err = await p
      .generateVectors({ prompt: "x", style: "icon", n: 1 })
      .catch((e: Error) => e);
    expect(String(err)).toMatch(/Recraft 402: Insufficient credits/);
    expect(String(err)).not.toContain("rk_secret_value");
  });

  it("reads the balance, and answers null when it can't", async () => {
    const ok = new RecraftVectorProvider({
      apiKey: "k",
      fetch: (async () => Response.json({ credits: 920 })) as unknown as typeof fetch,
    });
    expect(await ok.balance()).toBe(920);
    const bad = new RecraftVectorProvider({
      apiKey: "k",
      fetch: (async () => new Response("", { status: 401 })) as unknown as typeof fetch,
    });
    expect(await bad.balance()).toBeNull();
  });
});

describe("MockVectorProvider and the style briefs", () => {
  it("is deterministic per prompt and returns the variations asked for", async () => {
    const m = new MockVectorProvider();
    const a = await m.generateVectors({ prompt: "rocket", style: "icon", n: 3 });
    const b = await m.generateVectors({ prompt: "rocket", style: "icon", n: 3 });
    expect(a.svgs).toHaveLength(3);
    expect(a).toEqual(b);
  });

  it("every style has a brief and an aspect Recraft's vector models accept", () => {
    for (const style of ["icon", "illustration", "logo", "line"] as const) {
      const brief = briefFor({ prompt: "  a tree ", style, n: 1 });
      expect(brief.prompt).toContain(" a tree.");
      expect(["1:1", "4:3"]).toContain(brief.size);
    }
  });
});
