-- ============================================================================
-- 0017_admin_delete_walls_holes.sql
--
-- Lets an admin delete a pigeon hole or a whole sort wall from the Admin panel.
--
-- pigeon_holes cascade from sort_walls, but pigeon_hole_assignments, bag_scans
-- and orders reference holes with RESTRICT, so a straight delete fails once a
-- hole has any history. These RPCs guard against deleting holes/walls that are
-- in active use, then clean up historical references (nulling audit rows rather
-- than destroying them) so an idle/mistaken wall or hole can be removed safely.
-- ============================================================================

create or replace function admin_delete_pigeon_hole_v1(p_pigeon_hole_id uuid)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_hole pigeon_holes;
begin
  if (select role from profiles where id = auth.uid()) <> 'admin' then
    raise exception 'not permitted' using errcode = '42501';
  end if;

  select * into v_hole from pigeon_holes where id = p_pigeon_hole_id for update;
  if v_hole.id is null then
    raise exception 'pigeon hole not found' using errcode = 'P0002';
  end if;
  if v_hole.status not in ('free', 'out_of_service') then
    raise exception 'This hole is reserved or filled. Clear it before deleting.' using errcode = '40001';
  end if;
  if exists (
    select 1 from orders o
    where o.pigeon_hole_id = p_pigeon_hole_id
      and o.status not in ('dispatched', 'completed', 'cancelled')
  ) then
    raise exception 'An in-progress order still points to this hole. Finish it first.' using errcode = '40001';
  end if;

  update bag_scans set pigeon_hole_id = null where pigeon_hole_id = p_pigeon_hole_id;
  update orders set pigeon_hole_id = null where pigeon_hole_id = p_pigeon_hole_id;
  delete from pigeon_hole_assignments where pigeon_hole_id = p_pigeon_hole_id;
  update pigeon_holes set qr_code_id = null where id = p_pigeon_hole_id;
  delete from qr_codes where code_type = 'pigeon_hole' and entity_id = p_pigeon_hole_id;
  delete from pigeon_holes where id = p_pigeon_hole_id;
  return 1;
end;
$$;

grant execute on function admin_delete_pigeon_hole_v1(uuid) to authenticated;

create or replace function admin_delete_sort_wall_v1(p_sort_wall_id uuid)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_wall sort_walls;
  v_hole_ids uuid[];
begin
  if (select role from profiles where id = auth.uid()) <> 'admin' then
    raise exception 'not permitted' using errcode = '42501';
  end if;

  select * into v_wall from sort_walls where id = p_sort_wall_id for update;
  if v_wall.id is null then
    raise exception 'sort wall not found' using errcode = 'P0002';
  end if;

  select coalesce(array_agg(id), array[]::uuid[]) into v_hole_ids
  from pigeon_holes where sort_wall_id = p_sort_wall_id;

  if exists (
    select 1 from pigeon_holes
    where sort_wall_id = p_sort_wall_id and status not in ('free', 'out_of_service')
  ) then
    raise exception 'This wall has holes that are reserved or filled. Clear them before deleting the wall.' using errcode = '40001';
  end if;
  if exists (
    select 1 from orders o
    where (o.sort_wall_id = p_sort_wall_id or o.pigeon_hole_id = any(v_hole_ids))
      and o.status not in ('dispatched', 'completed', 'cancelled')
  ) then
    raise exception 'This wall still has in-progress orders. Finish them before deleting the wall.' using errcode = '40001';
  end if;

  update bag_scans set pigeon_hole_id = null where pigeon_hole_id = any(v_hole_ids);
  update orders set pigeon_hole_id = null where pigeon_hole_id = any(v_hole_ids);
  update orders set sort_wall_id = null where sort_wall_id = p_sort_wall_id;
  delete from pigeon_hole_assignments where pigeon_hole_id = any(v_hole_ids);
  update pigeon_holes set qr_code_id = null where sort_wall_id = p_sort_wall_id;
  delete from qr_codes where code_type = 'pigeon_hole' and entity_id = any(v_hole_ids);
  delete from sort_walls where id = p_sort_wall_id; -- cascades the (now dependency-free) holes
  return cardinality(v_hole_ids);
end;
$$;

grant execute on function admin_delete_sort_wall_v1(uuid) to authenticated;

notify pgrst, 'reload schema';
