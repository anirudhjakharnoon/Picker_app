import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, EventKind } from "./types";

/**
 * Appends one row to crawl_events. Always uses the service-role client
 * (the tick worker is the only writer - crawl_events has no client INSERT
 * policy, only a "job belongs to me" SELECT policy for the live log UI).
 */
export async function logEvent(
  supabase: SupabaseClient<Database>,
  jobId: string,
  kind: EventKind,
  message: string,
): Promise<void> {
  const { error } = await supabase.from("crawl_events").insert({ job_id: jobId, kind, message });
  if (error) {
    // Never let a logging failure abort the crawl itself.
    console.error(`Failed to log crawl_event for job ${jobId}:`, error.message);
  }
}
