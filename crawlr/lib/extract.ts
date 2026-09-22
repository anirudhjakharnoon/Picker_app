/**
 * HTML -> structured content extraction. No AI calls anywhere in this file.
 *
 * `extractMainContent` runs a Readability-style boilerplate-stripping pass
 * (drop nav/header/footer/script/style/aside, then score the remaining
 * candidates the same way Mozilla's Readability/Arc90 algorithm does - by
 * bubbling paragraph-level text scores up to their parent/grandparent and
 * penalizing link-dense containers - then picks the best-scoring node) and
 * converts the winning subtree to Markdown with turndown.
 */

import * as cheerio from "cheerio";
import type { AnyNode, Element } from "domhandler";
import TurndownService from "turndown";
import { registrableDomain } from "./domain";

export interface ExtractedContent {
  title: string;
  markdown: string;
  wordCount: number;
}

export type VideoEmbedProvider = "youtube" | "vimeo" | "loom";

export interface VideoEmbed {
  provider: VideoEmbedProvider;
  url: string;
}

export interface ExtractedAssets {
  images: string[];
  videos: string[];
  videoEmbeds: VideoEmbed[];
}

// ---------------------------------------------------------------------------
// Boilerplate stripping
// ---------------------------------------------------------------------------

const BOILERPLATE_TAGS = [
  "script",
  "style",
  "noscript",
  "template",
  "nav",
  "header",
  "footer",
  "aside",
  "form",
  "iframe",
  "svg",
  "button",
  "select",
  "textarea",
  "object",
  "embed",
  "link",
  "meta",
  "canvas",
  "figure > figcaption",
];

const UNLIKELY_CANDIDATE_PATTERN =
  /(^|[-_ ])(ad|ads|advert|banner|breadcrumbs?|combx|comment|community|cookie|disqus|extra|foot|footer|header|masthead|menu|modal|nav|newsletter|pager|pagination|popup|promo|related|share|shoutbox|sidebar|skyscraper|social|sponsor|subscribe|tags|toolbar|widget)([-_ ]|$)/i;

const LIKELY_CANDIDATE_PATTERN = /(article|body|content|entry|hentry|main|page|post|text|blog|story)/i;

function stripBoilerplate($: cheerio.CheerioAPI): void {
  $(BOILERPLATE_TAGS.join(",")).remove();
  $("[hidden]").remove();
  $("[aria-hidden='true']").remove();

  $("*").each((_, el) => {
    const $el = $(el);
    const identity = `${$el.attr("class") ?? ""} ${$el.attr("id") ?? ""}`.trim();
    if (!identity) return;
    if (UNLIKELY_CANDIDATE_PATTERN.test(identity) && !LIKELY_CANDIDATE_PATTERN.test(identity)) {
      $el.remove();
    }
  });
}

// ---------------------------------------------------------------------------
// Readability-style scoring
// ---------------------------------------------------------------------------

function baseTagScore(tagName: string): number {
  switch (tagName) {
    case "div":
    case "article":
    case "section":
    case "main":
      return 5;
    case "pre":
    case "td":
    case "blockquote":
      return 3;
    case "address":
    case "ol":
    case "ul":
    case "dl":
    case "dd":
    case "dt":
    case "li":
      return -3;
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6":
    case "th":
      return -5;
    default:
      return 0;
  }
}

function textOf($: cheerio.CheerioAPI, el: AnyNode): string {
  return $(el).text().replace(/\s+/g, " ").trim();
}

function linkDensity($: cheerio.CheerioAPI, el: AnyNode): number {
  const text = textOf($, el);
  if (text.length === 0) return 0;
  let linkLen = 0;
  $(el)
    .find("a")
    .each((_, a) => {
      linkLen += textOf($, a).length;
    });
  return Math.min(1, linkLen / text.length);
}

/**
 * Scores every element by bubbling paragraph-level content scores up to
 * parent + grandparent (Arc90/Readability algorithm), then picks the
 * highest-scoring node after penalizing link-dense containers.
 */
function findMainContentRoot($: cheerio.CheerioAPI): cheerio.Cheerio<AnyNode> {
  const scores = new Map<AnyNode, number>();

  const ensure = (node: AnyNode): number => {
    const existing = scores.get(node);
    if (existing !== undefined) return existing;
    const tagName = (node as Element).tagName?.toLowerCase() ?? "";
    const initial = baseTagScore(tagName);
    scores.set(node, initial);
    return initial;
  };

  $("p, pre, td, blockquote, li").each((_, el) => {
    const text = textOf($, el);
    if (text.length < 25) return;

    let contentScore = 1;
    contentScore += (text.match(/,/g) ?? []).length;
    contentScore += Math.min(Math.floor(text.length / 100), 3);

    const parent = $(el).parent().get(0);
    const grandparent = $(el).parent().parent().get(0);

    if (parent) scores.set(parent, ensure(parent) + contentScore);
    if (grandparent) scores.set(grandparent, ensure(grandparent) + contentScore / 2);
  });

  let bestNode: AnyNode | null = null;
  let bestScore = 0;

  for (const [node, rawScore] of scores.entries()) {
    const finalScore = rawScore * (1 - linkDensity($, node));
    if (finalScore > bestScore) {
      bestScore = finalScore;
      bestNode = node;
    }
  }

  // Prefer a semantic <article>/<main> ancestor of the winning node if one
  // exists close by - it's almost always the more correct boundary.
  if (bestNode) {
    const semanticAncestor = $(bestNode).closest("article, main, [role='main']");
    if (semanticAncestor.length > 0) {
      return semanticAncestor.first();
    }
    return $(bestNode);
  }

  const article = $("article").first();
  if (article.length > 0) return article;
  const main = $("main, [role='main']").first();
  if (main.length > 0) return main;
  return $("body");
}

function extractTitle($: cheerio.CheerioAPI): string {
  const ogTitle = $('meta[property="og:title"]').attr("content");
  if (ogTitle && ogTitle.trim()) return ogTitle.trim();
  const titleTag = $("title").first().text().trim();
  if (titleTag) return titleTag;
  const h1 = $("h1").first().text().trim();
  if (h1) return h1;
  return "";
}

let turndownService: TurndownService | null = null;
function getTurndownService(): TurndownService {
  if (!turndownService) {
    turndownService = new TurndownService({
      headingStyle: "atx",
      codeBlockStyle: "fenced",
      bulletListMarker: "-",
    });
  }
  return turndownService;
}

export function extractMainContent(html: string, _url: string): ExtractedContent {
  const $ = cheerio.load(html);
  const title = extractTitle($);
  stripBoilerplate($);

  const root = findMainContentRoot($);
  const rootHtml = root.html() ?? "";

  const markdown = getTurndownService()
    .turndown(rootHtml)
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const wordCount = markdown.length === 0 ? 0 : markdown.split(/\s+/).filter(Boolean).length;

  return { title, markdown, wordCount };
}

// ---------------------------------------------------------------------------
// Asset extraction
// ---------------------------------------------------------------------------

const EMBED_PATTERNS: Array<{ provider: VideoEmbedProvider; pattern: RegExp }> = [
  { provider: "youtube", pattern: /(?:youtube(?:-nocookie)?\.com|youtu\.be)/i },
  { provider: "vimeo", pattern: /player\.vimeo\.com|vimeo\.com/i },
  { provider: "loom", pattern: /loom\.com/i },
];

function resolveUrl(maybeRelative: string, baseUrl: string): string | null {
  try {
    return new URL(maybeRelative, baseUrl).toString();
  } catch {
    return null;
  }
}

function parseSrcset(srcset: string, baseUrl: string): string[] {
  return srcset
    .split(",")
    .map((entry) => entry.trim().split(/\s+/)[0])
    .filter((u): u is string => Boolean(u))
    .map((u) => resolveUrl(u, baseUrl))
    .filter((u): u is string => u !== null);
}

export function extractAssets(html: string, url: string): ExtractedAssets {
  const $ = cheerio.load(html);
  const images = new Set<string>();
  const videos = new Set<string>();
  const videoEmbeds: VideoEmbed[] = [];
  const seenEmbeds = new Set<string>();

  $("img").each((_, el) => {
    const $el = $(el);
    const src = $el.attr("src");
    if (src) {
      const abs = resolveUrl(src, url);
      if (abs) images.add(abs);
    }
    const srcset = $el.attr("srcset");
    if (srcset) {
      for (const abs of parseSrcset(srcset, url)) images.add(abs);
    }
  });

  $('meta[property="og:image"], meta[name="og:image"]').each((_, el) => {
    const content = $(el).attr("content");
    if (content) {
      const abs = resolveUrl(content, url);
      if (abs) images.add(abs);
    }
  });

  $("video").each((_, el) => {
    const $el = $(el);
    const directSrc = $el.attr("src");
    if (directSrc) {
      const abs = resolveUrl(directSrc, url);
      if (abs) videos.add(abs);
    }
    $el.find("source").each((_, sourceEl) => {
      const src = $(sourceEl).attr("src");
      if (src) {
        const abs = resolveUrl(src, url);
        if (abs) videos.add(abs);
      }
    });
  });

  $("iframe").each((_, el) => {
    const src = $(el).attr("src");
    if (!src) return;
    const abs = resolveUrl(src, url);
    if (!abs) return;
    for (const { provider, pattern } of EMBED_PATTERNS) {
      if (pattern.test(abs) && !seenEmbeds.has(abs)) {
        seenEmbeds.add(abs);
        videoEmbeds.push({ provider, url: abs });
        break;
      }
    }
  });

  return {
    images: Array.from(images),
    videos: Array.from(videos),
    videoEmbeds,
  };
}

// ---------------------------------------------------------------------------
// Link extraction
// ---------------------------------------------------------------------------

const TRACKING_PARAM_PATTERN = /^(utm_[a-z_]+|gclid|fbclid|msclkid|mc_[a-z]+|igshid|_ga|yclid|vero_id|mkt_tok|ref|ref_src|icid|cmpid)$/i;

function normalizeLink(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  url.hash = "";

  const keptParams: Array<[string, string]> = [];
  for (const [key, value] of url.searchParams.entries()) {
    if (!TRACKING_PARAM_PATTERN.test(key)) {
      keptParams.push([key, value]);
    }
  }
  keptParams.sort(([a], [b]) => a.localeCompare(b));
  url.search = "";
  for (const [key, value] of keptParams) {
    url.searchParams.append(key, value);
  }

  if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.slice(0, -1);
  }

  return url.toString();
}

/**
 * Absolute, same-registrable-domain, normalized, deduped links found in
 * `html`, resolved relative to `baseUrl`.
 */
export function extractLinks(html: string, baseUrl: string): string[] {
  const $ = cheerio.load(html);
  const baseDomain = registrableDomain(baseUrl);
  const seen = new Set<string>();
  const results: string[] = [];

  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    const abs = resolveUrl(href, baseUrl);
    if (!abs) return;
    const normalized = normalizeLink(abs);
    if (!normalized) return;
    const linkDomain = registrableDomain(normalized);
    if (linkDomain === null || linkDomain !== baseDomain) return;
    if (seen.has(normalized)) return;
    seen.add(normalized);
    results.push(normalized);
  });

  return results;
}
