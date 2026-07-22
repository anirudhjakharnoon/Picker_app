import { useEffect, useState, type FormEvent } from 'react';
import { supabase } from '../lib/supabaseClient';
import { useOrders } from '../lib/useOrders';
import { QrCodePreview } from '../components/QrCodePreview';
import { WarehouseGateQr } from '../components/WarehouseGateQr';
import { EyeIcon } from '../components/icons';
import type { OperationsConfiguration, Profile, PigeonHole, SortWall, Warehouse } from '../types/database';

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
  const [generatedCodes, setGeneratedCodes] = useState<
    { label: string; value: string }[]
  >([]);
  const { orders, refetch: refetchOrders } = useOrders();
  const [pickers, setPickers] = useState<Profile[]>([]);
  const [configuration, setConfiguration] = useState<OperationsConfiguration | null>(null);
  const [holes, setHoles] = useState<PigeonHole[]>([]);
  const [assigningOrderId, setAssigningOrderId] = useState<string | null>(null);
  const [resetConfirmation, setResetConfirmation] = useState('');
  const [viewingHole, setViewingHole] = useState<{ hole: PigeonHole; value: string } | null>(null);

  const notify = (msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 5000);
  };

  const loadRefData = async () => {
    const [w, sw, pickerRows, configRows, holeRows] = await Promise.all([
      supabase.from('warehouses').select('*'),
      supabase.from('sort_walls').select('*'),
      supabase.from('profiles').select('*').eq('role', 'picker').eq('status', 'active').order('full_name'),
      supabase.from('operations_configuration').select('*').eq('singleton', true).maybeSingle(),
      supabase.from('pigeon_holes').select('*'),
    ]);
    setWarehouses((w.data as unknown as Warehouse[]) ?? []);
    setSortWalls((sw.data as unknown as SortWall[]) ?? []);
    setPickers((pickerRows.data as unknown as Profile[]) ?? []);
    setConfiguration((configRows.data as unknown as OperationsConfiguration | null) ?? null);
    setHoles((holeRows.data as unknown as PigeonHole[]) ?? []);
  };

  useEffect(() => {
    void loadRefData();
  }, []);

  // PostgREST reports a missing function as a schema-cache lookup failure,
  // named by whichever set of arguments the client actually sent (it does
  // this rather than saying "wrong argument count" because RPC calls are
  // matched by argument NAME, not position). We only expect to hit this
  // specific case when p_is_fragile/p_store_name are sent to a project that
  // hasn't applied migration 0005 yet — everything else should surface as a
  // normal error.
  const isMissingFunctionError = (message: string) =>
    /could not find the function/i.test(message) || message.includes('PGRST202');

  const createOrder = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    // Capture the form element itself before any `await`: per the DOM spec,
    // `Event.currentTarget` reverts to null once the event finishes
    // dispatching, which happens long before an async handler resumes after
    // its first `await` — reading `e.currentTarget` later throws
    // "Cannot read properties of null". This is not React event pooling
    // (removed in React 17+); it's the underlying native Event object.
    const formEl = e.currentTarget;
    const form = new FormData(formEl);
    const isFragile = form.get('fragile') === 'on';
    const storeName = (form.get('storeName') as string | null)?.trim() || null;
    const usedExtendedArgs = isFragile || !!storeName;

    const baseArgs = {
      p_store_external_ref: form.get('storeRef'),
      p_bag_count: Number(form.get('bagCount')),
      p_store_floor: form.get('floor') || null,
      p_store_zone: form.get('zone') || null,
      p_store_address: form.get('address') || null,
    };
    const extendedArgs = {
      ...baseArgs,
      ...(isFragile ? { p_is_fragile: true } : {}),
      ...(storeName ? { p_store_name: storeName } : {}),
    };

    let { data, error } = await supabase.rpc('admin_create_order_v1', extendedArgs);

    // Migration 0005 hasn't been applied to this project yet: fall back to
    // the base 6-argument call automatically instead of blocking order
    // creation entirely. This is exactly the case a beginner hits by simply
    // leaving the pre-filled "Store display name" field in place.
    let fellBack = false;
    if (error && usedExtendedArgs && isMissingFunctionError(error.message)) {
      fellBack = true;
      ({ data, error } = await supabase.rpc('admin_create_order_v1', baseArgs));
    }

    if (error) {
      notify(`Failed: ${error.message}`);
    } else {
      const order = data as {
        external_order_ref: string;
        shared_bag_qr_code_id: string | null;
      };
      notify(
        fellBack
          ? `Created order ${order.external_order_ref}. Store name/fragile were skipped — run migration 0005_order_fragile.sql to enable them.`
          : `Created order ${order.external_order_ref}`
      );
      if (order.shared_bag_qr_code_id) {
        const { data: qr } = await supabase
          .from('qr_codes')
          .select('code_value')
          .eq('id', order.shared_bag_qr_code_id)
          .single();
        if (qr) {
          setGeneratedCodes((current) => [
            {
              label: `Bag code for ${order.external_order_ref} (same code on every bag)`,
              value: (qr as { code_value: string }).code_value,
            },
            ...current,
          ]);
        }
      }
    }
    formEl.reset();
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
      notify(`Failed: ${error.message}`);
    } else {
      const holes = (data as { hole_number: string; qr_code_id: string | null }[]) ?? [];
      notify(`Created ${holes.length} pigeon holes`);
      const qrIds = holes.flatMap((hole) => (hole.qr_code_id ? [hole.qr_code_id] : []));
      if (qrIds.length > 0) {
        const { data: qrRows } = await supabase
          .from('qr_codes')
          .select('id, code_value')
          .in('id', qrIds);
        const codeById = new Map(
          ((qrRows as { id: string; code_value: string }[] | null) ?? []).map((qr) => [
            qr.id,
            qr.code_value,
          ])
        );
        setGeneratedCodes((current) => [
          ...holes.flatMap((hole) =>
            hole.qr_code_id && codeById.has(hole.qr_code_id)
              ? [
                  {
                    label: `Pigeon hole ${hole.hole_number}`,
                    value: codeById.get(hole.qr_code_id)!,
                  },
                ]
              : []
          ),
          ...current,
        ]);
      }
    }
  };

  const assignPicker = async (orderId: string, pickerId: string) => {
    if (!pickerId) return;
    setAssigningOrderId(orderId);
    const { error } = await supabase.rpc('admin_assign_order_v1', {
      p_order_id: orderId,
      p_picker_id: pickerId,
    });
    setAssigningOrderId(null);
    if (error) notify(`Could not assign picker: ${error.message}`);
    else {
      notify('Picker assigned.');
      void refetchOrders();
    }
  };

  const saveConfiguration = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const { data, error } = await supabase.rpc('admin_update_operations_configuration_v1', {
      p_max_orders_per_picker: Number(form.get('maxOrders')),
      p_bags_per_pigeon_hole: Number(form.get('bagsPerHole')),
    });
    if (error) {
      notify(`Could not save configuration: ${error.message}`);
      return;
    }
    const { error: assignmentError } = await supabase.rpc('admin_update_assignment_configuration_v1', {
      p_auto_assign_enabled: form.get('autoAssign') === 'on',
      p_null_zone_matches_all_pickers: form.get('nullZoneAll') === 'on',
    });
    if (assignmentError) {
      notify(`Order capacity saved, but assignment settings failed: ${assignmentError.message}`);
      return;
    }
    setConfiguration(data as OperationsConfiguration);
    notify('Operations configuration saved. It applies to all pickers and free pigeon holes.');
    void loadRefData();
  };

  const resetOrders = async () => {
    const { data, error } = await supabase.rpc('admin_reset_orders_v1', {
      p_confirmation: resetConfirmation,
    });
    if (error) {
      notify(`Could not reset orders: ${error.message}`);
      return;
    }
    setResetConfirmation('');
    setGeneratedCodes([]);
    notify(`Deleted ${data as number} test order(s). Pigeon holes have been released.`);
    void refetchOrders();
    void loadRefData();
  };

  const pickerById = new Map(pickers.map((picker) => [picker.id, picker]));
  const holeById = new Map(holes.map((hole) => [hole.id, hole]));

  const viewHoleQr = async (hole: PigeonHole) => {
    if (!hole.qr_code_id) {
      notify('This pigeon hole does not have a QR code yet.');
      return;
    }
    const { data, error } = await supabase
      .from('qr_codes')
      .select('code_value')
      .eq('id', hole.qr_code_id)
      .maybeSingle();
    if (error || !data) {
      notify(`Could not load pigeon-hole QR: ${error?.message ?? 'not found'}`);
      return;
    }
    setViewingHole({ hole, value: (data as { code_value: string }).code_value });
  };

  return (
    <div className="admin-screen">
      {toast && <div className="toast">{toast}</div>}

      <header className="panel-heading">
        <div>
          <span className="panel-eyebrow">Platform controls</span>
          <h1>Admin</h1>
          <p>Create test orders and manage the physical QR setup for this MVP.</p>
        </div>
      </header>

      {generatedCodes.length > 0 && (
        <section className="generated-codes">
          <h2>Generated test codes</h2>
          <p className="hint">
            Keep this page open or copy these values. On a scanner screen, tap
            &quot;Can&apos;t scan? Enter code manually&quot; and paste the matching value.
          </p>
          {generatedCodes.map((code, index) => (
            <div className="generated-code" key={`${code.label}-${index}`}>
              <QrCodePreview value={code.value} label={code.label} />
              <div>
                <strong>{code.label}</strong>
                <code>{code.value}</code>
                <button
                  type="button"
                  onClick={() => {
                    void navigator.clipboard.writeText(code.value);
                    notify('Code copied.');
                  }}
                >
                  Copy
                </button>
              </div>
            </div>
          ))}
        </section>
      )}

      <section>
        <h2>Create test order</h2>
        <p className="hint">
          Stand-in for a real Store API webhook (Section 3.1/7.2). Generates the shared order-level
          QR code and the expected bag count.
        </p>
        <form onSubmit={createOrder}>
          <label>
            Store reference
            <input name="storeRef" required defaultValue="BUFFALO" />
          </label>
          <label>
            Store display name
            <input name="storeName" defaultValue="Buffalo Burger" />
          </label>
          <label>
            Bag count
            <input name="bagCount" type="number" min="1" required defaultValue={5} />
          </label>
          <label>
            Floor
            <input name="floor" defaultValue="4th" />
          </label>
          <label>
            Zone
            <input name="zone" defaultValue="C" />
          </label>
          <label>
            Address
            <input name="address" defaultValue="Mirdif City Centre, Level 1 - Sheikh Zayed Rd - Dubai" />
          </label>
          <label className="checkbox-row">
            <input name="fragile" type="checkbox" />
            Fragile items
          </label>
          <button type="submit">Create order</button>
        </form>
        <p className="hint">
          Store display name and Fragile items require the optional
          <code> 0005_order_fragile.sql </code> migration.
        </p>
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

      <section className="warehouse-qr-list">
        <h2>Warehouse QR codes</h2>
        <p className="hint">These are the actual live gate QR codes. Each code expires and refreshes every hour.</p>
        {warehouses.map((warehouse) => <WarehouseGateQr key={warehouse.id} warehouse={warehouse} />)}
      </section>

      <section>
        <h2>Configurations</h2>
        <p className="hint">
          The picker limit counts active orders through drop-off. The bag capacity applies to free pigeon holes;
          occupied holes keep their existing capacity until they are released.
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

      <section className="admin-live-orders">
        <h2>Live orders</h2>
        <p className="hint">Status and assignment update live. Available orders can be manually assigned to an active picker.</p>
        {orders.length === 0 && <p className="empty-state">No orders yet.</p>}
        {orders.map((order) => {
          const picker = order.assigned_picker_id ? pickerById.get(order.assigned_picker_id) : null;
          const hole = order.pigeon_hole_id ? holeById.get(order.pigeon_hole_id) : null;
          return (
            <div className="admin-order-row" key={order.id}>
              <div>
                <strong>{order.external_order_ref}</strong>
                <span className={`state-pill state-${order.status === 'picked' ? 'picked' : order.status === 'picking_in_progress' ? 'progress' : 'ready'}`}>
                  {adminOrderStatus(order.status)}
                </span>
                <p>Picker: {picker?.full_name ?? picker?.email ?? 'Unassigned'}</p>
                <p>Pigeon hole: {hole?.hole_number ?? 'Not assigned yet'}</p>
              </div>
              {order.shared_bag_qr_code_id && (
                <OrderQrPreview orderRef={order.external_order_ref} qrCodeId={order.shared_bag_qr_code_id} />
              )}
              {order.status === 'available' && (
                <label className="admin-assign-picker">
                  Assign picker
                  <select
                    defaultValue=""
                    disabled={assigningOrderId === order.id}
                    onChange={(event) => void assignPicker(order.id, event.target.value)}
                  >
                    <option value="" disabled>Select an active picker</option>
                    {pickers.map((availablePicker) => (
                      <option key={availablePicker.id} value={availablePicker.id}>
                        {availablePicker.full_name ?? availablePicker.email} ({availablePicker.max_concurrent_orders} max)
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
          );
        })}
      </section>

      <section className="admin-pigeon-holes">
        <h2>Pigeon-hole QR codes</h2>
        <p className="hint">Tap the eye to view and scan the QR code for a specific pigeon hole.</p>
        <div className="admin-hole-grid">
          {holes.map((hole) => (
            <div className="admin-hole-row" key={hole.id}>
              <span>
                <strong>{hole.hole_number}</strong>
                <small>{hole.status.replace(/_/g, ' ')} · {hole.bag_capacity ?? configuration?.bags_per_pigeon_hole ?? 0} bags</small>
              </span>
              <button
                type="button"
                className="icon-button"
                aria-label={`Show QR code for pigeon hole ${hole.hole_number}`}
                onClick={() => void viewHoleQr(hole)}
              >
                <EyeIcon />
              </button>
            </div>
          ))}
        </div>
      </section>

      <section className="danger-zone">
        <h2>Reset test orders</h2>
        <p className="hint">
          Permanently deletes every current test order, its bag scans and bag QR codes, then releases all pigeon holes.
          Warehouses, users, walls, hole QR codes, and stores are kept.
        </p>
        <label>
          Type <code>RESET ALL TEST ORDERS</code> to confirm
          <input value={resetConfirmation} onChange={(event) => setResetConfirmation(event.target.value)} />
        </label>
        <button type="button" className="danger-button" disabled={resetConfirmation !== 'RESET ALL TEST ORDERS'} onClick={() => void resetOrders()}>
          Delete all test orders
        </button>
      </section>

      <p className="hint">
        Warehouses and sort walls themselves are created directly via SQL (see
        supabase/seed.sql) since that only happens rarely — see app/README.md.
      </p>

      {viewingHole && (
        <div className="qr-dialog-backdrop" role="presentation" onClick={() => setViewingHole(null)}>
          <section
            className="qr-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={`QR code for pigeon hole ${viewingHole.hole.hole_number}`}
            onClick={(event) => event.stopPropagation()}
          >
            <button type="button" className="icon-button close" aria-label="Close QR code" onClick={() => setViewingHole(null)}>✕</button>
            <h2>Pigeon hole {viewingHole.hole.hole_number}</h2>
            <QrCodePreview value={viewingHole.value} label={`Pigeon hole ${viewingHole.hole.hole_number}`} />
            <code>{viewingHole.value}</code>
          </section>
        </div>
      )}
    </div>
  );
}

function adminOrderStatus(status: string): string {
  if (status === 'available' || status === 'assigned') return 'Pending pickup';
  if (status === 'picking_in_progress') return 'In progress';
  if (status === 'picked') return 'Picked up';
  return status.replace(/_/g, ' ');
}

function OrderQrPreview({ orderRef, qrCodeId }: { orderRef: string; qrCodeId: string }) {
  const [value, setValue] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void supabase
      .from('qr_codes')
      .select('code_value')
      .eq('id', qrCodeId)
      .maybeSingle()
      .then(({ data }) => {
        if (!cancelled) setValue((data as { code_value?: string } | null)?.code_value ?? null);
      });
    return () => {
      cancelled = true;
    };
  }, [qrCodeId]);

  return value ? (
    <div className="admin-order-qr">
      <QrCodePreview value={value} label={`Order ${orderRef}`} />
      <small>Order QR</small>
    </div>
  ) : null;
}
