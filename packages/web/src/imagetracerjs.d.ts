/** imagetracerjs ships no types; this is the one call Lucent makes (vector/traceCore.ts). */
declare module "imagetracerjs" {
  const ImageTracer: {
    imagedataToSVG(
      imageData: { width: number; height: number; data: Uint8ClampedArray },
      options?: Record<string, number | boolean | string>,
    ): string;
  };
  export default ImageTracer;
}
