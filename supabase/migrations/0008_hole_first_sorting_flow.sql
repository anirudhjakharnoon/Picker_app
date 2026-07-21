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

  select pha.*, ph.*
  into v_assignment, v_hole
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

  select pha.*, ph.*
  into v_assignment, v_hole
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
