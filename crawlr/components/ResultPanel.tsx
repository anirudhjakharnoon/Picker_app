"use client";

import { useState } from "react";
import { Panel } from "./ui/Panel";
import { Button } from "./ui/Button";
import { getExportUrl, downloadAssetsAsCsv, downloadAssetsAsJson, downloadImagesZip } from "@/lib/api";
import { ZIP_MAX_IMAGES } from "@/lib/constants";
import type { CrawlAssetRow, CrawlJobRow } from "@/lib/types";

const STATUS_LABEL: Record<CrawlJobRow["status"], { label: string; tone: string }> = {
  queued: { label: "Queued", tone: "text-signal-green/60" },
  probing: { label: "Probing", tone: "text-signal-cyan" },
  running: { label: "Running", tone: "text-signal-green" },
  completed: { label: "Completed", tone: "text-signal-green" },
  failed: { label: "Failed", tone: "text-signal-red" },
  aborted: { label: "Aborted", tone: "text-signal-amber" },
};

interface ResultPanelProps {
  job: CrawlJobRow;
  assets: CrawlAssetRow[];
  onNewCrawl: () => void;
}

export function ResultPanel({ job, assets, onNewCrawl }: ResultPanelProps) {
  const images = assets.filter((a) => a.asset_type === "image");
  const videos = assets.filter((a) => a.asset_type === "video");
  const embeds = assets.filter((a) => a.asset_type === "video_embed");

  const capped = job.pages_crawled + job.pages_errored >= job.max_pages;
  const statusInfo = STATUS_LABEL[job.status];

  return (
    <div className="flex flex-col gap-4">
      <Panel eyebrow="Result" title="Run Summary" glow>
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between font-mono text-sm">
            <span className={statusInfo.tone}>
              ● {statusInfo.label}
              {capped && job.status === "completed" ? " · CAPPED (page limit reached)" : ""}
            </span>
            <span className="text-signal-green/40">{job.target_url}</span>
          </div>
          <div className="grid grid-cols-2 gap-2 font-mono text-xs sm:grid-cols-4">
            <SummaryStat label="Crawled" value={job.pages_crawled} />
            <SummaryStat label="Skipped" value={job.pages_skipped} />
            <SummaryStat label="Errored" value={job.pages_errored} />
            <SummaryStat label="Robots-blocked" value={job.robots_disallowed} />
          </div>
          {job.error_message && (
            <div className="border border-signal-red/30 bg-signal-red/5 px-3 py-2 font-mono text-xs text-signal-red">
              {job.error_message}
            </div>
          )}
          <div className="flex justify-end">
            <Button variant="primary" onClick={onNewCrawl}>
              New crawl ↻
            </Button>
          </div>
        </div>
      </Panel>

      {job.content_types.includes("text") && (
        <Panel eyebrow="Text" title="Markdown Export">
          <ExportDownload job={job} />
        </Panel>
      )}

      {job.content_types.includes("images") && (
        <Panel eyebrow={`${images.length} found`} title="Image Gallery">
          <ImageGallery jobId={job.id} images={images} />
        </Panel>
      )}

      {job.content_types.includes("video") && (videos.length > 0 || embeds.length > 0) && (
        <Panel eyebrow={`${videos.length + embeds.length} found`} title="Video Links">
          <VideoList videos={videos} embeds={embeds} />
        </Panel>
      )}
    </div>
  );
}

function SummaryStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="border border-signal-green/10 bg-void-950/50 px-2 py-1.5">
      <div className="text-signal-green/40">{label}</div>
      <div className="text-base text-signal-green">{value}</div>
    </div>
  );
}

function ExportDownload({ job }: { job: CrawlJobRow }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDownload() {
    setLoading(true);
    setError(null);
    try {
      const { url } = await getExportUrl(job.id);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Download failed.");
    } finally {
      setLoading(false);
    }
  }

  if (!job.md_storage_path) {
    return <p className="font-mono text-xs text-signal-green/40">No export available yet.</p>;
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between font-mono text-xs text-signal-green/50">
        <span>{Math.round((job.md_size_bytes ?? 0) / 1024)} KB · one file, one section per page</span>
        <Button variant="primary" onClick={handleDownload} disabled={loading}>
          {loading ? "Signing…" : "Download .md ⤓"}
        </Button>
      </div>
      {error && <p className="font-mono text-xs text-signal-red">{error}</p>}
    </div>
  );
}

function ImageGallery({ jobId, images }: { jobId: string; images: CrawlAssetRow[] }) {
  const [zipping, setZipping] = useState(false);
  const [zipError, setZipError] = useState<string | null>(null);
  const zipEligible = images.length > 0 && images.length <= ZIP_MAX_IMAGES;

  async function handleZip() {
    setZipping(true);
    setZipError(null);
    try {
      await downloadImagesZip(jobId);
    } catch (err) {
      setZipError(err instanceof Error ? err.message : "ZIP failed.");
    } finally {
      setZipping(false);
    }
  }

  if (images.length === 0) {
    return <p className="font-mono text-xs text-signal-green/40">No images found (yet).</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => downloadAssetsAsCsv(images)}>Download list (CSV)</Button>
        <Button onClick={() => downloadAssetsAsJson(images)}>Download list (JSON)</Button>
        <Button
          onClick={handleZip}
          disabled={!zipEligible || zipping}
          title={zipEligible ? undefined : `ZIP bundling is only offered for ≤${ZIP_MAX_IMAGES} images`}
        >
          {zipping ? "Bundling…" : `Bundle & download ZIP${zipEligible ? "" : " (unavailable)"}`}
        </Button>
      </div>
      {zipError && <p className="font-mono text-xs text-signal-red">{zipError}</p>}
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-6">
        {images.slice(0, 120).map((img) => (
          <a
            key={img.id}
            href={img.asset_url}
            target="_blank"
            rel="noopener noreferrer"
            title={img.asset_url}
            className="group relative aspect-square overflow-hidden border border-signal-green/15 bg-void-950/50"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={img.asset_url}
              alt={img.alt_text ?? ""}
              loading="lazy"
              className="h-full w-full object-cover opacity-80 transition-opacity group-hover:opacity-100"
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).style.display = "none";
              }}
            />
            <span className="absolute inset-x-0 bottom-0 truncate bg-void-950/80 px-1 py-0.5 font-mono text-[9px] text-signal-green/60">
              ↗ source
            </span>
          </a>
        ))}
      </div>
      {images.length > 120 && (
        <p className="font-mono text-[11px] text-signal-green/40">
          Showing first 120 of {images.length} — use the CSV/JSON list for the full set.
        </p>
      )}
    </div>
  );
}

function VideoList({ videos, embeds }: { videos: CrawlAssetRow[]; embeds: CrawlAssetRow[] }) {
  return (
    <div className="flex flex-col gap-4">
      {videos.length > 0 && (
        <div>
          <h3 className="mb-2 font-mono text-[11px] uppercase tracking-widest text-signal-green/50">
            Self-hosted files ({videos.length})
          </h3>
          <ul className="flex flex-col gap-1.5 font-mono text-xs">
            {videos.map((v) => (
              <li key={v.id} className="flex items-center justify-between gap-2 border border-signal-green/10 bg-void-950/40 px-2 py-1.5">
                <span className="truncate text-signal-green/70">{v.asset_url}</span>
                <a
                  href={v.asset_url}
                  download
                  className="shrink-0 text-signal-cyan hover:underline"
                >
                  Download ⤓
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
      {embeds.length > 0 && (
        <div>
          <h3 className="mb-2 font-mono text-[11px] uppercase tracking-widest text-signal-green/50">
            Embedded players ({embeds.length})
          </h3>
          <p className="mb-2 font-mono text-[11px] text-signal-green/40">
            We don&apos;t offer downloads for embedded players (YouTube/Vimeo/Loom) — that&apos;s a
            platform ToS boundary, not a technical gap we&apos;re hiding.
          </p>
          <ul className="flex flex-col gap-1.5 font-mono text-xs">
            {embeds.map((v) => (
              <li key={v.id} className="flex items-center justify-between gap-2 border border-signal-green/10 bg-void-950/40 px-2 py-1.5">
                <span className="truncate text-signal-green/70">
                  {v.alt_text ? `${v.alt_text} · ` : ""}
                  {v.asset_url}
                </span>
                <a
                  href={v.asset_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="shrink-0 text-signal-cyan hover:underline"
                >
                  Open source ↗
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
