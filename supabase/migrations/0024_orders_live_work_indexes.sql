-- ============================================================================
-- 0024_orders_live_work_indexes.sql
--
-- Supports the bounded orders query the PWA now issues (see app/src/lib/useOrders.ts).
--
-- Background: useOrders() previously ran `select * from orders` with no filter
-- and no limit, on mount and again on every tab-focus, for every signed-in
-- user. RLS scopes that per role, but an admin is scoped to *everything*, so an
-- admin's screen fetched the entire orders table — and the table only ever
-- grows. Measured on a seeded 20k-order table, that single query returned
-- 20,000 rows and, before 0021, invoked auth_is_admin() and auth_role() once
-- per row: 40,000 function calls (each auth_role() doing its own profiles
-- lookup) for one page load. 0021 collapsed the per-row helper calls to one per
-- statement; this migration plus the client change addresses the other half,
-- which is the unbounded row count itself.
--
-- The client now asks only for live work: any non-terminal order, plus
-- terminal ones still inside a short recency window (so an order a picker just
-- completed does not vanish from their screen mid-flow). These two indexes are
-- what let Postgres satisfy that without scanning the whole table:
--
--   * orders_live_ingested_idx — a PARTIAL index covering only non-terminal
--     rows. This is the important one: it stays small permanently, because
--     completed/dispatched/cancelled orders drop out of it. Its size is
--     proportional to open work, not to history.
--   * orders_updated_at_idx — serves the "terminal but recent" arm of the OR.
--
-- Both are `if not exists`, so this is safe to re-run.
-- ============================================================================

create index if not exists orders_live_ingested_idx
  on orders (ingested_at)
  where status not in ('completed', 'dispatched', 'cancelled');

create index if not exists orders_updated_at_idx
  on orders (updated_at);

analyze orders;

notify pgrst, 'reload schema';
