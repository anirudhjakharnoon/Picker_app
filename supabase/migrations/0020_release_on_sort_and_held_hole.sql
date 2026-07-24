-- ============================================================================
-- 0020_release_on_sort_and_held_hole.sql
--
-- 1. Release an order from the picker the moment they finish SORTING it.
--    Sorting the last bag moves an order to 'ready_for_dispatch'. That state is
--    the warehouse's / last-mile's problem, not the picker's - so it must not
--    count against the picker's capacity or keep showing as their active work.
--    (The client mirrors this by treating 'ready_for_dispatch' as done too.)
--    This makes the per-batch limit non-permanent: once the picker sorts an
--    order, that capacity frees and they can be assigned another (up to max).
--
-- 2. scan_bag_into_held_hole_v1 - the picker-chosen flow no longer pre-selects
--    which order goes in which hole. The picker scans ANY free hole to hold it,
--    then scans a bag; the BAG identifies the order. This RPC derives the order
--    from the bag QR, checks the caller owns it, and delegates to the existing
--    (tested) scan_bag_into_chosen_hole_v1, which links the hole to that order
--    on the first bag and enforces the delivery-mode wall gate.
-- ============================================================================

-- 1. Capacity: count only orders the picker is still working (through sorting).
--    'ready_for_dispatch' (fully sorted) and terminal states are excluded, so a
--    sorted order releases the picker immediately.
create or replace function picker_active_order_count_v1(p_picker_id uuid)
returns integer language sql stable security definer set search_path = public, pg_temp as $$
  select count(*)::integer from orders
  where assigned_picker_id = p_picker_id
    and status in (
      'assigned','picking_in_progress','picked','in_transit_to_warehouse',
      'arrived_at_warehouse','sorting_in_progress'
    );
$$;

-- 2. Order-agnostic bag placement for the picker-chosen flow.
create or replace function scan_bag_into_held_hole_v1(
  p_client_event_id uuid,
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
  v_bag_qr qr_codes;
  v_order orders;
  v_result jsonb;
begin
  if (select role from profiles where id = auth.uid()) is distinct from 'picker' then
    raise exception 'only pickers can sort bags' using errcode = '42501';
  end if;

  -- The bag QR identifies which order this is.
  select * into v_bag_qr from qr_codes
  where code_value = p_bag_qr_value and code_type = 'bag' and status = 'active';
  if v_bag_qr.id is null then
    raise exception 'That QR is not a recognized bag. Please scan a bag.' using errcode = 'P0002';
  end if;

  select * into v_order from orders where id = v_bag_qr.entity_id;
  if v_order.id is null or v_order.assigned_picker_id is distinct from auth.uid() then
    raise exception 'Wrong bag - this bag is not one of your orders. Please scan the correct bag.' using errcode = '40001';
  end if;

  -- Delegate to the existing, tested placement logic (wall gate, first-bag
  -- linking, bag-scan mode, idempotency all handled there).
  v_result := scan_bag_into_chosen_hole_v1(
    p_client_event_id, v_order.id, p_bag_qr_value, p_pigeon_hole_qr_value, p_client_captured_at, p_device_id
  );

  -- Surface the order reference so the UI can name what was just sorted.
  return v_result || jsonb_build_object('order_id', v_order.id, 'order_ref', v_order.external_order_ref);
end;
$$;

grant execute on function scan_bag_into_held_hole_v1(uuid, text, text, timestamptz, text) to authenticated;

notify pgrst, 'reload schema';
