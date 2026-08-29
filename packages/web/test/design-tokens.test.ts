import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Guards the design-system contract the audit introduced. These are the values
 * components reference by name; if a token disappears, every consumer silently
 * falls back to nothing, so drift must fail loudly here.
 */
const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, "..", "src", "styles.css"), "utf8");

describe("design tokens", () => {
  it("defines the 4px spacing scale", () => {
    for (const [name, value] of [
      ["--space-1", "4px"],
      ["--space-2", "8px"],
      ["--space-3", "12px"],
      ["--space-4", "16px"],
      ["--space-5", "24px"],
      ["--space-6", "32px"],
      ["--space-7", "48px"],
      ["--space-8", "64px"],
    ] as const) {
      expect(css).toContain(`${name}: ${value}`);
    }
  });

  it("defines the pill radius and focus ring", () => {
    expect(css).toContain("--r-pill: 999px");
    expect(css).toMatch(/--focus-ring:\s*.+var\(--amber-1\)/);
  });

  it("applies a visible keyboard focus ring globally", () => {
    expect(css).toMatch(/:focus-visible\s*\{[^}]*box-shadow:\s*var\(--focus-ring\)/);
  });

  it("does not strip the focus outline from auth inputs without replacing it", () => {
    // The old rule was `.auth-input:focus { ... outline: none; }` with no
    // focus-visible replacement, which left keyboard users with no indicator.
    expect(css).toMatch(/\.auth-input:focus-visible[^}]*box-shadow:\s*var\(--focus-ring\)/);
  });

  it("provides a screen-reader-only utility for placeholder-only inputs", () => {
    expect(css).toMatch(/\.sr-only\s*\{/);
  });

  it("honours prefers-reduced-motion", () => {
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
  });

  it("ships shared empty-state and sample-data styles", () => {
    expect(css).toMatch(/\.view-empty\s*\{/);
    expect(css).toMatch(/\.sample-banner\s*\{/);
  });
});

/**
 * The floating canvas chrome is positioned by hand, so nothing in the type
 * system stops two pieces from being parked on the same coordinates. These
 * assert the row/column budget the layout depends on:
 *
 *  - bottom-right column: status badge at bottom 20 (~28px tall), Export on its
 *    own row above it, minimap above that;
 *  - right-hand column: the rail owns x 12–56, so Templates/Timer/minimap must
 *    start beyond it.
 */
describe("canvas chrome layout budget", () => {
  const offset = (selector: string, prop: string): number => {
    const block = css.match(new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`))?.[1];
    expect(block, `${selector} rule not found`).toBeTruthy();
    const value = block!.match(new RegExp(`(?:^|[;\\s])${prop}:\\s*(-?[\\d.]+)px`))?.[1];
    expect(value, `${selector} has no ${prop}`).toBeTruthy();
    return Number(value);
  };

  const RAIL_RIGHT_EDGE = 12 + 44; // .left-rail.on-right: right 12px, width 44px
  const BADGE_HEIGHT = 28; // inline-styled chrome-badge at bottom: 20

  it("keeps Export clear of the bottom-right status badge", () => {
    expect(offset(".export-btn", "bottom")).toBeGreaterThanOrEqual(20 + BADGE_HEIGHT);
  });

  it("stacks the minimap above the Export row", () => {
    expect(offset(".minimap", "bottom")).toBeGreaterThan(offset(".export-btn", "bottom"));
  });

  it("keeps the right-hand cluster clear of the right rail", () => {
    for (const selector of [".templates-btn", ".timer-btn", ".minimap", ".export-btn"]) {
      expect(offset(selector, "right"), selector).toBeGreaterThanOrEqual(RAIL_RIGHT_EDGE);
    }
  });

  it("caps the left shape toolbar so all tools stay reachable", () => {
    // Vertically centring it pushed the 16th tool off-screen; it must be
    // top-anchored with a scroll fallback instead.
    const block = css.match(/\.shape-toolbar\.left\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(block).toMatch(/top:\s*\d+px/);
    expect(block).toMatch(/bottom:\s*\d+px/);
    expect(block).toMatch(/overflow-y:\s*auto/);
    expect(block).toContain("transform: none");
  });

  it("leaves room for the corner badges beside the AI pill", () => {
    // The pill is centred on the same row as the zoom badge (left) and the
    // status badge (right); it must subtract both, not one. Anchored to the
    // line start so the `.ai-pill-wrap.shifted .ai-pill` override can't match.
    const block = css.match(/^\.ai-pill\s*\{([^}]*)\}/m)?.[1] ?? "";
    const reserved = Number(
      block.match(/width:\s*min\([\d.]+px,\s*calc\(100vw\s*-\s*(\d+)px\)\)/)?.[1],
    );
    expect(reserved).toBeGreaterThanOrEqual(440);
  });
});
