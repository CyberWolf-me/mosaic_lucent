import * as z from "zod/v4";

/**
 * Reusable schema primitives for the operation union (M0.5).
 *
 * Model-supplied strings reach SVG/iframe/document.write sinks. Without a contract
 * on what "valid" looks like, a malicious or buggy model could inject markup
 * into the page or break the renderer. Each primitive encodes one rule:
 *
 *  - svgPathData: the SVG path grammar (M/L/C/Q/A/Z/H/V/S/T + commas, spaces
 *    and decimals), with a length cap so an attacker can't craft a path that
 *    blows up the layout pass.
 *  - cssColor: a colour literal — hex, rgb(), hsl(), oklch() or oklab(), with
 *    numeric channels only. Named colours, var() and relative colour syntax are
 *    refused: plain words are an obvious sink for hostile markup, and a var()
 *    resolves only inside the app's stylesheet, so it breaks in an export and
 *    renders differently under every theme.
 *  - httpUrl: an absolute http(s) URL. The paste path in embed.ts already
 *    enforced this; the op path bypassed it, which is what M0.5 closes.
 *
 * Length caps are deliberately loose (kilobytes, not tens of bytes) so a real
 * label or a long URL passes. The point is to refuse hostile values, not to
 * restrict legitimate authoring.
 */

/** SVG path grammar: a handful of commands + digits, plus separators. */
const SVG_PATH_GRAMMAR = /^[MmLlHhVvCcSsQqTtAaZz][MmLlHhVvCcSsQqTtAaZz0-9.,\-\s]*$/;
/** 4 KB is enough for any reasonable freeform shape; longer values are noise. */
export const SVG_PATH_MAX_LENGTH = 4_000;

/**
 * CSS color literals: #rgb / #rrggbb / rgb[a]() / hsl[a]() / oklch() / oklab().
 *
 * The function bodies admit digits, separators, `%`, a sign and the `deg` unit —
 * nothing that can name something else. oklch/oklab are here because the
 * product's own palette is written in them: the sticky and inspector colours
 * were oklch literals, so the schema refused every sticky the canvas created,
 * and a saved board holding one failed to load (docs/26 F7).
 */
const CSS_COLOR =
  /^(#[0-9a-fA-F]{3,8}|(?:rgba?|hsla?|oklch|oklab)\((?:[0-9.,\s%/+-]|deg)+\))$/;

/** http(s) absolute URL — the only URLs we ever render. */
const HTTP_URL = /^https?:\/\/[^\s<>"']+$/i;

/** Empty string is allowed for "clear the field" semantics; the caller decides. */
const OPTIONAL_NONEMPTY = (s: string) => s.length > 0;

export const svgPathData = z
  .string()
  .max(SVG_PATH_MAX_LENGTH, "path exceeds the maximum length")
  .refine((s) => SVG_PATH_GRAMMAR.test(s.trim()), "path is not valid SVG path data");

export const cssColor = z
  .string()
  .max(64, "color string exceeds the maximum length")
  .refine((s) => OPTIONAL_NONEMPTY(s) && CSS_COLOR.test(s), "value is not a CSS color literal");

export const httpUrl = z
  .string()
  .max(2_000, "url exceeds the maximum length")
  .refine((s) => HTTP_URL.test(s), "value is not an http(s) URL");

/**
 * Optional variants. Declared once here rather than calling `.optional()` at
 * each use site so the three sink-bearing fields (`path`, `src`, and the
 * colour trio) always carry the same contract.
 */
export const optionalSvgPathData = svgPathData.optional();
export const optionalCssColor = cssColor.optional();
export const optionalHttpUrl = httpUrl.optional();
/**
 * Image sources (M0.5 follow-up).
 *
 * Pasted, dropped and AI-generated images live in the workspace as data URLs
 * until M3 moves them to object storage: `downscaleImage` in the web package
 * emits `data:image/jpeg;base64,...`, and the image route returns
 * `data:image/png;base64,...`. `httpUrl` alone therefore rejected every real
 * board with an image on it - `parseWorkspaceOrDefault` then substituted an
 * empty workspace, so a reload silently lost the board.
 *
 * The grammar is deliberately narrow: a known raster (or base64 SVG) media
 * type followed by strict base64. No spaces, quotes or angle brackets can
 * appear in a value that passes, so the SVG/`srcdoc` sinks cannot be broken
 * out of even before per-sink escaping. Percent-encoded (`;utf8,`) data URLs
 * are refused for the same reason - hostile markup survives that encoding.
 *
 * Only `kind: "image"` shapes may carry a data URL; `embed` reaches an iframe
 * src, which stays http(s)-only. That rule lives with the shape schema, which
 * is where `kind` is in scope.
 */
const IMAGE_DATA_URL =
  /^data:image\/(png|jpeg|jpg|gif|webp|avif|svg\+xml);base64,[A-Za-z0-9+/]+={0,2}$/;

/**
 * 4 MB of base64 (~3 MB decoded) per image. `downscaleImage` targets 1.5 MB,
 * so this leaves headroom for an image that predates the downscaler while
 * staying under the 8 MiB workspace body limit for a handful of them.
 */
export const IMAGE_DATA_URL_MAX_LENGTH = 4_000_000;

export const imageDataUrl = z
  .string()
  .max(IMAGE_DATA_URL_MAX_LENGTH, "image data URL exceeds the maximum length")
  .refine((s) => IMAGE_DATA_URL.test(s), "value is not a base64 image data URL");

/**
 * Asset references (M3).
 *
 * An image whose bytes live in object storage travels as `asset:ast_...` in the
 * same `src` field a data URL used, rather than as a new field on the shape.
 * That choice is what makes the change free everywhere else: the reducer, the
 * DELETE_SHAPE inverse and the stored-workspace schema all copy `src` through
 * verbatim, so a reference survives undo, replay and a round trip through the op
 * log without a line changing in any of them. A parallel `assetId` field would
 * have had to be threaded through each of those copies by hand, and the one that
 * got missed would drop the reference silently -- an image that vanishes on undo.
 *
 * A reference is deliberately not a fetchable URL. The bytes are served by a
 * route that checks board access, so the client resolves the id against that
 * route; a URL in the graph would instead leak the storage layout and outlive
 * any signature baked into it.
 */
export const ASSET_ID_PREFIX = "ast_";
export const ASSET_REF_SCHEME = "asset:";

/**
 * Ids are minted server-side (`newAssetId`) from a base36 clock plus hex
 * randomness, so lowercase alphanumerics are the entire alphabet. The pattern is
 * built from the two constants so they cannot drift apart; both are literal
 * `[a-z:_]` and carry no regex metacharacter into it.
 */
const ASSET_REF = new RegExp(`^${ASSET_REF_SCHEME}${ASSET_ID_PREFIX}[a-z0-9]{6,64}$`);

export const assetRef = z
  .string()
  .refine((s) => ASSET_REF.test(s), "value is not an asset reference");

/** True for a well-formed `asset:` reference. */
export function isAssetRef(value: string): boolean {
  return ASSET_REF.test(value);
}

/** The bare asset id inside a reference, or undefined when it is not one. */
export function assetRefId(value: string): string | undefined {
  return ASSET_REF.test(value) ? value.slice(ASSET_REF_SCHEME.length) : undefined;
}

/**
 * The reference for an asset id. Throws on an id that would not parse back:
 * a malformed reference written into a workspace is a broken image on every
 * client from then on, while a throw surfaces at the one call site that made it.
 */
export function formatAssetRef(id: string): string {
  const ref = ASSET_REF_SCHEME + id;
  if (!ASSET_REF.test(ref)) throw new Error(`not a valid asset id: ${id}`);
  return ref;
}

/**
 * An image shape's `src`: an asset reference, an http(s) URL, or an inline
 * base64 image. Boards written from M3 on carry the first; the other two stay in
 * the union because every board written before it still has to parse.
 */
export const imageSrc = z.union([httpUrl, assetRef, imageDataUrl], {
  error: "value is not an asset reference, an http(s) URL or a base64 image data URL",
});

export const optionalImageSrc = imageSrc.optional();

/** True for values the narrow data-URL grammar above accepts. */
export function isImageDataUrl(value: string): boolean {
  return value.length <= IMAGE_DATA_URL_MAX_LENGTH && IMAGE_DATA_URL.test(value);
}
