/**
 * A brand's own colour when it reads on both the paper and the dark theme;
 * otherwise undefined, and the mark takes the surrounding ink. Near-black
 * (Kafka, GitHub) and near-white marks would vanish on one theme or the other.
 */
export function brandInk(hex: string | undefined): string | undefined {
  if (!hex || !/^[0-9a-f]{6}$/i.test(hex)) return undefined;
  const lin = (i: number) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * lin(0) + 0.7152 * lin(2) + 0.0722 * lin(4);
  return luminance < 0.06 || luminance > 0.72 ? undefined : `#${hex}`;
}
