/**
 * Central place for every tunable cap/limit in the app. Documented in
 * README.md alongside the reasoning for each number. Keep this the single
 * source of truth so ops can retune without hunting through routes.
 */

/** crawl_jobs.max_depth default (matches the schema's own column default). */
export const DEFAULT_MAX_DEPTH = 3;

/**
 * Hard ceiling on crawl depth regardless of client request. The spec calls
 * for "max crawl depth" as a hard cap without giving an exact number (unlike
 * max_pages, which it pins at 2,000) - 10 is a conservative ceiling chosen so
 * a runaway "site" scope crawl can't spiral into effectively-unbounded depth
 * on a deep site while max_pages is still being reached.
 */
export const MAX_DEPTH_HARD_CAP = 10;

/** crawl_jobs.max_pages default (matches the schema's own column default). */
export const DEFAULT_MAX_PAGES = 500;

/** Hard ceiling on pages/job regardless of client request. */
export const MAX_PAGES_HARD_CAP = 2_000;

/** crawl_jobs.rate_limit_rps default (matches the schema's own column default). */
export const DEFAULT_RATE_LIMIT_RPS = 3;

/** Hard server-side ceiling on requests/sec per domain, regardless of client input. */
export const RATE_LIMIT_RPS_HARD_CAP = 5;

/** Max combined extracted text across all of a job's crawl_pages.markdown. */
export const MAX_TEXT_BYTES_PER_JOB = 15 * 1024 * 1024;

/** Max crawl_assets rows a single job may register. */
export const MAX_ASSETS_PER_JOB = 5_000;

/** Soft time budget (ms) for a single tick invocation before it re-invokes itself. */
export const TICK_TIME_BUDGET_MS = 50_000;

/**
 * Vercel function maxDuration (seconds) for the tick route. Set to 60s: the
 * Vercel Hobby plan caps Node serverless functions at 60s, and Pro/Enterprise
 * plans that allow higher (up to 300s/800s) still work fine with this value -
 * we chose the number that works on every plan rather than assuming Pro, and
 * rely on the tick's own self-recursion + the watchdog cron for jobs that
 * need far longer than one invocation. Bump this in vercel.json + here if
 * you're committed to a paid plan and want fewer watchdog hops per job.
 */
export const TICK_MAX_DURATION_SECONDS = 60;

/**
 * Watchdog re-ticks jobs whose last_ticked_at is older than this many ms.
 * The spec's system-architecture diagram asks for a ~15s watchdog cadence,
 * but Vercel Cron's finest supported granularity is once per minute (it has
 * no sub-minute schedule syntax, and adding an external scheduler would
 * violate the "no other services" constraint) - so the watchdog cron runs
 * every 1 minute (see vercel.json) and this threshold is set to 90s
 * (comfortably more than one cron period) so the watchdog never races an
 * still-in-flight self-recursive tick.
 */
export const WATCHDOG_STALL_THRESHOLD_MS = 90_000;

/** How many queue rows a single tick batch pulls at once. */
export const TICK_BATCH_SIZE = 5;

/** SSRF fetch timeout in ms. */
export const FETCH_TIMEOUT_MS = 8_000;

/** SSRF fetch max response bytes (per fetch, per the spec's resource caps). */
export const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

/** Max redirect hops the manual redirect-following logic will follow. */
export const MAX_REDIRECTS = 5;

/** Ports allowed unless explicitly present in the original user-supplied URL. */
export const DEFAULT_ALLOWED_PORTS = [80, 443] as const;

/** robots_cache TTL in ms (24h). */
export const ROBOTS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Data + Storage retention window: jobs older than this are purged by the
 * cleanup cron. The spec's range is 24-72h; 48h is the midpoint default.
 */
export const RETENTION_WINDOW_MS = 48 * 60 * 60 * 1000;

/** Signed URL expiry for markdown export downloads. */
export const EXPORT_SIGNED_URL_TTL_SECONDS = 10 * 60;

/** Image ZIP bundle eligibility caps (bounded, in-memory, never written to Storage). */
export const ZIP_MAX_IMAGES = 50;
export const ZIP_MAX_TOTAL_BYTES = 25 * 1024 * 1024;

/** Anonymous-owner job-creation throttle: job_rate_limits enforces this in Postgres. */
export const JOB_CREATION_MAX_PER_WINDOW = 5;
export const JOB_CREATION_WINDOW_SECONDS = 60 * 60;

/** Storage bucket that holds only markdown exports (never binary media). */
export const EXPORTS_BUCKET = "exports";

/** User-Agent sent on every crawl fetch, per the politeness requirement. */
export function buildUserAgent(siteUrl: string): string {
  return `CrawlrBot/1.0 (+${siteUrl}/about-crawlr)`;
}
