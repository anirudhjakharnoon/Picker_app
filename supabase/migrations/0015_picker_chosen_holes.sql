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
