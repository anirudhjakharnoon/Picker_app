import { useEffect, useState, type FormEvent } from 'react';
import { supabase } from '../lib/supabaseClient';
import { useOrders } from '../lib/useOrders';
import { QrCodePreview } from '../components/QrCodePreview';
import { EyeIcon, TrashIcon } from '../components/icons';
import { StatusPill } from '../components/StatusPill';
import { orderStatusMeta, holeStatusMeta } from '../lib/status';
import { useToast } from '../lib/useToast';
import type { OperationsConfiguration, Profile, PigeonHole, SortWall } from '../types/database';

/**
 * Testing tools, kept separate from real platform Admin controls: create test
 * orders, watch them flow live, view the QR codes you need to scan (order bags
 * and pigeon holes), and reset all test data. There is no real Store API yet,
 * so these RPCs stand in for it while exercising the picker/sort-wall flows.
 */
export function TestingPage() {
  const { toast, notify } = useToast(5000);
  const { orders, refetch: refetchOrders } = useOrders();
  const [generatedCodes, setGeneratedCodes] = useState<{ label: string; value: string }[]>([]);
  const [sortWalls, setSortWalls] = useState<SortWall[]>([]);
  const [pickers, setPickers] = useState<Profile[]>([]);
  const [configuration, setConfiguration] = useState<OperationsConfiguration | null>(null);
  const [holes, setHoles] = useState<PigeonHole[]>([]);
  const [assigningOrderId, setAssigningOrderId] = useState<string | null>(null);
  const [resetConfirmation, setResetConfirmation] = useState('');
  const [viewingHole, setViewingHole] = useState<{ hole: PigeonHole; value: string } | null>(null);

  const loadRefData = async () => {
    const [sw, pickerRows, configRows, holeRows] = await Promise.all([
      supabase.from('sort_walls').select('*'),
      supabase.from('profiles').select('*').eq('role', 'picker').eq('status', 'active').order('full_name'),
      supabase.from('operations_configuration').select('*').eq('singleton', true).maybeSingle(),
      supabase.from('pigeon_holes').select('*'),
    ]);
    setSortWalls((sw.data as unknown as SortWall[]) ?? []);
    setPickers((pickerRows.data as unknown as Profile[]) ?? []);
    setConfiguration((configRows.data as unknown as OperationsConfiguration | null) ?? null);
    setHoles((holeRows.data as unknown as PigeonHole[]) ?? []);
  };

  useEffect(() => {
    void loadRefData();
  }, []);

  const isMissingFunctionError = (message: string) =>
    /could not find the function/i.test(message) || message.includes('PGRST202');

  const createOrder = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formEl = e.currentTarget;
    const form = new FormData(formEl);
    const isFragile = form.get('fragile') === 'on';
    const storeName = (form.get('storeName') as string | null)?.trim() || null;
    const deliveryMode = (form.get('deliveryMode') as string | null) || null;
    const usedExtendedArgs = isFragile || !!storeName || !!deliveryMode;

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
      ...(deliveryMode ? { p_delivery_mode: deliveryMode } : {}),
    };

    let { data, error } = await supabase.rpc('admin_create_order_v1', extendedArgs);

    let fellBack = false;
    if (error && usedExtendedArgs && isMissingFunctionError(error.message)) {
      fellBack = true;
      ({ data, error } = await supabase.rpc('admin_create_order_v1', baseArgs));
    }

    if (error) {
      const message = /is_fragile/i.test(error.message)
        ? 'orders.is_fragile is missing. Run migration 0013_ensure_order_is_fragile.sql (or 0005_order_fragile.sql), then try again.'
        : error.message;
      notify(`Failed: ${message}`, 'error');
    } else {
      const order = data as { external_order_ref: string; shared_bag_qr_code_id: string | null };
      notify(
        fellBack
          ? `Created order ${order.external_order_ref}. Store name and Fragile aren't enabled on this environment yet.`
          : `Created order ${order.external_order_ref}`,
        'success',
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

  const assignPicker = async (orderId: string, pickerId: string) => {
    if (!pickerId) return;
    setAssigningOrderId(orderId);
    const { error } = await supabase.rpc('admin_assign_order_v1', {
      p_order_id: orderId,
      p_picker_id: pickerId,
    });
    setAssigningOrderId(null);
    if (error) notify(`Could not assign picker: ${error.message}`, 'error');
    else {
      notify('Picker assigned.', 'success');
      void refetchOrders();
    }
  };

  const resetOrders = async () => {
    const { data, error } = await supabase.rpc('admin_reset_orders_v1', { p_confirmation: resetConfirmation });
    if (error) {
      notify(`Could not reset orders: ${error.message}`, 'error');
      return;
    }
    setResetConfirmation('');
    setGeneratedCodes([]);
    notify(`Deleted ${data as number} test order(s). Pigeon holes have been released.`, 'success');
    void refetchOrders();
    void loadRefData();
  };

  const deleteHole = async (hole: PigeonHole) => {
    if (!window.confirm(`Delete pigeon hole ${hole.hole_number}? This removes the hole and its QR code.`)) return;
    const { error } = await supabase.rpc('admin_delete_pigeon_hole_v1', { p_pigeon_hole_id: hole.id });
    if (error) {
      notify(`Could not delete hole: ${error.message}`, 'error');
      return;
    }
    notify(`Pigeon hole ${hole.hole_number} deleted.`, 'success');
    void loadRefData();
  };

  const deleteWall = async (wall: SortWall) => {
    if (!window.confirm(`Delete "${wall.name}" and all its pigeon holes? This cannot be undone.`)) return;
    const { error } = await supabase.rpc('admin_delete_sort_wall_v1', { p_sort_wall_id: wall.id });
    if (error) {
      notify(`Could not delete wall: ${error.message}`, 'error');
      return;
    }
    notify(`Sort wall "${wall.name}" deleted.`, 'success');
    void loadRefData();
  };

  const viewHoleQr = async (hole: PigeonHole) => {
    if (!hole.qr_code_id) {
      notify('This pigeon hole does not have a QR code yet.', 'error');
      return;
    }
    const { data, error } = await supabase
      .from('qr_codes')
      .select('code_value')
      .eq('id', hole.qr_code_id)
      .maybeSingle();
    if (error || !data) {
      notify(`Could not load pigeon-hole QR: ${error?.message ?? 'not found'}`, 'error');
      return;
    }
    setViewingHole({ hole, value: (data as { code_value: string }).code_value });
  };

  const pickerById = new Map(pickers.map((picker) => [picker.id, picker]));
  const holeById = new Map(holes.map((hole) => [hole.id, hole]));

  return (
    <div className="admin-screen">
      {toast && <div className={`toast is-${toast.variant}`} role="alert">{toast.text}</div>}

      <header className="panel-heading">
        <div>
          <span className="panel-eyebrow">Test data</span>
          <h1>Testing</h1>
          <p>Create test orders, watch them flow, view the QR codes to scan, and reset test data.</p>
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
                    notify('Code copied.', 'success');
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
          Stand-in for a real Store API webhook. Generates the shared order-level QR code and the
          expected bag count, then enters the assignment engine immediately.
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
          <label>
            Delivery mode
            <select name="deliveryMode" defaultValue="LMS">
              <option value="LMS">LMS</option>
              <option value="Hyperlocal">Hyperlocal</option>
            </select>
          </label>
          <label className="checkbox-row">
            <input name="fragile" type="checkbox" />
            Fragile items
          </label>
          <button type="submit">Create order</button>
        </form>
      </section>

      <section className="admin-live-orders">
        <h2>Live orders</h2>
        <p className="hint">Status and assignment update live. Available orders can be manually assigned to an active picker.</p>
        {orders.length === 0 && <p className="empty-state">No orders yet. Create a test order above to see it here.</p>}
        {orders.map((order) => {
          const picker = order.assigned_picker_id ? pickerById.get(order.assigned_picker_id) : null;
          const hole = order.pigeon_hole_id ? holeById.get(order.pigeon_hole_id) : null;
          return (
            <div className="admin-order-row" key={order.id}>
              <div>
                <strong>{order.external_order_ref}</strong>
                <StatusPill meta={orderStatusMeta(order.status)} />
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
        <p className="hint">Holes are grouped by sort wall. Tap the eye to view a hole&apos;s QR code, or the bin to delete a hole. Delete a whole wall from its heading.</p>
        {sortWalls.length === 0 && <p className="empty-state">No sort walls yet. Create one in Admin.</p>}
        {sortWalls.map((wall) => {
          const wallHoles = holes.filter((h) => h.sort_wall_id === wall.id);
          return (
            <div className="admin-wall-group" key={wall.id}>
              <div className="admin-wall-group-head">
                <div className="wall-heading-row">
                  <h3>{wall.name}</h3>
                  {wall.delivery_mode && (
                    <span className={`state-pill ${wall.delivery_mode === 'LMS' ? 'tone-info' : 'tone-attention'}`}>
                      {wall.delivery_mode}
                    </span>
                  )}
                  <small className="admin-wall-count">{wallHoles.length} hole(s)</small>
                </div>
                <button type="button" className="secondary-button" onClick={() => void deleteWall(wall)}>
                  Delete wall
                </button>
              </div>
              {wallHoles.length === 0 ? (
                <p className="hint">No holes on this wall yet.</p>
              ) : (
                <div className="admin-hole-grid">
                  {wallHoles.map((hole) => (
                    <div className="admin-hole-row" key={hole.id}>
                      <span>
                        <strong>{hole.hole_number}</strong>
                        <span className="admin-hole-meta">
                          <StatusPill meta={holeStatusMeta(hole.status)} />
                          <small>{hole.bag_capacity ?? configuration?.bags_per_pigeon_hole ?? 0} bags</small>
                        </span>
                      </span>
                      <span className="admin-hole-actions">
                        <button
                          type="button"
                          className="icon-button"
                          aria-label={`Show QR code for pigeon hole ${hole.hole_number}`}
                          onClick={() => void viewHoleQr(hole)}
                        >
                          <EyeIcon />
                        </button>
                        <button
                          type="button"
                          className="icon-button icon-button-danger"
                          aria-label={`Delete pigeon hole ${hole.hole_number}`}
                          onClick={() => void deleteHole(hole)}
                        >
                          <TrashIcon />
                        </button>
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
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
