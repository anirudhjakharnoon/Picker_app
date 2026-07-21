-- ============================================================================
-- 0002_rls.sql
-- Row Level Security. RLS is the actual backend authorization boundary for
-- this app (the PWA talks to Supabase directly with only the public anon
-- key) — see docs/TECHNICAL_DESIGN_DOCUMENT.md Section 11.6.
--
-- Default posture: RLS enabled on every table, no anonymous access, no
-- direct client mutation of state-machine tables (those go through the
-- SECURITY DEFINER RPC functions in 0003_functions.sql instead).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Helper functions (STABLE, SECURITY INVOKER — read only the caller's own
-- profile row, which is exactly what RLS on `profiles` already permits).
-- ----------------------------------------------------------------------------

create or replace function auth_role()
returns user_role
language sql
stable
security invoker
set search_path = public
as $$
  select role from profiles where id = auth.uid();
$$;

create or replace function auth_warehouse_id()
returns uuid
language sql
stable
security invoker
set search_path = public
as $$
  select warehouse_id from profiles where id = auth.uid();
$$;

create or replace function auth_is_ops_or_admin()
returns boolean
language sql
stable
security invoker
set search_path = public
as $$
  select coalesce(auth_role() in ('ops_manager', 'admin'), false);
$$;

create or replace function auth_is_warehouse_role()
returns boolean
language sql
stable
security invoker
set search_path = public
as $$
  select coalesce(auth_role() in ('warehouse_staff', 'ops_manager', 'admin'), false);
$$;

create or replace function auth_is_admin()
returns boolean
language sql
stable
security invoker
set search_path = public
as $$
  select coalesce(auth_role() = 'admin', false);
$$;

-- ----------------------------------------------------------------------------
-- Enable RLS everywhere
-- ----------------------------------------------------------------------------

alter table warehouses enable row level security;
alter table sort_walls enable row level security;
alter table pigeon_holes enable row level security;
alter table qr_codes enable row level security;
alter table profiles enable row level security;
alter table stores enable row level security;
alter table orders enable row level security;
alter table order_bags enable row level security;
alter table bag_scans enable row level security;
alter table pigeon_hole_assignments enable row level security;
alter table delivery_partners enable row level security;
alter table delivery_assignments enable row level security;
alter table status_history enable row level security;
alter table audit_logs enable row level security;
alter table notifications enable row level security;

-- ----------------------------------------------------------------------------
-- profiles
-- ----------------------------------------------------------------------------

create policy profiles_select_own
  on profiles for select
  using (id = auth.uid() or auth_is_ops_or_admin());

create policy profiles_update_own_presence
  on profiles for update
  using (id = auth.uid())
  with check (id = auth.uid());
-- NOTE: this policy allows a picker to update their own row (e.g. is_online,
-- current_lat/lng, home_zone). It intentionally does NOT allow a user to
-- change their own `role`, `is_super_admin`, or `warehouse_id` — those are
-- blocked by application code (Section 12.5: admin-only, dashboard/RPC-only)
-- until a dedicated role-change RPC with server-side checks exists.

-- ----------------------------------------------------------------------------
-- warehouses / sort_walls / pigeon_holes — read scoped by warehouse, no
-- direct client writes (configuration changes go through Admin RPCs later).
-- ----------------------------------------------------------------------------

create policy warehouses_select
  on warehouses for select
  using (
    auth_is_admin()
    or id = auth_warehouse_id()
  );

create policy sort_walls_select
  on sort_walls for select
  using (
    auth_is_admin()
    or warehouse_id = auth_warehouse_id()
  );

create policy pigeon_holes_select
  on pigeon_holes for select
  using (
    auth_is_admin()
    or sort_wall_id in (select id from sort_walls where warehouse_id = auth_warehouse_id())
    -- Pickers must also see holes for the warehouse they are currently
    -- delivering to, even if their profile's home warehouse differs.
    or sort_wall_id in (
      select o.sort_wall_id from orders o
      where o.assigned_picker_id = auth.uid() and o.sort_wall_id is not null
    )
  );

-- ----------------------------------------------------------------------------
-- qr_codes — never directly writable by clients; readable only insofar as a
-- picker/staff member needs to validate a scan client-side. We deliberately
-- keep this narrow: pickers can only read codes tied to their own assigned
-- orders or to pigeon holes in their current warehouse context.
-- ----------------------------------------------------------------------------

create policy qr_codes_select
  on qr_codes for select
  using (
    auth_is_admin()
    or (
      code_type = 'bag'
      and entity_id in (select id from orders where assigned_picker_id = auth.uid())
    )
    or (
      code_type = 'pigeon_hole'
      and entity_id in (
        select ph.id from pigeon_holes ph
        join sort_walls sw on sw.id = ph.sort_wall_id
        where sw.warehouse_id = auth_warehouse_id()
           or ph.sort_wall_id in (
             select o.sort_wall_id from orders o
             where o.assigned_picker_id = auth.uid() and o.sort_wall_id is not null
           )
      )
    )
    or (code_type = 'warehouse_gate' and auth_role() is not null)
  );

-- ----------------------------------------------------------------------------
-- stores — read-only for warehouse/ops/admin roles (needed for order context)
-- ----------------------------------------------------------------------------

create policy stores_select
  on stores for select
  using (auth_is_warehouse_role() or auth_role() = 'picker');

-- ----------------------------------------------------------------------------
-- orders — the central authorization surface.
-- Picker: only their own currently assigned orders (or ones they historically
--         handled, so their own history remains visible after handoff).
-- Warehouse staff / ops: orders routed to their warehouse.
-- Admin: everything.
-- ----------------------------------------------------------------------------

create policy orders_select
  on orders for select
  using (
    auth_is_admin()
    or assigned_picker_id = auth.uid()
    or (auth_role() = 'picker' and status = 'available') -- unassigned offers a picker can accept
    or (auth_is_warehouse_role() and warehouse_id = auth_warehouse_id())
    or (auth_is_warehouse_role() and warehouse_id is null) -- not yet routed to a warehouse; ops needs visibility to triage
  );

-- No direct insert/update/delete policies on `orders` for any client role.
-- All order state transitions go through SECURITY DEFINER RPCs so that the
-- state machine (Section 6) and single-active-hole-reservation invariants
-- can never be bypassed by a raw table write from the browser.

-- ----------------------------------------------------------------------------
-- order_bags — read scoped the same way as their parent order.
-- ----------------------------------------------------------------------------

create policy order_bags_select
  on order_bags for select
  using (
    auth_is_admin()
    or order_id in (select id from orders where assigned_picker_id = auth.uid())
    or (auth_is_warehouse_role() and order_id in (
      select id from orders where warehouse_id = auth_warehouse_id()
    ))
  );

-- ----------------------------------------------------------------------------
-- bag_scans — pickers/staff may read their own scans and scans for orders
-- they can see; no direct insert (must go through scan_bag_v1 RPC).
-- ----------------------------------------------------------------------------

create policy bag_scans_select
  on bag_scans for select
  using (
    auth_is_admin()
    or actor_user_id = auth.uid()
    or order_id in (select id from orders where assigned_picker_id = auth.uid())
    or (auth_is_warehouse_role() and order_id in (
      select id from orders where warehouse_id = auth_warehouse_id()
    ))
  );

-- ----------------------------------------------------------------------------
-- pigeon_hole_assignments — read scoped like pigeon_holes.
-- ----------------------------------------------------------------------------

create policy pha_select
  on pigeon_hole_assignments for select
  using (
    auth_is_admin()
    or pigeon_hole_id in (
      select ph.id from pigeon_holes ph
      join sort_walls sw on sw.id = ph.sort_wall_id
      where sw.warehouse_id = auth_warehouse_id()
    )
    or order_id in (select id from orders where assigned_picker_id = auth.uid())
  );

-- ----------------------------------------------------------------------------
-- delivery_partners / delivery_assignments — warehouse-role read; mutations
-- via RPC only (force-assign must be audited).
-- ----------------------------------------------------------------------------

create policy delivery_partners_select
  on delivery_partners for select
  using (auth_is_warehouse_role());

create policy delivery_assignments_select
  on delivery_assignments for select
  using (
    auth_is_admin()
    or order_id in (select id from orders where warehouse_id = auth_warehouse_id())
  );

-- ----------------------------------------------------------------------------
-- status_history — read scoped like the underlying order; never client-writable.
-- ----------------------------------------------------------------------------

create policy status_history_select
  on status_history for select
  using (
    auth_is_admin()
    or (
      entity_type = 'order'
      and entity_id in (
        select id from orders
        where assigned_picker_id = auth.uid()
           or (auth_is_warehouse_role() and warehouse_id = auth_warehouse_id())
      )
    )
    or auth_is_warehouse_role()
  );

-- ----------------------------------------------------------------------------
-- audit_logs — ops/admin read-only; never updatable/deletable by anyone
-- (no update/delete policy exists at all, which means RLS denies it by
-- default even for the table owner via PostgREST/anon+authenticated roles).
-- ----------------------------------------------------------------------------

create policy audit_logs_select
  on audit_logs for select
  using (auth_is_ops_or_admin());

-- ----------------------------------------------------------------------------
-- notifications — a user can only see and mark-read their own notifications.
-- ----------------------------------------------------------------------------

create policy notifications_select_own
  on notifications for select
  using (recipient_user_id = auth.uid());

create policy notifications_update_own_read
  on notifications for update
  using (recipient_user_id = auth.uid())
  with check (recipient_user_id = auth.uid());
