import { NextResponse } from "next/server";
import {
  createRouteHandlerClient,
  createServiceRoleClient,
  getSessionUserId,
} from "@/lib/supabase/server";
import { getRobotsRules } from "@/lib/robots";
import { fetchSitemapUrls } from "@/lib/sitemap";
import { normalizeUrl } from "@/lib/extract";
import { registrableDomain } from "@/lib/domain";
import { isSyntacticallySafeUrl } from "@/lib/ssrf";
import { internalAuthHeaders } from "@/lib/internalAuth";
import { getSiteUrl } from "@/lib/supabase/env";
import {
  buildUserAgent,
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_PAGES,
  DEFAULT_RATE_LIMIT_RPS,
  JOB_CREATION_MAX_PER_WINDOW,
  JOB_CREATION_WINDOW_SECONDS,
  MAX_DEPTH_HARD_CAP,
  MAX_PAGES_HARD_CAP,
} from "@/lib/constants";
import { clampRatePerSecond } from "@/lib/rateLimiter";
import { clampInt, isNonEmptyString, isValidContentTypes, isValidScope } from "@/lib/validation";
import type { ContentType, CrawlScope, JobQuotaResult } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface CreateJobBody {
  url?: unknown;
  scope?: unknown;
  contentTypes?: unknown;
  maxPages?: unknown;
  maxDepth?: unknown;
  rateLimitRps?: unknown;
  ackPermission?: unknown;
}

export async function POST(request: Request): Promise<Response> {
  const routeClient = createRouteHandlerClient();
  const userId = await getSessionUserId(routeClient);
  if (!userId) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }

  let body: CreateJobBody;
  try {
    body = (await request.json()) as CreateJobBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (body.ackPermission !== true) {
    return NextResponse.json(
      { error: "You must acknowledge that you have the right to crawl this target." },
      { status: 400 },
    );
  }

  const { url, scope, contentTypes } = body;
  if (!isNonEmptyString(url) || !isSyntacticallySafeUrl(url)) {
    return NextResponse.json({ error: "Missing or invalid 'url'." }, { status: 400 });
  }
  if (!isValidScope(scope)) {
    return NextResponse.json({ error: "'scope' must be one of: page, linked, site." }, { status: 400 });
  }
  if (!isValidContentTypes(contentTypes)) {
    return NextResponse.json(
      { error: "'contentTypes' must be a non-empty subset of: text, images, video." },
      { status: 400 },
    );
  }

  // Postgres-enforced, atomic, per-owner job-creation throttle.
  const { data: quotaRows, error: quotaError } = await routeClient.rpc("try_consume_job_quota", {
    p_owner: userId,
    p_max_jobs: JOB_CREATION_MAX_PER_WINDOW,
    p_window_seconds: JOB_CREATION_WINDOW_SECONDS,
  });
  if (quotaError) {
    return NextResponse.json({ error: "Failed to check rate limit." }, { status: 500 });
  }
  const quota = (quotaRows as JobQuotaResult[] | null)?.[0];
  if (!quota?.allowed) {
    return NextResponse.json(
      { error: "You've created too many jobs recently. Please try again later." },
      { status: 429, headers: { "Retry-After": String(quota?.retry_after_seconds ?? 60) } },
    );
  }

  const targetUrl = url.trim();
  const rootDomain = registrableDomain(targetUrl) ?? new URL(targetUrl).hostname;
  const maxPages = clampInt(body.maxPages, DEFAULT_MAX_PAGES, 1, MAX_PAGES_HARD_CAP);
  const maxDepth = clampInt(body.maxDepth, DEFAULT_MAX_DEPTH, 0, MAX_DEPTH_HARD_CAP);
  const rateLimitRps = clampRatePerSecond(
    typeof body.rateLimitRps === "number" ? body.rateLimitRps : DEFAULT_RATE_LIMIT_RPS,
  );

  const { data: insertedJob, error: insertError } = await routeClient
    .from("crawl_jobs")
    .insert({
      owner: userId,
      target_url: targetUrl,
      root_domain: rootDomain,
      scope: scope as CrawlScope,
      content_types: contentTypes as ContentType[],
      status: "running",
      max_pages: maxPages,
      max_depth: maxDepth,
      rate_limit_rps: rateLimitRps,
      started_at: new Date().toISOString(),
    })
    .select()
    .single();

  if (insertError || !insertedJob) {
    return NextResponse.json({ error: "Failed to create job." }, { status: 500 });
  }

  const jobId = insertedJob.id;

  // Seeding crawl_queue requires the service-role client: the table has no
  // client-facing INSERT policy (only "job belongs to me" SELECT) - safe
  // here because we already verified ownership by creating jobId above
  // under the caller's own RLS-scoped session.
  const serviceClient = createServiceRoleClient();
  const userAgent = buildUserAgent(getSiteUrl());

  const seedUrls = new Set<string>();
  const normalizedTarget = normalizeUrl(targetUrl) ?? targetUrl;
  seedUrls.add(normalizedTarget);

  if (scope === "site") {
    try {
      const robotsRules = await getRobotsRules(serviceClient, targetUrl, userAgent);
      const sitemapUrls = await fetchSitemapUrls(targetUrl, userAgent, robotsRules.sitemaps);
      for (const u of sitemapUrls) {
        if (seedUrls.size >= maxPages) break;
        seedUrls.add(u);
      }
    } catch {
      // A broken sitemap just means we seed from the start URL alone.
    }
  }

  const queueRows = Array.from(seedUrls).map((seedUrl) => ({
    job_id: jobId,
    url: seedUrl,
    normalized_url: seedUrl,
    depth: 0,
    status: "pending" as const,
    discovered_from: seedUrl === normalizedTarget ? null : targetUrl,
  }));

  await serviceClient
    .from("crawl_queue")
    .upsert(queueRows, { onConflict: "job_id,normalized_url", ignoreDuplicates: true });

  // Fire-and-forget: kick off the first tick without blocking this response.
  fetch(`${getSiteUrl()}/api/jobs/${jobId}/tick`, {
    method: "POST",
    headers: internalAuthHeaders(),
  }).catch(() => {
    // The watchdog cron will pick this job up within WATCHDOG_STALL_THRESHOLD_MS
    // even if this kick-off request fails outright.
  });

  return NextResponse.json({ id: jobId, status: "running" }, { status: 201 });
}
