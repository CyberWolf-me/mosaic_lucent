import { useEffect, useSyncExternalStore } from "react";
import { isIconRef } from "@lucent/core";

/**
 * The icon registry (docs/26 §6.2): Iconoir concept icons and Simple Icons
 * brand marks, addressed as `iconoir:<name>` / `simple:<slug>`.
 *
 * The data is generated path data (scripts/build-icons.mjs), split into hash
 * buckets that load on demand, so a board pays for the icons it shows and
 * nothing else. Rendering reads a synchronous cache: a card whose icon hasn't
 * arrived yet draws without it and re-renders when it does — an icon is never
 * worth blocking a board on.
 */

export type IconSet = "iconoir" | "simple";

/**
 * One drawable part: a bare string is a stroked path (Iconoir's common case);
 * a tuple is [mode, d] with mode "f" (fill) or "b" (fill + stroke), plus "e"
 * for an evenodd fill rule.
 */
export type IconPart = string | [string, string];

export interface IconGlyph {
  ref: string;
  set: IconSet;
  name: string;
  parts: IconPart[];
  /** Brand colour, "RRGGBB" (Simple Icons only). */
  hex?: string;
  /** Brand name as its owner writes it (Simple Icons only). */
  title?: string;
  /** The owner's logo/trademark guidelines, where published. */
  guidelines?: string;
}

/** Must match scripts/build-icons.mjs — the registry test pins it. */
export const BUCKETS: Record<IconSet, number> = { iconoir: 8, simple: 64 };

export function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

export function bucketOf(set: IconSet, name: string): number {
  return fnv1a(name) % BUCKETS[set];
}

type Bucket = Record<string, unknown>;

const BUCKET_LOADERS = import.meta.glob<Bucket>("./data/{iconoir,simple}-*.json", {
  import: "default",
});

/** Split a well-formed reference; undefined for anything else. */
export function parseIconRef(
  ref: string | undefined | null,
): { set: IconSet; name: string } | undefined {
  if (!ref || !isIconRef(ref)) return undefined;
  const i = ref.indexOf(":");
  return { set: ref.slice(0, i) as IconSet, name: ref.slice(i + 1) };
}

const buckets = new Map<string, Bucket>();
const pending = new Map<string, Promise<Bucket | undefined>>();
const listeners = new Set<() => void>();
let version = 0;

function bump(): void {
  version++;
  for (const l of listeners) l();
}

function bucketKey(set: IconSet, name: string): string {
  return `${set}-${bucketOf(set, name)}`;
}

function loadBucket(key: string): Promise<Bucket | undefined> {
  const done = buckets.get(key);
  if (done) return Promise.resolve(done);
  let p = pending.get(key);
  if (!p) {
    const loader = BUCKET_LOADERS[`./data/${key}.json`];
    p = loader
      ? loader()
          .then((b) => {
            buckets.set(key, b);
            bump();
            return b;
          })
          .catch(() => {
            // A failed chunk (offline, a deploy swapped the hashes) is not an
            // error the user can act on: the card keeps its fallback, and the
            // next request tries again.
            pending.delete(key);
            return undefined;
          })
      : Promise.resolve(undefined);
    pending.set(key, p);
  }
  return p;
}

function glyphFrom(set: IconSet, name: string, raw: unknown): IconGlyph | null {
  if (!raw) return null;
  const ref = `${set}:${name}`;
  if (set === "iconoir") return { ref, set, name, parts: raw as IconPart[] };
  const [d, hex, title, guidelines] = raw as [string, string, string, string?];
  return {
    ref,
    set,
    name,
    parts: [["f", d]],
    hex,
    title,
    ...(guidelines ? { guidelines } : {}),
  };
}

/**
 * The glyph if its bucket is loaded: a glyph, `null` for a reference the
 * registry doesn't have, or `undefined` while it's still unknown. Sync, so
 * render paths (and the SVG export) can use it directly.
 */
export function peekIcon(ref: string | undefined | null): IconGlyph | null | undefined {
  const parsed = parseIconRef(ref);
  if (!parsed) return null;
  const bucket = buckets.get(bucketKey(parsed.set, parsed.name));
  if (!bucket) return undefined;
  return glyphFrom(parsed.set, parsed.name, bucket[parsed.name]);
}

/** Load (if needed) and return a glyph, or null when the registry lacks it. */
export async function loadIcon(ref: string | undefined | null): Promise<IconGlyph | null> {
  const parsed = parseIconRef(ref);
  if (!parsed) return null;
  const bucket = await loadBucket(bucketKey(parsed.set, parsed.name));
  return bucket ? glyphFrom(parsed.set, parsed.name, bucket[parsed.name]) : null;
}

/** Warm the buckets for a set of references (export, a board's first paint). */
export async function preloadIcons(refs: Iterable<string>): Promise<void> {
  const keys = new Set<string>();
  for (const ref of refs) {
    const parsed = parseIconRef(ref);
    if (parsed) keys.add(bucketKey(parsed.set, parsed.name));
  }
  await Promise.all([...keys].map(loadBucket));
}

const getVersion = () => version;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * The glyph for a reference, re-rendering when its bucket arrives: a glyph,
 * `null` when the registry doesn't have it (or there is no reference), and
 * `undefined` while its bucket is loading — so a caller can fall back on a
 * missing icon without flashing the fallback during an ordinary load.
 */
export function useIcon(ref: string | undefined | null): IconGlyph | null | undefined {
  // Subscribing to the version (not the glyph) keeps the snapshot a primitive,
  // which is what useSyncExternalStore needs to stay referentially stable.
  useSyncExternalStore(subscribe, getVersion, getVersion);
  const glyph = peekIcon(ref);
  useEffect(() => {
    if (glyph === undefined && ref) void loadIcon(ref);
  }, [glyph, ref]);
  return glyph;
}

// ---- the index: names and brand titles, for the picker and for repair ----

export interface IconIndex {
  iconoir: { version: string; names: string[] };
  /** [slug, title, hex, aka?] */
  simple: { version: string; icons: Array<[string, string, string, string[]?]> };
}

let indexPromise: Promise<IconIndex> | null = null;

/** The full name/title index (~50 KB gzipped): loaded only by search and repair. */
export function loadIconIndex(): Promise<IconIndex> {
  indexPromise ??= import("./data/index.json").then((m) => m.default as unknown as IconIndex);
  return indexPromise;
}
