-- CRAWLR - initial schema migration
--
-- Run this once in the Supabase SQL Editor (or via `supabase db push`) on a
-- fresh project. Safe to re-run: every statement is guarded with
-- `if not exists` / `create or replace` / `drop ... if exists` where
-- Postgres supports it, EXCEPT the RLS policy blocks, which use
-- `drop policy if exists` first so re-running never errors on "already
-- exists".
--
-- Tables, columns, and defaults below match the Data Model section of the
-- CRAWLR spec exactly - nothing has been added, renamed, or removed.

-- ---------------------------------------------------------------------------
-- Extensions
-- ---------------------------------------------------------------------------
create extension if not exists pgcrypto; -- gen_random_uuid()

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

-- One row per crawl run
create table if not exists crawl_jobs (
  id                uuid primary key default gen_random_uuid(),
  owner             uuid not null references auth.users(id),        -- anonymous auth uid
  created_at        timestamptz not null default now(),
  target_url        text not null,
  root_domain       text not null,
  scope             text not null check (scope in ('page','linked','site')),
  content_types     text[] not null,                                 -- subset of {text,images,video}
  status            text not null default 'queued'
                     check (status in ('queued','probing','running','completed','failed','aborted')),
  max_pages         int  not null default 500,
  max_depth         int  not null default 3,
  rate_limit_rps    numeric not null default 3,
  pages_crawled     int not null default 0,
  pages_skipped     int not null default 0,
  pages_errored     int not null default 0,
  images_found      int not null default 0,
  videos_found      int not null default 0,
  text_bytes        bigint not null default 0,
  robots_disallowed int not null default 0,
  started_at        timestamptz,
  finished_at       timestamptz,
  last_ticked_at    timestamptz,                                     -- watchdog liveness check
  error_message     text,
  md_storage_path   text,
  md_size_bytes     bigint
);

-- BFS frontier + processed record (the "queue")
create table if not exists crawl_queue (
  id               bigint generated always as identity primary key,
  job_id           uuid not null references crawl_jobs(id) on delete cascade,
  url              text not null,
  normalized_url   text not null,
  depth            int not null default 0,
  status           text not null default 'pending'
                    check (status in ('pending','fetching','done','skipped','error')),
  discovered_from  text,
  http_status      int,
  skip_reason      text,                                             -- 'robots' | 'depth' | 'offsite' | 'cap' | ...
  fetched_at       timestamptz,
  unique (job_id, normalized_url)
);
create index if not exists crawl_queue_job_id_status_idx on crawl_queue (job_id, status);

-- Extracted per-page content (markdown kept here, assembled into one file at completion)
create table if not exists crawl_pages (
  id           bigint generated always as identity primary key,
  job_id       uuid not null references crawl_jobs(id) on delete cascade,
  url          text not null,
  title        text,
  markdown     text,
  word_count   int,
  fetched_at   timestamptz not null default now()
);
create index if not exists crawl_pages_job_id_idx on crawl_pages (job_id);

-- Registry only - URLs, never bytes
create table if not exists crawl_assets (
  id            bigint generated always as identity primary key,
  job_id        uuid not null references crawl_jobs(id) on delete cascade,
  page_url      text not null,
  asset_type    text not null check (asset_type in ('image','video','video_embed')),
  asset_url     text not null,
  alt_text      text,
  mime_type     text,
  discovered_at timestamptz not null default now()
);
create index if not exists crawl_assets_job_id_idx on crawl_assets (job_id);
create index if not exists crawl_assets_job_id_type_idx on crawl_assets (job_id, asset_type);

-- Per-domain robots.txt / sitemap cache (avoid refetching within TTL)
create table if not exists robots_cache (
  domain        text primary key,
  robots_txt    text,
  sitemap_urls  text[],
  fetched_at    timestamptz not null default now(),
  expires_at    timestamptz not null
);

-- Append-only live log, streamed to the UI, trimmed/expired with the job
create table if not exists crawl_events (
  id         bigint generated always as identity primary key,
  job_id     uuid not null references crawl_jobs(id) on delete cascade,
  at         timestamptz not null default now(),
  kind       text not null,                                          -- fetch | extract | queue | skip | error | done
  message    text not null
);
create index if not exists crawl_events_job_id_at_idx on crawl_events (job_id, at);

-- Anonymous-user job-creation throttle
create table if not exists job_rate_limits (
  owner         uuid primary key references auth.users(id),
  window_start  timestamptz not null default now(),
  job_count     int not null default 0
);

-- ---------------------------------------------------------------------------
-- Row Level Security
--
-- crawl_jobs / job_rate_limits: scoped to `owner = auth.uid()`.
-- crawl_queue / crawl_pages / crawl_assets / crawl_events: scoped to
--   "job belongs to me", i.e. `job_id in (select id from crawl_jobs where
--   owner = auth.uid())`.
-- robots_cache: a shared, non-owned cache (there's no per-user column to key
--   on - it's keyed by domain and reused across every job that ever crawls
--   that domain). RLS is enabled but no policy is granted to
--   anon/authenticated at all: only the server (using the service role key,
--   which bypasses RLS) ever reads or writes it. No anonymous identity can
--   read another's data through this table because there IS no per-user
--   data in it, and no policy means zero client-side access either way.
--
-- Every table's INSERT/UPDATE/DELETE from the crawl worker itself (tick,
-- watchdog, cleanup) goes through the service-role client server-side, which
-- bypasses RLS by design - RLS here exists to safely allow the *client's*
-- own anon-auth session to do direct Realtime subscriptions and any direct
-- Postgrest reads without ever seeing another identity's rows.
-- ---------------------------------------------------------------------------

alter table crawl_jobs        enable row level security;
alter table crawl_queue       enable row level security;
alter table crawl_pages       enable row level security;
alter table crawl_assets      enable row level security;
alter table robots_cache      enable row level security;
alter table crawl_events      enable row level security;
alter table job_rate_limits   enable row level security;

-- crawl_jobs: owner can read their own jobs, insert their own jobs, and
-- update their own jobs (the app only ever sets status='aborted' via this
-- path - a self-tampering user could in theory also fake their own counters
-- through direct Postgrest access, which only affects what they see about
-- their own job, not any other identity's data).
drop policy if exists "crawl_jobs_select_own" on crawl_jobs;
create policy "crawl_jobs_select_own" on crawl_jobs
  for select to authenticated
  using (owner = auth.uid());

drop policy if exists "crawl_jobs_insert_own" on crawl_jobs;
create policy "crawl_jobs_insert_own" on crawl_jobs
  for insert to authenticated
  with check (owner = auth.uid());

drop policy if exists "crawl_jobs_update_own" on crawl_jobs;
create policy "crawl_jobs_update_own" on crawl_jobs
  for update to authenticated
  using (owner = auth.uid())
  with check (owner = auth.uid());

-- crawl_queue: read-only to the owner. Written only by the service role.
drop policy if exists "crawl_queue_select_own" on crawl_queue;
create policy "crawl_queue_select_own" on crawl_queue
  for select to authenticated
  using (job_id in (select id from crawl_jobs where owner = auth.uid()));

-- crawl_pages: read-only to the owner. Written only by the service role.
drop policy if exists "crawl_pages_select_own" on crawl_pages;
create policy "crawl_pages_select_own" on crawl_pages
  for select to authenticated
  using (job_id in (select id from crawl_jobs where owner = auth.uid()));

-- crawl_assets: read-only to the owner (this is what the live image gallery
-- subscribes to). Written only by the service role.
drop policy if exists "crawl_assets_select_own" on crawl_assets;
create policy "crawl_assets_select_own" on crawl_assets
  for select to authenticated
  using (job_id in (select id from crawl_jobs where owner = auth.uid()));

-- crawl_events: read-only to the owner (the live event log). Written only
-- by the service role.
drop policy if exists "crawl_events_select_own" on crawl_events;
create policy "crawl_events_select_own" on crawl_events
  for select to authenticated
  using (job_id in (select id from crawl_jobs where owner = auth.uid()));

-- job_rate_limits: owner can read/insert/update their own row (needed by
-- the try_consume_job_quota() RPC below, which runs as the calling user).
drop policy if exists "job_rate_limits_select_own" on job_rate_limits;
create policy "job_rate_limits_select_own" on job_rate_limits
  for select to authenticated
  using (owner = auth.uid());

drop policy if exists "job_rate_limits_insert_own" on job_rate_limits;
create policy "job_rate_limits_insert_own" on job_rate_limits
  for insert to authenticated
  with check (owner = auth.uid());

drop policy if exists "job_rate_limits_update_own" on job_rate_limits;
create policy "job_rate_limits_update_own" on job_rate_limits
  for update to authenticated
  using (owner = auth.uid())
  with check (owner = auth.uid());

-- robots_cache: RLS enabled above, intentionally zero policies - no
-- anon/authenticated access at all. Only the service role (bypasses RLS)
-- touches this table.

-- ---------------------------------------------------------------------------
-- Atomic, Postgres-enforced job-creation rate limiter.
--
-- Fixed window: up to p_max_jobs job creations per p_window_seconds per
-- owner. This is called by POST /api/jobs (via the user's own RLS-scoped
-- session, so `auth.uid()` resolves to the caller and the owner-match check
-- below plus the table's own RLS policies both guard it) BEFORE the job row
-- is inserted, so abuse is enforced in Postgres, not application memory.
-- ---------------------------------------------------------------------------

create or replace function public.try_consume_job_quota(
  p_owner uuid,
  p_max_jobs int default 5,
  p_window_seconds int default 3600
) returns table (allowed boolean, retry_after_seconds int)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_window_start timestamptz;
  v_job_count int;
  v_now timestamptz := now();
begin
  if p_owner is distinct from auth.uid() then
    raise exception 'try_consume_job_quota: owner must equal auth.uid()';
  end if;

  insert into job_rate_limits (owner, window_start, job_count)
  values (p_owner, v_now, 0)
  on conflict (owner) do nothing;

  select jrl.window_start, jrl.job_count
    into v_window_start, v_job_count
    from job_rate_limits jrl
    where jrl.owner = p_owner
    for update;

  if v_now - v_window_start > (p_window_seconds || ' seconds')::interval then
    update job_rate_limits
      set window_start = v_now, job_count = 1
      where owner = p_owner;
    return query select true, 0;
  elsif v_job_count < p_max_jobs then
    update job_rate_limits
      set job_count = job_count + 1
      where owner = p_owner;
    return query select true, 0;
  else
    return query select false,
      greatest(
        1,
        ceil(extract(epoch from (v_window_start + (p_window_seconds || ' seconds')::interval - v_now)))::int
      );
  end if;
end;
$$;

grant execute on function public.try_consume_job_quota(uuid, int, int) to authenticated;

-- ---------------------------------------------------------------------------
-- Realtime
--
-- The client subscribes to crawl_jobs (this job's row) and crawl_events
-- (this job's rows) for the live progress HUD, and crawl_assets for the live
-- image gallery grid, all filtered to job_id server-side by RLS.
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'crawl_jobs'
  ) then
    alter publication supabase_realtime add table crawl_jobs;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'crawl_events'
  ) then
    alter publication supabase_realtime add table crawl_events;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'crawl_assets'
  ) then
    alter publication supabase_realtime add table crawl_assets;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Storage: a single private `exports` bucket, Markdown files only.
--
-- Supabase Storage has no native per-object TTL/lifecycle policy (unlike S3
-- lifecycle rules) as of this writing, so retention is enforced by our own
-- GET /api/cron/cleanup job (see README - RETENTION_WINDOW_MS), which
-- deletes objects older than the retention window directly. The bucket
-- itself has no client-facing Storage RLS policies: every read is a
-- short-lived signed URL minted server-side with the service role, and
-- every write happens server-side with the service role - so, deliberately,
-- no anon/authenticated policy is created here either.
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public)
values ('exports', 'exports', false)
on conflict (id) do nothing;
