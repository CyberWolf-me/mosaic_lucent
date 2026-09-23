import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyOperations, createWorkspace, isIconRef } from "@lucent/core";
import { buildBoardSvg } from "../src/board/geometry.js";
import { nodeGlyphNow, nodeIconRefs } from "../src/icons/exportSvg.js";
import { allAutoIconRefs, autoIconFor, iconForLabel, normalizeLabel } from "../src/icons/auto.js";
import { brandInk } from "../src/icons/Icon.js";
import {
  BUCKETS,
  bucketOf,
  loadIcon,
  peekIcon,
  preloadIcons,
  type IconIndex,
} from "../src/icons/registry.js";
import { SUGGESTED_ICONS, searchIcons } from "../src/icons/search.js";

/**
 * docs/26 §6.2: the icon registry. The data is generated (scripts/build-icons.mjs);
 * these pin the three things the product leans on — the generator and the
 * registry agree on where an icon lives, every icon the product picks on its
 * own exists, and the label matching stays whole-word and specific-first.
 */

const DATA = join(__dirname, "../src/icons/data");

describe("icon registry data", () => {
  it("files every icon in the bucket the registry will look in", () => {
    for (const file of readdirSync(DATA).filter((f) => /^(iconoir|simple)-\d+\.json$/.test(f))) {
      const [set, n] = file.replace(".json", "").split("-") as ["iconoir" | "simple", string];
      const bucket = JSON.parse(readFileSync(join(DATA, file), "utf8")) as Record<string, unknown>;
      for (const name of Object.keys(bucket))
        expect(bucketOf(set, name), `${set}:${name}`).toBe(Number(n));
    }
    expect(BUCKETS).toEqual({ iconoir: 8, simple: 64 });
  });

  it("every name is a well-formed reference", () => {
    const index = JSON.parse(readFileSync(join(DATA, "index.json"), "utf8")) as {
      iconoir: { names: string[] };
      simple: { icons: Array<[string]> };
    };
    expect(index.iconoir.names.length).toBeGreaterThan(1000);
    expect(index.simple.icons.length).toBeGreaterThan(3000);
    for (const name of index.iconoir.names) expect(isIconRef(`iconoir:${name}`), name).toBe(true);
    for (const [slug] of index.simple.icons) expect(isIconRef(`simple:${slug}`), slug).toBe(true);
  });

  it("ships the licence notices beside the data", () => {
    const notice = readFileSync(join(DATA, "NOTICE.md"), "utf8");
    expect(notice).toMatch(/Iconoir .* — MIT/);
    expect(notice).toMatch(/Simple Icons .* — CC0-1\.0/);
    expect(notice).toMatch(/trademarks/i);
  });

  it("loads a brand mark with its colour, title and guidelines", async () => {
    expect(peekIcon("simple:postgresql")).toBeUndefined();
    const glyph = await loadIcon("simple:postgresql");
    expect(glyph).toMatchObject({ set: "simple", hex: "4169E1", title: "PostgreSQL" });
    expect(glyph?.guidelines).toMatch(/^https:\/\//);
    // Once its bucket is in, the sync path the renderer and export use sees it.
    expect(peekIcon("simple:postgresql")).toMatchObject({ title: "PostgreSQL" });
  });

  it("answers null — not a throw — for an icon it doesn't have, or no icon", async () => {
    expect(await loadIcon("simple:not-a-real-brand-xyz")).toBeNull();
    expect(await loadIcon("iconoir:no-such-icon")).toBeNull();
    expect(peekIcon(undefined)).toBeNull();
    expect(peekIcon('iconoir:x"><script>')).toBeNull();
  });

  // Loads most of the buckets, so it gets a looser clock than the default 5 s
  // when the whole suite is running in parallel.
  it("every icon the product chooses on its own exists", { timeout: 30_000 }, async () => {
    const refs = allAutoIconRefs();
    expect(refs.length).toBeGreaterThan(50);
    await preloadIcons(refs);
    expect(refs.filter((ref) => !peekIcon(ref))).toEqual([]);
  });
});

describe("automatic icons from a label", () => {
  it("names the product when the label does", () => {
    expect(iconForLabel("PostgreSQL")).toBe("simple:postgresql");
    expect(iconForLabel("Orders DB (Postgres)")).toBe("simple:postgresql");
    expect(iconForLabel("Kafka events")).toBe("simple:apachekafka");
    expect(iconForLabel("Next.js storefront")).toBe("simple:nextdotjs");
    expect(iconForLabel("Kubernetes cluster")).toBe("simple:kubernetes");
  });

  it("a brand outranks a concept, and a longer phrase a shorter one", () => {
    expect(iconForLabel("Sign in with Google")).toBe("simple:google");
    expect(iconForLabel("Stripe payments")).toBe("simple:stripe");
    expect(iconForLabel("API gateway")).toBe("iconoir:network");
    expect(iconForLabel("Payments API")).toBe("iconoir:credit-card");
  });

  it("falls back to what the node does", () => {
    expect(iconForLabel("Send receipt email")).toBe("iconoir:mail");
    expect(iconForLabel("Customer")).toBe("iconoir:user");
    expect(iconForLabel("Auth service")).toBe("iconoir:lock");
  });

  it("matches whole words only, and leaves ambiguous words alone", () => {
    expect(iconForLabel("Cardboard supplier")).toBeNull();
    expect(iconForLabel("Dbxyz")).toBeNull();
    // Shipping, not the Node framework.
    expect(iconForLabel("Express shipping")).toBe("iconoir:delivery-truck");
    expect(iconForLabel("Net revenue")).toBeNull();
    expect(iconForLabel("Review order summary")).toBe("iconoir:badge-check");
  });

  it("is case- and punctuation-insensitive", () => {
    expect(iconForLabel("REDIS")).toBe("simple:redis");
    expect(iconForLabel("redis.")).toBe("simple:redis");
    expect(normalizeLabel("CI/CD pipeline.")).toBe(" ci/cd pipeline ");
  });

  it("gives a few infrastructure types their icon when the label names nothing", () => {
    expect(autoIconFor("Orders", "database")).toBe("iconoir:database");
    expect(autoIconFor("Shopper", "actor")).toBe("iconoir:user");
    expect(autoIconFor("Checkout step", "process")).toBe("iconoir:credit-card");
    expect(autoIconFor("Step 3", "process")).toBeNull();
  });
});

describe("icon search", () => {
  const index = JSON.parse(readFileSync(join(DATA, "index.json"), "utf8")) as IconIndex;

  it("puts the exact brand first, and brands just above same-scoring concepts", () => {
    expect(searchIcons(index, "postgresql")[0]?.ref).toBe("simple:postgresql");
    expect(searchIcons(index, "Stripe")[0]?.ref).toBe("simple:stripe");
    expect(searchIcons(index, "node.js")[0]?.ref).toBe("simple:nodedotjs");
  });

  it("finds concepts by whole word and by the words of a kebab name", () => {
    expect(searchIcons(index, "database")[0]?.ref).toBe("iconoir:database");
    expect(searchIcons(index, "credit card")[0]?.ref).toBe("iconoir:credit-card");
  });

  it("answers nothing for nothing, and caps the list", () => {
    expect(searchIcons(index, "  ")).toEqual([]);
    expect(searchIcons(index, "a", 12)).toHaveLength(12);
    expect(searchIcons(index, "zzzqqq")).toEqual([]);
  });

  it("suggests only icons the registry has", async () => {
    for (const ref of SUGGESTED_ICONS) expect(await loadIcon(ref), ref).not.toBeNull();
  });
});

describe("icons in the SVG export", () => {
  const board = (icon?: string) =>
    applyOperations(createWorkspace(), [
      {
        op: "CREATE_NODE",
        id: "db",
        nodeType: "database",
        label: "Orders (Postgres)",
        ...(icon ? { icon } : {}),
      },
      { op: "MOVE_NODE", id: "db", position: { x: 100, y: 50 } },
    ]);

  it("draws the node's icon as paths, in the brand's colour", async () => {
    const ws = board();
    await preloadIcons(nodeIconRefs(Object.values(ws.nodes)));
    const svg = buildBoardSvg(ws);
    expect(svg).toContain(
      '<g transform="translate(109 58) scale(0.5833333333333334)" color="#4169E1">',
    );
    expect(svg).not.toMatch(/<script|<image|href=/);
  });

  it("a chosen icon outranks the label's, and a missing one falls back to it", async () => {
    await preloadIcons(["iconoir:server", "simple:not-a-real-brand-xyz"]);
    expect(nodeGlyphNow(board("iconoir:server").nodes.db!)?.ref).toBe("iconoir:server");
    expect(nodeGlyphNow(board("simple:not-a-real-brand-xyz").nodes.db!)?.ref).toBe(
      "simple:postgresql",
    );
  });
});

describe("brand colour on both themes", () => {
  it("keeps a mid-tone brand colour and hands near-black and near-white to the ink", () => {
    expect(brandInk("4169E1")).toBe("#4169E1");
    expect(brandInk("231F20")).toBeUndefined();
    expect(brandInk("FFFFFF")).toBeUndefined();
    expect(brandInk(undefined)).toBeUndefined();
    expect(brandInk("url(x)")).toBeUndefined();
  });
});
