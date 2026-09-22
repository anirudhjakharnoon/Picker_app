"use client";

import { useEffect, useState } from "react";
import { ensureAnonymousSession } from "../supabase/client";

export interface AnonymousSessionState {
  userId: string | null;
  ready: boolean;
}

/** Bootstraps (and quietly reuses) an anonymous Supabase session on mount. */
export function useAnonymousSession(): AnonymousSessionState {
  const [state, setState] = useState<AnonymousSessionState>({ userId: null, ready: false });

  useEffect(() => {
    let cancelled = false;
    ensureAnonymousSession().then((userId) => {
      if (!cancelled) setState({ userId, ready: true });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
