"use client";

import type { ContentType, CrawlScope } from "./types";
import type { ProbeResult } from "./probe";

async function parseJsonOrThrow<T>(res: Response): Promise<T> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // no body
  }
  if (!res.ok) {
    const message =
      body && typeof body === "object" && "error" in body
        ? String((body as { error: unknown }).error)
        : `Request failed with status ${res.status}`;
    throw new Error(message);
  }
  return body as T;
}

export async function probeTarget(url: string, scope: CrawlScope): Promise<ProbeResult> {
  const res = await fetch("/api/jobs/probe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, scope }),
  });
  return parseJsonOrThrow<ProbeResult>(res);
}

export interface CreateJobRequest {
  url: string;
  scope: CrawlScope;
  contentTypes: ContentType[];
  maxPages?: number;
  maxDepth?: number;
  rateLimitRps?: number;
  ackPermission: boolean;
}

export async function createJob(body: CreateJobRequest): Promise<{ id: string; status: string }> {
  const res = await fetch("/api/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return parseJsonOrThrow(res);
}

export async function abortJob(jobId: string): Promise<{ id: string; status: string }> {
  const res = await fetch(`/api/jobs/${jobId}/abort`, { method: "POST" });
  return parseJsonOrThrow(res);
}

export async function getExportUrl(jobId: string): Promise<{ url: string; expiresInSeconds: number }> {
  const res = await fetch(`/api/jobs/${jobId}/export/md`);
  return parseJsonOrThrow(res);
}

export function downloadAssetsAsJson(assets: Array<{ asset_url: string; asset_type: string; page_url: string }>): void {
  const blob = new Blob([JSON.stringify(assets, null, 2)], { type: "application/json" });
  triggerDownload(blob, "crawlr-assets.json");
}

export function downloadAssetsAsCsv(assets: Array<{ asset_url: string; asset_type: string; page_url: string }>): void {
  const header = "asset_type,asset_url,page_url";
  const rows = assets.map(
    (a) => `${a.asset_type},"${a.asset_url.replace(/"/g, '""')}","${a.page_url.replace(/"/g, '""')}"`,
  );
  const blob = new Blob([[header, ...rows].join("\n")], { type: "text/csv" });
  triggerDownload(blob, "crawlr-assets.csv");
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export async function downloadImagesZip(jobId: string): Promise<void> {
  const res = await fetch(`/api/jobs/${jobId}/images/zip`, { method: "POST" });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error ?? "Failed to build ZIP.");
  }
  const blob = await res.blob();
  triggerDownload(blob, `crawlr-${jobId}-images.zip`);
}
