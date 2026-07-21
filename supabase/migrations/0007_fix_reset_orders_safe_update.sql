-- ============================================================================
-- 0007_fix_reset_orders_safe_update.sql
--
-- Supabase's safe-update guard rejects UPDATE statements without a WHERE
-- clause, including inside SECURITY DEFINER RPCs. The reset function needs to
-- clear `orders.shared_bag_qr_code_id` before deleting bag QR rows (the FK
-- would otherwise block that delete), so scope that cleanup explicitly to the
-- set of orders being reset.
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

  -- This WHERE is required by Supabase's safe-update protection. It also
  -- documents the intent: clear only order-scoped QR foreign keys before the
  -- corresponding bag QR rows are deleted.
  update orders
  set shared_bag_qr_code_id = null
  where id in (select id from orders);

  delete from qr_codes where code_type = 'bag' and entity_id in (select id from orders);
  delete from orders;

  insert into audit_logs (actor_user_id, action, target_type, metadata)
  values (auth.uid(), 'orders.test_reset', 'orders', jsonb_build_object('deleted_count', v_count));
  return v_count;
end;
$$;

grant execute on function admin_reset_orders_v1(text) to authenticated;
notify pgrst, 'reload schema';
