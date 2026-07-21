import { useCallback, useEffect, useState } from 'react';
import { supabase } from './supabaseClient';
import type { Order } from '../types/database';

/**
 * Loads orders visible to the current user (RLS already scopes this to
 * "my assigned orders + unassigned available offers" for a picker, or
 * "my warehouse's orders" for warehouse/ops/admin roles — Section 11.6).
 *
 * Combines a Supabase Realtime subscription (fast path) with periodic
 * refetch (source-of-truth fallback) per docs Section 8.4: Realtime is an
 * acceleration mechanism here, never trusted as the sole source of state.
 */
export function useOrders(pollMs = 15000) {
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
      .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, () => {
        void refetch();
      })
      .subscribe();

    const interval = window.setInterval(() => void refetch(), pollMs);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refetch();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      void supabase.removeChannel(channel);
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refetch, pollMs]);

  return { orders, loading, error, refetch };
}
