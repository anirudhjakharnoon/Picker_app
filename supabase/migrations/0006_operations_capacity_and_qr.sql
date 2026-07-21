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
