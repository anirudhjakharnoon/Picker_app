-- ============================================================================
-- 0016_delivery_mode_walls.sql
--
-- Adds a "delivery mode" (LMS | Hyperlocal) to shipments and to sort walls, and
-- routes each shipment only to holes on the wall matching its delivery mode:
--
--   * orders.delivery_mode        - comes from the store order API.
--   * sort_walls.delivery_mode    - tags a wall as the LMS wall or Hyperlocal wall.
--   * An LMS shipment's bags may only go into holes on an LMS wall, and a
--     Hyperlocal shipment's only into Hyperlocal-wall holes. Enforced in BOTH
--     assignment modes: pre-assigned arrival reserves holes on the matching
--     wall; picker-chosen claim/scan reject a hole on the wrong wall.
--
-- Both columns are nullable so existing rows keep working: a shipment with no
-- delivery_mode routes to any wall (legacy), and an untagged wall accepts only
-- untagged shipments. Tag both walls (SQL provided separately, or via the new
-- admin "Create sort wall" form) to turn the separation on.
-- ============================================================================

alter table orders
  add column if not exists delivery_mode text
  check (delivery_mode is null or delivery_mode in ('LMS', 'Hyperlocal'));

alter table sort_walls
  add column if not exists delivery_mode text
  check (delivery_mode is null or delivery_mode in ('LMS', 'Hyperlocal'));

-- Wall delivery mode for a given hole (used by the picker-chosen gate).
create or replace function hole_wall_delivery_mode_v1(p_hole_id uuid)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select sw.delivery_mode
  from pigeon_holes ph join sort_walls sw on sw.id = ph.sort_wall_id
  where ph.id = p_hole_id
$$;

grant execute on function hole_wall_delivery_mode_v1(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- admin_create_sort_wall_v1 — create an LMS or Hyperlocal wall from Admin.
-- ----------------------------------------------------------------------------

create or replace function admin_create_sort_wall_v1(
  p_warehouse_id uuid,
  p_name text,
  p_delivery_mode text default null,
  p_rows integer default 1,
  p_columns integer default 1
)
returns sort_walls
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_wall sort_walls;
begin
  if (select role from profiles where id = auth.uid()) <> 'admin' then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if coalesce(trim(p_name), '') = '' then
    raise exception 'wall name is required' using errcode = '40001';
  end if;
  if p_delivery_mode is not null and p_delivery_mode not in ('LMS', 'Hyperlocal') then
    raise exception 'delivery mode must be LMS or Hyperlocal' using errcode = '40001';
  end if;

  insert into sort_walls (warehouse_id, name, delivery_mode, rows, columns, status)
  values (p_warehouse_id, trim(p_name), p_delivery_mode, greatest(coalesce(p_rows, 1), 1), greatest(coalesce(p_columns, 1), 1), 'active')
  returning * into v_wall;
  return v_wall;
end;
$$;

grant execute on function admin_create_sort_wall_v1(uuid, text, text, integer, integer) to authenticated;

-- ----------------------------------------------------------------------------
-- admin_create_order_v1 — gains p_delivery_mode. Drop the old 8-arg version so
-- there is a single, unambiguous signature for PostgREST.
-- ----------------------------------------------------------------------------

drop function if exists admin_create_order_v1(text, integer, text, text, text, text, boolean, text);

create or replace function admin_create_order_v1(
  p_store_external_ref text, p_bag_count integer, p_store_floor text default null,
  p_store_zone text default null, p_store_address text default null,
  p_external_order_ref text default null, p_is_fragile boolean default false,
  p_store_name text default null, p_delivery_mode text default null
) returns orders language plpgsql security definer set search_path = public, pg_temp as $$
declare v_caller_role user_role; v_store stores; v_order orders; v_qr qr_codes; v_ref text; i integer;
begin
  v_caller_role := (select role from profiles where id = auth.uid());
  if v_caller_role not in ('ops_manager','admin') then raise exception 'not permitted' using errcode = '42501'; end if;
  if p_bag_count is null or p_bag_count <= 0 or p_bag_count > 32767 then raise exception 'bag count must be a positive number no greater than 32767' using errcode = '40001'; end if;
  if p_delivery_mode is not null and p_delivery_mode not in ('LMS','Hyperlocal') then raise exception 'delivery mode must be LMS or Hyperlocal' using errcode = '40001'; end if;
  select * into v_store from stores where external_ref = p_store_external_ref;
  if v_store.id is null then
    insert into stores(external_ref,name,default_zone) values(p_store_external_ref,coalesce(p_store_name,p_store_external_ref),p_store_zone) returning * into v_store;
  elsif p_store_name is not null and p_store_name <> v_store.name then
    update stores set name=p_store_name,updated_at=now() where id=v_store.id returning * into v_store;
  end if;
  v_ref := coalesce(p_external_order_ref,'SO-'||to_char(now(),'YYMMDDHH24MISS')||'-'||substr(gen_random_uuid()::text,1,4));
  insert into orders(store_id,external_order_ref,bag_count_expected,store_floor,store_zone,store_address,status,is_fragile,delivery_mode)
  values(v_store.id,v_ref,p_bag_count,p_store_floor,coalesce(p_store_zone,v_store.default_zone),p_store_address,'available',coalesce(p_is_fragile,false),p_delivery_mode)
  returning * into v_order;
  insert into qr_codes(code_type,code_value,code_version,entity_id,status)
  values('bag',v_ref||'-'||substr(gen_random_uuid()::text,1,6),1,v_order.id,'active') returning * into v_qr;
  update orders set shared_bag_qr_code_id=v_qr.id where id=v_order.id returning * into v_order;
  for i in 1..p_bag_count loop insert into order_bags(order_id,bag_sequence,status) values(v_order.id,i,'expected'); end loop;
  insert into status_history(entity_type,entity_id,from_status,to_status,actor_type,actor_user_id)
  values('order',v_order.id,null,'available','user',auth.uid());
  select * into v_order from orders where id=v_order.id;
  return v_order;
end;
$$;

grant execute on function admin_create_order_v1(text,integer,text,text,text,text,boolean,text,text) to authenticated;

-- ----------------------------------------------------------------------------
-- record_warehouse_arrival_v1 (pre-assigned) — now selects, PER ORDER, the
-- active wall whose delivery_mode matches the shipment's. A shipment with a
-- delivery_mode but no matching wall goes to overflow (no hole) rather than
-- being routed to the wrong wall.
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
  where code_value = p_gate_qr_value and code_type = 'warehouse_gate'
    and status = 'active' and expires_at > now();
  if v_gate_qr.id is null then
    raise exception 'gate QR code is invalid or has expired; refresh the warehouse QR display' using errcode = 'P0002';
  end if;
  v_warehouse_id := v_gate_qr.entity_id;

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

    -- Pick the active wall for this shipment's delivery mode. A null-mode
    -- shipment matches any wall (legacy); a moded shipment needs a wall tagged
    -- with the same mode.
    select id into v_sort_wall_id
    from sort_walls
    where warehouse_id = v_warehouse_id and status = 'active'
      and (v_order.delivery_mode is null or delivery_mode is not distinct from v_order.delivery_mode)
    order by (delivery_mode is not distinct from v_order.delivery_mode) desc
    limit 1;

    -- No matching wall -> stage as overflow (arrived, no hole reserved).
    if v_sort_wall_id is null then
      update orders
      set status = 'arrived_at_warehouse', warehouse_id = v_warehouse_id,
          warehouse_arrived_at = now(), updated_at = now()
      where id = v_order_id;
      return query select v_order_id, null::text, false;
      continue;
    end if;

    select ceil(v_order.bag_count_expected::numeric / c.bags_per_pigeon_hole)::integer
      into v_required_holes
    from operations_configuration c where c.singleton;

    v_hole_ids := array[]::uuid[];
    v_hole_numbers := array[]::text[];
    for v_hole in
      select * from pigeon_holes
      where sort_wall_id = v_sort_wall_id and status = 'free'
      order by hole_number
      limit v_required_holes
      for update skip locked
    loop
      v_hole_ids := array_append(v_hole_ids, v_hole.id);
      v_hole_numbers := array_append(v_hole_numbers, v_hole.hole_number);
    end loop;

    if cardinality(v_hole_ids) < v_required_holes then
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

grant execute on function record_warehouse_arrival_v1(uuid, text, uuid[], timestamptz, double precision, double precision, text) to authenticated;

-- ----------------------------------------------------------------------------
-- claim_pigeon_hole_v1 — add the delivery-mode wall gate (picker-chosen).
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
  v_order_mode text;
  v_wall_mode text;
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

  -- Delivery-mode wall gate: an LMS shipment may only use LMS-wall holes, etc.
  if p_order_id is not null then
    v_order_mode := (select delivery_mode from orders where id = p_order_id);
    v_wall_mode := hole_wall_delivery_mode_v1(v_hole.id);
    if v_order_mode is not null and v_wall_mode is distinct from v_order_mode then
      raise exception 'This hole is on the % wall. Use a % hole for this shipment.',
        coalesce(v_wall_mode, 'un-tagged'), v_order_mode using errcode = '40001';
    end if;
  end if;

  if p_order_id is not null then
    select * into v_assignment
    from pigeon_hole_assignments
    where pigeon_hole_id = v_hole.id and order_id = p_order_id and status in ('reserved', 'active');
    if v_assignment.id is not null
       and (select assigned_picker_id from orders where id = p_order_id) = auth.uid() then
      return jsonb_build_object('hole_id', v_hole.id, 'hole_number', v_hole.hole_number, 'already_held', true);
    end if;
  end if;

  if v_hole.status = 'reserved'
     and v_hole.held_by_picker_id is not null and v_hole.held_at is not null
     and v_hole.held_at < now() - pigeon_hole_hold_ttl_v1()
     and not exists (select 1 from pigeon_hole_assignments pha where pha.pigeon_hole_id = v_hole.id and pha.status in ('reserved', 'active')) then
    update pigeon_holes set status = 'free', held_by_picker_id = null, held_at = null where id = v_hole.id;
    select * into v_hole from pigeon_holes where id = v_hole.id for update;
  end if;

  if v_hole.status = 'reserved' and v_hole.held_by_picker_id = auth.uid()
     and not exists (select 1 from pigeon_hole_assignments pha where pha.pigeon_hole_id = v_hole.id and pha.status in ('reserved', 'active')) then
    return jsonb_build_object('hole_id', v_hole.id, 'hole_number', v_hole.hole_number, 'already_held', true);
  end if;

  select exists (select 1 from pigeon_hole_assignments pha where pha.pigeon_hole_id = v_hole.id and pha.status in ('reserved', 'active')) into v_has_assignment;
  if v_has_assignment then
    raise exception 'This pigeon hole already holds a shipment. Scan an empty hole.' using errcode = '40001';
  end if;
  if v_hole.status = 'out_of_service' then
    raise exception 'This pigeon hole is out of service. Scan another hole.' using errcode = '40001';
  end if;
  if v_hole.status <> 'free' then
    raise exception 'This pigeon hole is not free. Scan an empty hole.' using errcode = '40001';
  end if;

  perform release_held_hole_v1();

  update pigeon_holes
  set status = 'reserved', held_by_picker_id = auth.uid(), held_at = now(), updated_at = now()
  where id = v_hole.id;

  return jsonb_build_object('hole_id', v_hole.id, 'hole_number', v_hole.hole_number, 'already_held', false);
end;
$$;

grant execute on function claim_pigeon_hole_v1(text, uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- scan_bag_into_chosen_hole_v1 — add the same delivery-mode wall gate (defence
-- in depth) right after the hole is resolved. Body otherwise unchanged.
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
  v_wall_mode text;
begin
  select * into v_existing from bag_scans where client_event_id = p_client_event_id;
  if v_existing.id is not null then
    select * into v_order from orders where id = v_existing.order_id;
    return jsonb_build_object('order_bag_id', v_existing.order_bag_id, 'dropped', v_order.bag_count_scanned_sort,
      'expected', v_order.bag_count_expected, 'hole_complete', true, 'idempotent_replay', true);
  end if;

  select * into v_order from orders where id = p_order_id for update;
  if v_order.id is null or v_order.assigned_picker_id is distinct from auth.uid() then
    raise exception 'order not found or not assigned to caller' using errcode = '42501';
  end if;
  if v_order.status not in ('arrived_at_warehouse', 'sorting_in_progress') then
    raise exception 'this shipment is not ready to be sorted (status=%)', v_order.status using errcode = '40001';
  end if;

  select * into v_hole_qr from qr_codes where code_value = p_pigeon_hole_qr_value and code_type = 'pigeon_hole' and status = 'active';
  if v_hole_qr.id is null then raise exception 'QR code is not a recognized pigeon hole' using errcode = 'P0002'; end if;
  select * into v_hole from pigeon_holes where id = v_hole_qr.entity_id for update;
  if v_hole.id is null then raise exception 'pigeon hole not found' using errcode = 'P0002'; end if;

  -- Delivery-mode wall gate.
  v_wall_mode := hole_wall_delivery_mode_v1(v_hole.id);
  if v_order.delivery_mode is not null and v_wall_mode is distinct from v_order.delivery_mode then
    raise exception 'This hole is on the % wall. Use a % hole for this shipment.',
      coalesce(v_wall_mode, 'un-tagged'), v_order.delivery_mode using errcode = '40001';
  end if;

  select * into v_bag_qr from qr_codes where code_value = p_bag_qr_value and code_type = 'bag' and status = 'active';
  if v_bag_qr.id is null or v_bag_qr.entity_id is distinct from p_order_id then
    raise exception 'Wrong bag - this bag does not belong to this shipment' using errcode = '40001';
  end if;

  select * into v_assignment from pigeon_hole_assignments where pigeon_hole_id = v_hole.id and status in ('reserved', 'active') for update;
  if v_assignment.id is not null and v_assignment.order_id is distinct from p_order_id then
    raise exception 'This pigeon hole is holding another shipment. Use a different hole.' using errcode = '40001';
  end if;
  if v_order.pigeon_hole_id is not null and v_order.pigeon_hole_id is distinct from v_hole.id then
    raise exception 'This shipment is already being placed in another hole. Finish that hole first.' using errcode = '40001';
  end if;

  if v_assignment.id is null then
    if v_hole.status not in ('free', 'reserved') then
      raise exception 'This pigeon hole is not available. Scan an empty hole.' using errcode = '40001';
    end if;
    if v_hole.status = 'reserved' and v_hole.held_by_picker_id is not null and v_hole.held_by_picker_id is distinct from auth.uid() then
      raise exception 'This pigeon hole is held by another picker. Scan an empty hole.' using errcode = '40001';
    end if;
    update order_bags set pigeon_hole_id = v_hole.id, updated_at = now() where order_id = p_order_id;
    insert into pigeon_hole_assignments (order_id, pigeon_hole_id, status, bags_reserved, bags_sorted)
    values (p_order_id, v_hole.id, 'active', v_order.bag_count_expected, 0) returning * into v_assignment;
    update pigeon_holes set status = 'partially_filled', held_by_picker_id = null, held_at = null, updated_at = now() where id = v_hole.id;
    update orders set pigeon_hole_id = v_hole.id, updated_at = now() where id = p_order_id;
  end if;

  select coalesce((select bag_scan_mode from operations_configuration where singleton), 'all_bags') into v_scan_mode;

  if v_scan_mode = 'one_bag' then
    update order_bags set status = 'sorted', sorted_at = now(), updated_at = now() where order_id = p_order_id and status = 'picked_up';
    update pigeon_hole_assignments set status = 'active', bags_sorted = bags_reserved, filled_at = coalesce(filled_at, now()) where id = v_assignment.id returning * into v_assignment;
    update pigeon_holes set status = 'filled', updated_at = now() where id = v_hole.id;
    insert into bag_scans (client_event_id, order_id, order_bag_id, qr_code_id, pigeon_hole_id, scan_type, scanned_entity_type, actor_user_id, device_id, client_captured_at)
    values (p_client_event_id, p_order_id, null, v_bag_qr.id, v_hole.id, 'sort', 'bag', auth.uid(), p_device_id, p_client_captured_at);
    update orders set bag_count_scanned_sort = bag_count_expected, status = 'ready_for_dispatch'::order_status, sorted_at = now(), updated_at = now() where id = p_order_id returning * into v_order;
    insert into status_history (entity_type, entity_id, from_status, to_status, actor_type, actor_user_id, reason)
    values ('order', p_order_id, 'sorting_in_progress', 'ready_for_dispatch', 'system', auth.uid(), 'picker_chosen + one_bag');
    return jsonb_build_object('hole_id', v_hole.id, 'hole_number', v_hole.hole_number, 'dropped', v_assignment.bags_reserved,
      'expected', v_assignment.bags_reserved, 'hole_complete', true, 'order_complete', true, 'scan_mode', 'one_bag', 'idempotent_replay', false);
  end if;

  select * into v_bag from order_bags where order_id = p_order_id and pigeon_hole_id = v_hole.id and status = 'picked_up' order by bag_sequence limit 1 for update skip locked;
  if v_bag.id is null then raise exception 'No remaining bags to place for this shipment in this hole.' using errcode = '40001'; end if;

  update order_bags set status = 'sorted', sorted_at = now(), updated_at = now() where id = v_bag.id;
  update pigeon_hole_assignments set status = 'active', bags_sorted = bags_sorted + 1, filled_at = case when bags_sorted + 1 >= bags_reserved then now() else filled_at end where id = v_assignment.id returning * into v_assignment;
  update pigeon_holes set status = case when v_assignment.bags_sorted >= v_assignment.bags_reserved then 'filled'::pigeon_hole_status else 'partially_filled'::pigeon_hole_status end, updated_at = now() where id = v_hole.id;
  insert into bag_scans (client_event_id, order_id, order_bag_id, qr_code_id, pigeon_hole_id, scan_type, scanned_entity_type, actor_user_id, device_id, client_captured_at)
  values (p_client_event_id, p_order_id, v_bag.id, v_bag_qr.id, v_hole.id, 'sort', 'bag', auth.uid(), p_device_id, p_client_captured_at);
  update orders set bag_count_scanned_sort = bag_count_scanned_sort + 1,
    status = case when bag_count_scanned_sort + 1 >= bag_count_expected then 'ready_for_dispatch'::order_status else 'sorting_in_progress'::order_status end,
    sorted_at = case when bag_count_scanned_sort + 1 >= bag_count_expected then now() else sorted_at end, updated_at = now()
  where id = p_order_id returning * into v_order;

  return jsonb_build_object('hole_id', v_hole.id, 'hole_number', v_hole.hole_number, 'dropped', v_assignment.bags_sorted,
    'expected', v_assignment.bags_reserved, 'hole_complete', v_assignment.bags_sorted >= v_assignment.bags_reserved,
    'order_complete', v_order.status = 'ready_for_dispatch', 'scan_mode', 'all_bags', 'idempotent_replay', false);
end;
$$;

grant execute on function scan_bag_into_chosen_hole_v1(uuid, uuid, text, text, timestamptz, text) to authenticated;

notify pgrst, 'reload schema';
