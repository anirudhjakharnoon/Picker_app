import { createContext, useContext } from 'react';
import type { Session } from '@supabase/supabase-js';
import type { Profile } from '../types/database';

export interface AuthContextValue {
  session: Session | null;
  profile: Profile | null;
  loading: boolean;
  error: string | null;
  /**
   * True while a profile load is retrying after a transient Supabase error
   * (e.g. PGRST002 "schema cache" hiccups). The UI can use this to show a
   * "still trying to connect" hint instead of a dead-end error message.
   */
  retrying: boolean;
  signInWithPassword: (email: string, password: string) => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
  refreshProfile: () => Promise<void>;
  /**
   * Applies a local, optimistic patch to the in-memory profile (e.g. flipping
   * `is_online` the instant a toggle is tapped) without waiting for the RPC
   * round trip. Callers are responsible for reconciling with
   * `refreshProfile()` once the underlying write settles — this is purely a
   * UI-responsiveness aid, never a security boundary (RLS/RPCs still enforce
   * the real write).
   */
  patchProfile: (patch: Partial<Profile>) => void;
}

export const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within an AuthProvider');
  return context;
}
