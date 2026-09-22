import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { isAuthorizedInternalRequest } from "@/lib/internalAuth";
import { EXPORTS_BUCKET, RETENTION_WINDOW_MS } from "@/lib/constants";
import type { CrawlJobRow } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Runs hourly (see vercel.json). Deletes Storage exports and DB rows for
 * jobs older than RETENTION_WINDOW_MS (data minimization: no binary media
 * is ever stored, and even the small Markdown exports don't outlive the
 * retention window). Deleting a crawl_jobs row cascades to crawl_queue,
 * crawl_pages, crawl_assets, and crawl_events via their `on delete cascade`
 * foreign keys - one DELETE cleans up everything for that job. Also prunes
 * expired robots_cache rows, which have their own independent TTL.
 */
export async function GET(request: Request): Promise<Response> {
  if (!isAuthorizedInternalRequest(request)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const supabase = createServiceRoleClient();
  const cutoffIso = new Date(Date.now() - RETENTION_WINDOW_MS).toISOString();

  const { data: expiredRaw } = await supabase
    .from("crawl_jobs")
    .select("id, md_storage_path")
    .lt("created_at", cutoffIso);
  const expired = (expiredRaw as Pick<CrawlJobRow, "id" | "md_storage_path">[] | null) ?? [];

  const storagePaths = expired.map((j) => j.md_storage_path).filter((p): p is string => Boolean(p));
  if (storagePaths.length > 0) {
    await supabase.storage.from(EXPORTS_BUCKET).remove(storagePaths);
  }

  if (expired.length > 0) {
    await supabase
      .from("crawl_jobs")
      .delete()
      .in(
        "id",
        expired.map((j) => j.id),
      );
  }

  const nowIso = new Date().toISOString();
  const { data: expiredRobotsRaw } = await supabase
    .from("robots_cache")
    .select("domain")
    .lt("expires_at", nowIso);
  const expiredRobotsDomains = ((expiredRobotsRaw as { domain: string }[] | null) ?? []).map((r) => r.domain);
  if (expiredRobotsDomains.length > 0) {
    await supabase.from("robots_cache").delete().in("domain", expiredRobotsDomains);
  }

  return NextResponse.json({
    jobsDeleted: expired.length,
    storageObjectsDeleted: storagePaths.length,
    robotsCacheRowsDeleted: expiredRobotsDomains.length,
  });
}
