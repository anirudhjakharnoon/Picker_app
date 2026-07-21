import { useCallback, useEffect, useState } from 'react';
import { supabase } from './supabaseClient';
import type { PigeonHole, SortWall } from '../types/database';

export function usePigeonHoles(pollMs = 10000) {
  const [holes, setHoles] = useState<PigeonHole[]>([]);
  const [sortWalls, setSortWalls] = useState<SortWall[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    const [holesRes, wallsRes] = await Promise.all([
      supabase.from('pigeon_holes').select('*').order('hole_number', { ascending: true }),
      supabase.from('sort_walls').select('*'),
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
      .on('postgres_changes', { event: '*', schema: 'public', table: 'pigeon_holes' }, () => {
        void refetch();
      })
      .subscribe();

    const interval = window.setInterval(() => void refetch(), pollMs);
    return () => {
      void supabase.removeChannel(channel);
      window.clearInterval(interval);
    };
  }, [refetch, pollMs]);

  return { holes, sortWalls, loading, error, refetch };
}
