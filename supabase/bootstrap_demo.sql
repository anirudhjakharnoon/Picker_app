-- ============================================================================
-- bootstrap_demo.sql
-- Run ONCE in the Supabase SQL Editor after supabase/setup.sql.
--
-- Creates:
--   * Demo Warehouse
--   * Wall A, tagged delivery_mode = 'LMS', with 8 holes (P-001 ... P-008)
--   * Wall B, tagged delivery_mode = 'Hyperlocal', with 4 holes (H-001 ... H-004)
--   * a QR code for every hole, and one warehouse gate QR code
--
-- Why the walls are TAGGED: since 0016_delivery_mode_walls.sql, a shipment is
-- only routed to holes on a wall whose delivery_mode matches its own, and an
-- untagged (null) wall matches only untagged shipments. An LMS shipment with no
-- LMS wall available therefore gets NO hole reserved ("overflow"), and the
-- picker's "Sort into pigeon holes" screen has nothing for them to scan. Earlier
-- versions of this script created Wall A untagged, which made every LMS or
-- Hyperlocal order unsortable on a freshly bootstrapped project.
--
-- This script is safe to rerun: it reuses existing records by name/number, and
-- it will TAG an existing untagged Wall A rather than leaving it broken.
-- ============================================================================

do $$
declare
  v_warehouse_id uuid;
  v_sort_wall_id uuid;
  v_hyperlocal_wall_id uuid;
  v_hole_id uuid;
  v_qr_id uuid;
  v_number text;
  i integer;
begin
  select id into v_warehouse_id
  from warehouses
  where name = 'Demo Warehouse'
  order by created_at
  limit 1;

  if v_warehouse_id is null then
    insert into warehouses (name, address)
    values ('Demo Warehouse', '1 Test Street')
    returning id into v_warehouse_id;
  end if;

  select id into v_sort_wall_id
  from sort_walls
  where warehouse_id = v_warehouse_id and name = 'Wall A'
  limit 1;

  if v_sort_wall_id is null then
    insert into sort_walls (warehouse_id, name, delivery_mode, rows, columns)
    values (v_warehouse_id, 'Wall A', 'LMS', 2, 4)
    returning id into v_sort_wall_id;
  else
    -- Repair path for projects bootstrapped before the walls were tagged: an
    -- untagged wall cannot receive LMS or Hyperlocal shipments at all.
    update sort_walls
    set delivery_mode = 'LMS', updated_at = now()
    where id = v_sort_wall_id and delivery_mode is null;
  end if;

  for i in 1..8 loop
    v_number := 'P-' || lpad(i::text, 3, '0');

    select id, qr_code_id into v_hole_id, v_qr_id
    from pigeon_holes
    where sort_wall_id = v_sort_wall_id and hole_number = v_number;

    if v_hole_id is null then
      insert into pigeon_holes (sort_wall_id, hole_number, status)
      values (v_sort_wall_id, v_number, 'free')
      returning id into v_hole_id;
    end if;

    if v_qr_id is null then
      insert into qr_codes (
        code_type, code_value, code_version, entity_id, status
      )
      values (
        'pigeon_hole',
        'HOLE-' || v_number || '-' || substr(gen_random_uuid()::text, 1, 6),
        1,
        v_hole_id,
        'active'
      )
      returning id into v_qr_id;

      update pigeon_holes
      set qr_code_id = v_qr_id
      where id = v_hole_id;
    end if;

    v_hole_id := null;
    v_qr_id := null;
  end loop;

  -- Wall B carries the Hyperlocal shipments, so both delivery modes are
  -- sortable on a fresh project without any extra admin setup.
  select id into v_hyperlocal_wall_id
  from sort_walls
  where warehouse_id = v_warehouse_id and name = 'Wall B'
  limit 1;

  if v_hyperlocal_wall_id is null then
    insert into sort_walls (warehouse_id, name, delivery_mode, rows, columns)
    values (v_warehouse_id, 'Wall B', 'Hyperlocal', 1, 4)
    returning id into v_hyperlocal_wall_id;
  else
    update sort_walls
    set delivery_mode = 'Hyperlocal', updated_at = now()
    where id = v_hyperlocal_wall_id and delivery_mode is null;
  end if;

  for i in 1..4 loop
    v_number := 'H-' || lpad(i::text, 3, '0');

    select id, qr_code_id into v_hole_id, v_qr_id
    from pigeon_holes
    where sort_wall_id = v_hyperlocal_wall_id and hole_number = v_number;

    if v_hole_id is null then
      insert into pigeon_holes (sort_wall_id, hole_number, status)
      values (v_hyperlocal_wall_id, v_number, 'free')
      returning id into v_hole_id;
    end if;

    if v_qr_id is null then
      insert into qr_codes (code_type, code_value, code_version, entity_id, status)
      values (
        'pigeon_hole',
        'HOLE-' || v_number || '-' || substr(gen_random_uuid()::text, 1, 6),
        1,
        v_hole_id,
        'active'
      )
      returning id into v_qr_id;

      update pigeon_holes set qr_code_id = v_qr_id where id = v_hole_id;
    end if;

    v_hole_id := null;
    v_qr_id := null;
  end loop;

  -- The gate QR must carry an expiry: record_warehouse_arrival_v1 requires
  -- `expires_at > now()`, so a gate code with a null expiry fails that check and
  -- the arrival scan is rejected. Earlier versions of this script inserted one
  -- with no expiry, which made the printed GATE- code unusable. Mint it the same
  -- way get_active_warehouse_gate_qr_v1 does, and treat an expired code as
  -- needing replacement so re-running this script hands back a valid one.
  if not exists (
    select 1 from qr_codes
    where code_type = 'warehouse_gate'
      and entity_id = v_warehouse_id
      and status = 'active'
      and expires_at > now()
  ) then
    update qr_codes
    set status = case when expires_at <= now() then 'expired'::qr_code_status else 'revoked'::qr_code_status end
    where code_type = 'warehouse_gate' and entity_id = v_warehouse_id and status = 'active';

    insert into qr_codes (
      code_type, code_value, code_version, entity_id, status, expires_at
    )
    select
      'warehouse_gate',
      'GATE-' || substr(gen_random_uuid()::text, 1, 8),
      coalesce((select max(code_version) + 1 from qr_codes
                where code_type = 'warehouse_gate' and entity_id = v_warehouse_id), 1),
      v_warehouse_id,
      'active',
      date_trunc('hour', now()) + make_interval(mins => w.gate_qr_rotation_minutes)
    from warehouses w
    where w.id = v_warehouse_id;
  end if;
end $$;

-- Results you will use while testing. Save or screenshot these values.
-- Both walls, with their delivery_mode. If delivery_mode is null here, LMS and
-- Hyperlocal shipments cannot be sorted onto that wall.
select
  w.id as warehouse_id,
  w.name,
  sw.id as sort_wall_id,
  sw.name as sort_wall_name,
  sw.delivery_mode
from warehouses w
join sort_walls sw on sw.warehouse_id = w.id
where w.name = 'Demo Warehouse'
order by sw.name;

-- The gate code ROTATES (hourly by default, per warehouses.gate_qr_rotation_minutes).
-- Once expires_at has passed, re-run this script for a fresh one, or read the
-- live code off the app's warehouse gate screen.
select
  qc.code_value as warehouse_gate_code,
  qc.expires_at as valid_until
from qr_codes qc
join warehouses w on w.id = qc.entity_id
where qc.code_type = 'warehouse_gate'
  and qc.status = 'active'
  and w.name = 'Demo Warehouse';

select
  sw.name as wall,
  sw.delivery_mode,
  ph.hole_number,
  qc.code_value as pigeon_hole_code
from pigeon_holes ph
join sort_walls sw on sw.id = ph.sort_wall_id
join warehouses w on w.id = sw.warehouse_id
join qr_codes qc on qc.id = ph.qr_code_id
where w.name = 'Demo Warehouse'
order by sw.name, ph.hole_number;
