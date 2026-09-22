/**
 * Central place for every tunable cap/limit in the app. Documented in README.md.
 * Keep this the single source of truth so ops can retune without hunting through routes.
 */

/** Max crawl depth allowed regardless of client request. */
export const MAX_DEPTH_HARD_CAP = 5;

/** Default crawl depth when the client omits one. */
export const DEFAULT_MAX_DEPTH = 2;

/** Max pages a single job may fetch regardless of client request. */
export const MAX_PAGES_HARD_CAP = 500;

/** Default page cap when the client omits one. */
export const DEFAULT_MAX_PAGES = 50;

/** Hard server-side ceiling on requests/sec per domain, regardless of client input. */
export const RATE_LIMIT_RPS_HARD_CAP = 5;

/** Default requests/sec per domain when the client omits one. */
export const DEFAULT_RATE_LIMIT_RPS = 3;

/** Soft time budget (ms) for a single tick invocation before it re-invokes itself. */
export const TICK_TIME_BUDGET_MS = 50_000;

/** Vercel function maxDuration (seconds) for the tick route. See README for plan rationale. */
export const TICK_MAX_DURATION_SECONDS = 60;

/** Watchdog re-ticks jobs whose last_ticked_at is older than this many ms. */
export const WATCHDOG_STALL_THRESHOLD_MS = 90_000;

/** How many queue rows a single tick batch pulls at once. */
export const TICK_BATCH_SIZE = 5;

/** SSRF fetch timeout in ms. */
export const FETCH_TIMEOUT_MS = 8_000;

/** SSRF fetch max response bytes. */
export const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

/** Max redirect hops the manual redirect-following logic will follow. */
export const MAX_REDIRECTS = 5;

/** Ports allowed unless explicitly present in the original user-supplied URL. */
export const DEFAULT_ALLOWED_PORTS = [80, 443] as const;

/** robots.txt cache TTL in ms (24h). */
export const ROBOTS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** Data + Storage retention window: jobs older than this are purged by the cleanup cron. */
export const RETENTION_WINDOW_MS = 48 * 60 * 60 * 1000;

/** Signed URL expiry for markdown export downloads. */
export const EXPORT_SIGNED_URL_TTL_SECONDS = 10 * 60;

/** Image ZIP bundle eligibility caps. */
export const ZIP_MAX_IMAGES = 50;
export const ZIP_MAX_TOTAL_BYTES = 25 * 1024 * 1024;

/** Storage bucket that holds only markdown exports (never binary media). */
export const EXPORTS_BUCKET = "exports";

/** User-Agent sent on every crawl fetch. */
export function buildUserAgent(siteUrl: string): string {
  return `CrawlrBot/1.0 (+${siteUrl}/about-crawlr)`;
}
