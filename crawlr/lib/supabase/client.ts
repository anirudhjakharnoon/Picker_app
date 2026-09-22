"use client";

/**
 * Browser Supabase client. Uses the anon key only - RLS is what keeps every
 * anonymous identity scoped to its own rows. Session is persisted via
 * cookies (through @supabase/ssr) so server Route Handlers can read the
 * same session and enforce RLS as the calling user too.
 */

import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../types";
import { getSupabaseAnonKey, getSupabaseUrl } from "./env";

let browserClient: SupabaseClient<Database> | undefined;

export function getSupabaseBrowserClient(): SupabaseClient<Database> {
  if (!browserClient) {
    browserClient = createBrowserClient<Database>(getSupabaseUrl(), getSupabaseAnonKey());
  }
  return browserClient;
}

/**
 * Ensures the browser has an anonymous session, signing in if needed. Safe
 * to call on every page load - it's a no-op once a session exists.
 */
export async function ensureAnonymousSession(): Promise<string | null> {
  const supabase = getSupabaseBrowserClient();
  const { data: sessionData } = await supabase.auth.getSession();
  if (sessionData.session) {
    return sessionData.session.user.id;
  }
  const { data, error } = await supabase.auth.signInAnonymously();
  if (error) {
    console.error("Anonymous sign-in failed:", error.message);
    return null;
  }
  return data.user?.id ?? null;
}
