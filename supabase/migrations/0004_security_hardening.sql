-- ============================================================================
-- 0004_security_hardening.sql
-- Supabase-specific privilege and RLS hardening.
--
-- Why this is separate:
--   0002_rls.sql intentionally introduced readable helper functions, but an
--   authenticated profile lookup from inside a profiles policy can recurse
--   back into that same policy. These SECURITY DEFINER helpers safely bypass
--   that recursion while accepting no caller-controlled identity input:
--   every lookup is anchored to auth.uid().
--
-- This migration also removes direct UPDATE access from profiles and
-- notifications. The browser must use audited/versioned RPC functions
-- instead, so a user cannot change their own role or rewrite a notification.
-- ============================================================================

create or replace function auth_role()
returns user_role
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select role from public.profiles where id = auth.uid();
$$;

create or replace function auth_warehouse_id()
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select warehouse_id from public.profiles where id = auth.uid();
$$;

create or replace function auth_is_ops_or_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(public.auth_role() in ('ops_manager', 'admin'), false);
$$;

create or replace function auth_is_warehouse_role()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(public.auth_role() in ('warehouse_staff', 'ops_manager', 'admin'), false);
$$;

create or replace function auth_is_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(public.auth_role() = 'admin', false);
$$;

-- Direct profile updates are unsafe: a row-level WITH CHECK on id alone
-- cannot stop a user from changing their own role/warehouse columns.
drop policy if exists profiles_update_own_presence on profiles;

-- Direct notification UPDATE would allow rewriting payload/recipient fields.
-- `notifications_mark_read_v1` is the only supported mutation.
drop policy if exists notifications_update_own_read on notifications;

-- Supabase functions are executable by PUBLIC by default unless revoked.
-- Revoke everything first, then grant only the exact browser-facing surface.
revoke execute on all functions in schema public from public;
revoke execute on all functions in schema public from anon;

grant usage on schema public to authenticated;
grant select on all tables in schema public to authenticated;

grant execute on function auth_role() to authenticated;
grant execute on function auth_warehouse_id() to authenticated;
grant execute on function auth_is_ops_or_admin() to authenticated;
grant execute on function auth_is_warehouse_role() to authenticated;
grant execute on function auth_is_admin() to authenticated;

grant execute on function set_picker_status_v1(boolean, double precision, double precision) to authenticated;
grant execute on function accept_order_v1(uuid) to authenticated;
grant execute on function decline_order_v1(uuid) to authenticated;
grant execute on function scan_bag_pickup_v1(
  uuid, uuid, text, timestamptz, double precision, double precision, text
) to authenticated;
grant execute on function scan_bag_for_sort_v1(
  uuid, uuid, text, timestamptz, double precision, double precision, text
) to authenticated;
grant execute on function scan_pigeon_hole_v1(
  uuid, uuid, text, timestamptz, double precision, double precision, text
) to authenticated;
grant execute on function record_warehouse_arrival_v1(
  uuid, text, uuid[], timestamptz, double precision, double precision, text
) to authenticated;
grant execute on function report_order_issue_v1(uuid, text, text) to authenticated;
grant execute on function mark_order_dispatched_v1(uuid, uuid, text) to authenticated;
grant execute on function mark_hole_out_of_service_v1(uuid, text) to authenticated;
grant execute on function restore_pigeon_hole_v1(uuid) to authenticated;
grant execute on function notifications_mark_read_v1(uuid) to authenticated;
grant execute on function admin_create_order_v1(
  text, integer, text, text, text, text
) to authenticated;
grant execute on function admin_create_pigeon_holes_v1(uuid, integer, text) to authenticated;
grant execute on function admin_create_warehouse_gate_v1(uuid) to authenticated;
grant usage on type warehouse_arrival_result to authenticated;

-- Explicitly keep anonymous users out. RLS already returns no rows, but
-- revoking table privileges gives defense in depth and clearer failures.
revoke all on all tables in schema public from anon;

-- Enable only the tables the PWA subscribes to through Supabase Realtime.
-- The local bare-Postgres test environment has no `supabase_realtime`
-- publication, so guard this block; the publication exists in Supabase.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1
      from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'orders'
    ) then
      alter publication supabase_realtime add table public.orders;
    end if;

    if not exists (
      select 1
      from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'pigeon_holes'
    ) then
      alter publication supabase_realtime add table public.pigeon_holes;
    end if;

    if not exists (
      select 1
      from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'notifications'
    ) then
      alter publication supabase_realtime add table public.notifications;
    end if;
  end if;
end $$;
