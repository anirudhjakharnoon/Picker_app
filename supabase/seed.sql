-- ============================================================================
-- seed.sql — LOCAL / DEV-ONLY test data.
--
-- This is NOT applied automatically to your real Supabase project. Run it
-- manually (via the Supabase SQL editor, or `psql` if you have a direct
-- connection string) only against a project you're happy to fill with test
-- data — never against production.
--
-- It creates one warehouse, one sort wall with 8 pigeon holes, and one
-- warehouse gate QR code, so you can exercise the full Picker → Sort Wall
-- flow end-to-end without waiting on a real Store API integration.
--
-- Prerequisite: at least one Admin user must already exist (created via the
-- Supabase Dashboard, see app/README.md "First admin user"), because the
-- admin_create_* RPCs check the caller's role. Run this seed AS that admin
-- user (e.g. paste it into the SQL editor while impersonating them, or run
-- the underlying inserts directly as shown below, which bypasses RLS
-- entirely since the SQL editor runs as a superuser/service role).
-- ============================================================================

insert into warehouses (name, address)
values ('Demo Warehouse', '1 Test Street')
returning id; -- copy this id for the next steps if running interactively

-- Replace the warehouse id below with the one printed above if you're not
-- running this as one uninterrupted script.
with w as (select id from warehouses where name = 'Demo Warehouse' limit 1)
insert into sort_walls (warehouse_id, name, rows, columns)
select id, 'Wall A', 2, 4 from w
returning id;

with sw as (select id from sort_walls where name = 'Wall A' limit 1)
select admin_create_pigeon_holes_v1(id, 8, 'P') from sw;
-- NOTE: admin_create_pigeon_holes_v1 requires the CALLING role to be
-- 'admin' (checked via auth.uid() -> profiles.role). If you're running this
-- from the SQL editor as the postgres/service role directly, auth.uid()
-- will be null and this call will be rejected with "not permitted" — in
-- that case, either run it from the app's Admin tab instead (Section 12.3),
-- or temporarily insert the holes directly:
--
-- insert into pigeon_holes (sort_wall_id, hole_number, status)
-- select id, 'P-00' || gs, 'free' from sort_walls, generate_series(1, 8) gs
-- where name = 'Wall A';

with w as (select id from warehouses where name = 'Demo Warehouse' limit 1)
select admin_create_warehouse_gate_v1(id) from w;
