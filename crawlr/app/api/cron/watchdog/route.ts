import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { isAuthorizedInternalRequest, internalAuthHeaders } from "@/lib/internalAuth";
import { getSiteUrl } from "@/lib/supabase/env";
import { WATCHDOG_STALL_THRESHOLD_MS } from "@/lib/constants";
import type { CrawlJobRow } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Runs every minute (see vercel.json - Vercel Cron's finest granularity).
 * Finds every 'running' job whose most recent activity (last_ticked_at,
 * falling back to started_at/created_at for a job whose very first tick
 * never landed) is older than WATCHDOG_STALL_THRESHOLD_MS, and re-invokes
 * its tick. This is what guarantees forward progress even if a tick's own
 * self-fetch continuation is ever dropped (a killed invocation, a network
 * blip, a cold-start timeout).
 */
export async function GET(request: Request): Promise<Response> {
  if (!isAuthorizedInternalRequest(request)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const supabase = createServiceRoleClient();
  const { data: runningRaw } = await supabase.from("crawl_jobs").select("*").eq("status", "running");
  const running = (runningRaw as CrawlJobRow[] | null) ?? [];

  const cutoff = Date.now() - WATCHDOG_STALL_THRESHOLD_MS;
  const stalled = running.filter((job) => {
    const lastActivity = job.last_ticked_at ?? job.started_at ?? job.created_at;
    return new Date(lastActivity).getTime() < cutoff;
  });

  const siteUrl = getSiteUrl();
  const results = await Promise.allSettled(
    stalled.map((job) =>
      fetch(`${siteUrl}/api/jobs/${job.id}/tick`, {
        method: "POST",
        headers: internalAuthHeaders(),
      }),
    ),
  );

  return NextResponse.json({
    runningJobs: running.length,
    stalledJobs: stalled.length,
    reInvoked: results.filter((r) => r.status === "fulfilled").length,
  });
}
