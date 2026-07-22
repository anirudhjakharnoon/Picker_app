-- ============================================================================
-- 0010_auto_assignment_manpower.sql
-- Zone-aware automatic assignment and secure picker roster support.
-- ============================================================================

alter table profiles
  add column if not exists phone_e164 text,
  add column if not exists picker_code text,
  add column if not exists all_zones boolean not null default false,
  add column if not exists login_code_rotated_at timestamptz;

alter table profiles
  add constraint profiles_picker_zone_scope_chk
  check (not all_zones or home_zone is null);

create unique index if not exists profiles_picker_phone_active_uidx
  on profiles(phone_e164)
  where role = 'picker' and status <> 'offboarded' and phone_e164 is not null;
create unique index if not exists profiles_picker_code_uidx
  on profiles(picker_code) where picker_code is not null;

create table if not exists zones (
  code text primary key,
  label text not null,
  sort_order smallint not null default 0,
  is_active boolean not null default true,
  check (code = upper(trim(code)) and length(code) between 1 and 32)
);
alter table zones enable row level security;
grant select on zones to authenticated;
create policy zones_authenticated_select on zones for select using (auth.uid() is not null);

alter table operations_configuration
  add column if not exists auto_assign_enabled boolean not null default true,
  add column if not exists assignment_policy text not null default 'least_active_orders'
    check (assignment_policy in ('least_active_orders')),
  add column if not exists null_zone_matches_all_pickers boolean not null default false;

alter table orders
  add column if not exists assignment_source text
    check (assignment_source is null or assignment_source in ('auto','manual','self_accept','requeue'));

create index if not exists profiles_auto_assign_eligible_idx
  on profiles(is_online, home_zone, all_zones)
  where role = 'picker' and status = 'active' and is_online = true;
create index if not exists orders_available_zone_idx
  on orders(store_zone, ingested_at)
  where status = 'available' and assigned_picker_id is null;

create or replace function picker_active_order_count_v1(p_picker_id uuid)
returns integer language sql stable security definer set search_path = public, pg_temp as $$
  select count(*)::integer from orders
  where assigned_picker_id = p_picker_id
    and status in ('assigned','picking_in_progress','picked','in_transit_to_warehouse',
                   'arrived_at_warehouse','sorting_in_progress','ready_for_dispatch');
$$;

create or replace function picker_zone_eligible_v1(p_picker_id uuid, p_zone text)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(
    p.all_zones
    or (p_zone is not null and lower(trim(p.home_zone)) = lower(trim(p_zone)))
    or (p_zone is null and c.null_zone_matches_all_pickers),
    false
  )
  from profiles p cross join operations_configuration c
  where p.id = p_picker_id and c.singleton;
$$;

create or replace function assign_order_to_picker_v1(
  p_order_id uuid,
  p_picker_id uuid,
  p_source text,
  p_actor_user_id uuid default null,
  p_skip_zone_check boolean default false,
  p_force boolean default false
)
returns orders
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_order orders;
  v_picker profiles;
  v_active_count integer;
begin
  select * into v_order from orders where id = p_order_id for update;
  if v_order.id is null or v_order.status <> 'available' or v_order.assigned_picker_id is not null then
    raise exception 'order is no longer available for assignment' using errcode = '40001';
  end if;
  select * into v_picker from profiles where id = p_picker_id for update;
  if v_picker.id is null or v_picker.role <> 'picker' or v_picker.status <> 'active' then
    raise exception 'picker is not active' using errcode = '40001';
  end if;
  if not p_skip_zone_check and not picker_zone_eligible_v1(p_picker_id, v_order.store_zone) then
    raise exception 'picker is not eligible for this order zone' using errcode = '40001';
  end if;
  select picker_active_order_count_v1(p_picker_id) into v_active_count;
  if not p_force and v_active_count >= v_picker.max_concurrent_orders then
    raise exception 'picker already has the configured maximum of % active orders', v_picker.max_concurrent_orders using errcode = '40001';
  end if;
  update orders
  set status = 'assigned', assigned_picker_id = p_picker_id, assigned_at = now(),
      assignment_source = p_source, updated_at = now()
  where id = p_order_id and status = 'available' and assigned_picker_id is null
  returning * into v_order;
  if v_order.id is null then raise exception 'assignment race lost' using errcode = '40001'; end if;
  insert into status_history(entity_type, entity_id, from_status, to_status, actor_type, actor_user_id, reason)
  values ('order', p_order_id, 'available', 'assigned',
    case when p_actor_user_id is null then 'system' else 'user' end,
    p_actor_user_id, p_source);
  return v_order;
end;
$$;

create or replace function try_auto_assign_order_v1(p_order_id uuid)
returns orders
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_order orders;
  v_picker_id uuid;
  v_result orders;
begin
  if not (select auto_assign_enabled from operations_configuration where singleton) then return null; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_order_id::text, 0));
  select * into v_order from orders where id = p_order_id;
  if v_order.id is null or v_order.status <> 'available' or v_order.assigned_picker_id is not null then return null; end if;
  select p.id into v_picker_id
  from profiles p
  where p.role = 'picker' and p.status = 'active' and p.is_online
    and picker_zone_eligible_v1(p.id, v_order.store_zone)
    and picker_active_order_count_v1(p.id) < p.max_concurrent_orders
  order by picker_active_order_count_v1(p.id), p.updated_at, p.id
  limit 1
  for update skip locked;
  if v_picker_id is null then return null; end if;
  select * into v_result from assign_order_to_picker_v1(p_order_id, v_picker_id, 'auto', null, false, false);
  return v_result;
exception when sqlstate '40001' then return null;
end;
$$;

create or replace function orders_try_auto_assign_trigger_v1()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.status = 'available' and new.assigned_picker_id is null then
    perform try_auto_assign_order_v1(new.id);
  end if;
  return new;
end;
$$;

drop trigger if exists orders_auto_assign_trigger_v1 on orders;
create trigger orders_auto_assign_trigger_v1
after insert or update of status, store_zone, assigned_picker_id on orders
for each row execute function orders_try_auto_assign_trigger_v1();

create or replace function picker_online_assign_backlog_trigger_v1()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare v_order_id uuid;
begin
  if new.role='picker' and new.status='active' and new.is_online and not old.is_online then
    for v_order_id in
      select o.id from orders o
      where o.status='available' and o.assigned_picker_id is null
        and picker_zone_eligible_v1(new.id,o.store_zone)
      order by o.ingested_at
      limit new.max_concurrent_orders
    loop
      perform try_auto_assign_order_v1(v_order_id);
    end loop;
  end if;
  return new;
end;
$$;
drop trigger if exists picker_online_assign_backlog_trigger_v1 on profiles;
create trigger picker_online_assign_backlog_trigger_v1
after update of is_online on profiles
for each row execute function picker_online_assign_backlog_trigger_v1();

-- Auto-created admin test orders now enter the assignment engine immediately.
create or replace function admin_create_order_v1(
  p_store_external_ref text, p_bag_count integer, p_store_floor text default null,
  p_store_zone text default null, p_store_address text default null,
  p_external_order_ref text default null, p_is_fragile boolean default false,
  p_store_name text default null
) returns orders language plpgsql security definer set search_path = public, pg_temp as $$
declare v_caller_role user_role; v_store stores; v_order orders; v_qr qr_codes; v_ref text; i integer;
begin
  v_caller_role := (select role from profiles where id = auth.uid());
  if v_caller_role not in ('ops_manager','admin') then raise exception 'not permitted' using errcode = '42501'; end if;
  if p_bag_count is null or p_bag_count <= 0 or p_bag_count > 32767 then raise exception 'bag count must be a positive number no greater than 32767' using errcode = '40001'; end if;
  select * into v_store from stores where external_ref = p_store_external_ref;
  if v_store.id is null then
    insert into stores(external_ref,name,default_zone) values(p_store_external_ref,coalesce(p_store_name,p_store_external_ref),p_store_zone) returning * into v_store;
  elsif p_store_name is not null and p_store_name <> v_store.name then
    update stores set name=p_store_name,updated_at=now() where id=v_store.id returning * into v_store;
  end if;
  v_ref := coalesce(p_external_order_ref,'SO-'||to_char(now(),'YYMMDDHH24MISS')||'-'||substr(gen_random_uuid()::text,1,4));
  insert into orders(store_id,external_order_ref,bag_count_expected,store_floor,store_zone,store_address,status,is_fragile)
  values(v_store.id,v_ref,p_bag_count,p_store_floor,coalesce(p_store_zone,v_store.default_zone),p_store_address,'available',coalesce(p_is_fragile,false))
  returning * into v_order;
  insert into qr_codes(code_type,code_value,code_version,entity_id,status)
  values('bag',v_ref||'-'||substr(gen_random_uuid()::text,1,6),1,v_order.id,'active') returning * into v_qr;
  update orders set shared_bag_qr_code_id=v_qr.id where id=v_order.id returning * into v_order;
  for i in 1..p_bag_count loop insert into order_bags(order_id,bag_sequence,status) values(v_order.id,i,'expected'); end loop;
  insert into status_history(entity_type,entity_id,from_status,to_status,actor_type,actor_user_id)
  values('order',v_order.id,null,'available','user',auth.uid());
  -- The AFTER INSERT trigger may assign the order; return authoritative row.
  select * into v_order from orders where id=v_order.id;
  return v_order;
end;
$$;

create or replace function picker_go_to_store_v1(p_order_id uuid)
returns orders language plpgsql security definer set search_path = public, pg_temp as $$
declare v_order orders;
begin
  select * into v_order from orders where id=p_order_id for update;
  if v_order.id is null or v_order.assigned_picker_id is distinct from auth.uid() or v_order.status <> 'assigned' then
    raise exception 'order is not assigned and ready to start' using errcode='40001';
  end if;
  if exists(select 1 from orders where assigned_picker_id=auth.uid() and id<>p_order_id and status='picking_in_progress') then
    raise exception 'finish picking the current store before going to another store' using errcode='40001';
  end if;
  update orders set status='picking_in_progress',updated_at=now() where id=p_order_id returning * into v_order;
  insert into status_history(entity_type,entity_id,from_status,to_status,actor_type,actor_user_id,reason)
  values('order',p_order_id,'assigned','picking_in_progress','user',auth.uid(),'picker started journey to store');
  return v_order;
end;
$$;

create or replace function admin_update_assignment_configuration_v1(
  p_auto_assign_enabled boolean, p_null_zone_matches_all_pickers boolean
) returns operations_configuration language plpgsql security definer set search_path=public,pg_temp as $$
declare v_config operations_configuration;
begin
  if (select role from profiles where id=auth.uid()) <> 'admin' then raise exception 'not permitted' using errcode='42501'; end if;
  update operations_configuration set auto_assign_enabled=p_auto_assign_enabled,
    null_zone_matches_all_pickers=p_null_zone_matches_all_pickers,updated_at=now(),updated_by_user_id=auth.uid()
  where singleton returning * into v_config;
  return v_config;
end;
$$;

create or replace function admin_list_pickers_v1()
returns table(id uuid, picker_code_masked text, full_name text, phone_masked text, home_zone text, all_zones boolean, status user_status, is_online boolean, active_orders integer)
language sql stable security definer set search_path=public,pg_temp as $$
  select p.id,
    case when p.picker_code is null then null else 'PKR-•••' || right(p.picker_code,1) end,
    p.full_name,
    case when p.phone_e164 is null then null else '••••' || right(p.phone_e164,4) end,
    p.home_zone,p.all_zones,p.status,p.is_online,picker_active_order_count_v1(p.id)
  from profiles p where p.role='picker' order by p.full_name nulls last,p.created_at;
$$;

create or replace function admin_update_picker_profile_v1(
  p_picker_id uuid,p_full_name text,p_home_zone text,p_all_zones boolean,p_status user_status
) returns profiles language plpgsql security definer set search_path=public,pg_temp as $$
declare v_profile profiles;
begin
  if (select role from profiles where id=auth.uid()) <> 'admin' then raise exception 'not permitted' using errcode='42501'; end if;
  update profiles set full_name=p_full_name,home_zone=case when p_all_zones then null else nullif(trim(p_home_zone),'') end,
    all_zones=p_all_zones,status=p_status,updated_at=now()
  where id=p_picker_id and role='picker' returning * into v_profile;
  if v_profile.id is null then raise exception 'picker not found' using errcode='P0002'; end if;
  return v_profile;
end;
$$;

-- Auto-direct assignment means an unassigned available order is not broadcast
-- to every picker. They see only their assigned work (admin/warehouse rules
-- remain unchanged).
drop policy if exists orders_select on orders;
create policy orders_select on orders for select using (
  auth_is_admin()
  or assigned_picker_id=auth.uid()
  or (auth_is_warehouse_role() and (warehouse_id=auth_warehouse_id() or warehouse_id is null))
);

grant execute on function picker_go_to_store_v1(uuid) to authenticated;
grant execute on function admin_update_assignment_configuration_v1(boolean,boolean) to authenticated;
grant execute on function admin_list_pickers_v1() to authenticated;
grant execute on function admin_update_picker_profile_v1(uuid,text,text,boolean,user_status) to authenticated;
grant execute on function admin_create_order_v1(text,integer,text,text,text,text,boolean,text) to authenticated;
grant execute on function accept_order_v1(uuid) to authenticated;
notify pgrst,'reload schema';
