import { describe, expect, it } from "vitest";
import { markTourSeen, tourSeen } from "../src/ui/Tour.js";

/**
 * The first-run tour's persistence contract (G1). The component itself is
 * DOM-bound (dialog, scrim, focus) and belongs to the e2e suite; what these
 * tests pin is the part that must never regress silently: the seen-flag
 * round-trip, and the two deliberately-odd behaviours documented in
 * Tour.tsx — a missing/unusable storage means *do not tour*, and a storage
 * error reads as seen.
 */

class FakeStorage implements Pick<Storage, "getItem" | "setItem"> {
  private readonly backing = new Map<string, string>();
  getItem(k: string): string | null {
    return this.backing.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.backing.set(k, v);
  }
}

class ExplodingGet {
  getItem(): string {
    throw new Error("denied");
  }
  setItem(): void {
    throw new Error("denied");
  }
}

describe("tour seen-flag", () => {
  it("a fresh browser has not seen the tour", () => {
    expect(tourSeen(new FakeStorage())).toBe(false);
  });

  it("marking it seen round-trips", () => {
    const store = new FakeStorage();
    expect(tourSeen(store)).toBe(false);
    markTourSeen(store);
    expect(tourSeen(store)).toBe(true);
  });

  it("no storage at all means do-not-tour (read as seen)", () => {
    expect(tourSeen(null)).toBe(true);
  });

  it("a storage that throws reads as seen — silent over noisy", () => {
    expect(tourSeen(new ExplodingGet())).toBe(true);
    // And marking never throws, even against a hostile store.
    expect(() => markTourSeen(new ExplodingGet() as unknown as Storage)).not.toThrow();
  });
});
