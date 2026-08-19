import { useCallback, useEffect, useState } from 'react';
import { supabase } from './supabaseClient';
import type { Order } from '../types/database';

// Explicit column list rather than `*`: it keeps the payload stable when the
// table gains columns, and avoids shipping bytes no screen reads.
const ORDER_COLUMNS = [
  'id', 'store_id', 'external_order_ref',
  'bag_count_expected', 'bag_count_scanned_pickup', 'bag_count_scanned_sort',
  'store_floor', 'store_zone', 'store_address',
  'qr_mode', 'shared_bag_qr_code_id', 'status',
  'assigned_picker_id', 'warehouse_id', 'sort_wall_id', 'pigeon_hole_id',
  'priority', 'is_fragile', 'delivery_mode', 'assignment_source',
  'packed_ready_at', 'ingested_at', 'assigned_at', 'picked_at',
  'warehouse_arrived_at', 'sorted_at', 'dispatched_at', 'completed_at',
  'created_at', 'updated_at',
].join(',');

// Statuses past which an order is finished and no screen needs it in the live
// list. Orders in these states are still fetched for a short window after their
// last change, so an order a picker has only just completed cannot vanish from
// under them mid-flow.
const TERMINAL_STATUSES = ['completed', 'dispatched', 'cancelled'] as const;
const TERMINAL_RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * Loads the orders the current user needs to act on (RLS already scopes this to
 * "my assigned orders" for a picker, or "my warehouse's orders" for
 * warehouse/ops/admin roles — Section 11.6).
 *
 * One initial fetch, then Supabase Realtime row deltas applied locally, with a
 * refetch on tab-focus as the reconciliation path. An earlier version polled a
 * full `select('*')` every 15 seconds and refetched on every Realtime event,
 * which amplified reads as every picker saw every other picker's scans.
 *
 * The fetch is bounded to live work (Section 11.6.4): unbounded `select *` made
 * the cost of opening the app grow with all history ever recorded, which for an
 * admin means the entire orders table on every mount and every tab-focus.
 */
export function useOrders() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    // Bounded on the server, not the client. Unbounded `select *` meant an
    // admin (whom RLS scopes to every order) refetched the whole table on
    // every mount and every tab-focus, so the cost of opening the app grew
    // with all history ever recorded. `orders_live_ingested_idx` in migration
    // 0024 is a partial index over exactly the non-terminal rows, so this stays
    // proportional to open work instead.
    const since = new Date(Date.now() - TERMINAL_RETENTION_MS).toISOString();
    const { data, error: fetchError } = await supabase
      .from('orders')
      .select(ORDER_COLUMNS)
      .or(`status.not.in.(${TERMINAL_STATUSES.join(',')}),updated_at.gt.${since}`)
      .order('ingested_at', { ascending: true });

    if (fetchError) {
      setError(fetchError.message);
    } else {
      setError(null);
      setOrders((data as unknown as Order[]) ?? []);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void refetch();

    const channel = supabase
      .channel('orders-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, (payload) => {
        const row = (payload.new ?? payload.old) as unknown as Order;
        if (!row?.id) return;
        setOrders((current) => {
          if (payload.eventType === 'DELETE') return current.filter((order) => order.id !== row.id);
          const withoutRow = current.filter((order) => order.id !== row.id);
          return [...withoutRow, row].sort(
            (a, b) => new Date(a.ingested_at).getTime() - new Date(b.ingested_at).getTime()
          );
        });
      })
      .subscribe();

    const onVisible = () => {
      if (document.visibilityState === 'visible') void refetch();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      void supabase.removeChannel(channel);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refetch]);

  return { orders, loading, error, refetch };
}
