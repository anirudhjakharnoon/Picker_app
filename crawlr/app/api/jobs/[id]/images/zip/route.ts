import { NextResponse } from "next/server";
import archiver from "archiver";
import { Readable } from "node:stream";
import { createRouteHandlerClient, getSessionUserId } from "@/lib/supabase/server";
import { safeFetch, SsrfError } from "@/lib/ssrf";
import { mapWithConcurrency } from "@/lib/concurrency";
import { buildUserAgent } from "@/lib/constants";
import { getSiteUrl } from "@/lib/supabase/env";
import { ZIP_MAX_IMAGES, ZIP_MAX_TOTAL_BYTES } from "@/lib/constants";
import type { CrawlAssetRow } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const DOWNLOAD_CONCURRENCY = 4;
/** Tighter than the crawl's own FETCH_TIMEOUT_MS - this route bundles up
 * to ZIP_MAX_IMAGES images in a single request/response cycle, so each
 * individual fetch gets a shorter budget to keep the whole route well
 * inside its maxDuration even if several images are slow. */
const ZIP_ITEM_TIMEOUT_MS = 6_000;

function filenameFor(url: string, index: number): string {
  try {
    const u = new URL(url);
    const base = u.pathname.split("/").filter(Boolean).pop() || `image-${index}`;
    const safe = base.replace(/[^a-zA-Z0-9._-]/g, "_");
    return `${String(index + 1).padStart(3, "0")}_${safe}`;
  } catch {
    return `image-${index}`;
  }
}

export async function POST(_request: Request, { params }: { params: { id: string } }): Promise<Response> {
  const routeClient = createRouteHandlerClient();
  const userId = await getSessionUserId(routeClient);
  if (!userId) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }

  const { data: job } = await routeClient
    .from("crawl_jobs")
    .select("id")
    .eq("id", params.id)
    .maybeSingle();
  if (!job) {
    return NextResponse.json({ error: "Job not found or not yours." }, { status: 404 });
  }

  const { data: assetsRaw } = await routeClient
    .from("crawl_assets")
    .select("*")
    .eq("job_id", params.id)
    .eq("asset_type", "image")
    .order("id", { ascending: true })
    .limit(ZIP_MAX_IMAGES + 1);
  const assets = (assetsRaw as CrawlAssetRow[] | null) ?? [];

  if (assets.length === 0) {
    return NextResponse.json({ error: "No images found for this job." }, { status: 400 });
  }
  if (assets.length > ZIP_MAX_IMAGES) {
    return NextResponse.json(
      { error: `Too many images for a ZIP bundle (max ${ZIP_MAX_IMAGES}). Use the CSV/JSON list instead.` },
      { status: 400 },
    );
  }

  const userAgent = buildUserAgent(getSiteUrl());

  const downloaded = await mapWithConcurrency(assets, DOWNLOAD_CONCURRENCY, async (asset) => {
    try {
      const res = await safeFetch(asset.asset_url, {
        method: "GET",
        headers: { "User-Agent": userAgent },
        timeoutMs: ZIP_ITEM_TIMEOUT_MS,
        maxBytes: ZIP_MAX_TOTAL_BYTES,
      });
      if (res.status < 200 || res.status >= 300) return null;
      return { url: asset.asset_url, buffer: res.body };
    } catch (err) {
      if (err instanceof SsrfError) return null;
      return null;
    }
  });

  const usable = downloaded.filter((d): d is { url: string; buffer: Buffer } => d !== null);
  if (usable.length === 0) {
    return NextResponse.json({ error: "None of this job's images could be downloaded." }, { status: 502 });
  }

  let totalBytes = 0;
  const withinBudget: Array<{ url: string; buffer: Buffer }> = [];
  for (const item of usable) {
    if (totalBytes + item.buffer.byteLength > ZIP_MAX_TOTAL_BYTES) break;
    totalBytes += item.buffer.byteLength;
    withinBudget.push(item);
  }

  const archive = archiver("zip", { zlib: { level: 6 } });
  archive.on("warning", (err) => console.warn("archiver warning:", err.message));
  archive.on("error", (err) => console.error("archiver error:", err.message));

  withinBudget.forEach((item, index) => {
    archive.append(item.buffer, { name: filenameFor(item.url, index) });
  });
  void archive.finalize();

  const webStream = Readable.toWeb(archive) as ReadableStream<Uint8Array>;

  return new Response(webStream, {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="crawlr-${params.id}-images.zip"`,
      "Cache-Control": "no-store",
    },
  });
}
