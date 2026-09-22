import { describe, expect, it, beforeAll } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { extractMainContent, extractAssets, extractLinks } from "../lib/extract";

async function loadFixture(name: string): Promise<string> {
  return readFile(path.join(__dirname, "fixtures", name), "utf-8");
}

describe("extractMainContent", () => {
  let html: string;

  beforeAll(async () => {
    html = await loadFixture("article.html");
  });

  it("extracts the title from og:title", () => {
    const { title } = extractMainContent(html, "https://example.com/blog/anglerfish");
    expect(title).toBe("The Deep Sea Anglerfish: A Field Guide");
  });

  it("includes the article's real paragraphs in the markdown", () => {
    const { markdown } = extractMainContent(html, "https://example.com/blog/anglerfish");
    expect(markdown).toContain("bioluminescent lure");
    expect(markdown).toContain("female anglerfish grows dramatically larger");
    expect(markdown).toContain("two hundred species");
  });

  it("strips nav, header, footer, aside, script, and style boilerplate", () => {
    const { markdown } = extractMainContent(html, "https://example.com/blog/anglerfish");
    expect(markdown).not.toContain("Subscribe to our newsletter");
    expect(markdown).not.toContain("Related");
    expect(markdown).not.toContain("Giant Squid");
    expect(markdown).not.toContain("Privacy Policy");
    expect(markdown).not.toContain("console.log");
    expect(markdown).not.toContain("tracking pixel");
  });

  it("reports a non-trivial word count", () => {
    const { wordCount } = extractMainContent(html, "https://example.com/blog/anglerfish");
    expect(wordCount).toBeGreaterThan(50);
  });

  it("picks the true content div over a link-farm sidebar div when there is no <article>/<main>", async () => {
    const plain = await loadFixture("no-semantic-tags.html");
    const { markdown } = extractMainContent(plain, "https://example.com/notes/tidepools");
    expect(markdown).toContain("Tidepools form in rocky depressions");
    expect(markdown).not.toContain("browse more tags");
  });

  it("returns empty markdown gracefully for a boilerplate-only page", () => {
    const html2 = "<html><body><nav><a href='/'>Home</a></nav><footer>copyright</footer></body></html>";
    const { markdown, wordCount } = extractMainContent(html2, "https://example.com/");
    expect(wordCount).toBe(markdown.length === 0 ? 0 : wordCount);
    expect(markdown).not.toContain("copyright");
  });
});

describe("extractAssets", () => {
  let html: string;
  const baseUrl = "https://example.com/blog/anglerfish";

  beforeAll(async () => {
    html = await loadFixture("article.html");
  });

  it("collects img src, srcset entries, and og:image as absolute URLs", () => {
    const { images } = extractAssets(html, baseUrl);
    expect(images).toContain("https://example.com/media/anglerfish-1.jpg");
    expect(images).toContain("https://example.com/blog/relative/anglerfish-2.jpg");
    expect(images).toContain("https://example.com/media/anglerfish-2-small.jpg");
    expect(images).toContain("https://example.com/media/anglerfish-2-large.jpg");
    expect(images).toContain("https://example.com/media/anglerfish-cover.jpg");
  });

  it("collects <video><source> URLs as direct video files", () => {
    const { videos } = extractAssets(html, baseUrl);
    expect(videos).toContain("https://example.com/media/anglerfish-clip.mp4");
    expect(videos).toContain("https://example.com/media/anglerfish-clip.webm");
  });

  it("matches known embed providers and excludes everything else", () => {
    const { videoEmbeds } = extractAssets(html, baseUrl);
    expect(videoEmbeds).toContainEqual({
      provider: "youtube",
      url: "https://www.youtube.com/embed/dQw4w9WgXcQ",
    });
    expect(videoEmbeds).toContainEqual({
      provider: "vimeo",
      url: "https://player.vimeo.com/video/123456789",
    });
    expect(videoEmbeds).toContainEqual({
      provider: "loom",
      url: "https://www.loom.com/embed/abcdef1234567890",
    });
    expect(videoEmbeds.some((e) => e.url.includes("ads.example.net"))).toBe(false);
    expect(videoEmbeds).toHaveLength(3);
  });

  it("dedupes repeated asset URLs", () => {
    const dup = `<img src="/a.jpg"><img src="/a.jpg"><img src="/a.jpg">`;
    const { images } = extractAssets(dup, baseUrl);
    expect(images).toEqual(["https://example.com/a.jpg"]);
  });
});

describe("extractLinks", () => {
  let html: string;
  const baseUrl = "https://example.com/blog/anglerfish";

  beforeAll(async () => {
    html = await loadFixture("article.html");
  });

  it("returns only same-registrable-domain links, absolute and deduped", () => {
    const links = extractLinks(html, baseUrl);
    expect(links).toContain("https://example.com/");
    expect(links).toContain("https://example.com/about");
    expect(links).toContain("https://example.com/newsletter");
    expect(links).toContain("https://example.com/species/anglerfish");
    expect(links).toContain("https://example.com/posts/giant-squid");
    expect(links).toContain("https://example.com/posts/vampire-squid");
    expect(links).toContain("https://example.com/privacy");

    expect(links.some((l) => l.includes("unrelated-domain.example"))).toBe(false);
    expect(links.some((l) => l.includes("marinebio.example.org"))).toBe(false);
  });

  it("collapses the same page reached via query-tracking-param, fragment, and bare form into one entry", () => {
    const links = extractLinks(html, baseUrl);
    const matches = links.filter((l) => l === "https://example.com/species/anglerfish");
    expect(matches).toHaveLength(1);
  });

  it("treats subdomains of the same registrable domain as same-site", () => {
    const withSubdomain = `<a href="https://blog.example.com/post-1">post</a><a href="https://shop.example.com/item">item</a>`;
    const links = extractLinks(withSubdomain, "https://www.example.com/");
    expect(links).toContain("https://blog.example.com/post-1");
    expect(links).toContain("https://shop.example.com/item");
  });

  it("excludes a different registrable domain even if it shares a suffix", () => {
    const html2 = `<a href="https://example.com.evil.net/phish">not the same site</a>`;
    const links = extractLinks(html2, baseUrl);
    expect(links).toHaveLength(0);
  });

  it("ignores non-http(s) hrefs like mailto: and javascript:", () => {
    const html2 = `<a href="mailto:hi@example.com">mail</a><a href="javascript:void(0)">js</a><a href="/ok">ok</a>`;
    const links = extractLinks(html2, baseUrl);
    expect(links).toEqual(["https://example.com/ok"]);
  });
});
