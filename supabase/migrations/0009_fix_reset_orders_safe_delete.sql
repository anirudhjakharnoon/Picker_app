-- ============================================================================
-- 0009_fix_reset_orders_safe_delete.sql
--
-- Follow-up to 0007: Supabase safe-update also rejects the final unscoped
-- DELETE FROM orders. Recreate the guarded reset RPC with explicit WHERE
-- clauses on both its FK cleanup update and final delete.
-- ============================================================================

create or replace function admin_reset_orders_v1(p_confirmation text)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_count integer;
begin
  if (select role from profiles where id = auth.uid()) <> 'admin' then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if p_confirmation <> 'RESET ALL TEST ORDERS' then
    raise exception 'type RESET ALL TEST ORDERS to confirm' using errcode = '40001';
  end if;

  select count(*) into v_count from orders;
  update pigeon_holes
  set status = 'free', updated_at = now()
  where status <> 'out_of_service';
  delete from delivery_assignments where order_id in (select id from orders);
  delete from pigeon_hole_assignments where order_id in (select id from orders);
  delete from bag_scans where order_id in (select id from orders);
  delete from status_history where entity_type = 'order' and entity_id in (select id from orders);
  update orders
  set shared_bag_qr_code_id = null
  where id in (select id from orders);
  delete from qr_codes where code_type = 'bag' and entity_id in (select id from orders);

  -- Explicit scope is required by Supabase safe-update. The predicate is
  -- intentionally all current order IDs because this is a guarded, test-only
  -- reset operation, protected by the exact confirmation phrase above.
  delete from orders where id in (select id from orders);

  insert into audit_logs (actor_user_id, action, target_type, metadata)
  values (auth.uid(), 'orders.test_reset', 'orders', jsonb_build_object('deleted_count', v_count));
  return v_count;
end;
$$;

grant execute on function admin_reset_orders_v1(text) to authenticated;
notify pgrst, 'reload schema';
