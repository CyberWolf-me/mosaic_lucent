import { describe, it, expect } from "vitest";
import { resolveEmbed } from "../src/embed.js";

describe("resolveEmbed", () => {
  it("treats direct image/gif URLs as image embeds", () => {
    expect(resolveEmbed("https://media.giphy.com/media/abc/giphy.gif")).toEqual({
      mode: "image",
      src: "https://media.giphy.com/media/abc/giphy.gif",
    });
    expect(resolveEmbed("https://x.com/a.png")?.mode).toBe("image");
  });

  it("converts a YouTube watch URL to a no-cookie embed iframe", () => {
    const r = resolveEmbed("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(r).toEqual({
      mode: "iframe",
      src: "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
    });
  });

  it("converts a youtu.be short link", () => {
    expect(resolveEmbed("https://youtu.be/dQw4w9WgXcQ")?.src).toContain("/embed/dQw4w9WgXcQ");
  });

  it("converts a Vimeo URL to a player iframe", () => {
    expect(resolveEmbed("https://vimeo.com/12345")).toEqual({
      mode: "iframe",
      src: "https://player.vimeo.com/video/12345",
    });
  });

  it("embeds a generic page as an iframe", () => {
    expect(resolveEmbed("https://example.com/page")).toEqual({
      mode: "iframe",
      src: "https://example.com/page",
    });
  });

  it("rejects non-http input", () => {
    expect(resolveEmbed("not a url")).toBeNull();
    expect(resolveEmbed("ftp://x/y")).toBeNull();
  });
});
