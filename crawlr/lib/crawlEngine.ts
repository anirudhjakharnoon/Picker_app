/**
 * The tick worker's core logic: claim a bounded batch of pending
 * crawl_queue rows, process each one (robots -> SSRF-safe fetch -> extract
 * -> persist), bump crawl_jobs counters in one batched call, and either
 * finalize the job (assemble + upload the Markdown export) or hand off to
 * a continuation (self-fetch) if the frontier isn't empty and the soft time
 * budget allows.
 *
 * Designed to be safely re-entrant: every mutation is idempotent or
 * additive in a way that tolerates being re-run (a no-op if status isn't
 * 'running'; claiming pending rows via an atomic update so two concurrent
 * ticks never double-process the same row; enqueueing discovered links via
 * upsert+ignoreDuplicates against the (job_id, normalized_url) unique
 * constraint).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { safeFetch } from "./ssrf";
import { getRobotsRules } from "./robots";
import { extractMainContent, extractAssets, extractLinks, normalizeUrl } from "./extract";
import { getDomainRateLimiter, clampRatePerSecond } from "./rateLimiter";
import { logEvent } from "./events";
import { assembleMarkdownDocument } from "./assembleMarkdown";
import { internalAuthHeaders } from "./internalAuth";
import {
  TICK_BATCH_SIZE,
  TICK_TIME_BUDGET_MS,
  MAX_TEXT_BYTES_PER_JOB,
  MAX_ASSETS_PER_JOB,
  MAX_DEPTH_HARD_CAP,
  MAX_PAGES_HARD_CAP,
  EXPORTS_BUCKET,
  buildUserAgent,
} from "./constants";
import type { AssetType, CrawlJobRow, CrawlQueueRow, Database } from "./types";

export interface TickDependencies {
  /** Fire-and-forget continuation trigger. Defaults to a real HTTP self-fetch. */
  selfFetch?: (jobId: string) => void;
  now?: () => number;
}

export interface TickSummary {
  jobId: string;
  ranAtAll: boolean;
  processed: number;
  finished: boolean;
  status: string;
}

interface CounterDeltas {
  pages_crawled: number;
  pages_skipped: number;
  pages_errored: number;
  images_found: number;
  videos_found: number;
  text_bytes: number;
  robots_disallowed: number;
}

function emptyDeltas(): CounterDeltas {
  return {
    pages_crawled: 0,
    pages_skipped: 0,
    pages_errored: 0,
    images_found: 0,
    videos_found: 0,
    text_bytes: 0,
    robots_disallowed: 0,
  };
}

function defaultSelfFetch(jobId: string, siteUrl: string): void {
  fetch(`${siteUrl}/api/jobs/${jobId}/tick`, {
    method: "POST",
    headers: internalAuthHeaders(),
  }).catch(() => {
    // Best-effort continuation - if this fails, the watchdog cron will
    // pick the job back up within WATCHDOG_STALL_THRESHOLD_MS.
  });
}

export async function runTick(
  supabase: SupabaseClient<Database>,
  jobId: string,
  siteUrl: string,
  deps: TickDependencies = {},
): Promise<TickSummary> {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const userAgent = buildUserAgent(siteUrl);

  const { data: jobData } = await supabase.from("crawl_jobs").select("*").eq("id", jobId).maybeSingle();
  const job = jobData as CrawlJobRow | null;

  if (!job || job.status !== "running") {
    return { jobId, ranAtAll: false, processed: 0, finished: false, status: job?.status ?? "missing" };
  }

  const rps = clampRatePerSecond(job.rate_limit_rps);
  const bucket = getDomainRateLimiter(`${job.id}`, rps);
  const maxDepth = Math.min(job.max_depth, MAX_DEPTH_HARD_CAP);
  const maxPages = Math.min(job.max_pages, MAX_PAGES_HARD_CAP);

  const { data: claimedRaw } = await supabase
    .from("crawl_queue")
    .update({ status: "fetching" })
    .eq("job_id", jobId)
    .eq("status", "pending")
    .order("depth", { ascending: true })
    .order("id", { ascending: true })
    .limit(TICK_BATCH_SIZE)
    .select();
  const claimed = (claimedRaw as CrawlQueueRow[] | null) ?? [];

  const deltas = emptyDeltas();
  let attemptedThisTick = job.pages_crawled + job.pages_errored;
  let remainingTextBudget = Math.max(0, MAX_TEXT_BYTES_PER_JOB - job.text_bytes);
  let remainingAssetBudget = Math.max(0, MAX_ASSETS_PER_JOB - job.images_found - job.videos_found);
  const discoveredLinksToEnqueue: Array<{ url: string; depth: number; discoveredFrom: string }> = [];

  for (const queueRow of claimed) {
    if (attemptedThisTick >= maxPages) {
      await finishQueueRow(supabase, queueRow, { status: "skipped", skip_reason: "cap" });
      deltas.pages_skipped += 1;
      await logEvent(supabase, jobId, "skip", `SKIP ${queueRow.url} - max_pages cap reached`);
      continue;
    }

    let targetPath: string;
    try {
      const u = new URL(queueRow.url);
      targetPath = u.pathname + u.search;
    } catch {
      targetPath = "/";
    }

    const robotsRules = await getRobotsRules(supabase, queueRow.url, userAgent);
    if (!robotsRules.isAllowed(targetPath)) {
      await finishQueueRow(supabase, queueRow, { status: "skipped", skip_reason: "robots" });
      deltas.pages_skipped += 1;
      deltas.robots_disallowed += 1;
      await logEvent(supabase, jobId, "skip", `SKIP ${queueRow.url} - disallowed by robots.txt`);
      continue;
    }

    await bucket.take();
    attemptedThisTick += 1;

    let fetchResult: { status: number; contentType: string; html: string } | null = null;
    try {
      const res = await safeFetch(queueRow.url, { method: "GET", headers: { "User-Agent": userAgent } });
      fetchResult = {
        status: res.status,
        contentType: res.headers["content-type"] ?? "",
        html: res.body.toString("utf-8"),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown fetch error";
      await finishQueueRow(supabase, queueRow, { status: "error", skip_reason: "fetch_error" });
      deltas.pages_errored += 1;
      await logEvent(supabase, jobId, "error", `ERROR ${queueRow.url} - ${message}`);
      continue;
    }

    if (fetchResult.status >= 400) {
      await finishQueueRow(supabase, queueRow, { status: "error", http_status: fetchResult.status });
      deltas.pages_errored += 1;
      await logEvent(supabase, jobId, "error", `GET ${targetPath} - ${fetchResult.status}`);
      continue;
    }

    if (!fetchResult.contentType.includes("html")) {
      await finishQueueRow(supabase, queueRow, { status: "done", http_status: fetchResult.status, skip_reason: "non_html" });
      deltas.pages_crawled += 1;
      await logEvent(supabase, jobId, "fetch", `GET ${targetPath} - ${fetchResult.status} - non-HTML, not extracted`);
      continue;
    }

    deltas.pages_crawled += 1;
    const html = fetchResult.html;
    let extractedNote = "";

    if (job.content_types.includes("text")) {
      const { title, markdown, wordCount } = extractMainContent(html, queueRow.url);
      const byteLength = Buffer.byteLength(markdown, "utf-8");
      if (byteLength <= remainingTextBudget) {
        await supabase.from("crawl_pages").insert({
          job_id: jobId,
          url: queueRow.url,
          title,
          markdown,
          word_count: wordCount,
        });
        deltas.text_bytes += byteLength;
        remainingTextBudget -= byteLength;
        extractedNote += ` - ${wordCount}w`;
      } else {
        extractedNote += " - text cap reached, not stored";
      }
    }

    if (job.content_types.includes("images") || job.content_types.includes("video")) {
      const assets = extractAssets(html, queueRow.url);
      const rows: Array<{
        job_id: string;
        page_url: string;
        asset_type: AssetType;
        asset_url: string;
        alt_text: string | null;
        mime_type: string | null;
      }> = [];

      if (job.content_types.includes("images")) {
        for (const imageUrl of assets.images) {
          if (remainingAssetBudget <= 0) break;
          rows.push({ job_id: jobId, page_url: queueRow.url, asset_type: "image", asset_url: imageUrl, alt_text: null, mime_type: null });
          remainingAssetBudget -= 1;
          deltas.images_found += 1;
        }
      }

      if (job.content_types.includes("video")) {
        for (const videoUrl of assets.videos) {
          if (remainingAssetBudget <= 0) break;
          rows.push({ job_id: jobId, page_url: queueRow.url, asset_type: "video", asset_url: videoUrl, alt_text: null, mime_type: null });
          remainingAssetBudget -= 1;
          deltas.videos_found += 1;
        }
        for (const embed of assets.videoEmbeds) {
          if (remainingAssetBudget <= 0) break;
          rows.push({ job_id: jobId, page_url: queueRow.url, asset_type: "video_embed", asset_url: embed.url, alt_text: embed.provider, mime_type: null });
          remainingAssetBudget -= 1;
          deltas.videos_found += 1;
        }
      }

      if (rows.length > 0) {
        await supabase.from("crawl_assets").insert(rows);
        extractedNote += ` - ${rows.length} assets`;
      }
    }

    await finishQueueRow(supabase, queueRow, { status: "done", http_status: fetchResult.status });
    await logEvent(supabase, jobId, "extract", `GET ${targetPath} - ${fetchResult.status}${extractedNote}`);

    const canExpand = job.scope !== "page" && (job.scope === "site" || queueRow.depth === 0);
    const nextDepth = queueRow.depth + 1;
    if (canExpand && nextDepth <= maxDepth) {
      for (const link of extractLinks(html, queueRow.url)) {
        discoveredLinksToEnqueue.push({ url: link, depth: nextDepth, discoveredFrom: queueRow.url });
      }
    }
  }

  if (discoveredLinksToEnqueue.length > 0) {
    const rows = discoveredLinksToEnqueue
      .map(({ url, depth, discoveredFrom }) => {
        const normalized = normalizeUrl(url);
        if (!normalized) return null;
        return {
          job_id: jobId,
          url,
          normalized_url: normalized,
          depth,
          status: "pending" as const,
          discovered_from: discoveredFrom,
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);

    if (rows.length > 0) {
      await supabase.from("crawl_queue").upsert(rows, { onConflict: "job_id,normalized_url", ignoreDuplicates: true });
    }
  }

  await bumpJobCounters(supabase, jobId, deltas);

  const { data: pendingRows } = await supabase
    .from("crawl_queue")
    .select("id")
    .eq("job_id", jobId)
    .eq("status", "pending")
    .limit(1);
  const frontierEmpty = ((pendingRows as unknown[] | null) ?? []).length === 0;

  const newPagesCrawled = job.pages_crawled + deltas.pages_crawled;
  const newPagesErrored = job.pages_errored + deltas.pages_errored;
  const capped = newPagesCrawled + newPagesErrored >= maxPages;

  if (frontierEmpty || capped) {
    await finalizeJob(supabase, jobId, job);
    return { jobId, ranAtAll: true, processed: claimed.length, finished: true, status: "completed" };
  }

  const elapsed = now() - startedAt;
  if (elapsed < TICK_TIME_BUDGET_MS) {
    const trigger = deps.selfFetch ?? ((id: string) => defaultSelfFetch(id, siteUrl));
    trigger(jobId);
  }

  return { jobId, ranAtAll: true, processed: claimed.length, finished: false, status: "running" };
}

async function finishQueueRow(
  supabase: SupabaseClient<Database>,
  queueRow: CrawlQueueRow,
  patch: Partial<Pick<CrawlQueueRow, "status" | "http_status" | "skip_reason">>,
): Promise<void> {
  await supabase
    .from("crawl_queue")
    .update({ ...patch, fetched_at: new Date().toISOString() })
    .eq("id", queueRow.id);
}

async function bumpJobCounters(
  supabase: SupabaseClient<Database>,
  jobId: string,
  deltas: CounterDeltas,
): Promise<void> {
  const { error } = await supabase.rpc("bump_job_counters", {
    p_job_id: jobId,
    p_pages_crawled: deltas.pages_crawled,
    p_pages_skipped: deltas.pages_skipped,
    p_pages_errored: deltas.pages_errored,
    p_images_found: deltas.images_found,
    p_videos_found: deltas.videos_found,
    p_text_bytes: deltas.text_bytes,
    p_robots_disallowed: deltas.robots_disallowed,
  });
  if (error) {
    console.error(`bump_job_counters failed for job ${jobId}:`, error.message);
  }
}

async function finalizeJob(
  supabase: SupabaseClient<Database>,
  jobId: string,
  job: CrawlJobRow,
): Promise<void> {
  const { data: pagesRaw } = await supabase
    .from("crawl_pages")
    .select("url,title,markdown")
    .eq("job_id", jobId)
    .order("id", { ascending: true });
  const pages = (pagesRaw as Array<{ url: string; title: string | null; markdown: string | null }> | null) ?? [];

  const document = assembleMarkdownDocument(
    { target_url: job.target_url, scope: job.scope, created_at: job.created_at },
    pages,
  );
  const buffer = Buffer.from(document, "utf-8");
  const path = `${jobId}/output.md`;

  await supabase.storage.from(EXPORTS_BUCKET).upload(path, buffer, {
    contentType: "text/markdown; charset=utf-8",
    upsert: true,
  });

  await supabase
    .from("crawl_jobs")
    .update({
      status: "completed",
      finished_at: new Date().toISOString(),
      md_storage_path: path,
      md_size_bytes: buffer.byteLength,
    })
    .eq("id", jobId);

  await logEvent(supabase, jobId, "done", `Crawl completed - ${pages.length} pages exported`);
}
