/**
 * robots.txt fetching, parsing, and per-domain caching.
 *
 * Every URL is checked against these rules BEFORE it is fetched for real -
 * disallowed URLs are never requested, only logged as skipped
 * (skip_reason='robots').
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { safeFetch } from "./ssrf";
import { ROBOTS_CACHE_TTL_MS } from "./constants";
import type { Database } from "./types";

export interface RobotsRule {
  allow: boolean;
  pattern: string;
  regex: RegExp;
}

export interface RobotsGroup {
  agents: string[];
  rules: RobotsRule[];
}

export interface ParsedRobots {
  groups: RobotsGroup[];
  sitemaps: string[];
}

export interface RobotsRules {
  sitemaps: string[];
  /** True if the given path (e.g. "/blog/post-1?x=1") may be fetched. */
  isAllowed(pathWithQuery: string): boolean;
}

/**
 * Converts a robots.txt path pattern (which supports `*` wildcards and a
 * trailing `$` end-anchor, per the de-facto/Google robots.txt spec) into a
 * prefix-matching RegExp.
 */
function ruleToRegex(rawPattern: string): RegExp {
  let pattern = rawPattern;
  let endAnchor = false;
  if (pattern.endsWith("$")) {
    endAnchor = true;
    pattern = pattern.slice(0, -1);
  }
  const escaped = pattern
    .split("*")
    .map((part) => part.replace(/[.+^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}${endAnchor ? "$" : ""}`);
}

export function parseRobotsTxt(content: string): ParsedRobots {
  const groups: RobotsGroup[] = [];
  const sitemaps: string[] = [];
  let currentGroup: RobotsGroup | null = null;
  let groupHasRules = false;

  const lines = content.split(/\r?\n/);
  for (const rawLine of lines) {
    const withoutComment = rawLine.split("#")[0] ?? "";
    const line = withoutComment.trim();
    if (!line) continue;

    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) continue;
    const field = line.slice(0, colonIndex).trim().toLowerCase();
    const value = line.slice(colonIndex + 1).trim();

    if (field === "user-agent") {
      if (!currentGroup || groupHasRules) {
        currentGroup = { agents: [], rules: [] };
        groups.push(currentGroup);
        groupHasRules = false;
      }
      currentGroup.agents.push(value.toLowerCase());
    } else if (field === "allow" || field === "disallow") {
      if (!currentGroup) {
        currentGroup = { agents: ["*"], rules: [] };
        groups.push(currentGroup);
      }
      groupHasRules = true;
      if (field === "disallow" && value === "") {
        // Empty Disallow means "no restriction" - deliberately not added.
        continue;
      }
      currentGroup.rules.push({ allow: field === "allow", pattern: value, regex: ruleToRegex(value) });
    } else if (field === "sitemap") {
      if (value) sitemaps.push(value);
    }
    // crawl-delay and other extension directives are intentionally ignored
    // for allow/disallow purposes; our own rate limiter governs pacing.
  }

  return { groups, sitemaps };
}

function selectGroup(groups: RobotsGroup[], userAgentToken: string): RobotsGroup | null {
  const needle = userAgentToken.toLowerCase();
  const specific = groups.find((g) => g.agents.some((a) => a !== "*" && needle.includes(a)));
  if (specific) return specific;
  return groups.find((g) => g.agents.includes("*")) ?? null;
}

export function buildRobotsRules(parsed: ParsedRobots, userAgentToken: string): RobotsRules {
  const group = selectGroup(parsed.groups, userAgentToken);

  return {
    sitemaps: parsed.sitemaps,
    isAllowed(pathWithQuery: string): boolean {
      if (!group) return true;

      let best: RobotsRule | null = null;
      for (const rule of group.rules) {
        if (!rule.regex.test(pathWithQuery)) continue;
        if (!best) {
          best = rule;
          continue;
        }
        if (rule.pattern.length > best.pattern.length) {
          best = rule;
        } else if (rule.pattern.length === best.pattern.length && rule.allow && !best.allow) {
          // Ties go to the least-restrictive (Allow) rule.
          best = rule;
        }
      }
      return best ? best.allow : true;
    },
  };
}

/**
 * Fetches (with caching) and parses robots.txt for the domain hosting
 * `targetUrl`, and returns ready-to-use rules for `userAgentToken` (the
 * bot's own User-Agent string, e.g. "CrawlrBot/1.0 (+https://.../about)").
 *
 * IMPORTANT: `supabase` must be a service-role client - robots_cache has no
 * RLS policies granted to anon/authenticated at all (see migration 0001),
 * so this only works server-side with the service role key.
 */
export async function getRobotsRules(
  supabase: SupabaseClient<Database>,
  targetUrl: string,
  userAgentToken: string,
): Promise<RobotsRules> {
  const url = new URL(targetUrl);
  const domain = url.hostname;
  const now = Date.now();

  const { data: cached } = await supabase
    .from("robots_cache")
    .select("*")
    .eq("domain", domain)
    .maybeSingle();

  if (cached && new Date(cached.expires_at).getTime() > now) {
    return buildRobotsRules(parseRobotsTxt(cached.robots_txt ?? ""), userAgentToken);
  }

  const robotsUrl = `${url.protocol}//${url.host}/robots.txt`;
  let text: string | null = null;
  let fetchFailedClosed = false;

  try {
    const res = await safeFetch(robotsUrl, {
      method: "GET",
      headers: { "User-Agent": userAgentToken },
    });
    if (res.status >= 200 && res.status < 300) {
      text = res.body.toString("utf-8");
    } else if (res.status >= 400 && res.status < 500) {
      // No robots.txt present at all -> no restrictions.
      text = "";
    } else {
      // 5xx or unexpected status: fail CLOSED rather than assume permission.
      fetchFailedClosed = true;
    }
  } catch {
    // Network/timeout/SSRF-guard failure: fail CLOSED, don't cache a
    // transient failure as if it were a definitive answer.
    fetchFailedClosed = true;
  }

  if (fetchFailedClosed) {
    return { sitemaps: [], isAllowed: () => false };
  }

  const parsed = parseRobotsTxt(text ?? "");
  const expiresAt = new Date(now + ROBOTS_CACHE_TTL_MS).toISOString();

  await supabase.from("robots_cache").upsert({
    domain,
    robots_txt: text,
    sitemap_urls: parsed.sitemaps,
    fetched_at: new Date(now).toISOString(),
    expires_at: expiresAt,
  });

  return buildRobotsRules(parsed, userAgentToken);
}
