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
