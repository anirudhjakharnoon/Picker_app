-- ============================================================================
-- 0025_cheap_wall_precheck_and_arrival_fix.sql
--
-- Two fixes:
--
-- (1) record_warehouse_arrival_picker_chosen_v1 picked ONE sort wall for the
--     WHOLE arrival batch, with no regard for delivery mode, and did it before
--     the per-order loop:
--         select id into v_sort_wall_id from sort_walls
--         where warehouse_id = v_warehouse_id and status = 'active' limit 1;
--     If a picker arrives with an LMS order and a Hyperlocal order in the same
--     batch, both got stamped with whichever wall happened to come back first
--     from Postgres - wrong for at least one of them. Moved inside the loop,
--     one lookup per order, preferring a wall whose delivery_mode matches that
--     order's - the same preference record_warehouse_arrival_v1 (pre-assigned
--     mode) already uses. This field does not gate which holes a picker can
--     scan (claim_pigeon_hole_v1 is SECURITY DEFINER and works off whatever
--     hole QR is scanned, not this column), so this is a correctness/reporting
--     fix, not a functional unblock - but it should still say the right thing.
--
-- (2) The picker-chosen hole-then-bag flow only discovers a wall mismatch
--     inside scan_bag_into_held_hole_v1 -> scan_bag_into_chosen_hole_v1, which
--     by then has already taken `for update` row locks on both `orders` and
--     `pigeon_holes` before raising and rolling back. That is a real cost paid
--     on every wrong-wall scan, and wrong-wall scans are exactly the common
--     case while pickers are learning a two-wall layout.
--
--     resolve_bag_qr_v1 lets the client check compatibility BEFORE calling the
--     mutating RPC at all: a single indexed, lock-free read (SECURITY INVOKER,
--     so it is bound by the caller's own RLS - a picker gets nothing back for
--     a bag that is not theirs, exactly as today) that resolves a scanned bag
--     QR straight to its order's delivery_mode. Paired with the wall's
--     delivery_mode - now returned by claim_pigeon_hole_v1 so the client has
--     it for free from the hold, no extra call - the client can compare the
--     two locally and, on a mismatch, show the exact same error immediately
--     without ever opening the write transaction.
--
--     The server-side check inside scan_bag_into_chosen_hole_v1 is untouched:
--     this is a fast path for the common case, not a replacement for the
--     authoritative check, which still runs on every write regardless of what
--     the client believes.
-- ============================================================================

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

  if not exists (select 1 from sort_walls where warehouse_id = v_warehouse_id and status = 'active') then
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

    -- Per order, not per batch: prefer a wall tagged with THIS order's
    -- delivery_mode, falling back to any active wall only if none matches
    -- (mirrors record_warehouse_arrival_v1's preference for pre-assigned mode).
    select id into v_sort_wall_id
    from sort_walls
    where warehouse_id = v_warehouse_id and status = 'active'
    order by (delivery_mode is not distinct from v_order.delivery_mode) desc, created_at
    limit 1;

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
-- claim_pigeon_hole_v1 — also return the wall's delivery_mode so the client
-- has it for free from the claim response, with no extra round trip needed to
-- do the client-side pre-check below.
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

  v_wall_mode := hole_wall_delivery_mode_v1(v_hole.id);

  -- Delivery-mode wall gate: an LMS shipment may only use LMS-wall holes, etc.
  if p_order_id is not null then
    v_order_mode := (select delivery_mode from orders where id = p_order_id);
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
      return jsonb_build_object('hole_id', v_hole.id, 'hole_number', v_hole.hole_number, 'already_held', true, 'wall_delivery_mode', v_wall_mode);
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
    return jsonb_build_object('hole_id', v_hole.id, 'hole_number', v_hole.hole_number, 'already_held', true, 'wall_delivery_mode', v_wall_mode);
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

  return jsonb_build_object('hole_id', v_hole.id, 'hole_number', v_hole.hole_number, 'already_held', false, 'wall_delivery_mode', v_wall_mode);
end;
$$;

grant execute on function claim_pigeon_hole_v1(text, uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- resolve_bag_qr_v1 — cheap, read-only, lock-free lookup so the client can
-- pre-validate a scanned bag against an already-held hole BEFORE calling the
-- mutating scan RPC. SECURITY INVOKER (the default) deliberately, not
-- SECURITY DEFINER: this needs no elevated privilege at all, it just runs the
-- two SELECTs as the calling picker, so ordinary RLS on qr_codes and orders
-- already scopes it correctly - a bag that is not the caller's returns no
-- rows, exactly like every other bag lookup in this schema.
-- ----------------------------------------------------------------------------

create or replace function resolve_bag_qr_v1(p_bag_qr_value text)
returns table(order_id uuid, external_order_ref text, delivery_mode text, status order_status)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select o.id, o.external_order_ref, o.delivery_mode, o.status
  from qr_codes q
  join orders o on o.id = q.entity_id
  where q.code_value = p_bag_qr_value and q.code_type = 'bag' and q.status = 'active';
$$;

grant execute on function resolve_bag_qr_v1(text) to authenticated;
revoke execute on function resolve_bag_qr_v1(text) from public;
revoke execute on function resolve_bag_qr_v1(text) from anon;

notify pgrst, 'reload schema';
