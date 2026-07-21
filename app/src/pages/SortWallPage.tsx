import { useEffect, useMemo, useState } from 'react';
import { usePigeonHoles } from '../lib/usePigeonHoles';
import { useOrders } from '../lib/useOrders';
import { supabase } from '../lib/supabaseClient';
import { WarehouseGateQr } from '../components/WarehouseGateQr';
import { useAuth } from '../auth/AuthContext';
import type { PigeonHoleStatus, Warehouse } from '../types/database';

const STATUS_LABEL: Record<PigeonHoleStatus, string> = {
  free: 'Free',
  reserved: 'Reserved',
  partially_filled: 'Partially filled',
  filled: 'Ready for pickup',
  out_of_service: 'Out of service',
};

export function SortWallPage() {
  const { profile } = useAuth();
  const { holes, sortWalls, refetch: refetchHoles } = usePigeonHoles();
  const { orders, refetch: refetchOrders } = useOrders();
  const [holeOrderIds, setHoleOrderIds] = useState<Map<string, string>>(new Map());
  const [busyHole, setBusyHole] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const notify = (msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 4000);
  };

  const orderByHoleId = useMemo(() => {
    const map = new Map<string, typeof orders[number]>();
    holeOrderIds.forEach((orderId, holeId) => {
      const order = orders.find((candidate) => candidate.id === orderId);
      if (order) map.set(holeId, order);
    });
    orders.forEach((o) => {
      // Legacy/migration-backfill fallback for orders assigned before the
      // multi-hole model. New allocations use pigeon_hole_assignments.
      if (o.pigeon_hole_id && !map.has(o.pigeon_hole_id)) map.set(o.pigeon_hole_id, o);
    });
    return map;
  }, [orders, holeOrderIds]);

  useEffect(() => {
    let cancelled = false;
    const loadAssignments = async () => {
      const { data } = await supabase
        .from('pigeon_hole_assignments')
        .select('order_id, pigeon_hole_id, status')
        .in('status', ['reserved', 'active']);
      if (cancelled) return;
      setHoleOrderIds(
        new Map(
          ((data as { order_id: string; pigeon_hole_id: string }[] | null) ?? []).map((assignment) => [
            assignment.pigeon_hole_id,
            assignment.order_id,
          ])
        )
      );
    };
    void loadAssignments();
    return () => {
      cancelled = true;
    };
  }, [holes, orders]);

  const dispatchOrder = async (orderId: string) => {
    setBusyHole(orderId);
    const { error } = await supabase.rpc('mark_order_dispatched_v1', {
      p_order_id: orderId,
      p_reason: 'Delivery partner collected (manual, free MVP)',
    });
    setBusyHole(null);
    if (error) notify(`Could not mark dispatched: ${error.message}`);
    else {
      notify('Order dispatched. Hole freed.');
      void refetchHoles();
      void refetchOrders();
    }
  };

  const toggleOutOfService = async (holeId: string, currentlyOut: boolean) => {
    setBusyHole(holeId);
    const rpc = currentlyOut ? 'restore_pigeon_hole_v1' : 'mark_hole_out_of_service_v1';
    const args = currentlyOut ? { p_pigeon_hole_id: holeId } : { p_pigeon_hole_id: holeId, p_reason: 'Marked out of service by warehouse staff' };
    const { error } = await supabase.rpc(rpc, args);
    setBusyHole(null);
    if (error) notify(`Action failed: ${error.message}`);
    else {
      notify(currentlyOut ? 'Hole restored to free.' : 'Hole marked out of service.');
      void refetchHoles();
    }
  };

  const exceptionOrders = orders.filter((o) => o.status.startsWith('exception_'));
  const freeCount = holes.filter((hole) => hole.status === 'free').length;
  const inUseCount = holes.filter((hole) =>
    ['reserved', 'partially_filled'].includes(hole.status)
  ).length;
  const readyCount = holes.filter((hole) => hole.status === 'filled').length;
  const unavailableCount = holes.filter((hole) => hole.status === 'out_of_service').length;

  return (
    <div className="sort-wall-screen">
      {toast && <div className="toast">{toast}</div>}

      <header className="panel-heading">
        <div>
          <span className="panel-eyebrow">Warehouse operations</span>
          <h1>Sort Wall</h1>
          <p>Live capacity, exceptions, and delivery handoffs at a glance.</p>
        </div>
      </header>

      {profile?.warehouse_id && (
        <WarehouseQrForStaff warehouseId={profile.warehouse_id} />
      )}

      <div className="wall-summary" aria-label="Sort wall capacity summary">
        <div className="wall-summary-card">
          <strong>{freeCount}</strong>
          <span>Free holes</span>
        </div>
        <div className="wall-summary-card">
          <strong>{inUseCount}</strong>
          <span>Being filled</span>
        </div>
        <div className="wall-summary-card">
          <strong>{readyCount}</strong>
          <span>Ready for pickup</span>
        </div>
        <div className="wall-summary-card">
          <strong>{unavailableCount}</strong>
          <span>Out of service</span>
        </div>
      </div>

      <section>
        <h2>Exceptions</h2>
        {exceptionOrders.length === 0 && <p className="empty-state">No stuck orders. Nice.</p>}
        {exceptionOrders.map((o) => (
          <div key={o.id} className="order-card exception">
            <strong>{o.external_order_ref}</strong>
            <div>{o.status.replace(/_/g, ' ')}</div>
          </div>
        ))}
      </section>

      {sortWalls.map((wall) => (
        <section key={wall.id}>
          <h2>{wall.name}</h2>
          <div className="pigeon-hole-grid">
            {holes
              .filter((h) => h.sort_wall_id === wall.id)
              .map((hole) => {
                const order = orderByHoleId.get(hole.id);
                return (
                  <div key={hole.id} className={`pigeon-hole pigeon-hole-${hole.status}`}>
                    <div className="pigeon-hole-number">{hole.hole_number}</div>
                    <div className="pigeon-hole-status">{STATUS_LABEL[hole.status]}</div>
                    {order && (
                      <div className="pigeon-hole-order">
                        {order.external_order_ref}
                        <br />
                        {order.bag_count_scanned_sort}/{order.bag_count_expected} bags
                      </div>
                    )}
                    {order && order.status === 'ready_for_dispatch' && (
                      <button type="button" disabled={busyHole === order.id} onClick={() => dispatchOrder(order.id)}>
                        Mark collected
                      </button>
                    )}
                    <button
                      type="button"
                      className="link-button"
                      disabled={busyHole === hole.id}
                      onClick={() => toggleOutOfService(hole.id, hole.status === 'out_of_service')}
                    >
                      {hole.status === 'out_of_service' ? 'Restore' : 'Mark out of service'}
                    </button>
                  </div>
                );
              })}
          </div>
        </section>
      ))}
    </div>
  );
}

function WarehouseQrForStaff({ warehouseId }: { warehouseId: string }) {
  const [warehouse, setWarehouse] = useState<Warehouse | null>(null);

  useEffect(() => {
    void supabase
      .from('warehouses')
      .select('*')
      .eq('id', warehouseId)
      .maybeSingle()
      .then(({ data }) => setWarehouse(data as unknown as Warehouse | null));
  }, [warehouseId]);

  return warehouse ? <WarehouseGateQr warehouse={warehouse} /> : null;
}
