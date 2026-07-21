import { createContext, useContext } from 'react';
import type { Session } from '@supabase/supabase-js';
import type { Profile } from '../types/database';

export interface AuthContextValue {
  session: Session | null;
  profile: Profile | null;
  loading: boolean;
  error: string | null;
  signInWithPassword: (email: string, password: string) => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
  refreshProfile: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within an AuthProvider');
  return context;
}
