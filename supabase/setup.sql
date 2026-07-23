-- ============================================================================
-- GENERATED FILE — beginner one-click Supabase setup
--
-- Paste this entire file into Supabase Dashboard > SQL Editor > New query,
-- then click Run. The numbered files in supabase/migrations/ are the source
-- of truth; regenerate this file with:
--   node scripts/build-supabase-setup.mjs
--
-- Generated from:
--   - 0001_schema.sql
--   - 0002_rls.sql
--   - 0003_functions.sql
--   - 0004_security_hardening.sql
--   - 0005_order_fragile.sql
--   - 0006_operations_capacity_and_qr.sql
--   - 0007_fix_reset_orders_safe_update.sql
--   - 0008_hole_first_sorting_flow.sql
--   - 0009_fix_reset_orders_safe_delete.sql
--   - 0010_auto_assignment_manpower.sql
--   - 0011_admin_create_picker.sql
--   - 0012_picker_create_clear_errors.sql
--   - 0013_ensure_order_is_fragile.sql
--   - 0014_bag_scan_mode.sql
--   - 0015_picker_chosen_holes.sql
-- ============================================================================


-- ======================== BEGIN 0001_schema.sql ========================

-- ============================================================================
-- 0001_schema.sql
-- Core MVP schema for the Picker / Sort Wall platform.
-- Free-tier (Supabase Free) scope: relational schema only, no paid extensions.
-- See docs/TECHNICAL_DESIGN_DOCUMENT.md Section 5 for the full rationale.
-- ============================================================================

create extension if not exists "pgcrypto";

-- ----------------------------------------------------------------------------
-- Enums
-- ----------------------------------------------------------------------------

create type user_role as enum ('picker', 'warehouse_staff', 'ops_manager', 'admin');
create type user_status as enum ('active', 'suspended', 'offboarded');

create type store_status as enum ('active', 'paused', 'offboarded');

create type qr_code_type as enum ('bag', 'pigeon_hole', 'warehouse_gate');
create type qr_code_status as enum ('active', 'revoked', 'expired');
create type qr_mode as enum ('shared_order', 'unique_bag');

create type order_status as enum (
  'ingested',
  'available',
  'assigned',
  'picking_in_progress',
  'picked',
  'in_transit_to_warehouse',
  'arrived_at_warehouse',
  'sorting_in_progress',
  'sorted',
  'ready_for_dispatch',
  'delivery_assigned',
  'dispatched',
  'completed',
  'cancelled',
  'exception_missing_bag',
  'exception_partial_sort'
);

create type order_bag_status as enum (
  'expected', 'picked_up', 'sorted', 'dispatched', 'missing', 'lost'
);

create type sort_wall_status as enum ('active', 'inactive');
create type pigeon_hole_status as enum (
  'free', 'reserved', 'partially_filled', 'filled', 'out_of_service'
);
create type pigeon_hole_assignment_status as enum (
  'reserved', 'active', 'freed', 'reallocated'
);

create type scan_type as enum ('pickup', 'warehouse_arrival', 'sort', 'manual_correction');
create type scanned_entity_type as enum ('bag', 'pigeon_hole', 'warehouse_gate');

create type status_history_entity_type as enum (
  'order', 'order_bag', 'pigeon_hole', 'picker_assignment', 'delivery_assignment'
);

create type notification_channel as enum ('in_app', 'web_push');
create type notification_status as enum ('queued', 'sent', 'delivered', 'read', 'failed');

create type delivery_assignment_status as enum (
  'assigned', 'accepted', 'arrived', 'collected', 'delivered', 'failed', 'reassigned'
);

-- ----------------------------------------------------------------------------
-- Warehouses / Sort Walls / Pigeon Holes
-- ----------------------------------------------------------------------------

create table warehouses (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  address text,
  status sort_wall_status not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table sort_walls (
  id uuid primary key default gen_random_uuid(),
  warehouse_id uuid not null references warehouses(id) on delete cascade,
  name text not null,
  rows smallint not null default 1,
  columns smallint not null default 1,
  status sort_wall_status not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index sort_walls_warehouse_id_idx on sort_walls(warehouse_id);

-- ----------------------------------------------------------------------------
-- QR codes (generic registry: bag / pigeon_hole / warehouse_gate)
-- ----------------------------------------------------------------------------

create table qr_codes (
  id uuid primary key default gen_random_uuid(),
  code_type qr_code_type not null,
  code_value text not null,
  code_version smallint not null default 1,
  entity_id uuid, -- polymorphic: orders.id (shared v1), order_bags.id (future), pigeon_holes.id, warehouses.id
  status qr_code_status not null default 'active',
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  constraint qr_codes_code_value_key unique (code_value)
);
create index qr_codes_type_entity_idx on qr_codes(code_type, entity_id);

create table pigeon_holes (
  id uuid primary key default gen_random_uuid(),
  sort_wall_id uuid not null references sort_walls(id) on delete cascade,
  hole_number text not null,
  qr_code_id uuid references qr_codes(id),
  status pigeon_hole_status not null default 'free',
  priority_reserved boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pigeon_holes_wall_number_key unique (sort_wall_id, hole_number)
);
create index pigeon_holes_status_idx on pigeon_holes(status);
create index pigeon_holes_wall_idx on pigeon_holes(sort_wall_id);

-- NOTE: qr_codes.entity_id is intentionally polymorphic (order, order_bag,
-- pigeon_hole, or warehouse depending on code_type) and therefore has no
-- single foreign key constraint. Referential integrity for entity_id is
-- enforced in application/RPC code, not the schema, by design (Section 5.3.4
-- of docs/TECHNICAL_DESIGN_DOCUMENT.md).

-- ----------------------------------------------------------------------------
-- Profiles (extends auth.users) — role & warehouse scope live here, never in
-- client-editable auth metadata.
-- ----------------------------------------------------------------------------

create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  full_name text,
  role user_role not null default 'picker',
  status user_status not null default 'active',
  warehouse_id uuid references warehouses(id),
  is_online boolean not null default false,
  current_lat double precision,
  current_lng double precision,
  home_zone text,
  max_concurrent_orders smallint not null default 3,
  is_super_admin boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index profiles_role_idx on profiles(role);
create index profiles_online_idx on profiles(is_online) where is_online = true;
create index profiles_warehouse_idx on profiles(warehouse_id);

-- ----------------------------------------------------------------------------
-- Stores / Orders / Order Bags
-- ----------------------------------------------------------------------------

create table stores (
  id uuid primary key default gen_random_uuid(),
  external_ref text not null unique,
  name text not null,
  default_zone text,
  status store_status not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table orders (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores(id),
  external_order_ref text not null,
  bag_count_expected smallint not null check (bag_count_expected > 0),
  bag_count_scanned_pickup smallint not null default 0,
  bag_count_scanned_sort smallint not null default 0,
  store_floor text,
  store_zone text,
  store_address text,
  qr_mode qr_mode not null default 'shared_order',
  shared_bag_qr_code_id uuid references qr_codes(id),
  status order_status not null default 'ingested',
  assigned_picker_id uuid references profiles(id),
  warehouse_id uuid references warehouses(id),
  sort_wall_id uuid references sort_walls(id),
  pigeon_hole_id uuid references pigeon_holes(id),
  priority smallint not null default 0,
  packed_ready_at timestamptz,
  ingested_at timestamptz not null default now(),
  assigned_at timestamptz,
  picked_at timestamptz,
  warehouse_arrived_at timestamptz,
  sorted_at timestamptz,
  dispatched_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint orders_store_external_ref_key unique (store_id, external_order_ref)
);
create index orders_status_idx on orders(status);
create index orders_assigned_picker_idx on orders(assigned_picker_id);
create index orders_warehouse_idx on orders(warehouse_id);
create index orders_status_ingested_idx on orders(status, ingested_at);

create table order_bags (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id) on delete cascade,
  bag_sequence smallint not null,
  status order_bag_status not null default 'expected',
  qr_code_id uuid references qr_codes(id),
  picked_up_at timestamptz,
  sorted_at timestamptz,
  dispatched_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint order_bags_order_sequence_key unique (order_id, bag_sequence)
);
create index order_bags_order_idx on order_bags(order_id);
create index order_bags_status_idx on order_bags(status);

-- ----------------------------------------------------------------------------
-- Bag scans (immutable event log — never updated after insert)
-- ----------------------------------------------------------------------------

create table bag_scans (
  id uuid primary key default gen_random_uuid(),
  client_event_id uuid not null unique,
  order_id uuid not null references orders(id),
  order_bag_id uuid references order_bags(id),
  qr_code_id uuid references qr_codes(id),
  pigeon_hole_id uuid references pigeon_holes(id),
  scan_type scan_type not null,
  scanned_entity_type scanned_entity_type not null,
  actor_user_id uuid not null references profiles(id),
  device_id text,
  gps_lat double precision,
  gps_lng double precision,
  client_captured_at timestamptz not null,
  created_at timestamptz not null default now(),
  is_valid boolean not null default true,
  rejection_reason text
);
create index bag_scans_order_idx on bag_scans(order_id);
create index bag_scans_actor_idx on bag_scans(actor_user_id);
create index bag_scans_type_created_idx on bag_scans(scan_type, created_at);

-- ----------------------------------------------------------------------------
-- Pigeon hole assignments (order <-> hole reservation lifecycle)
-- ----------------------------------------------------------------------------

create table pigeon_hole_assignments (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id),
  pigeon_hole_id uuid not null references pigeon_holes(id),
  status pigeon_hole_assignment_status not null default 'reserved',
  reserved_at timestamptz not null default now(),
  filled_at timestamptz,
  freed_at timestamptz,
  reallocated_from_id uuid references pigeon_hole_assignments(id)
);
create index pha_pigeon_hole_idx on pigeon_hole_assignments(pigeon_hole_id);
create index pha_order_idx on pigeon_hole_assignments(order_id);
create index pha_status_idx on pigeon_hole_assignments(status);
-- Only one active reservation per order at a time.
create unique index pha_one_active_per_order
  on pigeon_hole_assignments(order_id)
  where status in ('reserved', 'active');

-- ----------------------------------------------------------------------------
-- Delivery partners / assignments (manual-only in the free MVP)
-- ----------------------------------------------------------------------------

create table delivery_partners (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  status store_status not null default 'active',
  created_at timestamptz not null default now()
);

create table delivery_assignments (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id),
  delivery_partner_id uuid references delivery_partners(id),
  status delivery_assignment_status not null default 'assigned',
  assigned_by_user_id uuid references profiles(id),
  is_force_assigned boolean not null default false,
  notes text,
  assigned_at timestamptz not null default now(),
  collected_at timestamptz,
  delivered_at timestamptz
);
create index da_order_idx on delivery_assignments(order_id);
create index da_status_idx on delivery_assignments(status);

-- ----------------------------------------------------------------------------
-- Status history (polymorphic audit trail) & Audit logs (admin/config actions)
-- ----------------------------------------------------------------------------

create table status_history (
  id uuid primary key default gen_random_uuid(),
  entity_type status_history_entity_type not null,
  entity_id uuid not null,
  from_status text,
  to_status text not null,
  actor_type text not null default 'system' check (actor_type in ('system', 'user')),
  actor_user_id uuid references profiles(id),
  reason text,
  created_at timestamptz not null default now()
);
create index status_history_entity_idx on status_history(entity_type, entity_id, created_at);

create table audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid references profiles(id),
  action text not null,
  target_type text,
  target_id uuid,
  metadata jsonb,
  created_at timestamptz not null default now()
);
create index audit_logs_actor_idx on audit_logs(actor_user_id);
create index audit_logs_target_idx on audit_logs(target_type, target_id);

-- ----------------------------------------------------------------------------
-- Notifications (durable in-app inbox — no paid provider in free MVP)
-- ----------------------------------------------------------------------------

create table notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_user_id uuid not null references profiles(id),
  channel notification_channel not null default 'in_app',
  template text not null,
  payload jsonb not null default '{}'::jsonb,
  status notification_status not null default 'queued',
  created_at timestamptz not null default now(),
  read_at timestamptz
);
create index notifications_recipient_unread_idx
  on notifications(recipient_user_id, created_at)
  where read_at is null;

-- ----------------------------------------------------------------------------
-- updated_at maintenance trigger (generic, reused by every table with the column)
-- ----------------------------------------------------------------------------

create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

do $$
declare
  t text;
begin
  for t in select unnest(array[
    'warehouses','sort_walls','pigeon_holes','profiles','stores',
    'orders','order_bags'
  ]) loop
    execute format(
      'create trigger set_updated_at before update on %I for each row execute function set_updated_at()',
      t
    );
  end loop;
end $$;

-- ========================= END 0001_schema.sql =========================


-- ======================== BEGIN 0002_rls.sql ========================

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

-- ========================= END 0002_rls.sql =========================


-- ======================== BEGIN 0003_functions.sql ========================

-- ============================================================================
-- 0003_functions.sql
-- Transactional business logic as Postgres RPC functions.
--
-- All correctness-critical, multi-step operations (scans, hole allocation,
-- assignment acceptance) live here as SECURITY DEFINER functions rather than
-- being assembled from several raw client-side table writes. Each function:
--   - validates the caller's role/ownership explicitly (never trusts the
--     client to only call it "correctly"),
--   - sets a safe search_path (defends against search_path hijacking),
--   - performs its state transition + status_history/audit row in one
--     transaction, and
--   - is versioned by name (`_v1`) so a future breaking change ships as
--     `_v2` without invalidating an already-open cached client tab
--     (docs/TECHNICAL_DESIGN_DOCUMENT.md Section 7.1).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Auto-provision a profile row whenever an Auth user is created.
-- The account itself is still created by a trusted Admin (Supabase Dashboard
-- or, later, an Edge Function using the service-role key) — this trigger
-- only saves the manual "insert into profiles" step. Role defaults to
-- 'picker' and MUST be corrected by an Admin after creation; it is
-- intentionally not settable by the new user themselves.
-- ----------------------------------------------------------------------------

create or replace function handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into profiles (id, email, full_name, role, status)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', new.email),
    'picker',
    'active'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_auth_user();

-- ----------------------------------------------------------------------------
-- set_picker_status_v1 — online/offline toggle + optional location ping.
-- ----------------------------------------------------------------------------

create or replace function set_picker_status_v1(
  p_is_online boolean,
  p_lat double precision default null,
  p_lng double precision default null
)
returns profiles
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile profiles;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  update profiles
  set is_online = p_is_online,
      current_lat = coalesce(p_lat, current_lat),
      current_lng = coalesce(p_lng, current_lng),
      updated_at = now()
  where id = auth.uid()
  returning * into v_profile;

  if v_profile is null then
    raise exception 'profile not found for current user';
  end if;

  return v_profile;
end;
$$;

grant execute on function set_picker_status_v1(boolean, double precision, double precision) to authenticated;

-- ----------------------------------------------------------------------------
-- accept_order_v1 — atomic, race-safe assignment acceptance
-- (docs Section 3.3 / 6.1: AVAILABLE -> ASSIGNED, WHERE assigned_picker_id IS NULL)
-- ----------------------------------------------------------------------------

create or replace function accept_order_v1(p_order_id uuid)
returns orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order orders;
  v_caller_role user_role;
begin
  v_caller_role := (select role from profiles where id = auth.uid());
  if v_caller_role is distinct from 'picker' then
    raise exception 'only pickers can accept orders' using errcode = '42501';
  end if;

  update orders
  set status = 'assigned',
      assigned_picker_id = auth.uid(),
      assigned_at = now(),
      updated_at = now()
  where id = p_order_id
    and status = 'available'
    and assigned_picker_id is null
  returning * into v_order;

  if v_order is null then
    raise exception 'order already assigned or not available' using errcode = '40001';
  end if;

  insert into status_history (entity_type, entity_id, from_status, to_status, actor_type, actor_user_id)
  values ('order', p_order_id, 'available', 'assigned', 'user', auth.uid());

  return v_order;
end;
$$;

grant execute on function accept_order_v1(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- decline_order_v1 — picker explicitly declines an offer assigned to them
-- (only meaningful once an assignment model pushes offers directly; kept for
-- forward-compatibility with docs Section 3.3).
-- ----------------------------------------------------------------------------

create or replace function decline_order_v1(p_order_id uuid)
returns orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order orders;
begin
  update orders
  set status = 'available',
      assigned_picker_id = null,
      assigned_at = null,
      updated_at = now()
  where id = p_order_id
    and assigned_picker_id = auth.uid()
    and status = 'assigned'
  returning * into v_order;

  if v_order is null then
    raise exception 'order not found or not assigned to caller';
  end if;

  insert into status_history (entity_type, entity_id, from_status, to_status, actor_type, actor_user_id, reason)
  values ('order', p_order_id, 'assigned', 'available', 'user', auth.uid(), 'declined by picker');

  return v_order;
end;
$$;

grant execute on function decline_order_v1(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- scan_bag_pickup_v1 — records a PICKUP scan against the shared order-level
-- QR code. Each valid scan claims the next EXPECTED logical bag slot until
-- bag_count_expected is reached (docs Section 3.4/9.1: this proves M scan
-- actions against the correct order code, NOT M distinct physical bags).
-- ----------------------------------------------------------------------------

create or replace function scan_bag_pickup_v1(
  p_client_event_id uuid,
  p_order_id uuid,
  p_qr_code_value text,
  p_client_captured_at timestamptz,
  p_gps_lat double precision default null,
  p_gps_lng double precision default null,
  p_device_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order orders;
  v_qr qr_codes;
  v_bag order_bags;
  v_existing bag_scans;
begin
  -- Idempotency: a retried request with the same client_event_id returns the
  -- original result rather than creating a second event or double-counting.
  -- NOTE: bag_scans has several nullable columns (order_bag_id, qr_code_id,
  -- pigeon_hole_id, gps_lat/lng, ...), so a composite-row `IS NOT NULL` check
  -- would be wrong here: for a row type, `IS NOT NULL` only evaluates true
  -- when EVERY field is non-null, not "a row was found" (PL/pgSQL row-value
  -- NULL semantics follow the SQL standard's row comparison rules, not
  -- "was this SELECT INTO populated"). We check the non-nullable primary
  -- key column instead, which is always non-null exactly when a row exists.
  select * into v_existing from bag_scans where client_event_id = p_client_event_id;
  if v_existing.id is not null then
    select * into v_order from orders where id = v_existing.order_id;
    return jsonb_build_object(
      'order_bag_id', v_existing.order_bag_id,
      'scanned', v_order.bag_count_scanned_pickup,
      'expected', v_order.bag_count_expected,
      'order_status', v_order.status,
      'idempotent_replay', true
    );
  end if;

  select * into v_order from orders where id = p_order_id for update;
  if v_order is null then
    raise exception 'order not found' using errcode = 'P0002';
  end if;
  if v_order.assigned_picker_id is distinct from auth.uid() then
    raise exception 'order not assigned to caller' using errcode = '42501';
  end if;
  if v_order.status not in ('assigned', 'picking_in_progress') then
    raise exception 'order is not in a pickable state (status=%)', v_order.status using errcode = '40001';
  end if;

  select * into v_qr from qr_codes where code_value = p_qr_code_value and status = 'active';
  if v_qr is null then
    raise exception 'qr code not recognized or inactive' using errcode = 'P0002';
  end if;
  if v_qr.code_type <> 'bag' or v_qr.entity_id <> v_order.id then
    raise exception 'qr code does not belong to this order' using errcode = '40001';
  end if;

  if v_order.bag_count_scanned_pickup >= v_order.bag_count_expected then
    raise exception 'expected bag count already reached' using errcode = '40001';
  end if;

  -- Claim the next EXPECTED logical bag slot, locked against concurrent scans.
  select * into v_bag
  from order_bags
  where order_id = p_order_id and status = 'expected'
  order by bag_sequence
  limit 1
  for update skip locked;

  if v_bag is null then
    raise exception 'no remaining expected bag slots for this order' using errcode = '40001';
  end if;

  update order_bags
  set status = 'picked_up', picked_up_at = now(), updated_at = now()
  where id = v_bag.id;

  insert into bag_scans (
    client_event_id, order_id, order_bag_id, qr_code_id,
    scan_type, scanned_entity_type, actor_user_id,
    device_id, gps_lat, gps_lng, client_captured_at
  ) values (
    p_client_event_id, p_order_id, v_bag.id, v_qr.id,
    'pickup', 'bag', auth.uid(),
    p_device_id, p_gps_lat, p_gps_lng, p_client_captured_at
  );

  update orders
  set bag_count_scanned_pickup = bag_count_scanned_pickup + 1,
      status = case
        when bag_count_scanned_pickup + 1 >= bag_count_expected then 'picked'::order_status
        else 'picking_in_progress'::order_status
      end,
      picked_at = case
        when bag_count_scanned_pickup + 1 >= bag_count_expected then now()
        else picked_at
      end,
      updated_at = now()
  where id = p_order_id
  returning * into v_order;

  if v_order.status = 'picked' then
    insert into status_history (entity_type, entity_id, from_status, to_status, actor_type, actor_user_id)
    values ('order', p_order_id, 'picking_in_progress', 'picked', 'system', auth.uid());
  end if;

  return jsonb_build_object(
    'order_bag_id', v_bag.id,
    'bag_sequence', v_bag.bag_sequence,
    'scanned', v_order.bag_count_scanned_pickup,
    'expected', v_order.bag_count_expected,
    'order_status', v_order.status,
    'idempotent_replay', false
  );
end;
$$;

grant execute on function scan_bag_pickup_v1(uuid, uuid, text, timestamptz, double precision, double precision, text) to authenticated;

-- ----------------------------------------------------------------------------
-- scan_bag_for_sort_v1 — during sorting, scanning the bag reveals which
-- pigeon hole it must go to (does not itself change bag/order state).
-- ----------------------------------------------------------------------------

create or replace function scan_bag_for_sort_v1(
  p_client_event_id uuid,
  p_order_id uuid,
  p_qr_code_value text,
  p_client_captured_at timestamptz,
  p_gps_lat double precision default null,
  p_gps_lng double precision default null,
  p_device_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order orders;
  v_qr qr_codes;
  v_hole pigeon_holes;
  v_existing bag_scans;
begin
  -- NOTE: bag_scans has several nullable columns (order_bag_id, qr_code_id,
  -- pigeon_hole_id, gps_lat/lng, ...), so a composite-row `IS NOT NULL` check
  -- would be wrong here: for a row type, `IS NOT NULL` only evaluates true
  -- when EVERY field is non-null, not "a row was found" (PL/pgSQL row-value
  -- NULL semantics follow the SQL standard's row comparison rules, not
  -- "was this SELECT INTO populated"). We check the non-nullable primary
  -- key column instead, which is always non-null exactly when a row exists.
  select * into v_existing from bag_scans where client_event_id = p_client_event_id;
  if v_existing.id is not null then
    select * into v_hole from pigeon_holes where id = v_existing.pigeon_hole_id;
    return jsonb_build_object('pigeon_hole_number', v_hole.hole_number, 'idempotent_replay', true);
  end if;

  select * into v_order from orders where id = p_order_id;
  if v_order is null or v_order.assigned_picker_id is distinct from auth.uid() then
    raise exception 'order not found or not assigned to caller' using errcode = '42501';
  end if;

  select * into v_qr from qr_codes where code_value = p_qr_code_value and status = 'active';
  if v_qr is null or v_qr.code_type <> 'bag' or v_qr.entity_id <> v_order.id then
    raise exception 'qr code not recognized for this order' using errcode = 'P0002';
  end if;

  if v_order.pigeon_hole_id is null then
    -- Overflow: no hole has been reserved for this order yet.
    insert into bag_scans (
      client_event_id, order_id, qr_code_id, scan_type, scanned_entity_type,
      actor_user_id, device_id, gps_lat, gps_lng, client_captured_at, is_valid, rejection_reason
    ) values (
      p_client_event_id, p_order_id, v_qr.id, 'sort', 'bag',
      auth.uid(), p_device_id, p_gps_lat, p_gps_lng, p_client_captured_at, false, 'no_hole_reserved'
    );
    return jsonb_build_object('pigeon_hole_number', null, 'overflow', true);
  end if;

  select * into v_hole from pigeon_holes where id = v_order.pigeon_hole_id;

  insert into bag_scans (
    client_event_id, order_id, qr_code_id, pigeon_hole_id, scan_type, scanned_entity_type,
    actor_user_id, device_id, gps_lat, gps_lng, client_captured_at
  ) values (
    p_client_event_id, p_order_id, v_qr.id, v_hole.id, 'sort', 'bag',
    auth.uid(), p_device_id, p_gps_lat, p_gps_lng, p_client_captured_at
  );

  return jsonb_build_object('pigeon_hole_number', v_hole.hole_number, 'overflow', false);
end;
$$;

grant execute on function scan_bag_for_sort_v1(uuid, uuid, text, timestamptz, double precision, double precision, text) to authenticated;

-- ----------------------------------------------------------------------------
-- scan_pigeon_hole_v1 — confirms physical placement of a bag into its
-- reserved hole. Rejects (server-side, never trusting client state) if the
-- scanned hole does not match the order's active reservation.
-- ----------------------------------------------------------------------------

create or replace function scan_pigeon_hole_v1(
  p_client_event_id uuid,
  p_order_id uuid,
  p_pigeon_hole_qr_value text,
  p_client_captured_at timestamptz,
  p_gps_lat double precision default null,
  p_gps_lng double precision default null,
  p_device_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order orders;
  v_qr qr_codes;
  v_bag order_bags;
  v_hole pigeon_holes;
  v_pha pigeon_hole_assignments;
  v_existing bag_scans;
begin
  -- NOTE: bag_scans has several nullable columns (order_bag_id, qr_code_id,
  -- pigeon_hole_id, gps_lat/lng, ...), so a composite-row `IS NOT NULL` check
  -- would be wrong here: for a row type, `IS NOT NULL` only evaluates true
  -- when EVERY field is non-null, not "a row was found" (PL/pgSQL row-value
  -- NULL semantics follow the SQL standard's row comparison rules, not
  -- "was this SELECT INTO populated"). We check the non-nullable primary
  -- key column instead, which is always non-null exactly when a row exists.
  select * into v_existing from bag_scans where client_event_id = p_client_event_id;
  if v_existing.id is not null then
    select * into v_order from orders where id = v_existing.order_id;
    return jsonb_build_object(
      'order_bag_id', v_existing.order_bag_id,
      'sorted', v_order.bag_count_scanned_sort,
      'expected', v_order.bag_count_expected,
      'order_status', v_order.status,
      'idempotent_replay', true
    );
  end if;

  select * into v_order from orders where id = p_order_id for update;
  if v_order is null or v_order.assigned_picker_id is distinct from auth.uid() then
    raise exception 'order not found or not assigned to caller' using errcode = '42501';
  end if;

  select * into v_qr from qr_codes where code_value = p_pigeon_hole_qr_value and status = 'active';
  if v_qr is null or v_qr.code_type <> 'pigeon_hole' then
    raise exception 'qr code not recognized as a pigeon hole code' using errcode = 'P0002';
  end if;

  if v_order.pigeon_hole_id is null or v_order.pigeon_hole_id <> v_qr.entity_id then
    raise exception 'this hole does not match the reservation for this order' using errcode = '40001';
  end if;

  select * into v_hole from pigeon_holes where id = v_order.pigeon_hole_id for update;

  select * into v_bag
  from order_bags
  where order_id = p_order_id and status = 'picked_up'
  order by bag_sequence
  limit 1
  for update skip locked;

  if v_bag is null then
    raise exception 'no remaining picked-up bags to sort for this order' using errcode = '40001';
  end if;

  update order_bags set status = 'sorted', sorted_at = now(), updated_at = now() where id = v_bag.id;

  insert into bag_scans (
    client_event_id, order_id, order_bag_id, qr_code_id, pigeon_hole_id,
    scan_type, scanned_entity_type, actor_user_id, device_id, gps_lat, gps_lng, client_captured_at
  ) values (
    p_client_event_id, p_order_id, v_bag.id, v_qr.id, v_hole.id,
    'sort', 'pigeon_hole', auth.uid(), p_device_id, p_gps_lat, p_gps_lng, p_client_captured_at
  );

  select * into v_pha from pigeon_hole_assignments
  where order_id = p_order_id and status in ('reserved', 'active') for update;

  if v_pha.id is null then
    raise exception 'no active pigeon hole reservation found for this order — data integrity issue, escalate to ops';
  end if;

  if v_pha.status = 'reserved' then
    update pigeon_hole_assignments set status = 'active' where id = v_pha.id;
    update pigeon_holes set status = 'partially_filled', updated_at = now() where id = v_hole.id;
  end if;

  update orders
  set bag_count_scanned_sort = bag_count_scanned_sort + 1,
      status = case
        when bag_count_scanned_sort + 1 >= bag_count_expected then 'ready_for_dispatch'::order_status
        else 'sorting_in_progress'::order_status
      end,
      sorted_at = case
        when bag_count_scanned_sort + 1 >= bag_count_expected then now()
        else sorted_at
      end,
      updated_at = now()
  where id = p_order_id
  returning * into v_order;

  if v_order.status = 'ready_for_dispatch' then
    update pigeon_holes set status = 'filled', updated_at = now() where id = v_hole.id;
    update pigeon_hole_assignments set status = 'active', filled_at = now()
      where id = v_pha.id;
    insert into status_history (entity_type, entity_id, from_status, to_status, actor_type, actor_user_id)
    values ('order', p_order_id, 'sorting_in_progress', 'ready_for_dispatch', 'system', auth.uid());
  end if;

  return jsonb_build_object(
    'order_bag_id', v_bag.id,
    'bag_sequence', v_bag.bag_sequence,
    'sorted', v_order.bag_count_scanned_sort,
    'expected', v_order.bag_count_expected,
    'order_status', v_order.status,
    'idempotent_replay', false
  );
end;
$$;

grant execute on function scan_pigeon_hole_v1(uuid, uuid, text, timestamptz, double precision, double precision, text) to authenticated;

-- ----------------------------------------------------------------------------
-- record_warehouse_arrival_v1 — proves physical arrival (gate QR) and
-- reserves pigeon holes for every currently-PICKED order the picker is
-- carrying, using FOR UPDATE SKIP LOCKED so concurrent pickers arriving at
-- the same moment never race for the same hole (docs Section 13.2).
-- ----------------------------------------------------------------------------

create type warehouse_arrival_result as (
  order_id uuid,
  pigeon_hole_number text,
  reserved boolean
);

create or replace function record_warehouse_arrival_v1(
  p_client_event_id uuid,
  p_gate_qr_value text,
  p_order_ids uuid[],
  p_client_captured_at timestamptz,
  p_gps_lat double precision default null,
  p_gps_lng double precision default null,
  p_device_id text default null
)
returns setof warehouse_arrival_result
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_gate_qr qr_codes;
  v_warehouse_id uuid;
  v_sort_wall_id uuid;
  v_order_id uuid;
  v_order orders;
  v_hole pigeon_holes;
  v_existing bag_scans;
begin
  -- NOTE: bag_scans has several nullable columns (order_bag_id, qr_code_id,
  -- pigeon_hole_id, gps_lat/lng, ...), so a composite-row `IS NOT NULL` check
  -- would be wrong here: for a row type, `IS NOT NULL` only evaluates true
  -- when EVERY field is non-null, not "a row was found" (PL/pgSQL row-value
  -- NULL semantics follow the SQL standard's row comparison rules, not
  -- "was this SELECT INTO populated"). We check the non-nullable primary
  -- key column instead, which is always non-null exactly when a row exists.
  select * into v_existing from bag_scans where client_event_id = p_client_event_id;
  if v_existing.id is not null then
    -- Idempotent replay: return current reservation state for the same order set.
    return query
      select o.id, ph.hole_number, (o.pigeon_hole_id is not null)
      from orders o
      left join pigeon_holes ph on ph.id = o.pigeon_hole_id
      where o.id = any(p_order_ids);
    return;
  end if;

  select * into v_gate_qr from qr_codes where code_value = p_gate_qr_value and status = 'active';
  if v_gate_qr is null or v_gate_qr.code_type <> 'warehouse_gate' then
    raise exception 'gate qr code not recognized' using errcode = 'P0002';
  end if;
  v_warehouse_id := v_gate_qr.entity_id;

  select id into v_sort_wall_id from sort_walls where warehouse_id = v_warehouse_id and status = 'active' limit 1;
  if v_sort_wall_id is null then
    raise exception 'no active sort wall configured for this warehouse';
  end if;

  insert into bag_scans (
    client_event_id, order_id, qr_code_id, scan_type, scanned_entity_type,
    actor_user_id, device_id, gps_lat, gps_lng, client_captured_at
  ) values (
    p_client_event_id, p_order_ids[1], v_gate_qr.id, 'warehouse_arrival', 'warehouse_gate',
    auth.uid(), p_device_id, p_gps_lat, p_gps_lng, p_client_captured_at
  );

  foreach v_order_id in array p_order_ids loop
    select * into v_order from orders where id = v_order_id for update;
    if v_order is null or v_order.assigned_picker_id is distinct from auth.uid() or v_order.status <> 'picked' then
      continue; -- skip orders that are not this picker's or not yet fully picked
    end if;

    update orders
    set status = 'arrived_at_warehouse',
        warehouse_id = v_warehouse_id,
        sort_wall_id = v_sort_wall_id,
        warehouse_arrived_at = now(),
        updated_at = now()
    where id = v_order_id;

    -- Claim a free hole, skipping any locked by a concurrently-arriving picker.
    select * into v_hole
    from pigeon_holes
    where sort_wall_id = v_sort_wall_id and status = 'free'
    order by hole_number
    limit 1
    for update skip locked;

    if v_hole is null then
      insert into status_history (entity_type, entity_id, from_status, to_status, actor_type, actor_user_id, reason)
      values ('order', v_order_id, 'arrived_at_warehouse', 'arrived_at_warehouse', 'system', auth.uid(), 'sort_wall_full_overflow');
      return query select v_order_id, null::text, false;
      continue;
    end if;

    update pigeon_holes set status = 'reserved', updated_at = now() where id = v_hole.id;
    insert into pigeon_hole_assignments (order_id, pigeon_hole_id, status)
    values (v_order_id, v_hole.id, 'reserved');

    update orders
    set pigeon_hole_id = v_hole.id,
        status = 'sorting_in_progress',
        updated_at = now()
    where id = v_order_id;

    insert into status_history (entity_type, entity_id, from_status, to_status, actor_type, actor_user_id)
    values ('order', v_order_id, 'arrived_at_warehouse', 'sorting_in_progress', 'system', auth.uid());

    return query select v_order_id, v_hole.hole_number, true;
  end loop;
end;
$$;

grant execute on function record_warehouse_arrival_v1(uuid, text, uuid[], timestamptz, double precision, double precision, text) to authenticated;

-- ----------------------------------------------------------------------------
-- report_order_issue_v1 — picker-reported exception (missing bag, wrong
-- count, etc.) so a problem is never silently stuck (docs Section 3.4/12.6).
-- ----------------------------------------------------------------------------

create or replace function report_order_issue_v1(
  p_order_id uuid,
  p_issue_type text,
  p_notes text default null
)
returns orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order orders;
  v_from_status text;
  v_to_status order_status;
begin
  select * into v_order from orders where id = p_order_id for update;
  if v_order is null or v_order.assigned_picker_id is distinct from auth.uid() then
    raise exception 'order not found or not assigned to caller' using errcode = '42501';
  end if;

  v_from_status := v_order.status;
  v_to_status := case
    when v_order.status in ('sorting_in_progress') then 'exception_partial_sort'::order_status
    else 'exception_missing_bag'::order_status
  end;

  update orders set status = v_to_status, updated_at = now() where id = p_order_id returning * into v_order;

  insert into status_history (entity_type, entity_id, from_status, to_status, actor_type, actor_user_id, reason)
  values ('order', p_order_id, v_from_status, v_to_status, 'user', auth.uid(), coalesce(p_issue_type, '') || ': ' || coalesce(p_notes, ''));

  insert into notifications (recipient_user_id, channel, template, payload)
  select p.id, 'in_app', 'order_exception_raised',
         jsonb_build_object('order_id', p_order_id, 'issue_type', p_issue_type, 'notes', p_notes)
  from profiles p
  where p.role in ('ops_manager', 'admin')
    and (p.warehouse_id = v_order.warehouse_id or v_order.warehouse_id is null);

  return v_order;
end;
$$;

grant execute on function report_order_issue_v1(uuid, text, text) to authenticated;

-- ----------------------------------------------------------------------------
-- mark_order_dispatched_v1 — manual delivery-partner handoff (free MVP has
-- no automated partner API; Ops/Staff records the physical collection).
-- ----------------------------------------------------------------------------

create or replace function mark_order_dispatched_v1(
  p_order_id uuid,
  p_delivery_partner_id uuid default null,
  p_reason text default null
)
returns orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order orders;
  v_caller_role user_role;
  v_caller_warehouse uuid;
begin
  v_caller_role := (select role from profiles where id = auth.uid());
  v_caller_warehouse := (select warehouse_id from profiles where id = auth.uid());
  if v_caller_role not in ('warehouse_staff', 'ops_manager', 'admin') then
    raise exception 'not permitted' using errcode = '42501';
  end if;

  select * into v_order from orders where id = p_order_id for update;
  if v_order is null then
    raise exception 'order not found';
  end if;
  if v_caller_role <> 'admin' and v_order.warehouse_id is distinct from v_caller_warehouse then
    raise exception 'order does not belong to caller warehouse' using errcode = '42501';
  end if;
  if v_order.status <> 'ready_for_dispatch' then
    raise exception 'order is not ready for dispatch (status=%)', v_order.status using errcode = '40001';
  end if;

  update orders set status = 'dispatched', dispatched_at = now(), updated_at = now()
  where id = p_order_id returning * into v_order;

  if v_order.pigeon_hole_id is not null then
    update pigeon_holes set status = 'free', updated_at = now() where id = v_order.pigeon_hole_id;
    update pigeon_hole_assignments set status = 'freed', freed_at = now()
      where order_id = p_order_id and status = 'active';
  end if;

  insert into delivery_assignments (order_id, delivery_partner_id, status, assigned_by_user_id, is_force_assigned, notes, collected_at)
  values (p_order_id, p_delivery_partner_id, 'collected', auth.uid(), p_delivery_partner_id is not null, p_reason, now());

  insert into status_history (entity_type, entity_id, from_status, to_status, actor_type, actor_user_id, reason)
  values ('order', p_order_id, 'ready_for_dispatch', 'dispatched', 'user', auth.uid(), p_reason);

  insert into audit_logs (actor_user_id, action, target_type, target_id, metadata)
  values (auth.uid(), 'order.mark_dispatched', 'order', p_order_id, jsonb_build_object('reason', p_reason));

  return v_order;
end;
$$;

grant execute on function mark_order_dispatched_v1(uuid, uuid, text) to authenticated;

-- ----------------------------------------------------------------------------
-- mark_hole_out_of_service_v1 / restore_pigeon_hole_v1 — warehouse hardware
-- exceptions (docs Section 6.3/13.6).
-- ----------------------------------------------------------------------------

create or replace function mark_hole_out_of_service_v1(p_pigeon_hole_id uuid, p_reason text)
returns pigeon_holes
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_hole pigeon_holes;
  v_caller_role user_role;
begin
  v_caller_role := (select role from profiles where id = auth.uid());
  if v_caller_role not in ('warehouse_staff', 'ops_manager', 'admin') then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'reason is required' using errcode = '40001';
  end if;

  update pigeon_holes set status = 'out_of_service', updated_at = now()
  where id = p_pigeon_hole_id returning * into v_hole;

  insert into audit_logs (actor_user_id, action, target_type, target_id, metadata)
  values (auth.uid(), 'pigeon_hole.marked_out_of_service', 'pigeon_hole', p_pigeon_hole_id, jsonb_build_object('reason', p_reason));

  return v_hole;
end;
$$;

grant execute on function mark_hole_out_of_service_v1(uuid, text) to authenticated;

create or replace function restore_pigeon_hole_v1(p_pigeon_hole_id uuid)
returns pigeon_holes
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_hole pigeon_holes;
  v_caller_role user_role;
begin
  v_caller_role := (select role from profiles where id = auth.uid());
  if v_caller_role not in ('warehouse_staff', 'ops_manager', 'admin') then
    raise exception 'not permitted' using errcode = '42501';
  end if;

  update pigeon_holes set status = 'free', updated_at = now()
  where id = p_pigeon_hole_id and status = 'out_of_service'
  returning * into v_hole;

  if v_hole is null then
    raise exception 'hole not found or not out of service';
  end if;

  insert into audit_logs (actor_user_id, action, target_type, target_id)
  values (auth.uid(), 'pigeon_hole.restored', 'pigeon_hole', p_pigeon_hole_id);

  return v_hole;
end;
$$;

grant execute on function restore_pigeon_hole_v1(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- notifications_mark_read_v1
-- ----------------------------------------------------------------------------

create or replace function notifications_mark_read_v1(p_notification_id uuid)
returns notifications
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row notifications;
begin
  update notifications set status = 'read', read_at = now()
  where id = p_notification_id and recipient_user_id = auth.uid()
  returning * into v_row;

  if v_row is null then
    raise exception 'notification not found';
  end if;
  return v_row;
end;
$$;

grant execute on function notifications_mark_read_v1(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- Admin/test-data helpers — stand in for a real Store API integration until
-- one is built. Restricted to admin/ops so pickers/staff cannot fabricate
-- orders.
-- ----------------------------------------------------------------------------

create or replace function admin_create_order_v1(
  p_store_external_ref text,
  p_bag_count integer,
  p_store_floor text default null,
  p_store_zone text default null,
  p_store_address text default null,
  p_external_order_ref text default null
)
returns orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_caller_role user_role;
  v_store stores;
  v_order orders;
  v_qr qr_codes;
  v_ref text;
  i integer;
begin
  v_caller_role := (select role from profiles where id = auth.uid());
  if v_caller_role not in ('ops_manager', 'admin') then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if p_bag_count is null or p_bag_count <= 0 or p_bag_count > 32767 then
    raise exception 'bag count must be a positive number no greater than 32767' using errcode = '40001';
  end if;

  select * into v_store from stores where external_ref = p_store_external_ref;
  if v_store is null then
    insert into stores (external_ref, name, default_zone)
    values (p_store_external_ref, p_store_external_ref, p_store_zone)
    returning * into v_store;
  end if;

  v_ref := coalesce(p_external_order_ref, 'SO-' || to_char(now(), 'YYMMDDHH24MISS') || '-' || substr(gen_random_uuid()::text, 1, 4));

  insert into orders (store_id, external_order_ref, bag_count_expected, store_floor, store_zone, store_address, status)
  values (v_store.id, v_ref, p_bag_count, p_store_floor, coalesce(p_store_zone, v_store.default_zone), p_store_address, 'available')
  returning * into v_order;

  insert into qr_codes (code_type, code_value, code_version, entity_id, status)
  values ('bag', v_ref || '-' || substr(gen_random_uuid()::text, 1, 6), 1, v_order.id, 'active')
  returning * into v_qr;

  update orders set shared_bag_qr_code_id = v_qr.id where id = v_order.id returning * into v_order;

  for i in 1..p_bag_count loop
    insert into order_bags (order_id, bag_sequence, status)
    values (v_order.id, i, 'expected');
  end loop;

  insert into status_history (entity_type, entity_id, from_status, to_status, actor_type, actor_user_id)
  values ('order', v_order.id, null, 'available', 'user', auth.uid());

  return v_order;
end;
$$;

grant execute on function admin_create_order_v1(text, integer, text, text, text, text) to authenticated;

create or replace function admin_create_pigeon_holes_v1(
  p_sort_wall_id uuid,
  p_count integer,
  p_prefix text default 'P'
)
returns setof pigeon_holes
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_caller_role user_role;
  v_hole pigeon_holes;
  v_qr qr_codes;
  i integer;
  v_number text;
begin
  v_caller_role := (select role from profiles where id = auth.uid());
  if v_caller_role <> 'admin' then
    raise exception 'not permitted' using errcode = '42501';
  end if;

  for i in 1..p_count loop
    v_number := p_prefix || '-' || lpad(i::text, 3, '0');
    insert into pigeon_holes (sort_wall_id, hole_number, status)
    values (p_sort_wall_id, v_number, 'free')
    returning * into v_hole;

    insert into qr_codes (code_type, code_value, code_version, entity_id, status)
    values ('pigeon_hole', 'HOLE-' || v_number || '-' || substr(gen_random_uuid()::text, 1, 6), 1, v_hole.id, 'active')
    returning * into v_qr;

    update pigeon_holes set qr_code_id = v_qr.id where id = v_hole.id returning * into v_hole;
    return next v_hole;
  end loop;
  return;
end;
$$;

grant execute on function admin_create_pigeon_holes_v1(uuid, integer, text) to authenticated;

create or replace function admin_create_warehouse_gate_v1(p_warehouse_id uuid)
returns qr_codes
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_caller_role user_role;
  v_qr qr_codes;
begin
  v_caller_role := (select role from profiles where id = auth.uid());
  if v_caller_role <> 'admin' then
    raise exception 'not permitted' using errcode = '42501';
  end if;

  insert into qr_codes (code_type, code_value, code_version, entity_id, status)
  values ('warehouse_gate', 'GATE-' || substr(gen_random_uuid()::text, 1, 8), 1, p_warehouse_id, 'active')
  returning * into v_qr;

  return v_qr;
end;
$$;

grant execute on function admin_create_warehouse_gate_v1(uuid) to authenticated;

-- ========================= END 0003_functions.sql =========================


-- ======================== BEGIN 0004_security_hardening.sql ========================

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

-- ========================= END 0004_security_hardening.sql =========================


-- ======================== BEGIN 0005_order_fragile.sql ========================

-- ============================================================================
-- 0005_order_fragile.sql
-- Optional, additive enhancement powering the "Fragile Items" badge and a
-- friendlier store display name in the Picker queue (matches the reference
-- UI screenshots).
--
-- Safe to run on an existing project:
--   * adds one nullable-with-default column (no rewrite of existing rows), and
--   * recreates admin_create_order_v1 with two extra trailing parameters.
--
-- The PWA reads `orders.is_fragile` defensively, so the app keeps working
-- whether or not this migration has been applied; applying it simply lights
-- up the fragile badge and lets the Admin tab set a store display name.
-- ============================================================================

alter table orders
  add column if not exists is_fragile boolean not null default false;

-- Recreate (drop first so we replace rather than create a second overload).
drop function if exists admin_create_order_v1(text, integer, text, text, text, text);

create or replace function admin_create_order_v1(
  p_store_external_ref text,
  p_bag_count integer,
  p_store_floor text default null,
  p_store_zone text default null,
  p_store_address text default null,
  p_external_order_ref text default null,
  p_is_fragile boolean default false,
  p_store_name text default null
)
returns orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_caller_role user_role;
  v_store stores;
  v_order orders;
  v_qr qr_codes;
  v_ref text;
  i integer;
begin
  v_caller_role := (select role from profiles where id = auth.uid());
  if v_caller_role not in ('ops_manager', 'admin') then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if p_bag_count is null or p_bag_count <= 0 or p_bag_count > 32767 then
    raise exception 'bag count must be a positive number no greater than 32767' using errcode = '40001';
  end if;

  select * into v_store from stores where external_ref = p_store_external_ref;
  if v_store.id is null then
    insert into stores (external_ref, name, default_zone)
    values (p_store_external_ref, coalesce(p_store_name, p_store_external_ref), p_store_zone)
    returning * into v_store;
  elsif p_store_name is not null and p_store_name <> v_store.name then
    update stores set name = p_store_name, updated_at = now() where id = v_store.id
    returning * into v_store;
  end if;

  v_ref := coalesce(p_external_order_ref, 'SO-' || to_char(now(), 'YYMMDDHH24MISS') || '-' || substr(gen_random_uuid()::text, 1, 4));

  insert into orders (store_id, external_order_ref, bag_count_expected, store_floor, store_zone, store_address, status, is_fragile)
  values (v_store.id, v_ref, p_bag_count, p_store_floor, coalesce(p_store_zone, v_store.default_zone), p_store_address, 'available', coalesce(p_is_fragile, false))
  returning * into v_order;

  insert into qr_codes (code_type, code_value, code_version, entity_id, status)
  values ('bag', v_ref || '-' || substr(gen_random_uuid()::text, 1, 6), 1, v_order.id, 'active')
  returning * into v_qr;

  update orders set shared_bag_qr_code_id = v_qr.id where id = v_order.id returning * into v_order;

  for i in 1..p_bag_count loop
    insert into order_bags (order_id, bag_sequence, status)
    values (v_order.id, i, 'expected');
  end loop;

  insert into status_history (entity_type, entity_id, from_status, to_status, actor_type, actor_user_id)
  values ('order', v_order.id, null, 'available', 'user', auth.uid());

  return v_order;
end;
$$;

grant execute on function admin_create_order_v1(
  text, integer, text, text, text, text, boolean, text
) to authenticated;

-- ========================= END 0005_order_fragile.sql =========================


-- ======================== BEGIN 0006_operations_capacity_and_qr.sql ========================

-- ============================================================================
-- 0006_operations_capacity_and_qr.sql
--
-- Online-only operations upgrade:
--   * maximum orders per picker (enforced server-side, including admin assigns)
--   * multi-hole bag allocation with a per-hole bag capacity
--   * lazy hourly warehouse-gate QR rotation and expiry validation
--   * admin manual assignment, configuration, and a guarded test-order reset
--
-- Important: all multi-row mutations remain server-side SECURITY DEFINER RPCs.
-- The browser never receives authority to assign orders, reset orders, or
-- change capacities directly.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Configuration and capacity data
-- ----------------------------------------------------------------------------

create table if not exists operations_configuration (
  singleton boolean primary key default true check (singleton),
  max_orders_per_picker smallint not null default 3 check (max_orders_per_picker > 0),
  bags_per_pigeon_hole smallint not null default 5 check (bags_per_pigeon_hole > 0),
  updated_at timestamptz not null default now(),
  updated_by_user_id uuid references profiles(id)
);

insert into operations_configuration (singleton)
values (true)
on conflict (singleton) do nothing;

alter table operations_configuration enable row level security;
grant select on operations_configuration to authenticated;
create policy operations_configuration_admin_select
  on operations_configuration for select
  using (auth_is_admin());

alter table warehouses
  add column if not exists gate_qr_rotation_minutes smallint not null default 60
  check (gate_qr_rotation_minutes between 1 and 1440);

alter table pigeon_holes
  add column if not exists bag_capacity smallint not null default 5
  check (bag_capacity > 0);

alter table order_bags
  add column if not exists pigeon_hole_id uuid references pigeon_holes(id);

alter table pigeon_hole_assignments
  add column if not exists bags_reserved smallint not null default 0
  check (bags_reserved >= 0),
  add column if not exists bags_sorted smallint not null default 0
  check (bags_sorted >= 0);

-- One order may occupy several holes, but a hole must never hold bags from
-- more than one active order.
drop index if exists pha_one_active_per_order;
create unique index if not exists pha_one_active_per_hole
  on pigeon_hole_assignments(pigeon_hole_id)
  where status in ('reserved', 'active');

create index if not exists order_bags_order_status_sequence_idx
  on order_bags(order_id, status, bag_sequence);
create index if not exists order_bags_hole_status_idx
  on order_bags(pigeon_hole_id, status);
create index if not exists pigeon_holes_wall_status_number_idx
  on pigeon_holes(sort_wall_id, status, hole_number);
create index if not exists orders_picker_active_idx
  on orders(assigned_picker_id, status)
  where assigned_picker_id is not null
    and status not in ('dispatched', 'completed', 'cancelled');

-- ----------------------------------------------------------------------------
-- Internal capacity helper
-- ----------------------------------------------------------------------------

create or replace function assert_picker_capacity_v1(p_picker_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_picker profiles;
  v_active_count integer;
begin
  select * into v_picker from profiles where id = p_picker_id for update;
  if v_picker.id is null or v_picker.role <> 'picker' or v_picker.status <> 'active' then
    raise exception 'picker is not active' using errcode = '40001';
  end if;

  select count(*) into v_active_count
  from orders
  where assigned_picker_id = p_picker_id
    and status in (
      'assigned', 'picking_in_progress', 'picked', 'in_transit_to_warehouse',
      'arrived_at_warehouse', 'sorting_in_progress', 'ready_for_dispatch'
    );

  if v_active_count >= v_picker.max_concurrent_orders then
    raise exception 'picker already has the configured maximum of % active orders',
      v_picker.max_concurrent_orders using errcode = '40001';
  end if;
end;
$$;

-- ----------------------------------------------------------------------------
-- Assignment: picker swipe-accept and admin manual assignment share the same
-- lock/capacity guard so concurrent acceptance cannot over-assign a picker.
-- ----------------------------------------------------------------------------

create or replace function accept_order_v1(p_order_id uuid)
returns orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order orders;
  v_caller_role user_role;
begin
  v_caller_role := (select role from profiles where id = auth.uid());
  if v_caller_role is distinct from 'picker' then
    raise exception 'only pickers can accept orders' using errcode = '42501';
  end if;

  -- A picker may accept another order only after the currently accepted
  -- order is fully picked. This is deliberately stricter than the configurable
  -- concurrent-order cap: the cap applies to orders carried/in workflow, but
  -- scanning one order at a time avoids two half-picked orders.
  if exists (
    select 1 from orders
    where assigned_picker_id = auth.uid()
      and status in ('assigned', 'picking_in_progress')
  ) then
    raise exception 'finish the current accepted order before accepting another' using errcode = '40001';
  end if;

  perform assert_picker_capacity_v1(auth.uid());

  update orders
  set status = 'assigned',
      assigned_picker_id = auth.uid(),
      assigned_at = now(),
      updated_at = now()
  where id = p_order_id
    and status = 'available'
    and assigned_picker_id is null
  returning * into v_order;

  if v_order.id is null then
    raise exception 'order already assigned or not available' using errcode = '40001';
  end if;

  insert into status_history (entity_type, entity_id, from_status, to_status, actor_type, actor_user_id)
  values ('order', p_order_id, 'available', 'assigned', 'user', auth.uid());
  return v_order;
end;
$$;

create or replace function admin_assign_order_v1(p_order_id uuid, p_picker_id uuid)
returns orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order orders;
begin
  if (select role from profiles where id = auth.uid()) not in ('ops_manager', 'admin') then
    raise exception 'not permitted' using errcode = '42501';
  end if;

  perform assert_picker_capacity_v1(p_picker_id);

  update orders
  set status = 'assigned',
      assigned_picker_id = p_picker_id,
      assigned_at = now(),
      updated_at = now()
  where id = p_order_id
    and status = 'available'
    and assigned_picker_id is null
  returning * into v_order;

  if v_order.id is null then
    raise exception 'order is no longer available for assignment' using errcode = '40001';
  end if;

  insert into status_history (entity_type, entity_id, from_status, to_status, actor_type, actor_user_id, reason)
  values ('order', p_order_id, 'available', 'assigned', 'user', auth.uid(), 'manually assigned by operations');
  insert into audit_logs (actor_user_id, action, target_type, target_id, metadata)
  values (auth.uid(), 'order.admin_assign', 'order', p_order_id, jsonb_build_object('picker_id', p_picker_id));
  return v_order;
end;
$$;

-- ----------------------------------------------------------------------------
-- Hourly rotating warehouse QR. Rotation is lazy: calling this display/read
-- RPC mints the code for the current hour. This avoids paid cron jobs while
-- the scan RPC independently enforces the expiry.
-- ----------------------------------------------------------------------------

create or replace function get_active_warehouse_gate_qr_v1(p_warehouse_id uuid)
returns qr_codes
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_warehouse warehouses;
  v_qr qr_codes;
  v_role user_role;
  v_user_warehouse uuid;
begin
  v_role := (select role from profiles where id = auth.uid());
  v_user_warehouse := (select warehouse_id from profiles where id = auth.uid());
  if v_role not in ('warehouse_staff', 'ops_manager', 'admin')
     or (v_role <> 'admin' and v_user_warehouse is distinct from p_warehouse_id) then
    raise exception 'not permitted' using errcode = '42501';
  end if;

  select * into v_warehouse from warehouses where id = p_warehouse_id for update;
  if v_warehouse.id is null then
    raise exception 'warehouse not found' using errcode = 'P0002';
  end if;

  select * into v_qr
  from qr_codes
  where code_type = 'warehouse_gate'
    and entity_id = p_warehouse_id
    and status = 'active'
    and expires_at > now()
  order by created_at desc
  limit 1;
  if v_qr.id is not null then
    return v_qr;
  end if;

  update qr_codes
  set status = case when expires_at <= now() then 'expired'::qr_code_status else 'revoked'::qr_code_status end
  where code_type = 'warehouse_gate'
    and entity_id = p_warehouse_id
    and status = 'active';

  insert into qr_codes (code_type, code_value, code_version, entity_id, status, expires_at)
  values (
    'warehouse_gate',
    'GATE-' || to_char(now() at time zone 'UTC', 'YYYYMMDDHH24') || '-' || substr(gen_random_uuid()::text, 1, 8),
    coalesce((select max(code_version) + 1 from qr_codes where code_type = 'warehouse_gate' and entity_id = p_warehouse_id), 1),
    p_warehouse_id,
    'active',
    date_trunc('hour', now()) + make_interval(mins => v_warehouse.gate_qr_rotation_minutes)
  )
  returning * into v_qr;
  return v_qr;
end;
$$;

-- ----------------------------------------------------------------------------
-- Pigeon-hole allocation. All required holes are locked/claimed atomically;
-- if there is insufficient capacity, no partial reservation is created.
-- Each bag is explicitly routed to exactly one assigned hole.
-- ----------------------------------------------------------------------------

create or replace function record_warehouse_arrival_v1(
  p_client_event_id uuid,
  p_gate_qr_value text,
  p_order_ids uuid[],
  p_client_captured_at timestamptz,
  p_gps_lat double precision default null,
  p_gps_lng double precision default null,
  p_device_id text default null
)
returns setof warehouse_arrival_result
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_gate_qr qr_codes;
  v_warehouse_id uuid;
  v_sort_wall_id uuid;
  v_order_id uuid;
  v_order orders;
  v_hole pigeon_holes;
  v_hole_ids uuid[];
  v_hole_numbers text[];
  v_required_holes integer;
  v_bags_in_hole integer;
  v_bag order_bags;
  v_index integer;
begin
  select * into v_gate_qr
  from qr_codes
  where code_value = p_gate_qr_value
    and code_type = 'warehouse_gate'
    and status = 'active'
    and expires_at > now();
  if v_gate_qr.id is null then
    raise exception 'gate QR code is invalid or has expired; refresh the warehouse QR display' using errcode = 'P0002';
  end if;
  v_warehouse_id := v_gate_qr.entity_id;

  select id into v_sort_wall_id
  from sort_walls
  where warehouse_id = v_warehouse_id and status = 'active'
  limit 1;
  if v_sort_wall_id is null then
    raise exception 'no active sort wall configured for this warehouse';
  end if;

  -- One immutable event preserves idempotency for the gate scan itself.
  insert into bag_scans (
    client_event_id, order_id, qr_code_id, scan_type, scanned_entity_type,
    actor_user_id, device_id, gps_lat, gps_lng, client_captured_at
  ) values (
    p_client_event_id, p_order_ids[1], v_gate_qr.id, 'warehouse_arrival', 'warehouse_gate',
    auth.uid(), p_device_id, p_gps_lat, p_gps_lng, p_client_captured_at
  )
  on conflict (client_event_id) do nothing;

  foreach v_order_id in array p_order_ids loop
    select * into v_order from orders where id = v_order_id for update;
    if v_order.id is null
       or v_order.assigned_picker_id is distinct from auth.uid()
       or v_order.status <> 'picked' then
      continue;
    end if;

    select ceil(v_order.bag_count_expected::numeric / c.bags_per_pigeon_hole)::integer
      into v_required_holes
    from operations_configuration c
    where c.singleton;

    v_hole_ids := array[]::uuid[];
    v_hole_numbers := array[]::text[];
    for v_hole in
      select *
      from pigeon_holes
      where sort_wall_id = v_sort_wall_id and status = 'free'
      order by hole_number
      limit v_required_holes
      for update skip locked
    loop
      v_hole_ids := array_append(v_hole_ids, v_hole.id);
      v_hole_numbers := array_append(v_hole_numbers, v_hole.hole_number);
    end loop;

    if cardinality(v_hole_ids) < v_required_holes then
      -- No partial reservation: an order is either fully routable or held
      -- in the staging overflow area until enough holes become free.
      update orders
      set status = 'arrived_at_warehouse', warehouse_id = v_warehouse_id,
          sort_wall_id = v_sort_wall_id, warehouse_arrived_at = now(), updated_at = now()
      where id = v_order_id;
      return query select v_order_id, null::text, false;
      continue;
    end if;

    update orders
    set status = 'sorting_in_progress', warehouse_id = v_warehouse_id,
        sort_wall_id = v_sort_wall_id, pigeon_hole_id = v_hole_ids[1],
        warehouse_arrived_at = now(), updated_at = now()
    where id = v_order_id;

    v_bags_in_hole := 0;
    v_index := 1;
    for v_bag in
      select * from order_bags where order_id = v_order_id order by bag_sequence for update
    loop
      if v_bags_in_hole >= (select bag_capacity from pigeon_holes where id = v_hole_ids[v_index]) then
        v_index := v_index + 1;
        v_bags_in_hole := 0;
      end if;
      update order_bags set pigeon_hole_id = v_hole_ids[v_index], updated_at = now() where id = v_bag.id;
      v_bags_in_hole := v_bags_in_hole + 1;
    end loop;

    for v_index in 1..cardinality(v_hole_ids) loop
      select count(*)::smallint into v_bags_in_hole
      from order_bags where order_id = v_order_id and pigeon_hole_id = v_hole_ids[v_index];
      update pigeon_holes set status = 'reserved', updated_at = now() where id = v_hole_ids[v_index];
      insert into pigeon_hole_assignments (order_id, pigeon_hole_id, status, bags_reserved)
      values (v_order_id, v_hole_ids[v_index], 'reserved', v_bags_in_hole);
    end loop;

    insert into status_history (entity_type, entity_id, from_status, to_status, actor_type, actor_user_id)
    values ('order', v_order_id, 'picked', 'sorting_in_progress', 'system', auth.uid());
    return query select v_order_id, array_to_string(v_hole_numbers, ', '), true;
  end loop;
end;
$$;

create or replace function scan_bag_for_sort_v1(
  p_client_event_id uuid,
  p_order_id uuid,
  p_qr_code_value text,
  p_client_captured_at timestamptz,
  p_gps_lat double precision default null,
  p_gps_lng double precision default null,
  p_device_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order orders;
  v_qr qr_codes;
  v_bag order_bags;
  v_hole pigeon_holes;
begin
  select * into v_order from orders where id = p_order_id;
  if v_order.id is null or v_order.assigned_picker_id is distinct from auth.uid() then
    raise exception 'order not found or not assigned to caller' using errcode = '42501';
  end if;
  select * into v_qr from qr_codes where code_value = p_qr_code_value and code_type = 'bag' and status = 'active';
  if v_qr.id is null or v_qr.entity_id <> v_order.id then
    raise exception 'qr code not recognized for this order' using errcode = 'P0002';
  end if;
  select * into v_bag
  from order_bags
  where order_id = p_order_id and status = 'picked_up'
  order by bag_sequence
  limit 1;
  if v_bag.id is null or v_bag.pigeon_hole_id is null then
    return jsonb_build_object('pigeon_hole_number', null, 'overflow', true);
  end if;
  select * into v_hole from pigeon_holes where id = v_bag.pigeon_hole_id;
  return jsonb_build_object('pigeon_hole_number', v_hole.hole_number, 'overflow', false);
end;
$$;

create or replace function scan_pigeon_hole_v1(
  p_client_event_id uuid,
  p_order_id uuid,
  p_pigeon_hole_qr_value text,
  p_client_captured_at timestamptz,
  p_gps_lat double precision default null,
  p_gps_lng double precision default null,
  p_device_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order orders;
  v_qr qr_codes;
  v_bag order_bags;
  v_hole pigeon_holes;
  v_assignment pigeon_hole_assignments;
  v_existing bag_scans;
begin
  select * into v_existing from bag_scans where client_event_id = p_client_event_id;
  if v_existing.id is not null then
    select * into v_order from orders where id = v_existing.order_id;
    return jsonb_build_object(
      'order_bag_id', v_existing.order_bag_id,
      'sorted', v_order.bag_count_scanned_sort,
      'expected', v_order.bag_count_expected,
      'order_status', v_order.status,
      'idempotent_replay', true
    );
  end if;
  select * into v_order from orders where id = p_order_id for update;
  if v_order.id is null or v_order.assigned_picker_id is distinct from auth.uid() then
    raise exception 'order not found or not assigned to caller' using errcode = '42501';
  end if;
  select * into v_qr from qr_codes where code_value = p_pigeon_hole_qr_value and code_type = 'pigeon_hole' and status = 'active';
  if v_qr.id is null then
    raise exception 'qr code not recognized as a pigeon hole code' using errcode = 'P0002';
  end if;
  select * into v_bag
  from order_bags
  where order_id = p_order_id and status = 'picked_up'
  order by bag_sequence
  limit 1
  for update skip locked;
  if v_bag.id is null then
    raise exception 'no remaining picked-up bags to sort for this order' using errcode = '40001';
  end if;
  if v_bag.pigeon_hole_id is distinct from v_qr.entity_id then
    raise exception 'this hole does not match the reservation for the next bag' using errcode = '40001';
  end if;
  select * into v_hole from pigeon_holes where id = v_bag.pigeon_hole_id for update;
  select * into v_assignment from pigeon_hole_assignments
  where order_id = p_order_id and pigeon_hole_id = v_hole.id and status in ('reserved', 'active')
  for update;

  update order_bags set status = 'sorted', sorted_at = now(), updated_at = now() where id = v_bag.id;
  update pigeon_hole_assignments
  set status = 'active', bags_sorted = bags_sorted + 1,
      filled_at = case when bags_sorted + 1 >= bags_reserved then now() else filled_at end
  where id = v_assignment.id;
  update pigeon_holes
  set status = case
      when (select bags_sorted from pigeon_hole_assignments where id = v_assignment.id) >= v_assignment.bags_reserved
        then 'filled'::pigeon_hole_status
      else 'partially_filled'::pigeon_hole_status
    end,
    updated_at = now()
  where id = v_hole.id;

  insert into bag_scans (
    client_event_id, order_id, order_bag_id, qr_code_id, pigeon_hole_id,
    scan_type, scanned_entity_type, actor_user_id, device_id, gps_lat, gps_lng, client_captured_at
  ) values (
    p_client_event_id, p_order_id, v_bag.id, v_qr.id, v_hole.id,
    'sort', 'pigeon_hole', auth.uid(), p_device_id, p_gps_lat, p_gps_lng, p_client_captured_at
  );

  update orders
  set bag_count_scanned_sort = bag_count_scanned_sort + 1,
      status = case when bag_count_scanned_sort + 1 >= bag_count_expected then 'ready_for_dispatch'::order_status else 'sorting_in_progress'::order_status end,
      sorted_at = case when bag_count_scanned_sort + 1 >= bag_count_expected then now() else sorted_at end,
      updated_at = now()
  where id = p_order_id
  returning * into v_order;
  return jsonb_build_object('order_bag_id', v_bag.id, 'bag_sequence', v_bag.bag_sequence,
    'sorted', v_order.bag_count_scanned_sort, 'expected', v_order.bag_count_expected,
    'order_status', v_order.status, 'idempotent_replay', false);
end;
$$;

create or replace function mark_order_dispatched_v1(
  p_order_id uuid,
  p_delivery_partner_id uuid default null,
  p_reason text default null
)
returns orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_order orders; v_caller_role user_role; v_caller_warehouse uuid;
begin
  v_caller_role := (select role from profiles where id = auth.uid());
  v_caller_warehouse := (select warehouse_id from profiles where id = auth.uid());
  if v_caller_role not in ('warehouse_staff', 'ops_manager', 'admin') then raise exception 'not permitted' using errcode = '42501'; end if;
  select * into v_order from orders where id = p_order_id for update;
  if v_order.id is null or v_order.status <> 'ready_for_dispatch' then raise exception 'order is not ready for dispatch' using errcode = '40001'; end if;
  if v_caller_role <> 'admin' and v_order.warehouse_id is distinct from v_caller_warehouse then raise exception 'order does not belong to caller warehouse' using errcode = '42501'; end if;
  update orders set status = 'dispatched', dispatched_at = now(), updated_at = now() where id = p_order_id returning * into v_order;
  update pigeon_holes set status = 'free', updated_at = now()
  where id in (select pigeon_hole_id from pigeon_hole_assignments where order_id = p_order_id and status in ('reserved', 'active'));
  update pigeon_hole_assignments set status = 'freed', freed_at = now() where order_id = p_order_id and status in ('reserved', 'active');
  insert into delivery_assignments (order_id, delivery_partner_id, status, assigned_by_user_id, is_force_assigned, notes, collected_at)
  values (p_order_id, p_delivery_partner_id, 'collected', auth.uid(), p_delivery_partner_id is not null, p_reason, now());
  return v_order;
end;
$$;

-- ----------------------------------------------------------------------------
-- Admin configuration, safe test reset, and gate compatibility helper.
-- ----------------------------------------------------------------------------

create or replace function admin_update_operations_configuration_v1(
  p_max_orders_per_picker smallint,
  p_bags_per_pigeon_hole smallint
)
returns operations_configuration
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_config operations_configuration;
begin
  if (select role from profiles where id = auth.uid()) <> 'admin' then raise exception 'not permitted' using errcode = '42501'; end if;
  if p_max_orders_per_picker <= 0 or p_bags_per_pigeon_hole <= 0 then raise exception 'capacities must be positive' using errcode = '40001'; end if;
  update operations_configuration
  set max_orders_per_picker = p_max_orders_per_picker,
      bags_per_pigeon_hole = p_bags_per_pigeon_hole,
      updated_at = now(), updated_by_user_id = auth.uid()
  where singleton
  returning * into v_config;
  update profiles set max_concurrent_orders = p_max_orders_per_picker, updated_at = now() where role = 'picker';
  update pigeon_holes set bag_capacity = p_bags_per_pigeon_hole, updated_at = now()
  where status = 'free';
  return v_config;
end;
$$;

create or replace function admin_create_pigeon_holes_v1(
  p_sort_wall_id uuid,
  p_count integer,
  p_prefix text default 'P'
)
returns setof pigeon_holes
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_hole pigeon_holes;
  v_qr qr_codes;
  v_capacity smallint;
  v_number text;
  i integer;
begin
  if (select role from profiles where id = auth.uid()) <> 'admin' then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if p_count <= 0 then
    raise exception 'count must be positive' using errcode = '40001';
  end if;
  select bags_per_pigeon_hole into v_capacity from operations_configuration where singleton;
  for i in 1..p_count loop
    v_number := p_prefix || '-' || lpad(i::text, 3, '0');
    insert into pigeon_holes (sort_wall_id, hole_number, status, bag_capacity)
    values (p_sort_wall_id, v_number, 'free', v_capacity)
    returning * into v_hole;
    insert into qr_codes (code_type, code_value, code_version, entity_id, status)
    values ('pigeon_hole', 'HOLE-' || v_number || '-' || substr(gen_random_uuid()::text, 1, 6), 1, v_hole.id, 'active')
    returning * into v_qr;
    update pigeon_holes set qr_code_id = v_qr.id where id = v_hole.id returning * into v_hole;
    return next v_hole;
  end loop;
end;
$$;

create or replace function admin_reset_orders_v1(p_confirmation text)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_count integer;
begin
  if (select role from profiles where id = auth.uid()) <> 'admin' then raise exception 'not permitted' using errcode = '42501'; end if;
  if p_confirmation <> 'RESET ALL TEST ORDERS' then
    raise exception 'type RESET ALL TEST ORDERS to confirm' using errcode = '40001';
  end if;
  select count(*) into v_count from orders;
  update pigeon_holes set status = 'free', updated_at = now() where status <> 'out_of_service';
  delete from delivery_assignments where order_id in (select id from orders);
  delete from pigeon_hole_assignments where order_id in (select id from orders);
  delete from bag_scans where order_id in (select id from orders);
  delete from status_history where entity_type = 'order' and entity_id in (select id from orders);
  update orders set shared_bag_qr_code_id = null;
  delete from qr_codes where code_type = 'bag' and entity_id in (select id from orders);
  delete from orders;
  insert into audit_logs (actor_user_id, action, target_type, metadata)
  values (auth.uid(), 'orders.test_reset', 'orders', jsonb_build_object('deleted_count', v_count));
  return v_count;
end;
$$;

-- Legacy admin call now delegates to the rotating-code lifecycle (the return
-- signature is kept so current clients do not break).
create or replace function admin_create_warehouse_gate_v1(p_warehouse_id uuid)
returns qr_codes
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if (select role from profiles where id = auth.uid()) <> 'admin' then raise exception 'not permitted' using errcode = '42501'; end if;
  return get_active_warehouse_gate_qr_v1(p_warehouse_id);
end;
$$;

grant execute on function get_active_warehouse_gate_qr_v1(uuid) to authenticated;
grant execute on function admin_assign_order_v1(uuid, uuid) to authenticated;
grant execute on function admin_update_operations_configuration_v1(smallint, smallint) to authenticated;
grant execute on function admin_reset_orders_v1(text) to authenticated;
grant execute on function accept_order_v1(uuid) to authenticated;
grant execute on function record_warehouse_arrival_v1(uuid, text, uuid[], timestamptz, double precision, double precision, text) to authenticated;
grant execute on function scan_bag_for_sort_v1(uuid, uuid, text, timestamptz, double precision, double precision, text) to authenticated;
grant execute on function scan_pigeon_hole_v1(uuid, uuid, text, timestamptz, double precision, double precision, text) to authenticated;
grant execute on function mark_order_dispatched_v1(uuid, uuid, text) to authenticated;

-- Supabase PostgREST normally detects DDL automatically; notify it explicitly
-- so the new RPC signatures/relations are immediately visible even on a busy
-- project where its schema-cache refresh is delayed.
notify pgrst, 'reload schema';

-- Notifications have no current browser subscriber. Keeping the table in
-- Supabase Realtime creates needless WAL/publication work whenever an
-- exception is reported, so remove it defensively if an earlier migration
-- added it. Orders and pigeon_holes remain the only live operational feeds.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename = 'notifications'
     ) then
    alter publication supabase_realtime drop table public.notifications;
  end if;
end $$;

-- ========================= END 0006_operations_capacity_and_qr.sql =========================


-- ======================== BEGIN 0007_fix_reset_orders_safe_update.sql ========================

-- ============================================================================
-- 0007_fix_reset_orders_safe_update.sql
--
-- Supabase's safe-update guard rejects UPDATE statements without a WHERE
-- clause, including inside SECURITY DEFINER RPCs. The reset function needs to
-- clear `orders.shared_bag_qr_code_id` before deleting bag QR rows (the FK
-- would otherwise block that delete), so scope that cleanup explicitly to the
-- set of orders being reset.
-- ============================================================================

create or replace function admin_reset_orders_v1(p_confirmation text)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_count integer;
begin
  if (select role from profiles where id = auth.uid()) <> 'admin' then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if p_confirmation <> 'RESET ALL TEST ORDERS' then
    raise exception 'type RESET ALL TEST ORDERS to confirm' using errcode = '40001';
  end if;

  select count(*) into v_count from orders;
  update pigeon_holes
  set status = 'free', updated_at = now()
  where status <> 'out_of_service';
  delete from delivery_assignments where order_id in (select id from orders);
  delete from pigeon_hole_assignments where order_id in (select id from orders);
  delete from bag_scans where order_id in (select id from orders);
  delete from status_history where entity_type = 'order' and entity_id in (select id from orders);

  -- This WHERE is required by Supabase's safe-update protection. It also
  -- documents the intent: clear only order-scoped QR foreign keys before the
  -- corresponding bag QR rows are deleted.
  update orders
  set shared_bag_qr_code_id = null
  where id in (select id from orders);

  delete from qr_codes where code_type = 'bag' and entity_id in (select id from orders);
  delete from orders;

  insert into audit_logs (actor_user_id, action, target_type, metadata)
  values (auth.uid(), 'orders.test_reset', 'orders', jsonb_build_object('deleted_count', v_count));
  return v_count;
end;
$$;

grant execute on function admin_reset_orders_v1(text) to authenticated;
notify pgrst, 'reload schema';

-- ========================= END 0007_fix_reset_orders_safe_update.sql =========================


-- ======================== BEGIN 0008_hole_first_sorting_flow.sql ========================

-- ============================================================================
-- 0008_hole_first_sorting_flow.sql
--
-- Implements the physical sorting sequence:
--   1. reveal only the first incomplete pigeon hole,
--   2. scan that hole to prove arrival,
--   3. scan every bag allocated to that hole,
--   4. unlock the next hole only when the current one is complete.
--
-- Existing orders use one shared bag QR per order. Therefore the server can
-- reliably reject a QR from another order, but cannot distinguish two
-- physical bags of the *same* order until a future unique-bag-QR rollout.
-- ============================================================================

-- Backfill orders that were already in the legacy one-order/one-hole sorting
-- flow when 0006/0008 are applied. New arrivals already have per-bag routing;
-- legacy assignments get their lone order-level hole copied down to each bag.
update order_bags ob
set pigeon_hole_id = o.pigeon_hole_id,
    updated_at = now()
from orders o
where ob.order_id = o.id
  and ob.pigeon_hole_id is null
  and o.pigeon_hole_id is not null;

update pigeon_hole_assignments pha
set bags_reserved = counts.total_bags
from (
  select order_id, count(*)::smallint as total_bags
  from order_bags
  group by order_id
) counts
where pha.order_id = counts.order_id
  and pha.bags_reserved = 0
  and pha.status in ('reserved', 'active');

create or replace function get_order_sorting_steps_v1(p_order_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order orders;
begin
  select * into v_order from orders where id = p_order_id;
  if v_order.id is null or v_order.assigned_picker_id is distinct from auth.uid() then
    raise exception 'order not found or not assigned to caller' using errcode = '42501';
  end if;

  return coalesce((
    select jsonb_agg(
      jsonb_build_object(
        'hole_id', row.hole_id,
        -- Do not disclose a later hole number until every earlier allocated
        -- hole is full. The client also renders a locked state for it.
        'hole_number', case when row.step_index <= row.unlocked_until then row.hole_number else null end,
        'bags_reserved', row.bags_reserved,
        'bags_sorted', row.bags_sorted,
        'is_unlocked', row.step_index <= row.unlocked_until
      )
      order by row.step_index
    )
    from (
      select staged.*,
        coalesce(
          min(case when staged.bags_sorted < staged.bags_reserved then staged.step_index end) over (),
          count(*) over ()
        ) as unlocked_until
      from (
      select
        pha.pigeon_hole_id as hole_id,
        ph.hole_number,
        pha.bags_reserved,
        pha.bags_sorted,
        row_number() over (order by pha.reserved_at, ph.hole_number) as step_index
      from pigeon_hole_assignments pha
      join pigeon_holes ph on ph.id = pha.pigeon_hole_id
      where pha.order_id = p_order_id
        and pha.status in ('reserved', 'active')
      ) staged
    ) row
  ), '[]'::jsonb);
end;
$$;

-- `get_order_sorting_steps_v1` needs the first incomplete hole in several
-- mutations. Keep the selection server-side so a client cannot skip ahead.
create or replace function verify_pigeon_hole_v1(
  p_order_id uuid,
  p_pigeon_hole_qr_value text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order orders;
  v_qr qr_codes;
  v_assignment pigeon_hole_assignments;
  v_hole pigeon_holes;
begin
  select * into v_order from orders where id = p_order_id;
  if v_order.id is null or v_order.assigned_picker_id is distinct from auth.uid() then
    raise exception 'order not found or not assigned to caller' using errcode = '42501';
  end if;

  select * into v_qr from qr_codes
  where code_value = p_pigeon_hole_qr_value and code_type = 'pigeon_hole' and status = 'active';
  if v_qr.id is null then
    raise exception 'QR code is not a recognized pigeon hole' using errcode = 'P0002';
  end if;

  select pha.*
  into v_assignment
  from pigeon_hole_assignments pha
  join pigeon_holes ph on ph.id = pha.pigeon_hole_id
  where pha.order_id = p_order_id
    and pha.status in ('reserved', 'active')
    and pha.bags_sorted < pha.bags_reserved
  order by pha.reserved_at, ph.hole_number
  limit 1;

  if v_assignment.id is null then
    raise exception 'all allocated pigeon holes are already complete' using errcode = '40001';
  end if;
  select * into v_hole from pigeon_holes where id = v_assignment.pigeon_hole_id;
  if v_qr.entity_id is distinct from v_assignment.pigeon_hole_id then
    raise exception 'Wrong pigeon hole. Scan the currently unlocked hole: %', v_hole.hole_number using errcode = '40001';
  end if;

  return jsonb_build_object(
    'hole_id', v_hole.id,
    'hole_number', v_hole.hole_number,
    'dropped', v_assignment.bags_sorted,
    'expected', v_assignment.bags_reserved
  );
end;
$$;

create or replace function scan_bag_into_pigeon_hole_v1(
  p_client_event_id uuid,
  p_order_id uuid,
  p_bag_qr_value text,
  p_pigeon_hole_qr_value text,
  p_client_captured_at timestamptz,
  p_device_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_existing bag_scans;
  v_order orders;
  v_bag_qr qr_codes;
  v_hole_qr qr_codes;
  v_assignment pigeon_hole_assignments;
  v_hole pigeon_holes;
  v_bag order_bags;
begin
  select * into v_existing from bag_scans where client_event_id = p_client_event_id;
  if v_existing.id is not null then
    select * into v_order from orders where id = v_existing.order_id;
    return jsonb_build_object(
      'order_bag_id', v_existing.order_bag_id,
      'dropped', v_order.bag_count_scanned_sort,
      'order_expected', v_order.bag_count_expected,
      'hole_complete', true,
      'idempotent_replay', true
    );
  end if;

  select * into v_order from orders where id = p_order_id for update;
  if v_order.id is null or v_order.assigned_picker_id is distinct from auth.uid() then
    raise exception 'order not found or not assigned to caller' using errcode = '42501';
  end if;

  select * into v_hole_qr from qr_codes
  where code_value = p_pigeon_hole_qr_value and code_type = 'pigeon_hole' and status = 'active';
  if v_hole_qr.id is null then
    raise exception 'QR code is not a recognized pigeon hole' using errcode = 'P0002';
  end if;

  select pha.*
  into v_assignment
  from pigeon_hole_assignments pha
  join pigeon_holes ph on ph.id = pha.pigeon_hole_id
  where pha.order_id = p_order_id
    and pha.status in ('reserved', 'active')
    and pha.bags_sorted < pha.bags_reserved
  order by pha.reserved_at, ph.hole_number
  limit 1
  for update of pha, ph;
  if v_assignment.id is null or v_hole_qr.entity_id is distinct from v_assignment.pigeon_hole_id then
    raise exception 'Wrong pigeon hole. Complete the currently unlocked hole first.' using errcode = '40001';
  end if;
  select * into v_hole from pigeon_holes where id = v_assignment.pigeon_hole_id;

  select * into v_bag_qr from qr_codes
  where code_value = p_bag_qr_value and code_type = 'bag' and status = 'active';
  if v_bag_qr.id is null or v_bag_qr.entity_id is distinct from p_order_id then
    raise exception 'Wrong bag, bag does not belong to the hole' using errcode = '40001';
  end if;

  select * into v_bag
  from order_bags
  where order_id = p_order_id
    and pigeon_hole_id = v_assignment.pigeon_hole_id
    and status = 'picked_up'
  order by bag_sequence
  limit 1
  for update skip locked;
  if v_bag.id is null then
    raise exception 'Wrong bag, bag does not belong to the hole' using errcode = '40001';
  end if;

  update order_bags
  set status = 'sorted', sorted_at = now(), updated_at = now()
  where id = v_bag.id;

  update pigeon_hole_assignments
  set status = 'active',
      bags_sorted = bags_sorted + 1,
      filled_at = case when bags_sorted + 1 >= bags_reserved then now() else filled_at end
  where id = v_assignment.id
  returning * into v_assignment;

  update pigeon_holes
  set status = case
      when v_assignment.bags_sorted >= v_assignment.bags_reserved then 'filled'::pigeon_hole_status
      else 'partially_filled'::pigeon_hole_status
    end,
    updated_at = now()
  where id = v_assignment.pigeon_hole_id;

  insert into bag_scans (
    client_event_id, order_id, order_bag_id, qr_code_id, pigeon_hole_id,
    scan_type, scanned_entity_type, actor_user_id, device_id, client_captured_at
  ) values (
    p_client_event_id, p_order_id, v_bag.id, v_bag_qr.id, v_assignment.pigeon_hole_id,
    'sort', 'bag', auth.uid(), p_device_id, p_client_captured_at
  );

  update orders
  set bag_count_scanned_sort = bag_count_scanned_sort + 1,
      status = case
        when bag_count_scanned_sort + 1 >= bag_count_expected then 'ready_for_dispatch'::order_status
        else 'sorting_in_progress'::order_status
      end,
      sorted_at = case when bag_count_scanned_sort + 1 >= bag_count_expected then now() else sorted_at end,
      updated_at = now()
  where id = p_order_id
  returning * into v_order;

  return jsonb_build_object(
    'order_bag_id', v_bag.id,
    'dropped', v_assignment.bags_sorted,
    'expected', v_assignment.bags_reserved,
    'hole_complete', v_assignment.bags_sorted >= v_assignment.bags_reserved,
    'order_complete', v_order.status = 'ready_for_dispatch',
    'idempotent_replay', false
  );
end;
$$;

grant execute on function get_order_sorting_steps_v1(uuid) to authenticated;
grant execute on function verify_pigeon_hole_v1(uuid, text) to authenticated;
grant execute on function scan_bag_into_pigeon_hole_v1(uuid, uuid, text, text, timestamptz, text) to authenticated;
notify pgrst, 'reload schema';

-- ========================= END 0008_hole_first_sorting_flow.sql =========================


-- ======================== BEGIN 0009_fix_reset_orders_safe_delete.sql ========================

-- ============================================================================
-- 0009_fix_reset_orders_safe_delete.sql
--
-- Follow-up to 0007: Supabase safe-update also rejects the final unscoped
-- DELETE FROM orders. Recreate the guarded reset RPC with explicit WHERE
-- clauses on both its FK cleanup update and final delete.
-- ============================================================================

create or replace function admin_reset_orders_v1(p_confirmation text)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_count integer;
begin
  if (select role from profiles where id = auth.uid()) <> 'admin' then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if p_confirmation <> 'RESET ALL TEST ORDERS' then
    raise exception 'type RESET ALL TEST ORDERS to confirm' using errcode = '40001';
  end if;

  select count(*) into v_count from orders;
  update pigeon_holes
  set status = 'free', updated_at = now()
  where status <> 'out_of_service';
  delete from delivery_assignments where order_id in (select id from orders);
  delete from pigeon_hole_assignments where order_id in (select id from orders);
  delete from bag_scans where order_id in (select id from orders);
  delete from status_history where entity_type = 'order' and entity_id in (select id from orders);
  update orders
  set shared_bag_qr_code_id = null
  where id in (select id from orders);
  delete from qr_codes where code_type = 'bag' and entity_id in (select id from orders);

  -- Explicit scope is required by Supabase safe-update. The predicate is
  -- intentionally all current order IDs because this is a guarded, test-only
  -- reset operation, protected by the exact confirmation phrase above.
  delete from orders where id in (select id from orders);

  insert into audit_logs (actor_user_id, action, target_type, metadata)
  values (auth.uid(), 'orders.test_reset', 'orders', jsonb_build_object('deleted_count', v_count));
  return v_count;
end;
$$;

grant execute on function admin_reset_orders_v1(text) to authenticated;
notify pgrst, 'reload schema';

-- ========================= END 0009_fix_reset_orders_safe_delete.sql =========================


-- ======================== BEGIN 0010_auto_assignment_manpower.sql ========================

-- ============================================================================
-- 0010_auto_assignment_manpower.sql
-- Zone-aware automatic assignment and secure picker roster support.
-- ============================================================================

alter table profiles
  add column if not exists phone_e164 text,
  add column if not exists picker_code text,
  add column if not exists all_zones boolean not null default false,
  add column if not exists login_code_rotated_at timestamptz;

alter table profiles
  add constraint profiles_picker_zone_scope_chk
  check (not all_zones or home_zone is null);

create unique index if not exists profiles_picker_phone_active_uidx
  on profiles(phone_e164)
  where role = 'picker' and status <> 'offboarded' and phone_e164 is not null;
create unique index if not exists profiles_picker_code_uidx
  on profiles(picker_code) where picker_code is not null;

create table if not exists zones (
  code text primary key,
  label text not null,
  sort_order smallint not null default 0,
  is_active boolean not null default true,
  check (code = upper(trim(code)) and length(code) between 1 and 32)
);
alter table zones enable row level security;
grant select on zones to authenticated;
create policy zones_authenticated_select on zones for select using (auth.uid() is not null);

alter table operations_configuration
  add column if not exists auto_assign_enabled boolean not null default true,
  add column if not exists assignment_policy text not null default 'least_active_orders'
    check (assignment_policy in ('least_active_orders')),
  add column if not exists null_zone_matches_all_pickers boolean not null default false;

alter table orders
  add column if not exists assignment_source text
    check (assignment_source is null or assignment_source in ('auto','manual','self_accept','requeue'));

create index if not exists profiles_auto_assign_eligible_idx
  on profiles(is_online, home_zone, all_zones)
  where role = 'picker' and status = 'active' and is_online = true;
create index if not exists orders_available_zone_idx
  on orders(store_zone, ingested_at)
  where status = 'available' and assigned_picker_id is null;

create or replace function picker_active_order_count_v1(p_picker_id uuid)
returns integer language sql stable security definer set search_path = public, pg_temp as $$
  select count(*)::integer from orders
  where assigned_picker_id = p_picker_id
    and status in ('assigned','picking_in_progress','picked','in_transit_to_warehouse',
                   'arrived_at_warehouse','sorting_in_progress','ready_for_dispatch');
$$;

create or replace function picker_zone_eligible_v1(p_picker_id uuid, p_zone text)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(
    p.all_zones
    or (p_zone is not null and lower(trim(p.home_zone)) = lower(trim(p_zone)))
    or (p_zone is null and c.null_zone_matches_all_pickers),
    false
  )
  from profiles p cross join operations_configuration c
  where p.id = p_picker_id and c.singleton;
$$;

create or replace function assign_order_to_picker_v1(
  p_order_id uuid,
  p_picker_id uuid,
  p_source text,
  p_actor_user_id uuid default null,
  p_skip_zone_check boolean default false,
  p_force boolean default false
)
returns orders
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_order orders;
  v_picker profiles;
  v_active_count integer;
begin
  select * into v_order from orders where id = p_order_id for update;
  if v_order.id is null or v_order.status <> 'available' or v_order.assigned_picker_id is not null then
    raise exception 'order is no longer available for assignment' using errcode = '40001';
  end if;
  select * into v_picker from profiles where id = p_picker_id for update;
  if v_picker.id is null or v_picker.role <> 'picker' or v_picker.status <> 'active' then
    raise exception 'picker is not active' using errcode = '40001';
  end if;
  if not p_skip_zone_check and not picker_zone_eligible_v1(p_picker_id, v_order.store_zone) then
    raise exception 'picker is not eligible for this order zone' using errcode = '40001';
  end if;
  select picker_active_order_count_v1(p_picker_id) into v_active_count;
  if not p_force and v_active_count >= v_picker.max_concurrent_orders then
    raise exception 'picker already has the configured maximum of % active orders', v_picker.max_concurrent_orders using errcode = '40001';
  end if;
  update orders
  set status = 'assigned', assigned_picker_id = p_picker_id, assigned_at = now(),
      assignment_source = p_source, updated_at = now()
  where id = p_order_id and status = 'available' and assigned_picker_id is null
  returning * into v_order;
  if v_order.id is null then raise exception 'assignment race lost' using errcode = '40001'; end if;
  insert into status_history(entity_type, entity_id, from_status, to_status, actor_type, actor_user_id, reason)
  values ('order', p_order_id, 'available', 'assigned',
    case when p_actor_user_id is null then 'system' else 'user' end,
    p_actor_user_id, p_source);
  return v_order;
end;
$$;

create or replace function try_auto_assign_order_v1(p_order_id uuid)
returns orders
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_order orders;
  v_picker_id uuid;
  v_result orders;
begin
  if not (select auto_assign_enabled from operations_configuration where singleton) then return null; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_order_id::text, 0));
  select * into v_order from orders where id = p_order_id;
  if v_order.id is null or v_order.status <> 'available' or v_order.assigned_picker_id is not null then return null; end if;
  select p.id into v_picker_id
  from profiles p
  where p.role = 'picker' and p.status = 'active' and p.is_online
    and picker_zone_eligible_v1(p.id, v_order.store_zone)
    and picker_active_order_count_v1(p.id) < p.max_concurrent_orders
  order by picker_active_order_count_v1(p.id), p.updated_at, p.id
  limit 1
  for update skip locked;
  if v_picker_id is null then return null; end if;
  select * into v_result from assign_order_to_picker_v1(p_order_id, v_picker_id, 'auto', null, false, false);
  return v_result;
exception when sqlstate '40001' then return null;
end;
$$;

create or replace function orders_try_auto_assign_trigger_v1()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.status = 'available' and new.assigned_picker_id is null then
    perform try_auto_assign_order_v1(new.id);
  end if;
  return new;
end;
$$;

drop trigger if exists orders_auto_assign_trigger_v1 on orders;
create trigger orders_auto_assign_trigger_v1
after insert or update of status, store_zone, assigned_picker_id on orders
for each row execute function orders_try_auto_assign_trigger_v1();

create or replace function picker_online_assign_backlog_trigger_v1()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare v_order_id uuid;
begin
  if new.role='picker' and new.status='active' and new.is_online and not old.is_online then
    for v_order_id in
      select o.id from orders o
      where o.status='available' and o.assigned_picker_id is null
        and picker_zone_eligible_v1(new.id,o.store_zone)
      order by o.ingested_at
      limit new.max_concurrent_orders
    loop
      perform try_auto_assign_order_v1(v_order_id);
    end loop;
  end if;
  return new;
end;
$$;
drop trigger if exists picker_online_assign_backlog_trigger_v1 on profiles;
create trigger picker_online_assign_backlog_trigger_v1
after update of is_online on profiles
for each row execute function picker_online_assign_backlog_trigger_v1();

-- Auto-created admin test orders now enter the assignment engine immediately.
create or replace function admin_create_order_v1(
  p_store_external_ref text, p_bag_count integer, p_store_floor text default null,
  p_store_zone text default null, p_store_address text default null,
  p_external_order_ref text default null, p_is_fragile boolean default false,
  p_store_name text default null
) returns orders language plpgsql security definer set search_path = public, pg_temp as $$
declare v_caller_role user_role; v_store stores; v_order orders; v_qr qr_codes; v_ref text; i integer;
begin
  v_caller_role := (select role from profiles where id = auth.uid());
  if v_caller_role not in ('ops_manager','admin') then raise exception 'not permitted' using errcode = '42501'; end if;
  if p_bag_count is null or p_bag_count <= 0 or p_bag_count > 32767 then raise exception 'bag count must be a positive number no greater than 32767' using errcode = '40001'; end if;
  select * into v_store from stores where external_ref = p_store_external_ref;
  if v_store.id is null then
    insert into stores(external_ref,name,default_zone) values(p_store_external_ref,coalesce(p_store_name,p_store_external_ref),p_store_zone) returning * into v_store;
  elsif p_store_name is not null and p_store_name <> v_store.name then
    update stores set name=p_store_name,updated_at=now() where id=v_store.id returning * into v_store;
  end if;
  v_ref := coalesce(p_external_order_ref,'SO-'||to_char(now(),'YYMMDDHH24MISS')||'-'||substr(gen_random_uuid()::text,1,4));
  insert into orders(store_id,external_order_ref,bag_count_expected,store_floor,store_zone,store_address,status,is_fragile)
  values(v_store.id,v_ref,p_bag_count,p_store_floor,coalesce(p_store_zone,v_store.default_zone),p_store_address,'available',coalesce(p_is_fragile,false))
  returning * into v_order;
  insert into qr_codes(code_type,code_value,code_version,entity_id,status)
  values('bag',v_ref||'-'||substr(gen_random_uuid()::text,1,6),1,v_order.id,'active') returning * into v_qr;
  update orders set shared_bag_qr_code_id=v_qr.id where id=v_order.id returning * into v_order;
  for i in 1..p_bag_count loop insert into order_bags(order_id,bag_sequence,status) values(v_order.id,i,'expected'); end loop;
  insert into status_history(entity_type,entity_id,from_status,to_status,actor_type,actor_user_id)
  values('order',v_order.id,null,'available','user',auth.uid());
  -- The AFTER INSERT trigger may assign the order; return authoritative row.
  select * into v_order from orders where id=v_order.id;
  return v_order;
end;
$$;

create or replace function picker_go_to_store_v1(p_order_id uuid)
returns orders language plpgsql security definer set search_path = public, pg_temp as $$
declare v_order orders;
begin
  select * into v_order from orders where id=p_order_id for update;
  if v_order.id is null or v_order.assigned_picker_id is distinct from auth.uid() or v_order.status <> 'assigned' then
    raise exception 'order is not assigned and ready to start' using errcode='40001';
  end if;
  if exists(select 1 from orders where assigned_picker_id=auth.uid() and id<>p_order_id and status='picking_in_progress') then
    raise exception 'finish picking the current store before going to another store' using errcode='40001';
  end if;
  update orders set status='picking_in_progress',updated_at=now() where id=p_order_id returning * into v_order;
  insert into status_history(entity_type,entity_id,from_status,to_status,actor_type,actor_user_id,reason)
  values('order',p_order_id,'assigned','picking_in_progress','user',auth.uid(),'picker started journey to store');
  return v_order;
end;
$$;

create or replace function admin_update_assignment_configuration_v1(
  p_auto_assign_enabled boolean, p_null_zone_matches_all_pickers boolean
) returns operations_configuration language plpgsql security definer set search_path=public,pg_temp as $$
declare v_config operations_configuration;
begin
  if (select role from profiles where id=auth.uid()) <> 'admin' then raise exception 'not permitted' using errcode='42501'; end if;
  update operations_configuration set auto_assign_enabled=p_auto_assign_enabled,
    null_zone_matches_all_pickers=p_null_zone_matches_all_pickers,updated_at=now(),updated_by_user_id=auth.uid()
  where singleton returning * into v_config;
  return v_config;
end;
$$;

create or replace function admin_list_pickers_v1()
returns table(id uuid, picker_code_masked text, full_name text, phone_masked text, home_zone text, all_zones boolean, status user_status, is_online boolean, active_orders integer)
language sql stable security definer set search_path=public,pg_temp as $$
  select p.id,
    case when p.picker_code is null then null else 'PKR-•••' || right(p.picker_code,1) end,
    p.full_name,
    case when p.phone_e164 is null then null else '••••' || right(p.phone_e164,4) end,
    p.home_zone,p.all_zones,p.status,p.is_online,picker_active_order_count_v1(p.id)
  from profiles p where p.role='picker' order by p.full_name nulls last,p.created_at;
$$;

create or replace function admin_update_picker_profile_v1(
  p_picker_id uuid,p_full_name text,p_home_zone text,p_all_zones boolean,p_status user_status
) returns profiles language plpgsql security definer set search_path=public,pg_temp as $$
declare v_profile profiles;
begin
  if (select role from profiles where id=auth.uid()) <> 'admin' then raise exception 'not permitted' using errcode='42501'; end if;
  update profiles set full_name=p_full_name,home_zone=case when p_all_zones then null else nullif(trim(p_home_zone),'') end,
    all_zones=p_all_zones,status=p_status,updated_at=now()
  where id=p_picker_id and role='picker' returning * into v_profile;
  if v_profile.id is null then raise exception 'picker not found' using errcode='P0002'; end if;
  return v_profile;
end;
$$;

-- Auto-direct assignment means an unassigned available order is not broadcast
-- to every picker. They see only their assigned work (admin/warehouse rules
-- remain unchanged).
drop policy if exists orders_select on orders;
create policy orders_select on orders for select using (
  auth_is_admin()
  or assigned_picker_id=auth.uid()
  or (auth_is_warehouse_role() and (warehouse_id=auth_warehouse_id() or warehouse_id is null))
);

grant execute on function picker_go_to_store_v1(uuid) to authenticated;
grant execute on function admin_update_assignment_configuration_v1(boolean,boolean) to authenticated;
grant execute on function admin_list_pickers_v1() to authenticated;
grant execute on function admin_update_picker_profile_v1(uuid,text,text,boolean,user_status) to authenticated;
grant execute on function admin_create_order_v1(text,integer,text,text,text,text,boolean,text) to authenticated;
grant execute on function accept_order_v1(uuid) to authenticated;
notify pgrst,'reload schema';

-- ========================= END 0010_auto_assignment_manpower.sql =========================


-- ======================== BEGIN 0011_admin_create_picker.sql ========================

-- ============================================================================
-- 0011_admin_create_picker.sql
-- Create pickers from the Manpower UI without a deployed Edge Function.
-- Inserts into auth.users + auth.identities (bcrypt via pgcrypto), then
-- provisions the application profile. Admin-only.
-- ============================================================================

create or replace function admin_normalise_picker_phone_v1(p_phone text)
returns text
language plpgsql
immutable
as $$
declare
  v_raw text := trim(coalesce(p_phone, ''));
  v_digits text;
begin
  v_raw := regexp_replace(v_raw, '[^\d+]', '', 'g');
  if v_raw ~ '^\+[1-9]\d{7,14}$' then
    return v_raw;
  end if;
  v_digits := regexp_replace(v_raw, '\D', '', 'g');
  -- Mall deployment default: UAE local mobile 05XXXXXXXX / 5XXXXXXXX -> +9715XXXXXXXX.
  if v_digits ~ '^0?5\d{8}$' then
    return '+971' || regexp_replace(v_digits, '^0', '');
  end if;
  return null;
end;
$$;

create or replace function admin_create_picker_v1(
  p_full_name text,
  p_phone text,
  p_login_code text,
  p_zone text default null,
  p_all_zones boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth, extensions, pg_temp
as $$
declare
  v_caller_role user_role;
  v_full_name text := trim(coalesce(p_full_name, ''));
  v_phone text := admin_normalise_picker_phone_v1(p_phone);
  v_login_code text := trim(coalesce(p_login_code, ''));
  v_all_zones boolean := coalesce(p_all_zones, false);
  v_zone text := case when v_all_zones then null else nullif(upper(trim(coalesce(p_zone, ''))), '') end;
  v_email text;
  v_user_id uuid := gen_random_uuid();
  v_picker_code text;
  v_alphabet text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_i integer;
  v_profile profiles;
begin
  select role into v_caller_role from profiles where id = auth.uid();
  if v_caller_role is distinct from 'admin' then
    raise exception 'not permitted' using errcode = '42501';
  end if;

  if length(v_full_name) < 2
     or v_phone is null
     or v_login_code !~ '^\d{6,8}$'
     or (not v_all_zones and v_zone is null) then
    raise exception 'invalid picker details' using errcode = '22023';
  end if;

  if exists (
    select 1 from profiles
    where role = 'picker' and status <> 'offboarded' and phone_e164 = v_phone
  ) then
    raise exception 'mobile already exists' using errcode = '23505';
  end if;

  v_email := 'p' || regexp_replace(v_phone, '\D', '', 'g') || '@picker.internal';

  -- Generate a short unique picker code (PKR-XXXX).
  for v_i in 1..12 loop
    v_picker_code := 'PKR-' ||
      substr(v_alphabet, 1 + (get_byte(gen_random_bytes(4), 0) % length(v_alphabet)), 1) ||
      substr(v_alphabet, 1 + (get_byte(gen_random_bytes(4), 1) % length(v_alphabet)), 1) ||
      substr(v_alphabet, 1 + (get_byte(gen_random_bytes(4), 2) % length(v_alphabet)), 1) ||
      substr(v_alphabet, 1 + (get_byte(gen_random_bytes(4), 3) % length(v_alphabet)), 1);
    exit when not exists (select 1 from profiles where picker_code = v_picker_code);
  end loop;

  begin
    insert into auth.users (
      instance_id,
      id,
      aud,
      role,
      email,
      encrypted_password,
      email_confirmed_at,
      raw_app_meta_data,
      raw_user_meta_data,
      created_at,
      updated_at,
      confirmation_token,
      recovery_token,
      email_change_token_new,
      email_change
    ) values (
      '00000000-0000-0000-0000-000000000000',
      v_user_id,
      'authenticated',
      'authenticated',
      v_email,
      crypt(v_login_code, gen_salt('bf')),
      now(),
      jsonb_build_object('provider', 'email', 'providers', jsonb_build_array('email')),
      jsonb_build_object('full_name', v_full_name, 'phone_e164', v_phone),
      now(),
      now(),
      '',
      '',
      '',
      ''
    );

    insert into auth.identities (
      id,
      user_id,
      identity_data,
      provider,
      provider_id,
      last_sign_in_at,
      created_at,
      updated_at
    ) values (
      gen_random_uuid(),
      v_user_id,
      jsonb_build_object('sub', v_user_id::text, 'email', v_email),
      'email',
      v_user_id::text,
      now(),
      now(),
      now()
    );
  exception
    when unique_violation then
      raise exception 'mobile already exists' using errcode = '23505';
  end;

  update profiles
  set role = 'picker',
      full_name = v_full_name,
      phone_e164 = v_phone,
      picker_code = v_picker_code,
      home_zone = v_zone,
      all_zones = v_all_zones,
      status = 'active',
      login_code_rotated_at = now(),
      updated_at = now()
  where id = v_user_id
  returning * into v_profile;

  if v_profile.id is null then
    raise exception 'could not provision picker profile' using errcode = 'P0001';
  end if;

  insert into audit_logs (actor_user_id, action, target_type, target_id, metadata)
  values (
    auth.uid(),
    'picker.create',
    'profile',
    v_user_id,
    jsonb_build_object('zone', v_zone, 'all_zones', v_all_zones)
  );

  return jsonb_build_object(
    'id', v_profile.id,
    'picker_code', v_profile.picker_code,
    'phone_e164', v_profile.phone_e164,
    'full_name', v_profile.full_name,
    'home_zone', v_profile.home_zone,
    'all_zones', v_profile.all_zones,
    'login_code', v_login_code
  );
end;
$$;

revoke all on function admin_normalise_picker_phone_v1(text) from public;
revoke all on function admin_create_picker_v1(text, text, text, text, boolean) from public;
grant execute on function admin_create_picker_v1(text, text, text, text, boolean) to authenticated;

notify pgrst, 'reload schema';

-- ========================= END 0011_admin_create_picker.sql =========================


-- ======================== BEGIN 0012_picker_create_clear_errors.sql ========================

-- ============================================================================
-- 0012_picker_create_clear_errors.sql
-- Broader mobile normalisation and field-specific human-readable errors
-- for admin_create_picker_v1.
-- ============================================================================

create or replace function admin_normalise_picker_phone_v1(p_phone text)
returns text
language plpgsql
immutable
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

create or replace function admin_create_picker_v1(
  p_full_name text,
  p_phone text,
  p_login_code text,
  p_zone text default null,
  p_all_zones boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth, extensions, pg_temp
as $$
declare
  v_caller_role user_role;
  v_full_name text := trim(coalesce(p_full_name, ''));
  v_phone text := admin_normalise_picker_phone_v1(p_phone);
  v_login_code text := trim(coalesce(p_login_code, ''));
  v_all_zones boolean := coalesce(p_all_zones, false);
  v_zone text := case when v_all_zones then null else nullif(upper(trim(coalesce(p_zone, ''))), '') end;
  v_email text;
  v_user_id uuid := gen_random_uuid();
  v_picker_code text;
  v_alphabet text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_bytes bytea;
  v_i integer;
  v_profile profiles;
begin
  select role into v_caller_role from profiles where id = auth.uid();
  if v_caller_role is distinct from 'admin' then
    raise exception 'Only an admin can create pickers.' using errcode = '42501';
  end if;

  if length(v_full_name) < 2 then
    raise exception 'Enter the picker''s full name (at least 2 characters).' using errcode = '22023';
  end if;

  if trim(coalesce(p_phone, '')) = '' then
    raise exception 'Enter a mobile number.' using errcode = '22023';
  end if;

  if v_phone is null then
    raise exception 'Mobile number "%s" is not recognised. Use a UAE number like 0501234567, or an international number like +971501234567.',
      trim(p_phone)
      using errcode = '22023';
  end if;

  if v_login_code = '' then
    raise exception 'Enter a login code (6 to 8 digits).' using errcode = '22023';
  end if;

  if v_login_code !~ '^\d{6,8}$' then
    raise exception 'Login code must be 6 to 8 digits only (no letters or spaces). You entered "%s".',
      v_login_code
      using errcode = '22023';
  end if;

  if not v_all_zones and v_zone is null then
    raise exception 'Choose a zone (for example C), or tick All Zones.' using errcode = '22023';
  end if;

  if not v_all_zones and not exists (
    select 1 from zones where code = v_zone and is_active
  ) then
    -- Allow free-typed zones when the zones table is empty (first-time setup),
    -- but reject unknown codes once zones have been configured.
    if exists (select 1 from zones where is_active) then
      raise exception 'Zone "%s" is not in the active zone list. Pick one of the suggested zones, or tick All Zones.',
        v_zone
        using errcode = '22023';
    end if;
  end if;

  if exists (
    select 1 from profiles
    where role = 'picker' and status <> 'offboarded' and phone_e164 = v_phone
  ) then
    raise exception 'Mobile %s is already assigned to another active picker.', v_phone
      using errcode = '23505';
  end if;

  v_email := 'p' || regexp_replace(v_phone, '\D', '', 'g') || '@picker.internal';

  for v_i in 1..12 loop
    v_bytes := gen_random_bytes(4);
    v_picker_code := 'PKR-' ||
      substr(v_alphabet, 1 + (get_byte(v_bytes, 0) % length(v_alphabet)), 1) ||
      substr(v_alphabet, 1 + (get_byte(v_bytes, 1) % length(v_alphabet)), 1) ||
      substr(v_alphabet, 1 + (get_byte(v_bytes, 2) % length(v_alphabet)), 1) ||
      substr(v_alphabet, 1 + (get_byte(v_bytes, 3) % length(v_alphabet)), 1);
    exit when not exists (select 1 from profiles where picker_code = v_picker_code);
  end loop;

  begin
    insert into auth.users (
      instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
      confirmation_token, recovery_token, email_change_token_new, email_change
    ) values (
      '00000000-0000-0000-0000-000000000000',
      v_user_id,
      'authenticated',
      'authenticated',
      v_email,
      crypt(v_login_code, gen_salt('bf')),
      now(),
      jsonb_build_object('provider', 'email', 'providers', jsonb_build_array('email')),
      jsonb_build_object('full_name', v_full_name, 'phone_e164', v_phone),
      now(),
      now(),
      '',
      '',
      '',
      ''
    );

    insert into auth.identities (
      id, user_id, identity_data, provider, provider_id,
      last_sign_in_at, created_at, updated_at
    ) values (
      gen_random_uuid(),
      v_user_id,
      jsonb_build_object('sub', v_user_id::text, 'email', v_email),
      'email',
      v_user_id::text,
      now(),
      now(),
      now()
    );
  exception
    when unique_violation then
      raise exception 'Mobile %s (or its login email) is already registered. Use a different mobile number.',
        v_phone
        using errcode = '23505';
  end;

  update profiles
  set role = 'picker',
      full_name = v_full_name,
      phone_e164 = v_phone,
      picker_code = v_picker_code,
      home_zone = v_zone,
      all_zones = v_all_zones,
      status = 'active',
      login_code_rotated_at = now(),
      updated_at = now()
  where id = v_user_id
  returning * into v_profile;

  if v_profile.id is null then
    raise exception 'The login account was created, but the picker profile could not be saved. Contact support with mobile %s.',
      v_phone
      using errcode = 'P0001';
  end if;

  insert into audit_logs (actor_user_id, action, target_type, target_id, metadata)
  values (
    auth.uid(),
    'picker.create',
    'profile',
    v_user_id,
    jsonb_build_object('zone', v_zone, 'all_zones', v_all_zones)
  );

  return jsonb_build_object(
    'id', v_profile.id,
    'picker_code', v_profile.picker_code,
    'phone_e164', v_profile.phone_e164,
    'full_name', v_profile.full_name,
    'home_zone', v_profile.home_zone,
    'all_zones', v_profile.all_zones,
    'login_code', v_login_code
  );
end;
$$;

revoke all on function admin_normalise_picker_phone_v1(text) from public;
revoke all on function admin_create_picker_v1(text, text, text, text, boolean) from public;
grant execute on function admin_create_picker_v1(text, text, text, text, boolean) to authenticated;

notify pgrst, 'reload schema';

-- ========================= END 0012_picker_create_clear_errors.sql =========================


-- ======================== BEGIN 0013_ensure_order_is_fragile.sql ========================

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

-- ========================= END 0013_ensure_order_is_fragile.sql =========================


-- ======================== BEGIN 0014_bag_scan_mode.sql ========================

-- ============================================================================
-- 0014_bag_scan_mode.sql
--
-- Adds an operations-wide "bag scan mode" that controls how many physical
-- scans a picker must perform per shipment (what the schema calls an `order`).
--
--   * 'all_bags' (default, legacy behaviour): every bag in the shipment is
--     scanned at pickup AND at drop-off. Nothing changes for existing sites.
--   * 'one_bag': scanning any ONE bag of the shipment confirms the whole
--     shipment at that stage. One scan at pickup marks every bag picked up;
--     one scan at the pigeon hole marks every bag sorted and the shipment
--     ready for dispatch.
--
-- The setting is global (a single operations_configuration row), toggled from
-- the Admin panel. The bag/scan audit trail is preserved: one bag_scans row is
-- still written per confirming scan, and every order_bags row is still moved to
-- its correct status so counts, history and dispatch gating stay consistent.
--
-- Terminology note: throughout this codebase `orders` == shipments. One store
-- order may map to several shipments; a picker is assigned a shipment, and a
-- pigeon hole holds exactly one shipment.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Configuration column
-- ----------------------------------------------------------------------------

alter table operations_configuration
  add column if not exists bag_scan_mode text not null default 'all_bags'
  check (bag_scan_mode in ('all_bags', 'one_bag'));

-- ----------------------------------------------------------------------------
-- get_bag_scan_mode_v1 — lets a picker's client learn the active mode.
-- operations_configuration is admin-only via RLS, so a SECURITY DEFINER reader
-- exposes just this one non-sensitive flag to any authenticated user.
-- ----------------------------------------------------------------------------

create or replace function get_bag_scan_mode_v1()
returns text
language sql
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (select bag_scan_mode from operations_configuration where singleton),
    'all_bags'
  );
$$;

grant execute on function get_bag_scan_mode_v1() to authenticated;

-- ----------------------------------------------------------------------------
-- admin_set_bag_scan_mode_v1 — admin-only setter (mirrors the other
-- admin_update_*_configuration_v1 helpers).
-- ----------------------------------------------------------------------------

create or replace function admin_set_bag_scan_mode_v1(p_bag_scan_mode text)
returns operations_configuration
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_config operations_configuration;
begin
  if (select role from profiles where id = auth.uid()) <> 'admin' then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if p_bag_scan_mode not in ('all_bags', 'one_bag') then
    raise exception 'bag scan mode must be all_bags or one_bag' using errcode = '40001';
  end if;

  update operations_configuration
  set bag_scan_mode = p_bag_scan_mode,
      updated_at = now(),
      updated_by_user_id = auth.uid()
  where singleton
  returning * into v_config;

  return v_config;
end;
$$;

grant execute on function admin_set_bag_scan_mode_v1(text) to authenticated;

-- ----------------------------------------------------------------------------
-- scan_bag_pickup_v1 — pickup scan, now mode-aware.
--   all_bags: claim the next expected bag slot (one scan per bag).
--   one_bag:  a single scan claims every remaining expected bag at once.
-- ----------------------------------------------------------------------------

create or replace function scan_bag_pickup_v1(
  p_client_event_id uuid,
  p_order_id uuid,
  p_qr_code_value text,
  p_client_captured_at timestamptz,
  p_gps_lat double precision default null,
  p_gps_lng double precision default null,
  p_device_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order orders;
  v_qr qr_codes;
  v_bag order_bags;
  v_existing bag_scans;
  v_scan_mode text;
  v_from_status order_status;
begin
  -- Idempotency: a retried request with the same client_event_id returns the
  -- original result rather than creating a second event or double-counting.
  select * into v_existing from bag_scans where client_event_id = p_client_event_id;
  if v_existing.id is not null then
    select * into v_order from orders where id = v_existing.order_id;
    return jsonb_build_object(
      'order_bag_id', v_existing.order_bag_id,
      'scanned', v_order.bag_count_scanned_pickup,
      'expected', v_order.bag_count_expected,
      'order_status', v_order.status,
      'idempotent_replay', true
    );
  end if;

  select * into v_order from orders where id = p_order_id for update;
  if v_order is null then
    raise exception 'order not found' using errcode = 'P0002';
  end if;
  if v_order.assigned_picker_id is distinct from auth.uid() then
    raise exception 'order not assigned to caller' using errcode = '42501';
  end if;
  if v_order.status not in ('assigned', 'picking_in_progress') then
    raise exception 'order is not in a pickable state (status=%)', v_order.status using errcode = '40001';
  end if;

  select * into v_qr from qr_codes where code_value = p_qr_code_value and status = 'active';
  if v_qr is null then
    raise exception 'qr code not recognized or inactive' using errcode = 'P0002';
  end if;
  if v_qr.code_type <> 'bag' or v_qr.entity_id <> v_order.id then
    raise exception 'qr code does not belong to this order' using errcode = '40001';
  end if;

  if v_order.bag_count_scanned_pickup >= v_order.bag_count_expected then
    raise exception 'expected bag count already reached' using errcode = '40001';
  end if;

  select coalesce((select bag_scan_mode from operations_configuration where singleton), 'all_bags')
    into v_scan_mode;
  v_from_status := v_order.status;

  if v_scan_mode = 'one_bag' then
    -- One confirming scan for the whole shipment. Record the scan against the
    -- lowest-sequence expected bag, then mark every remaining expected bag as
    -- picked up so counts, statuses and history stay consistent.
    select * into v_bag
    from order_bags
    where order_id = p_order_id and status = 'expected'
    order by bag_sequence
    limit 1
    for update;

    if v_bag is null then
      raise exception 'no remaining expected bag slots for this order' using errcode = '40001';
    end if;

    update order_bags
    set status = 'picked_up', picked_up_at = now(), updated_at = now()
    where order_id = p_order_id and status = 'expected';

    insert into bag_scans (
      client_event_id, order_id, order_bag_id, qr_code_id,
      scan_type, scanned_entity_type, actor_user_id,
      device_id, gps_lat, gps_lng, client_captured_at
    ) values (
      p_client_event_id, p_order_id, v_bag.id, v_qr.id,
      'pickup', 'bag', auth.uid(),
      p_device_id, p_gps_lat, p_gps_lng, p_client_captured_at
    );

    update orders
    set bag_count_scanned_pickup = bag_count_expected,
        status = 'picked'::order_status,
        picked_at = now(),
        updated_at = now()
    where id = p_order_id
    returning * into v_order;

    insert into status_history (entity_type, entity_id, from_status, to_status, actor_type, actor_user_id, reason)
    values ('order', p_order_id, v_from_status::text, 'picked', 'system', auth.uid(), 'one_bag scan mode');

    return jsonb_build_object(
      'order_bag_id', v_bag.id,
      'bag_sequence', v_bag.bag_sequence,
      'scanned', v_order.bag_count_scanned_pickup,
      'expected', v_order.bag_count_expected,
      'order_status', v_order.status,
      'scan_mode', 'one_bag',
      'idempotent_replay', false
    );
  end if;

  -- Default 'all_bags': claim the next EXPECTED logical bag slot, locked
  -- against concurrent scans.
  select * into v_bag
  from order_bags
  where order_id = p_order_id and status = 'expected'
  order by bag_sequence
  limit 1
  for update skip locked;

  if v_bag is null then
    raise exception 'no remaining expected bag slots for this order' using errcode = '40001';
  end if;

  update order_bags
  set status = 'picked_up', picked_up_at = now(), updated_at = now()
  where id = v_bag.id;

  insert into bag_scans (
    client_event_id, order_id, order_bag_id, qr_code_id,
    scan_type, scanned_entity_type, actor_user_id,
    device_id, gps_lat, gps_lng, client_captured_at
  ) values (
    p_client_event_id, p_order_id, v_bag.id, v_qr.id,
    'pickup', 'bag', auth.uid(),
    p_device_id, p_gps_lat, p_gps_lng, p_client_captured_at
  );

  update orders
  set bag_count_scanned_pickup = bag_count_scanned_pickup + 1,
      status = case
        when bag_count_scanned_pickup + 1 >= bag_count_expected then 'picked'::order_status
        else 'picking_in_progress'::order_status
      end,
      picked_at = case
        when bag_count_scanned_pickup + 1 >= bag_count_expected then now()
        else picked_at
      end,
      updated_at = now()
  where id = p_order_id
  returning * into v_order;

  if v_order.status = 'picked' then
    insert into status_history (entity_type, entity_id, from_status, to_status, actor_type, actor_user_id)
    values ('order', p_order_id, 'picking_in_progress', 'picked', 'system', auth.uid());
  end if;

  return jsonb_build_object(
    'order_bag_id', v_bag.id,
    'bag_sequence', v_bag.bag_sequence,
    'scanned', v_order.bag_count_scanned_pickup,
    'expected', v_order.bag_count_expected,
    'order_status', v_order.status,
    'scan_mode', 'all_bags',
    'idempotent_replay', false
  );
end;
$$;

grant execute on function scan_bag_pickup_v1(uuid, uuid, text, timestamptz, double precision, double precision, text) to authenticated;

-- ----------------------------------------------------------------------------
-- scan_bag_into_pigeon_hole_v1 — drop-off scan, now mode-aware.
--   all_bags: mark one bag sorted into the currently-unlocked hole per scan.
--   one_bag:  a single valid bag scan marks the whole shipment sorted — every
--             picked-up bag across all of the shipment's holes — and readies
--             it for dispatch.
-- Hole/bag validation (correct hole unlocked, bag belongs to the shipment) is
-- unchanged in both modes; only the state transition differs.
-- ----------------------------------------------------------------------------

create or replace function scan_bag_into_pigeon_hole_v1(
  p_client_event_id uuid,
  p_order_id uuid,
  p_bag_qr_value text,
  p_pigeon_hole_qr_value text,
  p_client_captured_at timestamptz,
  p_device_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_existing bag_scans;
  v_order orders;
  v_bag_qr qr_codes;
  v_hole_qr qr_codes;
  v_assignment pigeon_hole_assignments;
  v_hole pigeon_holes;
  v_bag order_bags;
  v_scan_mode text;
begin
  select * into v_existing from bag_scans where client_event_id = p_client_event_id;
  if v_existing.id is not null then
    select * into v_order from orders where id = v_existing.order_id;
    return jsonb_build_object(
      'order_bag_id', v_existing.order_bag_id,
      'dropped', v_order.bag_count_scanned_sort,
      'order_expected', v_order.bag_count_expected,
      'hole_complete', true,
      'idempotent_replay', true
    );
  end if;

  select * into v_order from orders where id = p_order_id for update;
  if v_order.id is null or v_order.assigned_picker_id is distinct from auth.uid() then
    raise exception 'order not found or not assigned to caller' using errcode = '42501';
  end if;

  select * into v_hole_qr from qr_codes
  where code_value = p_pigeon_hole_qr_value and code_type = 'pigeon_hole' and status = 'active';
  if v_hole_qr.id is null then
    raise exception 'QR code is not a recognized pigeon hole' using errcode = 'P0002';
  end if;

  select pha.*
  into v_assignment
  from pigeon_hole_assignments pha
  join pigeon_holes ph on ph.id = pha.pigeon_hole_id
  where pha.order_id = p_order_id
    and pha.status in ('reserved', 'active')
    and pha.bags_sorted < pha.bags_reserved
  order by pha.reserved_at, ph.hole_number
  limit 1
  for update of pha, ph;
  if v_assignment.id is null or v_hole_qr.entity_id is distinct from v_assignment.pigeon_hole_id then
    raise exception 'Wrong pigeon hole. Complete the currently unlocked hole first.' using errcode = '40001';
  end if;
  select * into v_hole from pigeon_holes where id = v_assignment.pigeon_hole_id;

  select * into v_bag_qr from qr_codes
  where code_value = p_bag_qr_value and code_type = 'bag' and status = 'active';
  if v_bag_qr.id is null or v_bag_qr.entity_id is distinct from p_order_id then
    raise exception 'Wrong bag, bag does not belong to the hole' using errcode = '40001';
  end if;

  select * into v_bag
  from order_bags
  where order_id = p_order_id
    and pigeon_hole_id = v_assignment.pigeon_hole_id
    and status = 'picked_up'
  order by bag_sequence
  limit 1
  for update skip locked;
  if v_bag.id is null then
    raise exception 'Wrong bag, bag does not belong to the hole' using errcode = '40001';
  end if;

  select coalesce((select bag_scan_mode from operations_configuration where singleton), 'all_bags')
    into v_scan_mode;

  if v_scan_mode = 'one_bag' then
    -- One confirming scan sorts the entire shipment. Move every remaining
    -- picked-up bag (across all of this shipment's holes) to sorted, fill each
    -- of its holes, and ready the shipment for dispatch. Record the scan
    -- against the bag actually presented.
    update order_bags
    set status = 'sorted', sorted_at = now(), updated_at = now()
    where order_id = p_order_id and status = 'picked_up';

    update pigeon_hole_assignments
    set status = 'active',
        bags_sorted = bags_reserved,
        filled_at = coalesce(filled_at, now())
    where order_id = p_order_id and status in ('reserved', 'active');

    update pigeon_holes
    set status = 'filled', updated_at = now()
    where id in (
      select pigeon_hole_id from pigeon_hole_assignments
      where order_id = p_order_id and status = 'active'
    );

    insert into bag_scans (
      client_event_id, order_id, order_bag_id, qr_code_id, pigeon_hole_id,
      scan_type, scanned_entity_type, actor_user_id, device_id, client_captured_at
    ) values (
      p_client_event_id, p_order_id, v_bag.id, v_bag_qr.id, v_assignment.pigeon_hole_id,
      'sort', 'bag', auth.uid(), p_device_id, p_client_captured_at
    );

    update orders
    set bag_count_scanned_sort = bag_count_expected,
        status = 'ready_for_dispatch'::order_status,
        sorted_at = now(),
        updated_at = now()
    where id = p_order_id
    returning * into v_order;

    insert into status_history (entity_type, entity_id, from_status, to_status, actor_type, actor_user_id, reason)
    values ('order', p_order_id, 'sorting_in_progress', 'ready_for_dispatch', 'system', auth.uid(), 'one_bag scan mode');

    return jsonb_build_object(
      'order_bag_id', v_bag.id,
      'dropped', v_assignment.bags_reserved,
      'expected', v_assignment.bags_reserved,
      'hole_complete', true,
      'order_complete', true,
      'scan_mode', 'one_bag',
      'idempotent_replay', false
    );
  end if;

  -- Default 'all_bags': sort exactly one bag into the unlocked hole.
  update order_bags
  set status = 'sorted', sorted_at = now(), updated_at = now()
  where id = v_bag.id;

  update pigeon_hole_assignments
  set status = 'active',
      bags_sorted = bags_sorted + 1,
      filled_at = case when bags_sorted + 1 >= bags_reserved then now() else filled_at end
  where id = v_assignment.id
  returning * into v_assignment;

  update pigeon_holes
  set status = case
      when v_assignment.bags_sorted >= v_assignment.bags_reserved then 'filled'::pigeon_hole_status
      else 'partially_filled'::pigeon_hole_status
    end,
    updated_at = now()
  where id = v_assignment.pigeon_hole_id;

  insert into bag_scans (
    client_event_id, order_id, order_bag_id, qr_code_id, pigeon_hole_id,
    scan_type, scanned_entity_type, actor_user_id, device_id, client_captured_at
  ) values (
    p_client_event_id, p_order_id, v_bag.id, v_bag_qr.id, v_assignment.pigeon_hole_id,
    'sort', 'bag', auth.uid(), p_device_id, p_client_captured_at
  );

  update orders
  set bag_count_scanned_sort = bag_count_scanned_sort + 1,
      status = case
        when bag_count_scanned_sort + 1 >= bag_count_expected then 'ready_for_dispatch'::order_status
        else 'sorting_in_progress'::order_status
      end,
      sorted_at = case when bag_count_scanned_sort + 1 >= bag_count_expected then now() else sorted_at end,
      updated_at = now()
  where id = p_order_id
  returning * into v_order;

  return jsonb_build_object(
    'order_bag_id', v_bag.id,
    'dropped', v_assignment.bags_sorted,
    'expected', v_assignment.bags_reserved,
    'hole_complete', v_assignment.bags_sorted >= v_assignment.bags_reserved,
    'order_complete', v_order.status = 'ready_for_dispatch',
    'scan_mode', 'all_bags',
    'idempotent_replay', false
  );
end;
$$;

grant execute on function scan_bag_into_pigeon_hole_v1(uuid, uuid, text, text, timestamptz, text) to authenticated;

notify pgrst, 'reload schema';

-- ========================= END 0014_bag_scan_mode.sql =========================


-- ======================== BEGIN 0015_picker_chosen_holes.sql ========================

-- ============================================================================
-- 0015_picker_chosen_holes.sql
--
-- Adds a second pigeon-hole assignment mode, selectable from Admin -> Config:
--
--   * 'pre_assigned' (default, current behaviour): a hole is reserved for the
--     shipment at warehouse arrival and the picker is routed to it. Nothing in
--     this mode changes - the existing arrival/sort RPCs are untouched.
--
--   * 'picker_chosen': no hole is reserved at arrival. At the wall the picker
--     scans any FREE hole to put it "on hold", then scans a bag; the first bag
--     LINKS that hole to the bag's shipment. From then on only that shipment's
--     bags may go into that hole, and the shipment's bags may only go into that
--     hole. Works with both bag-scan modes (0014): one scan completes the
--     shipment in one_bag mode; per-bag in all_bags mode.
--
-- Terminology: `orders` == shipments; one pigeon hole holds one shipment.
--
-- This migration only ADDS objects (a config column, two hold columns, and new
-- RPCs) so pre_assigned mode is byte-for-byte unchanged.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Config + hole hold columns
-- ----------------------------------------------------------------------------

alter table operations_configuration
  add column if not exists hole_assignment_mode text not null default 'pre_assigned'
  check (hole_assignment_mode in ('pre_assigned', 'picker_chosen'));

-- A free hole a picker has scanned but not yet placed a bag into is "held" by
-- that picker so a second picker who scans it is told it is taken. The hold is
-- transient: it is cleared when the first bag links the hole to a shipment, is
-- moved when the picker scans a different hole, and is auto-released if stale.
alter table pigeon_holes
  add column if not exists held_by_picker_id uuid references profiles(id),
  add column if not exists held_at timestamptz;

-- How long an un-started hold survives before another picker may take the hole.
create or replace function pigeon_hole_hold_ttl_v1()
returns interval language sql immutable as $$ select interval '30 minutes' $$;

-- ----------------------------------------------------------------------------
-- Mode reader (picker client, past admin-only RLS) + admin setter
-- ----------------------------------------------------------------------------

create or replace function get_hole_assignment_mode_v1()
returns text
language sql
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (select hole_assignment_mode from operations_configuration where singleton),
    'pre_assigned'
  );
$$;

grant execute on function get_hole_assignment_mode_v1() to authenticated;

create or replace function admin_set_hole_assignment_mode_v1(p_mode text)
returns operations_configuration
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_config operations_configuration;
begin
  if (select role from profiles where id = auth.uid()) <> 'admin' then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if p_mode not in ('pre_assigned', 'picker_chosen') then
    raise exception 'hole assignment mode must be pre_assigned or picker_chosen' using errcode = '40001';
  end if;

  update operations_configuration
  set hole_assignment_mode = p_mode,
      updated_at = now(),
      updated_by_user_id = auth.uid()
  where singleton
  returning * into v_config;

  return v_config;
end;
$$;

grant execute on function admin_set_hole_assignment_mode_v1(text) to authenticated;

-- ----------------------------------------------------------------------------
-- record_warehouse_arrival_picker_chosen_v1 — arrival WITHOUT reserving holes.
-- Marks each fully-picked order this picker carries as arrived/sorting, so it
-- shows on the sort screen awaiting a hole the picker will choose at the wall.
-- Returns the same shape as the pre_assigned arrival (hole number is always
-- null here; reserved=true means "arrived OK").
-- ----------------------------------------------------------------------------

create or replace function record_warehouse_arrival_picker_chosen_v1(
  p_client_event_id uuid,
  p_gate_qr_value text,
  p_order_ids uuid[],
  p_client_captured_at timestamptz,
  p_gps_lat double precision default null,
  p_gps_lng double precision default null,
  p_device_id text default null
)
returns setof warehouse_arrival_result
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_gate_qr qr_codes;
  v_warehouse_id uuid;
  v_sort_wall_id uuid;
  v_order_id uuid;
  v_order orders;
  v_existing bag_scans;
begin
  select * into v_existing from bag_scans where client_event_id = p_client_event_id;
  if v_existing.id is not null then
    return query
      select o.id, null::text, (o.warehouse_arrived_at is not null)
      from orders o where o.id = any(p_order_ids);
    return;
  end if;

  select * into v_gate_qr from qr_codes where code_value = p_gate_qr_value and status = 'active';
  if v_gate_qr.id is null or v_gate_qr.code_type <> 'warehouse_gate' then
    raise exception 'gate QR code is invalid or has expired; refresh the warehouse QR display' using errcode = 'P0002';
  end if;
  v_warehouse_id := v_gate_qr.entity_id;

  select id into v_sort_wall_id
  from sort_walls where warehouse_id = v_warehouse_id and status = 'active' limit 1;
  if v_sort_wall_id is null then
    raise exception 'no active sort wall configured for this warehouse';
  end if;

  insert into bag_scans (
    client_event_id, order_id, qr_code_id, scan_type, scanned_entity_type,
    actor_user_id, device_id, gps_lat, gps_lng, client_captured_at
  ) values (
    p_client_event_id, p_order_ids[1], v_gate_qr.id, 'warehouse_arrival', 'warehouse_gate',
    auth.uid(), p_device_id, p_gps_lat, p_gps_lng, p_client_captured_at
  )
  on conflict (client_event_id) do nothing;

  foreach v_order_id in array p_order_ids loop
    select * into v_order from orders where id = v_order_id for update;
    if v_order.id is null
       or v_order.assigned_picker_id is distinct from auth.uid()
       or v_order.status <> 'picked' then
      continue;
    end if;

    update orders
    set status = 'sorting_in_progress',
        warehouse_id = v_warehouse_id,
        sort_wall_id = v_sort_wall_id,
        warehouse_arrived_at = now(),
        updated_at = now()
    where id = v_order_id;

    insert into status_history (entity_type, entity_id, from_status, to_status, actor_type, actor_user_id, reason)
    values ('order', v_order_id, 'picked', 'sorting_in_progress', 'system', auth.uid(), 'picker_chosen hole mode');

    return query select v_order_id, null::text, true;
  end loop;
end;
$$;

grant execute on function record_warehouse_arrival_picker_chosen_v1(uuid, text, uuid[], timestamptz, double precision, double precision, text) to authenticated;

-- ----------------------------------------------------------------------------
-- release_held_hole_v1 — free any un-started holds this picker is holding
-- (a hold with no active assignment). Called when the picker backs out of the
-- choose-hole flow, and used internally before taking a new hold.
-- ----------------------------------------------------------------------------

create or replace function release_held_hole_v1()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_count integer;
begin
  update pigeon_holes ph
  set status = 'free', held_by_picker_id = null, held_at = null, updated_at = now()
  where ph.held_by_picker_id = auth.uid()
    and ph.status = 'reserved'
    and not exists (
      select 1 from pigeon_hole_assignments pha
      where pha.pigeon_hole_id = ph.id and pha.status in ('reserved', 'active')
    );
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

grant execute on function release_held_hole_v1() to authenticated;

-- ----------------------------------------------------------------------------
-- claim_pigeon_hole_v1 — picker scans a FREE hole to put it on hold. Rejects a
-- hole that is occupied, out of service, or already held by another picker.
-- Re-scanning the picker's own held hole is idempotent. Taking a new hold
-- releases the picker's previous un-started hold.
-- ----------------------------------------------------------------------------

create or replace function claim_pigeon_hole_v1(p_hole_qr_value text, p_order_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_qr qr_codes;
  v_hole pigeon_holes;
  v_has_assignment boolean;
  v_assignment pigeon_hole_assignments;
begin
  if (select role from profiles where id = auth.uid()) is distinct from 'picker' then
    raise exception 'only pickers can claim pigeon holes' using errcode = '42501';
  end if;

  select * into v_qr from qr_codes
  where code_value = p_hole_qr_value and code_type = 'pigeon_hole' and status = 'active';
  if v_qr.id is null then
    raise exception 'QR code is not a recognized pigeon hole' using errcode = 'P0002';
  end if;

  select * into v_hole from pigeon_holes where id = v_qr.entity_id for update;
  if v_hole.id is null then
    raise exception 'pigeon hole not found' using errcode = 'P0002';
  end if;

  -- Resume: re-scanning the hole this shipment is already being placed in is a
  -- no-op success, so a picker who stepped away can carry on (multi-bag mode).
  if p_order_id is not null then
    select * into v_assignment
    from pigeon_hole_assignments
    where pigeon_hole_id = v_hole.id and order_id = p_order_id and status in ('reserved', 'active');
    if v_assignment.id is not null
       and (select assigned_picker_id from orders where id = p_order_id) = auth.uid() then
      return jsonb_build_object('hole_id', v_hole.id, 'hole_number', v_hole.hole_number, 'already_held', true);
    end if;
  end if;

  -- Auto-release a stale hold on this hole so an abandoned hold cannot lock it.
  if v_hole.status = 'reserved'
     and v_hole.held_by_picker_id is not null
     and v_hole.held_at is not null
     and v_hole.held_at < now() - pigeon_hole_hold_ttl_v1()
     and not exists (
       select 1 from pigeon_hole_assignments pha
       where pha.pigeon_hole_id = v_hole.id and pha.status in ('reserved', 'active')
     ) then
    update pigeon_holes set status = 'free', held_by_picker_id = null, held_at = null where id = v_hole.id;
    select * into v_hole from pigeon_holes where id = v_hole.id for update;
  end if;

  -- Idempotent re-scan of the picker's own held hole.
  if v_hole.status = 'reserved' and v_hole.held_by_picker_id = auth.uid()
     and not exists (
       select 1 from pigeon_hole_assignments pha
       where pha.pigeon_hole_id = v_hole.id and pha.status in ('reserved', 'active')
     ) then
    return jsonb_build_object('hole_id', v_hole.id, 'hole_number', v_hole.hole_number, 'already_held', true);
  end if;

  select exists (
    select 1 from pigeon_hole_assignments pha
    where pha.pigeon_hole_id = v_hole.id and pha.status in ('reserved', 'active')
  ) into v_has_assignment;

  if v_has_assignment then
    raise exception 'This pigeon hole already holds a shipment. Scan an empty hole.' using errcode = '40001';
  end if;
  if v_hole.status = 'out_of_service' then
    raise exception 'This pigeon hole is out of service. Scan another hole.' using errcode = '40001';
  end if;
  if v_hole.status <> 'free' then
    raise exception 'This pigeon hole is not free. Scan an empty hole.' using errcode = '40001';
  end if;

  -- Free the picker's previous un-started hold before taking this one.
  perform release_held_hole_v1();

  update pigeon_holes
  set status = 'reserved', held_by_picker_id = auth.uid(), held_at = now(), updated_at = now()
  where id = v_hole.id;

  return jsonb_build_object('hole_id', v_hole.id, 'hole_number', v_hole.hole_number, 'already_held', false);
end;
$$;

grant execute on function claim_pigeon_hole_v1(text, uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- scan_bag_into_chosen_hole_v1 — place a bag into a picker-chosen hole. The
-- FIRST bag links the hole to that bag's shipment (creating the assignment and
-- routing every bag of the shipment to this hole). Thereafter only this
-- shipment's bags may enter this hole, and this shipment's bags may enter no
-- other hole. Honours the 0014 bag-scan mode.
-- ----------------------------------------------------------------------------

create or replace function scan_bag_into_chosen_hole_v1(
  p_client_event_id uuid,
  p_order_id uuid,
  p_bag_qr_value text,
  p_pigeon_hole_qr_value text,
  p_client_captured_at timestamptz,
  p_device_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_existing bag_scans;
  v_order orders;
  v_bag_qr qr_codes;
  v_hole_qr qr_codes;
  v_hole pigeon_holes;
  v_assignment pigeon_hole_assignments;
  v_bag order_bags;
  v_scan_mode text;
begin
  -- Idempotent replay.
  select * into v_existing from bag_scans where client_event_id = p_client_event_id;
  if v_existing.id is not null then
    select * into v_order from orders where id = v_existing.order_id;
    return jsonb_build_object(
      'order_bag_id', v_existing.order_bag_id,
      'dropped', v_order.bag_count_scanned_sort,
      'expected', v_order.bag_count_expected,
      'hole_complete', true,
      'idempotent_replay', true
    );
  end if;

  select * into v_order from orders where id = p_order_id for update;
  if v_order.id is null or v_order.assigned_picker_id is distinct from auth.uid() then
    raise exception 'order not found or not assigned to caller' using errcode = '42501';
  end if;
  if v_order.status not in ('arrived_at_warehouse', 'sorting_in_progress') then
    raise exception 'this shipment is not ready to be sorted (status=%)', v_order.status using errcode = '40001';
  end if;

  select * into v_hole_qr from qr_codes
  where code_value = p_pigeon_hole_qr_value and code_type = 'pigeon_hole' and status = 'active';
  if v_hole_qr.id is null then
    raise exception 'QR code is not a recognized pigeon hole' using errcode = 'P0002';
  end if;
  select * into v_hole from pigeon_holes where id = v_hole_qr.entity_id for update;
  if v_hole.id is null then
    raise exception 'pigeon hole not found' using errcode = 'P0002';
  end if;

  -- The bag must belong to this shipment.
  select * into v_bag_qr from qr_codes
  where code_value = p_bag_qr_value and code_type = 'bag' and status = 'active';
  if v_bag_qr.id is null or v_bag_qr.entity_id is distinct from p_order_id then
    raise exception 'Wrong bag - this bag does not belong to this shipment' using errcode = '40001';
  end if;

  -- Existing active/reserved assignment on this hole, if any.
  select * into v_assignment
  from pigeon_hole_assignments
  where pigeon_hole_id = v_hole.id and status in ('reserved', 'active')
  for update;

  if v_assignment.id is not null and v_assignment.order_id is distinct from p_order_id then
    raise exception 'This pigeon hole is holding another shipment. Use a different hole.' using errcode = '40001';
  end if;

  -- If this shipment is already linked to a different hole, keep it there.
  if v_order.pigeon_hole_id is not null and v_order.pigeon_hole_id is distinct from v_hole.id then
    raise exception 'This shipment is already being placed in another hole. Finish that hole first.' using errcode = '40001';
  end if;

  -- FIRST bag: link the hole to this shipment (create the assignment, route all
  -- of the shipment's bags here, clear any hold).
  if v_assignment.id is null then
    if v_hole.status not in ('free', 'reserved') then
      raise exception 'This pigeon hole is not available. Scan an empty hole.' using errcode = '40001';
    end if;
    if v_hole.status = 'reserved'
       and v_hole.held_by_picker_id is not null
       and v_hole.held_by_picker_id is distinct from auth.uid() then
      raise exception 'This pigeon hole is held by another picker. Scan an empty hole.' using errcode = '40001';
    end if;

    update order_bags set pigeon_hole_id = v_hole.id, updated_at = now()
    where order_id = p_order_id;

    insert into pigeon_hole_assignments (order_id, pigeon_hole_id, status, bags_reserved, bags_sorted)
    values (p_order_id, v_hole.id, 'active', v_order.bag_count_expected, 0)
    returning * into v_assignment;

    update pigeon_holes
    set status = 'partially_filled', held_by_picker_id = null, held_at = null, updated_at = now()
    where id = v_hole.id;

    update orders set pigeon_hole_id = v_hole.id, updated_at = now() where id = p_order_id;
  end if;

  select coalesce((select bag_scan_mode from operations_configuration where singleton), 'all_bags')
    into v_scan_mode;

  if v_scan_mode = 'one_bag' then
    update order_bags
    set status = 'sorted', sorted_at = now(), updated_at = now()
    where order_id = p_order_id and status = 'picked_up';

    update pigeon_hole_assignments
    set status = 'active', bags_sorted = bags_reserved, filled_at = coalesce(filled_at, now())
    where id = v_assignment.id
    returning * into v_assignment;

    update pigeon_holes set status = 'filled', updated_at = now() where id = v_hole.id;

    insert into bag_scans (
      client_event_id, order_id, order_bag_id, qr_code_id, pigeon_hole_id,
      scan_type, scanned_entity_type, actor_user_id, device_id, client_captured_at
    ) values (
      p_client_event_id, p_order_id, null, v_bag_qr.id, v_hole.id,
      'sort', 'bag', auth.uid(), p_device_id, p_client_captured_at
    );

    update orders
    set bag_count_scanned_sort = bag_count_expected,
        status = 'ready_for_dispatch'::order_status,
        sorted_at = now(), updated_at = now()
    where id = p_order_id
    returning * into v_order;

    insert into status_history (entity_type, entity_id, from_status, to_status, actor_type, actor_user_id, reason)
    values ('order', p_order_id, 'sorting_in_progress', 'ready_for_dispatch', 'system', auth.uid(), 'picker_chosen + one_bag');

    return jsonb_build_object(
      'hole_id', v_hole.id, 'hole_number', v_hole.hole_number,
      'dropped', v_assignment.bags_reserved, 'expected', v_assignment.bags_reserved,
      'hole_complete', true, 'order_complete', true, 'scan_mode', 'one_bag',
      'idempotent_replay', false
    );
  end if;

  -- all_bags: place exactly one picked-up bag routed to this hole.
  select * into v_bag
  from order_bags
  where order_id = p_order_id and pigeon_hole_id = v_hole.id and status = 'picked_up'
  order by bag_sequence
  limit 1
  for update skip locked;
  if v_bag.id is null then
    raise exception 'No remaining bags to place for this shipment in this hole.' using errcode = '40001';
  end if;

  update order_bags set status = 'sorted', sorted_at = now(), updated_at = now() where id = v_bag.id;

  update pigeon_hole_assignments
  set status = 'active',
      bags_sorted = bags_sorted + 1,
      filled_at = case when bags_sorted + 1 >= bags_reserved then now() else filled_at end
  where id = v_assignment.id
  returning * into v_assignment;

  update pigeon_holes
  set status = case when v_assignment.bags_sorted >= v_assignment.bags_reserved
                    then 'filled'::pigeon_hole_status else 'partially_filled'::pigeon_hole_status end,
      updated_at = now()
  where id = v_hole.id;

  insert into bag_scans (
    client_event_id, order_id, order_bag_id, qr_code_id, pigeon_hole_id,
    scan_type, scanned_entity_type, actor_user_id, device_id, client_captured_at
  ) values (
    p_client_event_id, p_order_id, v_bag.id, v_bag_qr.id, v_hole.id,
    'sort', 'bag', auth.uid(), p_device_id, p_client_captured_at
  );

  update orders
  set bag_count_scanned_sort = bag_count_scanned_sort + 1,
      status = case when bag_count_scanned_sort + 1 >= bag_count_expected
                    then 'ready_for_dispatch'::order_status else 'sorting_in_progress'::order_status end,
      sorted_at = case when bag_count_scanned_sort + 1 >= bag_count_expected then now() else sorted_at end,
      updated_at = now()
  where id = p_order_id
  returning * into v_order;

  return jsonb_build_object(
    'hole_id', v_hole.id, 'hole_number', v_hole.hole_number,
    'dropped', v_assignment.bags_sorted, 'expected', v_assignment.bags_reserved,
    'hole_complete', v_assignment.bags_sorted >= v_assignment.bags_reserved,
    'order_complete', v_order.status = 'ready_for_dispatch', 'scan_mode', 'all_bags',
    'idempotent_replay', false
  );
end;
$$;

grant execute on function scan_bag_into_chosen_hole_v1(uuid, uuid, text, text, timestamptz, text) to authenticated;

notify pgrst, 'reload schema';

-- ========================= END 0015_picker_chosen_holes.sql =========================

