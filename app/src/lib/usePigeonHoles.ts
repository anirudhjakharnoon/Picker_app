import { useCallback, useEffect, useState } from 'react';
import { supabase } from './supabaseClient';
import type { PigeonHole, SortWall } from '../types/database';

// Explicit column lists rather than `*`, for the same reason as useOrders:
// stable payloads as the tables gain columns, and no bytes shipped that no
// screen reads. Both tables are bounded by physical wall size, so unlike
// `orders` they need no row-count bound.
const HOLE_COLUMNS = [
  'id', 'sort_wall_id', 'hole_number', 'qr_code_id', 'status',
  'priority_reserved', 'bag_capacity', 'held_by_picker_id', 'held_at',
  'created_at', 'updated_at',
].join(',');

const WALL_COLUMNS = [
  'id', 'warehouse_id', 'name', 'rows', 'columns', 'status',
  'delivery_mode', 'created_at', 'updated_at',
].join(',');

export function usePigeonHoles() {
  const [holes, setHoles] = useState<PigeonHole[]>([]);
  const [sortWalls, setSortWalls] = useState<SortWall[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    const [holesRes, wallsRes] = await Promise.all([
      supabase.from('pigeon_holes').select(HOLE_COLUMNS).order('hole_number', { ascending: true }),
      supabase.from('sort_walls').select(WALL_COLUMNS),
    ]);

    if (holesRes.error) setError(holesRes.error.message);
    else setError(null);

    setHoles((holesRes.data as unknown as PigeonHole[]) ?? []);
    setSortWalls((wallsRes.data as unknown as SortWall[]) ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    void refetch();

    const channel = supabase
      .channel('pigeon-holes-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'pigeon_holes' }, (payload) => {
        const row = (payload.new ?? payload.old) as unknown as PigeonHole;
        if (!row?.id) return;
        setHoles((current) => {
          if (payload.eventType === 'DELETE') return current.filter((hole) => hole.id !== row.id);
          return [...current.filter((hole) => hole.id !== row.id), row].sort((a, b) =>
            a.hole_number.localeCompare(b.hole_number)
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

  return { holes, sortWalls, loading, error, refetch };
}
