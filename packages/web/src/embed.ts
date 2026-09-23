/**
 * Normalize a pasted URL into an embeddable form (docs/14 §6 media, §7).
 * Distinguishes plain images/GIFs (render as <img>) from web/video embeds
 * (render as sandboxed <iframe>). YouTube/Vimeo get converted to their embed
 * URLs; everything else embeds as-is.
 */
export interface EmbedInfo {
  /** "image" for direct image/gif files, "iframe" for pages/video. */
  mode: "image" | "iframe";
  src: string;
}

export function resolveEmbed(raw: string): EmbedInfo | null {
  const url = raw.trim();
  if (!/^https?:\/\//i.test(url)) return null;

  // Direct image/GIF files.
  if (/\.(gif|png|jpe?g|webp|svg)(\?.*)?$/i.test(url)) {
    return { mode: "image", src: url };
  }

  // YouTube -> privacy-friendly embed.
  const yt = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([\w-]{6,})/);
  if (yt) return { mode: "iframe", src: `https://www.youtube-nocookie.com/embed/${yt[1]}` };

  // Vimeo.
  const vimeo = url.match(/vimeo\.com\/(\d+)/);
  if (vimeo) return { mode: "iframe", src: `https://player.vimeo.com/video/${vimeo[1]}` };

  // Giphy page -> media gif.
  const giphy = url.match(/giphy\.com\/gifs\/(?:.*-)?(\w+)$/);
  if (giphy) return { mode: "image", src: `https://media.giphy.com/media/${giphy[1]}/giphy.gif` };

  // Generic page embed.
  return { mode: "iframe", src: url };
}

/**
 * How a stored embed renders, derived from its (already resolved) src. The
 * mode used to ride in `style.fill` as "iframe"/"image", which the schema's
 * colour check refuses, so every embed insert was silently rejected.
 */
export function embedModeOf(src: string | undefined): EmbedInfo["mode"] {
  return (src && resolveEmbed(src)?.mode) || "iframe";
}
