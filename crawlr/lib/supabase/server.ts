/**
 * Server-side Supabase clients.
 *
 * Two flavors, used deliberately for different trust boundaries:
 *
 *  - `createRouteHandlerClient()`: uses the ANON key + the caller's own
 *    session cookies (via @supabase/ssr). Every Postgrest call through this
 *    client is subject to RLS as *that specific user*. Use this for any
 *    route that acts on behalf of the end user (creating a job, checking
 *    their own rate limit, verifying they own a job before returning a
 *    signed export URL, aborting their own job).
 *
 *  - `createServiceRoleClient()`: uses the SERVICE ROLE key, which bypasses
 *    RLS entirely. Use this ONLY for trusted, server-to-server internal
 *    work where the route itself is the security boundary and has already
 *    established which job it's operating on (the tick worker, the
 *    watchdog/cleanup crons, and Storage signed-URL minting). Never let
 *    unvalidated client input reach a service-role query without an
 *    explicit application-level ownership/id check first.
 */

import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import type { Database } from "../types";
import { getSupabaseAnonKey, getSupabaseServiceRoleKey, getSupabaseUrl } from "./env";

interface CookieToSet {
  name: string;
  value: string;
  options: CookieOptions;
}

export function createRouteHandlerClient(): SupabaseClient<Database> {
  const cookieStore = cookies();
  return createServerClient<Database>(getSupabaseUrl(), getSupabaseAnonKey(), {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet: CookieToSet[]) {
        for (const { name, value, options } of cookiesToSet) {
          try {
            cookieStore.set(name, value, options);
          } catch {
            // Route Handlers running in some contexts (e.g. after the
            // response has started streaming) can't mutate cookies - safe
            // to ignore, the session cookie was already set by the client.
          }
        }
      },
    },
  });
}

let serviceRoleClient: SupabaseClient<Database> | null = null;

export function createServiceRoleClient(): SupabaseClient<Database> {
  if (!serviceRoleClient) {
    serviceRoleClient = createClient<Database>(getSupabaseUrl(), getSupabaseServiceRoleKey(), {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return serviceRoleClient;
}

/** Returns the authenticated user's id from the route's own session, or null. */
export async function getSessionUserId(
  supabase: SupabaseClient<Database>,
): Promise<string | null> {
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;
  return data.user.id;
}
