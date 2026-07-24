import { useEffect, useState, type FormEvent } from 'react';
import { supabase } from '../lib/supabaseClient';
import { WarehouseGateQr } from '../components/WarehouseGateQr';
import { useToast } from '../lib/useToast';
import type { OperationsConfiguration, SortWall, Warehouse } from '../types/database';

/**
 * Platform Admin: the real operational configuration - sort walls, pigeon
 * holes, warehouse gate QR codes, and the operations settings that apply to
 * every picker. Test-data tools (create test orders, live orders, hole QR
 * codes to scan, reset) live on the separate Testing tab.
 */
export function AdminPage() {
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [sortWalls, setSortWalls] = useState<SortWall[]>([]);
  const [configuration, setConfiguration] = useState<OperationsConfiguration | null>(null);
  const { toast, notify } = useToast(5000);

  const loadRefData = async () => {
    const [w, sw, configRows] = await Promise.all([
      supabase.from('warehouses').select('*'),
      supabase.from('sort_walls').select('*'),
      supabase.from('operations_configuration').select('*').eq('singleton', true).maybeSingle(),
    ]);
    setWarehouses((w.data as unknown as Warehouse[]) ?? []);
    setSortWalls((sw.data as unknown as SortWall[]) ?? []);
    setConfiguration((configRows.data as unknown as OperationsConfiguration | null) ?? null);
  };

  useEffect(() => {
    void loadRefData();
  }, []);

  const createSortWall = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formEl = e.currentTarget;
    const form = new FormData(formEl);
    const { error } = await supabase.rpc('admin_create_sort_wall_v1', {
      p_warehouse_id: form.get('wallWarehouseId'),
      p_name: form.get('wallName'),
      p_delivery_mode: form.get('wallDeliveryMode') || null,
    });
    if (error) {
      notify(`Could not create sort wall: ${error.message}`, 'error');
      return;
    }
    notify('Sort wall created.', 'success');
    formEl.reset();
    void loadRefData();
  };

  const createHoles = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formEl = e.currentTarget;
    const form = new FormData(formEl);
    const { data, error } = await supabase.rpc('admin_create_pigeon_holes_v1', {
      p_sort_wall_id: form.get('sortWallId'),
      p_count: Number(form.get('count')),
      p_prefix: form.get('prefix') || 'P',
    });
    if (error) {
      notify(`Failed: ${error.message}`, 'error');
      return;
    }
    const holes = (data as { hole_number: string; qr_code_id: string | null }[]) ?? [];
    notify(`Created ${holes.length} pigeon holes. View or scan their QR codes in Testing → Pigeon-hole QR codes.`, 'success');
    formEl.reset();
  };

  const saveConfiguration = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const { data, error } = await supabase.rpc('admin_update_operations_configuration_v1', {
      p_max_orders_per_picker: Number(form.get('maxOrders')),
      p_bags_per_pigeon_hole: Number(form.get('bagsPerHole')),
    });
    if (error) {
      notify(`Could not save configuration: ${error.message}`, 'error');
      return;
    }
    const { error: assignmentError } = await supabase.rpc('admin_update_assignment_configuration_v1', {
      p_auto_assign_enabled: form.get('autoAssign') === 'on',
      p_null_zone_matches_all_pickers: form.get('nullZoneAll') === 'on',
    });
    if (assignmentError) {
      await loadRefData();
      notify(`Order capacity saved, but assignment settings failed: ${assignmentError.message}`, 'error');
      return;
    }
    const { data: scanModeData, error: scanModeError } = await supabase.rpc('admin_set_bag_scan_mode_v1', {
      p_bag_scan_mode: form.get('bagScanMode') === 'one_bag' ? 'one_bag' : 'all_bags',
    });
    if (scanModeError) {
      await loadRefData();
      notify(`Capacity saved, but bag scan mode failed: ${scanModeError.message}`, 'error');
      return;
    }
    const { data: holeModeData, error: holeModeError } = await supabase.rpc('admin_set_hole_assignment_mode_v1', {
      p_mode: form.get('holeAssignmentMode') === 'picker_chosen' ? 'picker_chosen' : 'pre_assigned',
    });
    if (holeModeError) {
      await loadRefData();
      notify(`Saved, but pigeon-hole assignment mode failed: ${holeModeError.message}`, 'error');
      return;
    }
    setConfiguration(
      (holeModeData as OperationsConfiguration) ??
        (scanModeData as OperationsConfiguration) ??
        (data as OperationsConfiguration),
    );
    notify('Operations configuration saved. It applies to all pickers and free pigeon holes.', 'success');
    void loadRefData();
  };

  return (
    <div className="admin-screen">
      {toast && <div className={`toast is-${toast.variant}`} role="alert">{toast.text}</div>}

      <header className="panel-heading">
        <div>
          <span className="panel-eyebrow">Platform controls</span>
          <h1>Admin</h1>
          <p>Manage the physical QR setup and the operations settings that apply to every picker.</p>
        </div>
      </header>

      <section>
        <h2>Create sort wall</h2>
        <p className="hint">
          Tag a wall as the LMS wall or the Hyperlocal wall. A shipment can only be
          placed on holes of a wall matching its delivery mode. Requires migration
          <code> 0016_delivery_mode_walls.sql</code>.
        </p>
        <form onSubmit={createSortWall}>
          <label>
            Warehouse
            <select name="wallWarehouseId" required>
              {warehouses.map((w) => (
                <option key={w.id} value={w.id}>{w.name}</option>
              ))}
            </select>
          </label>
          <label>
            Wall name
            <input name="wallName" required placeholder="LMS Wall" />
          </label>
          <label>
            Delivery mode
            <select name="wallDeliveryMode" defaultValue="LMS">
              <option value="LMS">LMS</option>
              <option value="Hyperlocal">Hyperlocal</option>
              <option value="">Untagged (any)</option>
            </select>
          </label>
          <button type="submit">Create sort wall</button>
        </form>
      </section>

      <section>
        <h2>Create pigeon holes</h2>
        <p className="hint">Use a distinct prefix per wall (e.g. LMS / HL) so hole numbers stay unique across walls.</p>
        <form onSubmit={createHoles}>
          <label>
            Sort wall
            <select name="sortWallId" required>
              {sortWalls.map((sw) => (
                <option key={sw.id} value={sw.id}>
                  {sw.name}{sw.delivery_mode ? ` (${sw.delivery_mode})` : ''}
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

      <section className="warehouse-qr-list">
        <h2>Warehouse QR codes</h2>
        <p className="hint">These are the actual live gate QR codes. Each code expires and refreshes every hour.</p>
        {warehouses.map((warehouse) => <WarehouseGateQr key={warehouse.id} warehouse={warehouse} />)}
      </section>

      <section>
        <h2>Configurations</h2>
        <p className="hint">
          The picker limit counts orders through drop-off at the warehouse; once dropped off, that
          capacity frees up. The bag capacity applies to free pigeon holes; occupied holes keep their
          existing capacity until they are released.
        </p>
        <form key={configuration?.updated_at ?? 'default'} onSubmit={saveConfiguration}>
          <label>
            Maximum active orders per picker
            <input name="maxOrders" type="number" min="1" required defaultValue={configuration?.max_orders_per_picker ?? 3} />
          </label>
          <label>
            Maximum bags per pigeon hole
            <input name="bagsPerHole" type="number" min="1" required defaultValue={configuration?.bags_per_pigeon_hole ?? 5} />
          </label>
          <label>
            Bags scanned per shipment
            <select name="bagScanMode" defaultValue={configuration?.bag_scan_mode ?? 'all_bags'}>
              <option value="all_bags">Scan every bag (pickup and drop-off)</option>
              <option value="one_bag">Scan one bag per shipment</option>
            </select>
          </label>
          <p className="hint">
            &quot;Scan one bag per shipment&quot; lets a picker confirm a whole shipment with a single
            scan at pickup and a single scan at the pigeon hole. &quot;Scan every bag&quot; keeps the
            current bag-by-bag flow. Applies to all shipments.
          </p>
          <label>
            Pigeon-hole assignment
            <select name="holeAssignmentMode" defaultValue={configuration?.hole_assignment_mode ?? 'pre_assigned'}>
              <option value="pre_assigned">Pre-assigned (system routes the picker to a hole)</option>
              <option value="picker_chosen">Picker-chosen (picker scans any free hole at the wall)</option>
            </select>
          </label>
          <p className="hint">
            &quot;Pre-assigned&quot; reserves a hole at warehouse arrival and shows the picker where to
            go. &quot;Picker-chosen&quot; lets the picker scan any free hole; the first bag links that
            hole to the shipment, and only that shipment&apos;s bags can go in it. Applies to all shipments.
          </p>
          <label className="checkbox-row">
            <input name="autoAssign" type="checkbox" defaultChecked={configuration?.auto_assign_enabled ?? true} />
            Automatically assign orders to eligible online pickers
          </label>
          <label className="checkbox-row">
            <input name="nullZoneAll" type="checkbox" defaultChecked={configuration?.null_zone_matches_all_pickers ?? false} />
            Treat orders without a zone as eligible for all pickers
          </label>
          <button type="submit">Save configuration</button>
        </form>
      </section>

      <p className="hint">
        Warehouses are created directly via SQL (see supabase/seed.sql) since that only happens rarely.
        Test orders, live-order monitoring, hole QR codes to scan, and reset live on the Testing tab.
      </p>
    </div>
  );
}
