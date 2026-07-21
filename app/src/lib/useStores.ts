import { useEffect, useState } from 'react';
import { supabase } from './supabaseClient';
import type { Store } from '../types/database';

/**
 * Loads the stores the current user can see (RLS allows pickers/warehouse
 * roles to read stores) and exposes a fast id -> display name lookup so the
 * Picker queue can show "Pickup from DC: Buffalo Burger" instead of a raw id.
 */
export function useStoreNames() {
  const [byId, setById] = useState<Record<string, string>>({});

  useEffect(() => {
    let mounted = true;
    void supabase
      .from('stores')
      .select('id, name')
      .then(({ data }) => {
        if (!mounted || !data) return;
        const map: Record<string, string> = {};
        (data as Pick<Store, 'id' | 'name'>[]).forEach((s) => {
          map[s.id] = s.name;
        });
        setById(map);
      });
    return () => {
      mounted = false;
    };
  }, []);

  return byId;
}
