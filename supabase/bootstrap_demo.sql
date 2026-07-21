-- ============================================================================
-- bootstrap_demo.sql
-- Run ONCE in the Supabase SQL Editor after supabase/setup.sql.
--
-- Creates:
--   * Demo Warehouse
--   * Wall A
--   * 8 pigeon holes (P-001 ... P-008), each with a QR code
--   * one warehouse gate QR code
--
-- This script is safe to rerun: it reuses existing records by name/number.
-- ============================================================================

do $$
declare
  v_warehouse_id uuid;
  v_sort_wall_id uuid;
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
    insert into sort_walls (warehouse_id, name, rows, columns)
    values (v_warehouse_id, 'Wall A', 2, 4)
    returning id into v_sort_wall_id;
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

  if not exists (
    select 1 from qr_codes
    where code_type = 'warehouse_gate'
      and entity_id = v_warehouse_id
      and status = 'active'
  ) then
    insert into qr_codes (
      code_type, code_value, code_version, entity_id, status
    )
    values (
      'warehouse_gate',
      'GATE-' || substr(gen_random_uuid()::text, 1, 8),
      1,
      v_warehouse_id,
      'active'
    );
  end if;
end $$;

-- Results you will use while testing. Save or screenshot these values.
select
  w.id as warehouse_id,
  w.name,
  sw.id as sort_wall_id,
  sw.name as sort_wall_name
from warehouses w
join sort_walls sw on sw.warehouse_id = w.id
where w.name = 'Demo Warehouse' and sw.name = 'Wall A';

select
  qc.code_value as warehouse_gate_code
from qr_codes qc
join warehouses w on w.id = qc.entity_id
where qc.code_type = 'warehouse_gate'
  and qc.status = 'active'
  and w.name = 'Demo Warehouse';

select
  ph.hole_number,
  qc.code_value as pigeon_hole_code
from pigeon_holes ph
join sort_walls sw on sw.id = ph.sort_wall_id
join warehouses w on w.id = sw.warehouse_id
join qr_codes qc on qc.id = ph.qr_code_id
where w.name = 'Demo Warehouse' and sw.name = 'Wall A'
order by ph.hole_number;
