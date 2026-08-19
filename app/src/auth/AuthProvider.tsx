import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '../lib/supabaseClient';
import type { Profile } from '../types/database';
import { AuthContext } from './AuthContext';
import { humanizeAuthError, isRetryableAuthError } from '../lib/authErrors';

// A transient PostgREST/Supabase hiccup (e.g. PGRST002 "Could not query the
// database for the schema cache") should not permanently strand a user on an
// error screen. Retry a few times with backoff before surfacing anything.
const PROFILE_LOAD_RETRY_DELAYS_MS = [500, 1500, 3000, 5000];

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const loadProfileGenerationRef = useRef(0);

  const loadProfile = useCallback(async (userId: string) => {
    const generation = ++loadProfileGenerationRef.current;
    const isStale = () => generation !== loadProfileGenerationRef.current;

    for (let attempt = 0; attempt <= PROFILE_LOAD_RETRY_DELAYS_MS.length; attempt += 1) {
      const { data, error: profileError } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', userId)
        .single();

      if (isStale()) return; // a newer call (e.g. sign-out, re-sign-in) superseded this one

      if (!profileError) {
        setProfile(data as unknown as Profile);
        setError(null);
        setRetrying(false);
        return;
      }

      const attemptsRemaining = attempt < PROFILE_LOAD_RETRY_DELAYS_MS.length;
      if (!isRetryableAuthError(profileError.message) || !attemptsRemaining) {
        setError(humanizeAuthError(profileError.message));
        setProfile(null);
        setRetrying(false);
        return;
      }

      setRetrying(true);
      await delay(PROFILE_LOAD_RETRY_DELAYS_MS[attempt]);
      if (isStale()) return;
    }
  }, []);

  useEffect(() => {
    let mounted = true;

    supabase.auth.getSession().then(({ data }) => {
      if (!mounted) return;
      setSession(data.session);
      if (data.session) {
        void loadProfile(data.session.user.id).finally(() => setLoading(false));
      } else {
        setLoading(false);
      }
    });

    const { data: subscription } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
      if (newSession) {
        void loadProfile(newSession.user.id);
      } else {
        setProfile(null);
      }
    });

    return () => {
      mounted = false;
      subscription.subscription.unsubscribe();
    };
  }, [loadProfile]);

  const signInWithPassword = useCallback(async (email: string, password: string) => {
    setError(null);
    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
    if (signInError) {
      // A gateway-level failure (e.g. a 521 with no CORS headers on the error
      // response) reaches us as a bare "Failed to fetch", which reads as a
      // rejected login. Humanising it keeps "wrong login code" and "the server
      // is unreachable" distinguishable on the sign-in screen.
      const message = humanizeAuthError(signInError.message);
      setError(message);
      return { error: message };
    }
    return { error: null };
  }, []);

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
    setProfile(null);
    setSession(null);
  }, []);

  const refreshProfile = useCallback(async () => {
    if (session) {
      await loadProfile(session.user.id);
    }
  }, [session, loadProfile]);

  const patchProfile = useCallback((patch: Partial<Profile>) => {
    setProfile((prev) => (prev ? { ...prev, ...patch } : prev));
  }, []);

  return (
    <AuthContext.Provider
      value={{
        session,
        profile,
        loading,
        error,
        retrying,
        signInWithPassword,
        signOut,
        refreshProfile,
        patchProfile,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}
