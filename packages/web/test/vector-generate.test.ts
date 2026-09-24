import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IconIndex } from "../src/icons/registry.js";
import { brandInPrompt, generateVectors } from "../src/vector/generate.js";

/**
 * docs/26 §6.3 V3, client half: what the Generate tab sends and how it reads
 * every answer, and the brand guard — another company's logo is placed from
 * the library, never generated (Recraft's developer terms forbid it).
 */

const index = JSON.parse(
  readFileSync(join(__dirname, "../src/icons/data/index.json"), "utf8"),
) as IconIndex;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("brandInPrompt", () => {
  it("catches a request for another company's logo or icon", () => {
    expect(brandInPrompt("a Stripe logo but green", index)).toMatchObject({ slug: "stripe" });
    expect(brandInPrompt("PostgreSQL elephant icon", index)).toMatchObject({ slug: "postgresql" });
    expect(brandInPrompt("the GitHub Actions mark", index)).toMatchObject({
      slug: "githubactions",
    });
  });

  it("leaves ordinary prompts, and brand words used as words, alone", () => {
    expect(brandInPrompt("a friendly robot mascot", index)).toBeNull();
    expect(brandInPrompt("an icon for a checkout flow", index)).toBeNull();
    // A brand name without asking for a logo is a subject, not a mark.
    expect(brandInPrompt("a notion of speed, abstract", index)).toBeNull();
    // Our own product's mark is fine to design.
    expect(brandInPrompt("a logo for Lucent, a visual workspace", index)).toBeNull();
  });
});

describe("generateVectors", () => {
  const ok = {
    variations: [
      { vector: { viewBox: [0, 0, 24, 24], paths: [{ d: "M0 0L24 24" }] }, width: 24, height: 24 },
    ],
    provider: "recraft",
  };

  it("posts the prompt, style, count and board, and returns the variations", async () => {
    const fetchSpy = vi.fn(async (url: string) =>
      url === "/api/auth/csrf" ? Response.json({ token: "t" }) : Response.json(ok),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const r = await generateVectors({ prompt: "a rocket", style: "icon", n: 3, boardId: "brd_1" });
    expect(r).toEqual({ ok: true, variations: ok.variations, provider: "recraft" });
    const call = fetchSpy.mock.calls.find((c) => c[0] === "/api/vector") as unknown as [
      string,
      RequestInit,
    ];
    expect(JSON.parse(String(call[1].body))).toEqual({
      prompt: "a rocket",
      style: "icon",
      n: 3,
      boardId: "brd_1",
    });
  });

  it("turns every failure into a sentence a person can act on", async () => {
    const answer = (status: number, body: unknown) =>
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json(body, { status })),
      );
    answer(503, { error: "x" });
    expect(await generateVectors({ prompt: "a", style: "icon", n: 1, boardId: null })).toEqual({
      ok: false,
      error: "Vector generation isn't set up on this workspace.",
    });
    answer(403, { error: "restricted boards can't send content to AI providers" });
    expect(await generateVectors({ prompt: "a", style: "icon", n: 1, boardId: "b" })).toMatchObject(
      {
        error: "restricted boards can't send content to AI providers",
      },
    );
    answer(502, { error: "vector provider failed", detail: "Recraft 402: Insufficient credits" });
    expect(
      await generateVectors({ prompt: "a", style: "icon", n: 1, boardId: null }),
    ).toMatchObject({
      error: "The generation allowance is used up.",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("offline");
      }),
    );
    expect(
      await generateVectors({ prompt: "a", style: "icon", n: 1, boardId: null }),
    ).toMatchObject({
      ok: false,
      error: expect.stringMatching(/Couldn't reach Lucent/),
    });
  });
});
