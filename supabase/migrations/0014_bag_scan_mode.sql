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
