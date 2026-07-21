import { useEffect, useState, type FormEvent } from 'react';
import { supabase } from '../lib/supabaseClient';
import type { SortWall, Warehouse } from '../types/database';

/**
 * Minimal admin/test-data tools. There is no real Store API integration yet
 * (docs/TECHNICAL_DESIGN_DOCUMENT.md Section 3.1) — these forms call the
 * `admin_create_*` RPCs (Section 12.3/20.1) so you can create a warehouse,
 * sort wall, pigeon holes, a warehouse gate code, and test orders directly
 * from the Supabase SQL editor once, then generate ongoing test data here.
 */
export function AdminPage() {
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [sortWalls, setSortWalls] = useState<SortWall[]>([]);
  const [toast, setToast] = useState<string | null>(null);

  const notify = (msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 5000);
  };

  const loadRefData = async () => {
    const [w, sw] = await Promise.all([supabase.from('warehouses').select('*'), supabase.from('sort_walls').select('*')]);
    setWarehouses((w.data as unknown as Warehouse[]) ?? []);
    setSortWalls((sw.data as unknown as SortWall[]) ?? []);
  };

  useEffect(() => {
    void loadRefData();
  }, []);

  const createOrder = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const { data, error } = await supabase.rpc('admin_create_order_v1', {
      p_store_external_ref: form.get('storeRef'),
      p_bag_count: Number(form.get('bagCount')),
      p_store_floor: form.get('floor') || null,
      p_store_zone: form.get('zone') || null,
      p_store_address: form.get('address') || null,
    });
    if (error) notify(`Failed: ${error.message}`);
    else notify(`Created order ${(data as { external_order_ref: string }).external_order_ref}`);
    e.currentTarget.reset();
  };

  const createHoles = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const { data, error } = await supabase.rpc('admin_create_pigeon_holes_v1', {
      p_sort_wall_id: form.get('sortWallId'),
      p_count: Number(form.get('count')),
      p_prefix: form.get('prefix') || 'P',
    });
    if (error) notify(`Failed: ${error.message}`);
    else notify(`Created ${(data as unknown[])?.length ?? 0} pigeon holes`);
  };

  const createGate = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const { data, error } = await supabase.rpc('admin_create_warehouse_gate_v1', {
      p_warehouse_id: form.get('warehouseId'),
    });
    if (error) notify(`Failed: ${error.message}`);
    else notify(`Gate code created: ${(data as { code_value: string }).code_value}`);
  };

  return (
    <div className="admin-screen">
      {toast && <div className="toast">{toast}</div>}

      <section>
        <h2>Create test order</h2>
        <p className="hint">
          Stand-in for a real Store API webhook (Section 3.1/7.2). Generates the shared order-level
          QR code and the expected bag count.
        </p>
        <form onSubmit={createOrder}>
          <label>
            Store reference
            <input name="storeRef" required defaultValue="STORE-DEMO" />
          </label>
          <label>
            Bag count
            <input name="bagCount" type="number" min="1" required defaultValue={3} />
          </label>
          <label>
            Floor
            <input name="floor" defaultValue="2" />
          </label>
          <label>
            Zone
            <input name="zone" defaultValue="North" />
          </label>
          <label>
            Address
            <input name="address" defaultValue="12 Market Rd" />
          </label>
          <button type="submit">Create order</button>
        </form>
      </section>

      <section>
        <h2>Create pigeon holes</h2>
        <form onSubmit={createHoles}>
          <label>
            Sort wall
            <select name="sortWallId" required>
              {sortWalls.map((sw) => (
                <option key={sw.id} value={sw.id}>
                  {sw.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Count
            <input name="count" type="number" min="1" required defaultValue={10} />
          </label>
          <label>
            Prefix
            <input name="prefix" defaultValue="P" />
          </label>
          <button type="submit">Create holes</button>
        </form>
      </section>

      <section>
        <h2>Create warehouse gate code</h2>
        <form onSubmit={createGate}>
          <label>
            Warehouse
            <select name="warehouseId" required>
              {warehouses.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </label>
          <button type="submit">Create gate code</button>
        </form>
      </section>

      <p className="hint">
        Warehouses and sort walls themselves are created directly via SQL (see
        supabase/seed.sql) since that only happens rarely — see app/README.md.
      </p>
    </div>
  );
}
