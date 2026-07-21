import { useCallback, useEffect, useState } from 'react';
import { supabase } from './supabaseClient';
import type { Order } from '../types/database';

/**
 * Loads orders visible to the current user (RLS already scopes this to
 * "my assigned orders + unassigned available offers" for a picker, or
 * "my warehouse's orders" for warehouse/ops/admin roles — Section 11.6).
 *
 * Uses one initial fetch and applies Supabase Realtime row deltas locally.
 * The previous implementation combined a full `select('*')` every 15 seconds
 * with a full refetch on every Realtime event and explicit post-action
 * refetches. That created substantial read amplification as every picker saw
 * each other pick/scan an order. Row deltas keep the live UI without repeated
 * full-table reads; a visibility refetch remains as a reconciliation path.
 */
export function useOrders() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    const { data, error: fetchError } = await supabase
      .from('orders')
      .select('*')
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
