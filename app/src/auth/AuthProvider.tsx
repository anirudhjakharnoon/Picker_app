import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '../lib/supabaseClient';
import type { Profile } from '../types/database';
import { AuthContext } from './AuthContext';
import { humanizeAuthError, isRetryableAuthError } from '../lib/authErrors';
import { withAbortTimeout } from '../lib/rpcTimeout';

// A transient PostgREST/Supabase hiccup (e.g. PGRST002 "Could not query the
// database for the schema cache") should not permanently strand a user on an
// error screen, so one burst of attempts with backoff is worth it.
//
// But when the database is genuinely DOWN rather than blipping, retrying is
// actively harmful: it cannot succeed, it burns request quota, and it keeps
// load on an instance that needs headroom to recover. An earlier version of
// this file had a burst but no limit ACROSS bursts, and every auth event
// (token refresh, tab focus, re-mount) started a fresh one. Against a project
// returning 503s that produced a sustained ~5-6 requests/second for the same
// profile row - over a million failed requests in under an hour.
//
// So: short burst, then a hard stop. After MAX_CONSECUTIVE_FAILED_BURSTS the
// breaker opens and NOTHING retries automatically again until the user asks,
// via the Try again button on BackendUnavailablePage.
const PROFILE_LOAD_RETRY_DELAYS_MS = [800, 2500];
const MAX_CONSECUTIVE_FAILED_BURSTS = 2;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [autoRetryPaused, setAutoRetryPaused] = useState(false);
  const loadProfileGenerationRef = useRef(0);
  // Single-flight: concurrent callers share one in-flight load instead of each
  // starting their own burst. Without this, several auth events arriving inside
  // one round-trip each added a parallel burst.
  const inFlightRef = useRef<Promise<void> | null>(null);
  const consecutiveFailedBurstsRef = useRef(0);
  // Mirrored as a ref so loadProfile can read the breaker WITHOUT taking
  // `autoRetryPaused` as a dependency. If it did, loadProfile's identity would
  // change whenever the breaker flipped, which would re-run the effect below -
  // re-subscribing onAuthStateChange and re-calling getSession each time. That
  // is its own retry loop, and exactly the class of bug this file is fixing.
  const autoRetryPausedRef = useRef(false);

  const runProfileLoad = useCallback(async (userId: string) => {
    const generation = ++loadProfileGenerationRef.current;
    const isStale = () => generation !== loadProfileGenerationRef.current;

    for (let attempt = 0; attempt <= PROFILE_LOAD_RETRY_DELAYS_MS.length; attempt += 1) {
      // Bounded and cancellable: an abandoned request that keeps running can
      // leave PostgREST holding a pooled connection mid-transaction (see
      // withAbortTimeout), and a starved pool is what takes the whole REST
      // layer down while the database itself stays healthy.
      const { data, error: profileError } = await withAbortTimeout((signal) =>
        supabase.from('profiles').select('*').eq('id', userId).abortSignal(signal).single(),
      ).catch((err: unknown) => ({
        data: null,
        error: { message: err instanceof Error ? err.message : 'Request failed' },
      }));

      if (isStale()) return; // a newer call (e.g. sign-out, re-sign-in) superseded this one

      if (!profileError) {
        consecutiveFailedBurstsRef.current = 0;
        autoRetryPausedRef.current = false;
        setProfile(data as unknown as Profile);
        setError(null);
        setRetrying(false);
        setAutoRetryPaused(false);
        return;
      }

      const attemptsRemaining = attempt < PROFILE_LOAD_RETRY_DELAYS_MS.length;
      if (!isRetryableAuthError(profileError.message) || !attemptsRemaining) {
        // This burst failed. Count it, and once enough have failed in a row,
        // stop retrying on our own initiative entirely.
        consecutiveFailedBurstsRef.current += 1;
        const paused = consecutiveFailedBurstsRef.current >= MAX_CONSECUTIVE_FAILED_BURSTS;
        autoRetryPausedRef.current = paused;
        setError(humanizeAuthError(profileError.message));
        setProfile(null);
        setRetrying(false);
        setAutoRetryPaused(paused);
        return;
      }

      setRetrying(true);
      await delay(PROFILE_LOAD_RETRY_DELAYS_MS[attempt]);
      if (isStale()) return;
    }
  }, []);

  /**
   * @param force set by the user's explicit "Try again" - resets the breaker.
   *   Automatic callers (initial load, auth events) pass nothing and are
   *   refused once the breaker is open.
   */
  const loadProfile = useCallback(
    async (userId: string, force = false): Promise<void> => {
      if (force) {
        consecutiveFailedBurstsRef.current = 0;
        autoRetryPausedRef.current = false;
        setAutoRetryPaused(false);
      } else if (autoRetryPausedRef.current) {
        return; // breaker open: only a manual retry gets through
      }

      if (inFlightRef.current) return inFlightRef.current;

      const run = runProfileLoad(userId).finally(() => {
        inFlightRef.current = null;
      });
      inFlightRef.current = run;
      return run;
    },
    [runProfileLoad],
  );

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

  // Always forces: this is only reached from a deliberate user action (the Try
  // again button, or a post-write reconcile), so it resets the breaker.
  const refreshProfile = useCallback(async () => {
    if (session) {
      await loadProfile(session.user.id, true);
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
        autoRetryPaused,
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
