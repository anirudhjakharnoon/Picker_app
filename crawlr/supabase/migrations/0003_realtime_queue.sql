-- CRAWLR - migration 0003
--
-- Run this after 0001_init.sql and 0002_job_counters_rpc.sql.
--
-- Adds crawl_queue to the Realtime publication. crawl_queue is exactly the
-- table that represents each page's live crawl status (pending / fetching /
-- done / skipped / error), which is what directly drives the Split HUD's
-- live link-graph hero visual - the spec calls this graph out as a core,
-- named requirement ("a live link-graph... driven by the Realtime feed of
-- crawl_queue"), so subscribing to it directly (instead of polling, or
-- inferring per-page status from crawl_events' free-text messages) is both
-- more correct and more resource-efficient. crawl_queue already has a
-- "job belongs to me" SELECT policy from migration 0001, so this only
-- affects which tables changefeeds are published for - not who can read
-- them.

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'crawl_queue'
  ) then
    alter publication supabase_realtime add table crawl_queue;
  end if;
end;
$$;
