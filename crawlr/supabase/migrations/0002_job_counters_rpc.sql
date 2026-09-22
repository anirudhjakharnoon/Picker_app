-- CRAWLR - migration 0002
--
-- Run this after 0001_init.sql. Adds an atomic counter-increment function
-- used by the tick worker (POST /api/jobs/[id]/tick) to update crawl_jobs'
-- running totals + last_ticked_at in one statement per tick, instead of a
-- read-modify-write from application code (which would be vulnerable to
-- lost updates if the watchdog and a self-recursive tick ever overlap for
-- the same job). Called with the service-role client, which bypasses RLS,
-- so this is `security invoker` purely for clarity - it never runs on
-- behalf of an end user.

create or replace function public.bump_job_counters(
  p_job_id uuid,
  p_pages_crawled int default 0,
  p_pages_skipped int default 0,
  p_pages_errored int default 0,
  p_images_found int default 0,
  p_videos_found int default 0,
  p_text_bytes bigint default 0,
  p_robots_disallowed int default 0
) returns void
language sql
security invoker
set search_path = public
as $$
  update crawl_jobs
  set
    pages_crawled = pages_crawled + p_pages_crawled,
    pages_skipped = pages_skipped + p_pages_skipped,
    pages_errored = pages_errored + p_pages_errored,
    images_found = images_found + p_images_found,
    videos_found = videos_found + p_videos_found,
    text_bytes = text_bytes + p_text_bytes,
    robots_disallowed = robots_disallowed + p_robots_disallowed,
    last_ticked_at = now()
  where id = p_job_id;
$$;

grant execute on function public.bump_job_counters(uuid, int, int, int, int, int, bigint, int) to service_role;
