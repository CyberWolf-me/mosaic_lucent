import ImageTracer from "imagetracerjs";

/**
 * Raster → vector, the pure half (docs/26 §6.3). Runs in a worker in the app
 * (trace.worker.ts) and directly in tests. Tracing is local on purpose: a
 * photo of a whiteboard or a client's logo never leaves the browser, so it is
 * allowed on restricted boards where a vendor API is not.
 *
 * imagetracerjs (public domain) posterizes the image into a palette and
 * traces each colour layer into paths; its SVG then goes through the same
 * sanitizing importer as any other SVG — the tracer's output is not trusted
 * either.
 */

export type TracePreset = "logo" | "illustration" | "detailed";

export interface TraceInput {
  width: number;
  height: number;
  /** RGBA bytes, row-major (ImageData.data). */
  data: Uint8ClampedArray;
}

const OPTIONS: Record<TracePreset, Record<string, number | boolean>> = {
  // Flat artwork: few colours, sharp corners, tiny specks dropped.
  logo: {
    numberofcolors: 6,
    colorquantcycles: 3,
    ltres: 1,
    qtres: 1,
    pathomit: 12,
    blurradius: 0,
    roundcoords: 1,
  },
  // Illustrations: more colours, a little smoothing.
  illustration: {
    numberofcolors: 16,
    colorquantcycles: 3,
    ltres: 1,
    qtres: 1,
    pathomit: 8,
    blurradius: 1,
    roundcoords: 1,
  },
  // Photos and texture: many colours — heavier, still capped by the schema.
  detailed: {
    numberofcolors: 32,
    colorquantcycles: 2,
    ltres: 0.5,
    qtres: 0.5,
    pathomit: 4,
    blurradius: 0,
    roundcoords: 1,
  },
};

export function traceToSvg(input: TraceInput, preset: TracePreset): string {
  return ImageTracer.imagedataToSVG(
    { width: input.width, height: input.height, data: input.data },
    {
      ...OPTIONS[preset],
      viewbox: true,
      desc: false,
      strokewidth: 1,
      linefilter: preset !== "detailed",
    },
  );
}
