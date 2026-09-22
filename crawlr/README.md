# CRAWLR

A URL → **Text / Images / Video** extraction tool, built on **Supabase + Vercel only**.

Paste a URL, pick what to extract, pick how far to crawl, hit **Run**. CRAWLR crawls
within scope, honors `robots.txt`, and returns:

- **Text** → a single assembled `.md` file (one section per page), downloaded via a
  short-lived Supabase Storage signed URL.
- **Images** → a live gallery of every image found, each linking straight to its
  original source (never re-hosted), plus a CSV/JSON list export and an optional
  bounded in-memory ZIP for small sets (≤50 images).
- **Video** → direct download links for self-hosted video files (the browser downloads
  straight from the origin) and "open source" links for embedded players
  (YouTube/Vimeo/etc.), which are never re-hosted.

No AI, no third-party scraping/proxy APIs, no headless browser, no queue service, no
Redis. Content extraction is deterministic HTML parsing (`cheerio` + a
Readability-style boilerplate strip) and `turndown` for HTML→Markdown — the same URL
always produces the same Markdown.

## Stack

- **Next.js 14 App Router**, TypeScript (strict, no `any` in security/extraction
  modules — enforced by ESLint), Tailwind CSS.
- **Supabase**: Postgres (jobs/queue/pages/assets, RLS on every table), Realtime
  (`crawl_jobs`, `crawl_queue`, `crawl_events`, `crawl_assets`), Storage (a single
  private `exports` bucket, Markdown only), Anonymous Auth (no signup flow).
- **Vercel**: Node serverless functions + Vercel Cron (watchdog + cleanup).

## Setup

### 1. Create a Supabase project

Create a project at [supabase.com](https://supabase.com), then in the SQL Editor run
the three migrations in `supabase/migrations/`, **in order**:

1. `0001_init.sql` — the full schema (`crawl_jobs`, `crawl_queue`, `crawl_pages`,
   `crawl_assets`, `robots_cache`, `crawl_events`, `job_rate_limits`), RLS policies on
   every table, the `try_consume_job_quota()` job-creation throttle, Realtime on
   `crawl_jobs`/`crawl_events`/`crawl_assets`, and the private `exports` Storage bucket.
2. `0002_job_counters_rpc.sql` — the atomic `bump_job_counters()` function the tick
   worker uses to update `crawl_jobs`' running totals without lost-update races.
3. `0003_realtime_queue.sql` — adds `crawl_queue` to the Realtime publication (drives
   the live link-graph).

You can paste each file's contents into the SQL Editor and run it, or use the CLI:

```bash
supabase link --project-ref <your-project-ref>
supabase db push
```

Enable **Anonymous sign-ins** under Authentication → Providers (they're off by
default on new projects).

### 2. Environment variables

Copy `.env.example` to `.env.local` and fill in:

```bash
NEXT_PUBLIC_SUPABASE_URL=          # Project Settings → API
NEXT_PUBLIC_SUPABASE_ANON_KEY=     # Project Settings → API
SUPABASE_SERVICE_ROLE_KEY=         # Project Settings → API — server-only, never expose
NEXT_PUBLIC_SITE_URL=              # e.g. https://your-deployment.vercel.app
CRON_SECRET=                       # any long random string
```

`CRON_SECRET` protects `/api/jobs/[id]/tick`, `/api/cron/watchdog`, and
`/api/cron/cleanup` from being called by anyone other than Vercel Cron or our own
server code — Vercel automatically sends `Authorization: Bearer $CRON_SECRET` on every
cron request once that env var is set on the project.

### 3. Install, test, run

```bash
npm install
npm test        # unit + integration tests (vitest)
npm run lint
npm run typecheck
npm run dev
```

### 4. Deploy

Deploy to Vercel with the same env vars set in the project settings. `vercel.json`
already declares the two cron jobs:

```json
{
  "crons": [
    { "path": "/api/cron/watchdog", "schedule": "* * * * *" },
    { "path": "/api/cron/cleanup", "schedule": "0 * * * *" }
  ]
}
```

## Architecture

```
Client (browser)
  - supabase-js: anonymous auth (signInAnonymously on first load), Realtime
    subscriptions to crawl_jobs / crawl_queue / crawl_events / crawl_assets
    for the active job only, throttled into UI state at most every 600ms
  - all ambient animation (scanline, particle drift) is pure CSS, zero
    backend calls, frozen under prefers-reduced-motion

API Routes (Node serverless)
  POST /api/jobs/probe            read-only reconnaissance (no rows written)
  POST /api/jobs                  creates the job, seeds crawl_queue, kicks off the
                                   first tick (fire-and-forget)
  POST /api/jobs/:id/tick         processes one bounded batch of the frontier,
                                   then either finalizes the job or triggers a
                                   self-fetch continuation while time remains
  POST /api/jobs/:id/abort        owner-scoped, running -> aborted
  GET  /api/jobs/:id/export/md    mints a fresh signed URL, never proxies the file
  POST /api/jobs/:id/images/zip   bounded (<=50 images, <=25MB), streamed, never
                                   written to Storage
  GET  /api/cron/watchdog         every 1 min: re-ticks any 'running' job whose
                                   last activity is stale
  GET  /api/cron/cleanup          every 1 hr: deletes Storage exports + cascades
                                   DB rows past the retention window

Supabase
  Postgres  - crawl_jobs / crawl_queue / crawl_pages / crawl_assets /
              robots_cache / crawl_events / job_rate_limits, RLS on every table
  Realtime  - crawl_jobs, crawl_queue, crawl_events, crawl_assets
  Storage   - `exports` bucket, .md only, private, signed URLs on demand
  Auth      - Anonymous sign-in -> stable uid for RLS + abuse limiting
```

### Why this shape

- **No queue service, no Redis, no headless browser.** The "queue" is a Postgres
  table (`crawl_queue`); rate limiting is an in-process per-domain token bucket seeded
  from `crawl_jobs.rate_limit_rps`; live progress is Supabase Realtime (push, not
  poll).
- **Long crawls without a long-lived server.** A single tick handles one bounded
  batch (5 URLs), then either finalizes the job or fires a self-fetch continuation to
  a fresh invocation — the classic "resumable, stateless-between-invocations"
  serverless pattern. A Cron watchdog re-invokes any job whose `last_ticked_at` has
  gone stale, so a killed invocation can never permanently stall a job.
- **JS-rendered SPAs are explicitly out of scope.** A headless browser is exactly the
  heavy dependency this brief asks to avoid. The crawler parses raw HTML/DOM via
  `cheerio`; sites that need client-side JS to render their primary content will
  extract incompletely, and the UI says so up front.

### Trust boundaries (why there are two Supabase clients)

- `createRouteHandlerClient()` — anon key + the caller's own session cookies (via
  `@supabase/ssr`). Every query through this client is subject to RLS **as that
  specific anonymous user**. Used for anything acting on behalf of the end user:
  creating a job, checking/consuming their own job-creation quota, verifying job
  ownership before returning a signed export URL, aborting their own job.
- `createServiceRoleClient()` — service role key, bypasses RLS. Used only for
  trusted, server-to-server work where the route itself is the security boundary and
  has already established which job it's operating on: the tick worker, both cron
  routes, and Storage signed-URL minting.

### RLS summary

| Table | Policy |
|---|---|
| `crawl_jobs` | `owner = auth.uid()` for select/insert/update |
| `crawl_queue`, `crawl_pages`, `crawl_assets`, `crawl_events` | select-only, `job_id in (select id from crawl_jobs where owner = auth.uid())` — all writes go through the service-role tick worker |
| `job_rate_limits` | `owner = auth.uid()` for select/insert/update |
| `robots_cache` | RLS enabled, **zero** client policies — it's a shared, non-owned cache; only the service role ever touches it |

## Caps & limits (`lib/constants.ts`)

Every cap is enforced **server-side** regardless of what the client requests.

| Cap | Default | Hard ceiling |
|---|---|---|
| Pages per job | 500 | 2,000 |
| Crawl depth | 3 | 10 (spec didn't pin an exact hard depth cap — see comment in `lib/constants.ts`) |
| Requests/sec per domain | 3 | 5 |
| Combined extracted text | — | 15 MB / job |
| Assets registered | — | 5,000 / job |
| Response size per fetch | — | 10 MB |
| Job creation | — | 5 jobs / hour / anonymous owner (Postgres-enforced, atomic) |
| Data retention | 48h | Storage exports + DB rows purged by the hourly cleanup cron |
| ZIP bundle | — | ≤50 images, ≤25 MB, in-memory only |

## Security

- **SSRF (`lib/ssrf.ts`)**: rejects non-http(s) schemes, resolves DNS and blocks
  private/loopback/link-local/multicast/reserved ranges (including the
  `169.254.169.254` cloud metadata address) for both IPv4 and IPv6, re-validates the
  resolved IP on every redirect hop (DNS-pinned — no rebinding trust), caps redirects,
  enforces request timeouts and a hard response-size cap, and blocks non-standard
  ports unless the user's original URL explicitly included one.
- **robots.txt (`lib/robots.ts`)**: real longest-match-wins Allow/Disallow semantics
  (wildcards, `$` end-anchor, bot-specific vs. wildcard group precedence), fails
  **closed** (treats the domain as fully disallowed) on a 5xx or network error instead
  of assuming permission, and only fails **open** (allow-all) on a definitive 404.
- **Politeness**: a descriptive `User-Agent` (`CrawlrBot/1.0 (+<site>/about-crawlr)`)
  linking to a page that documents the bot's behavior and how to block it; a
  per-domain token-bucket rate limit; no header spoofing, no CAPTCHA bypass, no
  stealth/anti-detection behavior of any kind.
- **Abuse prevention**: the anonymous-owner job-creation throttle is enforced by a
  single atomic Postgres function (`try_consume_job_quota`), not application memory.
- **Data minimization**: no binary media is ever persisted — only the assembled
  Markdown and small structured metadata rows (URLs, titles, sizes). Storage exports
  and their DB rows auto-expire via the hourly cleanup cron.

## Testing

```bash
npm test
```

107 tests across:

- `tests/ssrf.test.ts` — scheme/IP/port validation, redirect re-validation, timeout
  and size-cap enforcement, obfuscated-IP tricks.
- `tests/robots.test.ts` — parsing correctness (wildcards, `$` anchor, group
  precedence, longest-match-wins, tie-breaking) and the fetch/cache/fail-closed
  behavior.
- `tests/rateLimiter.test.ts` — token-bucket refill math and the per-domain registry.
- `tests/extract.test.ts` — boilerplate stripping, Readability-style main-content
  scoring (including a no-semantic-tags fixture), asset/link extraction and
  normalization.
- `tests/crawlEngine.integration.test.ts` — a full small crawl (`scope='page'`)
  against a mocked `safeFetch` and an in-memory fake Supabase client, asserting the
  final `crawl_pages` Markdown, `crawl_assets` rows, `crawl_queue` status, atomically
  bumped `crawl_jobs` counters, and the uploaded Markdown export are all correct, plus
  robots-skip, no-op-when-not-running, and self-fetch-continuation behavior.

## Known deviations from the spec (and why)

- **Watchdog cadence**: the spec's architecture diagram asks for a ~15s watchdog.
  Vercel Cron's finest supported granularity is once per minute — there's no
  sub-minute schedule syntax, and adding an external scheduler would violate the
  "Supabase + Vercel only" constraint. The watchdog runs every minute instead (this
  matches the spec's own numbered non-functional-requirements section, which
  separately describes a ~90s/1-minute cadence).
- **Per-IP job-creation limiting**: the given `job_rate_limits` schema is keyed by
  `owner` (uuid) only — there's no IP column to key a second limiter on, and adding
  one would mean inventing a different schema. The per-owner limit is implemented
  exactly as specified; per-IP limiting is not.
- **Asset `alt_text`/`mime_type`**: `extractAssets()` returns plain URL lists (per its
  own tested function signature), so these columns are populated as `null`. A
  follow-up could have `extractAssets` also capture `<img alt>` and `<source type>`
  and thread them through.
- **Per-domain rate-limit state**: the schema has no dedicated table for persisted
  per-domain token-bucket state, and a crawl job only ever targets one
  `root_domain` anyway, so pacing is applied within each tick's own request loop
  (seeded from `crawl_jobs.rate_limit_rps`) rather than persisted across invocations.

## Explicit scope boundaries

- No JavaScript rendering — static HTML/DOM only.
- No login/paywall/CAPTCHA bypass.
- No re-hosting of images or embedded video — both always link back to source.
- No AI-based summarization/extraction — deterministic parsing only.
- Hard caps on pages/time/size apply even to "entire domain" — the result summary
  shows **CAPPED** rather than silently truncating.
