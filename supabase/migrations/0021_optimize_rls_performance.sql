-- ============================================================================
-- 0021_optimize_rls_performance.sql
--
-- Fixes the Supabase Performance/Security Advisor warnings:
--   - "Auth RLS Initialization Plan" on every table with a policy
--   - "Function Search Path Mutable" on a couple of small helper functions
--
-- Why this matters for CPU usage:
--   Every one of our RLS policies calls a helper like auth_is_admin(),
--   auth_warehouse_id(), or auth.uid() directly inside USING (...). Postgres
--   cannot prove those calls are constant for the whole statement unless they
--   are wrapped in a scalar subquery, so — even though the functions are
--   STABLE — it falls back to re-invoking them once *per row scanned*. Each
--   call to auth_is_admin()/auth_warehouse_id() itself does a lookup against
--   `profiles`, so on any query that scans more than a handful of rows
--   (orders, bag_scans, pigeon_hole_assignments, status_history, Realtime
--   change checks, ...) this multiplies into a large number of extra
--   `profiles` lookups, which is very likely the biggest single contributor
--   to sustained 100% CPU on the free-tier's shared compute.
--
--   Wrapping every call as `(select auth_is_admin())` / `(select auth.uid())`
--   lets Postgres fold it into a one-time InitPlan instead: the value is
--   computed once per statement and reused for every row, no functional
--   change in who can see what. This is Supabase's own documented fix for
--   the "Auth RLS Initialization Plan" advisor lint — see
--   https://supabase.com/docs/guides/troubleshooting/rls-performance-and-best-practices-Z5Jjwv
--
--   Every policy is also pinned to `to authenticated` (all of them already
--   only make sense for signed-in users, and 0004_security_hardening.sql
--   already revokes table privileges from `anon`; this just makes it
--   explicit and lets Postgres skip evaluating these policies entirely for
--   any other role).
--
--   No authorization behaviour changes here — every USING clause below is
--   the same boolean expression as before, just with `(select ...)` around
--   each function/auth.uid() call so it is computed once instead of per row.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- profiles
-- ----------------------------------------------------------------------------

drop policy if exists profiles_select_own on profiles;
create policy profiles_select_own
  on profiles for select
  to authenticated
  using (id = (select auth.uid()) or (select auth_is_ops_or_admin()));

-- ----------------------------------------------------------------------------
-- warehouses / sort_walls / pigeon_holes
-- ----------------------------------------------------------------------------

drop policy if exists warehouses_select on warehouses;
create policy warehouses_select
  on warehouses for select
  to authenticated
  using (
    (select auth_is_admin())
    or id = (select auth_warehouse_id())
  );

drop policy if exists sort_walls_select on sort_walls;
create policy sort_walls_select
  on sort_walls for select
  to authenticated
  using (
    (select auth_is_admin())
    or warehouse_id = (select auth_warehouse_id())
  );

drop policy if exists pigeon_holes_select on pigeon_holes;
create policy pigeon_holes_select
  on pigeon_holes for select
  to authenticated
  using (
    (select auth_is_admin())
    or sort_wall_id in (select id from sort_walls where warehouse_id = (select auth_warehouse_id()))
    or sort_wall_id in (
      select o.sort_wall_id from orders o
      where o.assigned_picker_id = (select auth.uid()) and o.sort_wall_id is not null
    )
  );

-- ----------------------------------------------------------------------------
-- qr_codes
-- ----------------------------------------------------------------------------

drop policy if exists qr_codes_select on qr_codes;
create policy qr_codes_select
  on qr_codes for select
  to authenticated
  using (
    (select auth_is_admin())
    or (
      code_type = 'bag'
      and entity_id in (select id from orders where assigned_picker_id = (select auth.uid()))
    )
    or (
      code_type = 'pigeon_hole'
      and entity_id in (
        select ph.id from pigeon_holes ph
        join sort_walls sw on sw.id = ph.sort_wall_id
        where sw.warehouse_id = (select auth_warehouse_id())
           or ph.sort_wall_id in (
             select o.sort_wall_id from orders o
             where o.assigned_picker_id = (select auth.uid()) and o.sort_wall_id is not null
           )
      )
    )
    or (code_type = 'warehouse_gate' and (select auth_role()) is not null)
  );

-- ----------------------------------------------------------------------------
-- stores
-- ----------------------------------------------------------------------------

drop policy if exists stores_select on stores;
create policy stores_select
  on stores for select
  to authenticated
  using ((select auth_is_warehouse_role()) or (select auth_role()) = 'picker');

-- ----------------------------------------------------------------------------
-- orders — current definition per 0010_auto_assignment_manpower.sql (the
-- earlier "picker sees all available offers" clause from 0002_rls.sql was
-- intentionally dropped there and must not be reintroduced here).
-- ----------------------------------------------------------------------------

drop policy if exists orders_select on orders;
create policy orders_select
  on orders for select
  to authenticated
  using (
    (select auth_is_admin())
    or assigned_picker_id = (select auth.uid())
    or (
      (select auth_is_warehouse_role())
      and (warehouse_id = (select auth_warehouse_id()) or warehouse_id is null)
    )
  );

-- ----------------------------------------------------------------------------
-- order_bags / bag_scans
-- ----------------------------------------------------------------------------

drop policy if exists order_bags_select on order_bags;
create policy order_bags_select
  on order_bags for select
  to authenticated
  using (
    (select auth_is_admin())
    or order_id in (select id from orders where assigned_picker_id = (select auth.uid()))
    or (
      (select auth_is_warehouse_role())
      and order_id in (select id from orders where warehouse_id = (select auth_warehouse_id()))
    )
  );

drop policy if exists bag_scans_select on bag_scans;
create policy bag_scans_select
  on bag_scans for select
  to authenticated
  using (
    (select auth_is_admin())
    or actor_user_id = (select auth.uid())
    or order_id in (select id from orders where assigned_picker_id = (select auth.uid()))
    or (
      (select auth_is_warehouse_role())
      and order_id in (select id from orders where warehouse_id = (select auth_warehouse_id()))
    )
  );

-- ----------------------------------------------------------------------------
-- pigeon_hole_assignments
-- ----------------------------------------------------------------------------

drop policy if exists pha_select on pigeon_hole_assignments;
create policy pha_select
  on pigeon_hole_assignments for select
  to authenticated
  using (
    (select auth_is_admin())
    or pigeon_hole_id in (
      select ph.id from pigeon_holes ph
      join sort_walls sw on sw.id = ph.sort_wall_id
      where sw.warehouse_id = (select auth_warehouse_id())
    )
    or order_id in (select id from orders where assigned_picker_id = (select auth.uid()))
  );

-- ----------------------------------------------------------------------------
-- delivery_partners / delivery_assignments
-- ----------------------------------------------------------------------------

drop policy if exists delivery_partners_select on delivery_partners;
create policy delivery_partners_select
  on delivery_partners for select
  to authenticated
  using ((select auth_is_warehouse_role()));

drop policy if exists delivery_assignments_select on delivery_assignments;
create policy delivery_assignments_select
  on delivery_assignments for select
  to authenticated
  using (
    (select auth_is_admin())
    or order_id in (select id from orders where warehouse_id = (select auth_warehouse_id()))
  );

-- ----------------------------------------------------------------------------
-- status_history / audit_logs / notifications
-- ----------------------------------------------------------------------------

drop policy if exists status_history_select on status_history;
create policy status_history_select
  on status_history for select
  to authenticated
  using (
    (select auth_is_admin())
    or (
      entity_type = 'order'
      and entity_id in (
        select id from orders
        where assigned_picker_id = (select auth.uid())
           or ((select auth_is_warehouse_role()) and warehouse_id = (select auth_warehouse_id()))
      )
    )
    or (select auth_is_warehouse_role())
  );

drop policy if exists audit_logs_select on audit_logs;
create policy audit_logs_select
  on audit_logs for select
  to authenticated
  using ((select auth_is_ops_or_admin()));

drop policy if exists notifications_select_own on notifications;
create policy notifications_select_own
  on notifications for select
  to authenticated
  using (recipient_user_id = (select auth.uid()));

-- ----------------------------------------------------------------------------
-- operations_configuration (0006_operations_capacity_and_qr.sql) / zones
-- (0010_auto_assignment_manpower.sql)
-- ----------------------------------------------------------------------------

drop policy if exists operations_configuration_admin_select on operations_configuration;
create policy operations_configuration_admin_select
  on operations_configuration for select
  to authenticated
  using ((select auth_is_admin()));

drop policy if exists zones_authenticated_select on zones;
create policy zones_authenticated_select
  on zones for select
  to authenticated
  using ((select auth.uid()) is not null);

-- ----------------------------------------------------------------------------
-- A general (non-partial) index for the full notifications_select_own scan
-- — the existing notifications_recipient_unread_idx only covers unread rows.
-- ----------------------------------------------------------------------------

create index if not exists notifications_recipient_idx on notifications(recipient_user_id);

-- ----------------------------------------------------------------------------
-- "Function Search Path Mutable" — a handful of small helper functions were
-- created without `set search_path`, which the advisor flags as a hardening
-- gap (an unqualified identifier inside the function body could otherwise be
-- hijacked by a caller-controlled search_path). None of these reference
-- unqualified table/function names beyond Postgres built-ins, so this is a
-- defense-in-depth fix, not a behaviour change.
-- ----------------------------------------------------------------------------

create or replace function set_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function pigeon_hole_hold_ttl_v1()
returns interval
language sql
immutable
set search_path = public, pg_temp
as $$ select interval '30 minutes' $$;

create or replace function admin_normalise_picker_phone_v1(p_phone text)
returns text
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_raw text := trim(coalesce(p_phone, ''));
  v_digits text;
begin
  if v_raw = '' then
    return null;
  end if;

  v_raw := regexp_replace(v_raw, '[^\d+]', '', 'g');
  -- Already E.164.
  if v_raw ~ '^\+[1-9]\d{7,14}$' then
    return v_raw;
  end if;

  v_digits := regexp_replace(v_raw, '\D', '', 'g');
  -- Strip international access prefix 00.
  if v_digits ~ '^00[1-9]\d{7,14}$' then
    v_digits := substr(v_digits, 3);
  end if;

  -- Mall default: UAE local 05XXXXXXXX / 5XXXXXXXX -> +9715XXXXXXXX.
  if v_digits ~ '^0?5\d{8}$' then
    return '+971' || regexp_replace(v_digits, '^0', '');
  end if;

  -- Country code without +: 9715XXXXXXXX or any 8–15 digit international number.
  if v_digits ~ '^[1-9]\d{7,14}$' then
    return '+' || v_digits;
  end if;

  return null;
end;
$$;

notify pgrst, 'reload schema';
