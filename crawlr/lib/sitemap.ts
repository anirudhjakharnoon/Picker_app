/**
 * Minimal sitemap.xml <loc> extraction, used only when seeding a
 * scope='site' job. Reuses cheerio (already a dependency) in XML mode
 * rather than pulling in a dedicated XML/sitemap parser package.
 */

import * as cheerio from "cheerio";
import { safeFetch } from "./ssrf";
import { normalizeUrl } from "./extract";
import { isSameRegistrableDomain } from "./domain";

const MAX_SITEMAP_URLS = 500;

function parseLocsFromXml(xml: string): string[] {
  const $ = cheerio.load(xml, { xmlMode: true });
  const locs: string[] = [];
  $("loc").each((_, el) => {
    const text = $(el).text().trim();
    if (text) locs.push(text);
  });
  return locs;
}

/**
 * Fetches every sitemap URL (from robots.txt's Sitemap: lines, falling back
 * to /sitemap.xml) and returns the deduped, same-domain, normalized page
 * URLs they list - capped at MAX_SITEMAP_URLS.
 */
export async function fetchSitemapUrls(
  targetUrl: string,
  userAgent: string,
  sitemapCandidates: string[],
): Promise<string[]> {
  const url = new URL(targetUrl);
  const candidates = sitemapCandidates.length > 0
    ? sitemapCandidates
    : [`${url.protocol}//${url.host}/sitemap.xml`];

  const seen = new Set<string>();
  const results: string[] = [];

  for (const sitemapUrl of candidates.slice(0, 5)) {
    if (results.length >= MAX_SITEMAP_URLS) break;
    try {
      const res = await safeFetch(sitemapUrl, {
        method: "GET",
        headers: { "User-Agent": userAgent },
        maxBytes: 5 * 1024 * 1024,
      });
      if (res.status < 200 || res.status >= 300) continue;
      const body = res.body.toString("utf-8");
      const locs = parseLocsFromXml(body);
      for (const loc of locs) {
        if (results.length >= MAX_SITEMAP_URLS) break;
        const normalized = normalizeUrl(loc);
        if (!normalized) continue;
        if (!isSameRegistrableDomain(normalized, targetUrl)) continue;
        if (seen.has(normalized)) continue;
        seen.add(normalized);
        results.push(normalized);
      }
    } catch {
      // A broken/unreachable sitemap just means fewer seed URLs - not fatal.
      continue;
    }
  }

  return results;
}
