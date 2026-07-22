-- ============================================================================
-- 0013_ensure_order_is_fragile.sql
-- admin_create_order_v1 (from 0005/0010) inserts into orders.is_fragile.
-- Projects that applied later migrations without 0005 fail with:
--   column "is_fragile" of relation "orders" does not exist
-- This migration is idempotent and safe to re-run.
-- ============================================================================

alter table orders
  add column if not exists is_fragile boolean not null default false;

notify pgrst, 'reload schema';
