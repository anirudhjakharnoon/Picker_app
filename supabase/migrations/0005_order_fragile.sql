-- ============================================================================
-- 0005_order_fragile.sql
-- Optional, additive enhancement powering the "Fragile Items" badge and a
-- friendlier store display name in the Picker queue (matches the reference
-- UI screenshots).
--
-- Safe to run on an existing project:
--   * adds one nullable-with-default column (no rewrite of existing rows), and
--   * recreates admin_create_order_v1 with two extra trailing parameters.
--
-- The PWA reads `orders.is_fragile` defensively, so the app keeps working
-- whether or not this migration has been applied; applying it simply lights
-- up the fragile badge and lets the Admin tab set a store display name.
-- ============================================================================

alter table orders
  add column if not exists is_fragile boolean not null default false;

-- Recreate (drop first so we replace rather than create a second overload).
drop function if exists admin_create_order_v1(text, integer, text, text, text, text);

create or replace function admin_create_order_v1(
  p_store_external_ref text,
  p_bag_count integer,
  p_store_floor text default null,
  p_store_zone text default null,
  p_store_address text default null,
  p_external_order_ref text default null,
  p_is_fragile boolean default false,
  p_store_name text default null
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
  if v_store.id is null then
    insert into stores (external_ref, name, default_zone)
    values (p_store_external_ref, coalesce(p_store_name, p_store_external_ref), p_store_zone)
    returning * into v_store;
  elsif p_store_name is not null and p_store_name <> v_store.name then
    update stores set name = p_store_name, updated_at = now() where id = v_store.id
    returning * into v_store;
  end if;

  v_ref := coalesce(p_external_order_ref, 'SO-' || to_char(now(), 'YYMMDDHH24MISS') || '-' || substr(gen_random_uuid()::text, 1, 4));

  insert into orders (store_id, external_order_ref, bag_count_expected, store_floor, store_zone, store_address, status, is_fragile)
  values (v_store.id, v_ref, p_bag_count, p_store_floor, coalesce(p_store_zone, v_store.default_zone), p_store_address, 'available', coalesce(p_is_fragile, false))
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

grant execute on function admin_create_order_v1(
  text, integer, text, text, text, text, boolean, text
) to authenticated;
