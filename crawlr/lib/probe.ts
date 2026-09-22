/**
 * The pre-run "probe": a read-only reconnaissance pass used by the UI's
 * TARGET panel before the user commits to a crawl. Never creates a job or
 * writes queue/page/asset rows - it only reports reachability, robots
 * status, same-origin link count, and (for scope='site') whether a
 * sitemap.xml exists.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { safeFetch, SsrfError } from "./ssrf";
import { extractLinks } from "./extract";
import { getRobotsRules } from "./robots";
import type { CrawlScope, Database } from "./types";

export interface ProbeResult {
  ok: boolean;
  targetUrl: string;
  reachable: boolean;
  httpStatus: number | null;
  finalUrl: string | null;
  sameOriginLinkCount: number;
  robots: {
    checked: boolean;
    allowedAtRoot: boolean;
    sitemapCount: number;
  };
  sitemap: {
    checked: boolean;
    found: boolean;
  };
  error: string | null;
}

function errorMessageFor(err: unknown): string {
  if (err instanceof SsrfError) {
    switch (err.code) {
      case "invalid_scheme":
        return "Only http:// and https:// URLs are supported.";
      case "invalid_port":
        return "That port isn't allowed for crawling.";
      case "unsafe_ip":
        return "That address resolves to a private or reserved IP range and cannot be crawled.";
      case "dns_resolution_failed":
        return "That domain doesn't resolve to any address.";
      case "too_many_redirects":
        return "Too many redirects were encountered while probing that URL.";
      case "timeout":
        return "The request timed out while probing that URL.";
      case "response_too_large":
        return "The page's response was too large to probe.";
      default:
        return "That URL could not be probed safely.";
    }
  }
  if (err instanceof Error) return err.message;
  return "Unknown error while probing the URL.";
}

export async function probeUrl(
  supabase: SupabaseClient<Database>,
  rawUrl: string,
  scope: CrawlScope,
  userAgent: string,
): Promise<ProbeResult> {
  let url: URL;
  try {
    url = new URL(rawUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new SsrfError("Only http(s) URLs are supported", "invalid_scheme");
    }
  } catch (err) {
    return {
      ok: false,
      targetUrl: rawUrl,
      reachable: false,
      httpStatus: null,
      finalUrl: null,
      sameOriginLinkCount: 0,
      robots: { checked: false, allowedAtRoot: false, sitemapCount: 0 },
      sitemap: { checked: false, found: false },
      error: errorMessageFor(err),
    };
  }

  let html = "";
  let finalUrl: string | null = null;
  let httpStatus: number | null = null;

  try {
    const res = await safeFetch(url.toString(), {
      method: "GET",
      headers: { "User-Agent": userAgent },
    });
    finalUrl = res.finalUrl;
    httpStatus = res.status;
    const contentType = res.headers["content-type"] ?? "";
    if (contentType.includes("html")) {
      html = res.body.toString("utf-8");
    }
  } catch (err) {
    return {
      ok: false,
      targetUrl: rawUrl,
      reachable: false,
      httpStatus: null,
      finalUrl: null,
      sameOriginLinkCount: 0,
      robots: { checked: false, allowedAtRoot: false, sitemapCount: 0 },
      sitemap: { checked: false, found: false },
      error: errorMessageFor(err),
    };
  }

  const robotsRules = await getRobotsRules(supabase, url.toString(), userAgent);
  const allowedAtRoot = robotsRules.isAllowed(url.pathname + url.search);

  const sameOriginLinkCount = html ? extractLinks(html, url.toString()).length : 0;

  let sitemapFound = robotsRules.sitemaps.length > 0;
  const shouldCheckSitemap = scope === "site";
  if (shouldCheckSitemap && !sitemapFound) {
    try {
      const sitemapRes = await safeFetch(`${url.protocol}//${url.host}/sitemap.xml`, {
        method: "GET",
        headers: { "User-Agent": userAgent },
        maxBytes: 1024 * 1024,
      });
      sitemapFound = sitemapRes.status >= 200 && sitemapRes.status < 300;
    } catch {
      sitemapFound = false;
    }
  }

  const reachable = httpStatus !== null && httpStatus >= 200 && httpStatus < 400;

  return {
    ok: true,
    targetUrl: rawUrl,
    reachable,
    httpStatus,
    finalUrl,
    sameOriginLinkCount,
    robots: {
      checked: true,
      allowedAtRoot,
      sitemapCount: robotsRules.sitemaps.length,
    },
    sitemap: {
      checked: shouldCheckSitemap,
      found: shouldCheckSitemap ? sitemapFound : robotsRules.sitemaps.length > 0,
    },
    error: null,
  };
}
