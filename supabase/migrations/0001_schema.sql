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
