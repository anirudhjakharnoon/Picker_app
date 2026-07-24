-- ============================================================================
-- 0018_suspension_and_drop_capacity.sql
--
-- Two operational-lifecycle fixes:
--
--  1. Suspension / offboarding is now actually enforced server-side:
--       - a suspended/offboarded picker is forced OFFLINE the moment an admin
--         changes their status (admin_update_picker_profile_v1), and any of
--         their not-yet-started ('assigned') orders are requeued so someone
--         else can take them;
--       - a non-active picker can no longer flip themselves back ONLINE
--         (set_picker_status_v1), so they stop receiving auto-assigned orders;
--       - accepting or starting an order rejects a non-active caller.
--     (The auto-assignment engine already filters status = 'active'.)
--
--  2. Dropping picked orders off frees the picker's capacity:
--       picker_active_order_count_v1 no longer counts orders that have already
--       been handed off at the warehouse (arrived_at_warehouse and later). So
--       once a picker drops off everything they picked, that capacity is free
--       and they can be assigned the next batch (up to their configured max),
--       while they continue sorting the dropped orders into pigeon holes.
-- ============================================================================

-- 2. Capacity frees on drop-off ------------------------------------------------
-- Count only the "carrying" states (assigned -> in transit). Once an order
-- reaches the warehouse it no longer occupies the picker's pickup capacity.
create or replace function picker_active_order_count_v1(p_picker_id uuid)
returns integer language sql stable security definer set search_path = public, pg_temp as $$
  select count(*)::integer from orders
  where assigned_picker_id = p_picker_id
    and status in ('assigned','picking_in_progress','picked','in_transit_to_warehouse');
$$;

-- Same rule for the swipe-accept / admin-assign capacity guard: make it reuse
-- the count above so there is a single definition of "occupies capacity", and
-- dropped-off orders free the picker here too.
create or replace function assert_picker_capacity_v1(p_picker_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_picker profiles;
  v_active_count integer;
begin
  select * into v_picker from profiles where id = p_picker_id for update;
  if v_picker.id is null or v_picker.role <> 'picker' or v_picker.status <> 'active' then
    raise exception 'picker is not active' using errcode = '40001';
  end if;

  v_active_count := picker_active_order_count_v1(p_picker_id);

  if v_active_count >= v_picker.max_concurrent_orders then
    raise exception 'picker already has the configured maximum of % active orders',
      v_picker.max_concurrent_orders using errcode = '40001';
  end if;
end;
$$;

-- 1a. A non-active picker cannot go (or be) online ----------------------------
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
  v_status user_status;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  select status into v_status from profiles where id = auth.uid();

  -- Trying to come online while suspended/offboarded is refused outright.
  if p_is_online and v_status is distinct from 'active' then
    raise exception 'Your account is not active. Please contact your administrator.'
      using errcode = '42501';
  end if;

  update profiles
  set is_online = (p_is_online and status = 'active'),
      current_lat = coalesce(p_lat, current_lat),
      current_lng = coalesce(p_lng, current_lng),
      updated_at = now()
  where id = auth.uid()
  returning * into v_profile;

  if v_profile.id is null then
    raise exception 'profile not found' using errcode = 'P0002';
  end if;
  return v_profile;
end;
$$;

grant execute on function set_picker_status_v1(boolean, double precision, double precision) to authenticated;

-- 1b. Suspending/offboarding forces the picker offline and requeues their
--     not-yet-started work so it doesn't get stuck with an inactive picker.
create or replace function admin_update_picker_profile_v1(
  p_picker_id uuid, p_full_name text, p_home_zone text, p_all_zones boolean, p_status user_status
) returns profiles language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_profile profiles;
  v_order_id uuid;
begin
  if (select role from profiles where id = auth.uid()) <> 'admin' then
    raise exception 'not permitted' using errcode = '42501';
  end if;

  update profiles
  set full_name = p_full_name,
      home_zone = case when p_all_zones then null else nullif(trim(p_home_zone), '') end,
      all_zones = p_all_zones,
      status = p_status,
      -- Deactivating a picker takes them offline immediately.
      is_online = case when p_status = 'active' then is_online else false end,
      updated_at = now()
  where id = p_picker_id and role = 'picker'
  returning * into v_profile;

  if v_profile.id is null then
    raise exception 'picker not found' using errcode = 'P0002';
  end if;

  -- When deactivating, release orders the picker had not physically started
  -- yet ('assigned') back into the pool. Orders already being picked/carried
  -- stay with them (the bags are physically in hand) and are handled manually.
  if p_status is distinct from 'active' then
    for v_order_id in
      select id from orders where assigned_picker_id = p_picker_id and status = 'assigned'
    loop
      update orders
      set status = 'available', assigned_picker_id = null, assigned_at = null,
          assignment_source = 'requeue', updated_at = now()
      where id = v_order_id;
      insert into status_history(entity_type, entity_id, from_status, to_status, actor_type, actor_user_id, reason)
      values ('order', v_order_id, 'assigned', 'available', 'user', auth.uid(), 'picker deactivated - order requeued');
    end loop;
  end if;

  return v_profile;
end;
$$;

grant execute on function admin_update_picker_profile_v1(uuid, text, text, boolean, user_status) to authenticated;

-- 1c. Guard the two picker entry points against a non-active caller. The scan
--     RPCs are reached only from these, and the client blocks a suspended
--     picker at login, but guarding here is defence in depth.
create or replace function accept_order_v1(p_order_id uuid)
returns orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order orders;
  v_caller_role user_role;
  v_status user_status;
begin
  select role, status into v_caller_role, v_status from profiles where id = auth.uid();
  if v_caller_role is distinct from 'picker' then
    raise exception 'only pickers can accept orders' using errcode = '42501';
  end if;
  -- Suspended/offboarded pickers cannot take work.
  if v_status is distinct from 'active' then
    raise exception 'Your account is not active. Please contact your administrator.' using errcode = '42501';
  end if;

  -- A picker may accept another order only after the currently accepted order
  -- is fully picked (unchanged from 0006).
  if exists (
    select 1 from orders
    where assigned_picker_id = auth.uid()
      and status in ('assigned', 'picking_in_progress')
  ) then
    raise exception 'finish the current accepted order before accepting another' using errcode = '40001';
  end if;

  perform assert_picker_capacity_v1(auth.uid());

  update orders
  set status = 'assigned',
      assigned_picker_id = auth.uid(),
      assigned_at = now(),
      updated_at = now()
  where id = p_order_id
    and status = 'available'
    and assigned_picker_id is null
  returning * into v_order;

  if v_order.id is null then
    raise exception 'order already assigned or not available' using errcode = '40001';
  end if;

  insert into status_history (entity_type, entity_id, from_status, to_status, actor_type, actor_user_id)
  values ('order', p_order_id, 'available', 'assigned', 'user', auth.uid());
  return v_order;
end;
$$;

grant execute on function accept_order_v1(uuid) to authenticated;

create or replace function picker_go_to_store_v1(p_order_id uuid)
returns orders language plpgsql security definer set search_path = public, pg_temp as $$
declare v_order orders; v_status user_status;
begin
  select status into v_status from profiles where id = auth.uid();
  if v_status is distinct from 'active' then
    raise exception 'Your account is not active. Please contact your administrator.' using errcode = '42501';
  end if;
  select * into v_order from orders where id = p_order_id for update;
  if v_order.id is null or v_order.assigned_picker_id is distinct from auth.uid() or v_order.status <> 'assigned' then
    raise exception 'order is not assigned and ready to start' using errcode='40001';
  end if;
  if exists(select 1 from orders where assigned_picker_id = auth.uid() and id <> p_order_id and status = 'picking_in_progress') then
    raise exception 'finish picking the current store before going to another store' using errcode='40001';
  end if;
  update orders set status='picking_in_progress', updated_at=now() where id=p_order_id returning * into v_order;
  insert into status_history(entity_type, entity_id, from_status, to_status, actor_type, actor_user_id, reason)
  values('order', p_order_id, 'assigned', 'picking_in_progress', 'user', auth.uid(), 'picker started journey to store');
  return v_order;
end;
$$;

grant execute on function picker_go_to_store_v1(uuid) to authenticated;

notify pgrst, 'reload schema';
