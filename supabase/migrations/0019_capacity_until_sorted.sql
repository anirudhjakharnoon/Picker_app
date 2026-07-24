-- ============================================================================
-- 0019_capacity_until_sorted.sql
--
-- Refinement of 0018's capacity rule. 0018 freed a picker's capacity as soon as
-- an order was handed off at the warehouse (arrived_at_warehouse), which let a
-- picker who had dropped off but was still SORTING receive new orders. The
-- desired behaviour: an order occupies the picker's capacity until it is fully
-- sorted into a pigeon hole (dispatched). So capacity only fully frees once the
-- picker has sorted everything assigned to them (the "all sorted" state).
--
-- This restores counting the post-handoff/sorting states, so the count is
-- "every order that is not yet dispatched/completed/cancelled".
-- assert_picker_capacity_v1 already reuses this function (0018), so both the
-- auto-assignment engine and swipe/admin assignment pick up the change.
-- ============================================================================

create or replace function picker_active_order_count_v1(p_picker_id uuid)
returns integer language sql stable security definer set search_path = public, pg_temp as $$
  select count(*)::integer from orders
  where assigned_picker_id = p_picker_id
    and status in (
      'assigned','picking_in_progress','picked','in_transit_to_warehouse',
      'arrived_at_warehouse','sorting_in_progress','ready_for_dispatch'
    );
$$;

notify pgrst, 'reload schema';
