import type { CrawlJobRow } from "@/lib/types";
import { MAX_PAGES_HARD_CAP } from "@/lib/constants";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)}MB`;
}

export function CounterGrid({ job }: { job: CrawlJobRow }) {
  const maxPages = Math.min(job.max_pages, MAX_PAGES_HARD_CAP);
  const attempted = job.pages_crawled + job.pages_errored;
  const pct = maxPages > 0 ? Math.min(100, Math.round((attempted / maxPages) * 100)) : 0;

  return (
    <div className="flex flex-col gap-3">
      <div>
        <div className="mb-1 flex justify-between font-mono text-[11px] text-signal-green/50">
          <span>PAGES {attempted} / {maxPages}</span>
          <span>{pct}%</span>
        </div>
        <div className="h-1.5 w-full border border-signal-green/20 bg-void-950">
          <div
            className="h-full bg-signal-green shadow-glow transition-[width] duration-500"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 font-mono text-xs">
        <Stat label="Crawled" value={job.pages_crawled} tone="ok" />
        <Stat label="Skipped" value={job.pages_skipped} tone="warn" />
        <Stat label="Errored" value={job.pages_errored} tone="bad" />
        <Stat label="Robots-blocked" value={job.robots_disallowed} tone="warn" />
        <Stat label="Images" value={job.images_found} tone="cyan" />
        <Stat label="Video" value={job.videos_found} tone="cyan" />
      </div>

      <div className="flex justify-between border-t border-signal-green/10 pt-2 font-mono text-[11px] text-signal-green/40">
        <span>Text extracted</span>
        <span className="text-signal-green/70">{formatBytes(job.text_bytes)}</span>
      </div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone: "ok" | "warn" | "bad" | "cyan" }) {
  const color = {
    ok: "text-signal-green",
    warn: "text-signal-amber",
    bad: "text-signal-red",
    cyan: "text-signal-cyan",
  }[tone];
  return (
    <div className="flex items-center justify-between border border-signal-green/10 bg-void-950/50 px-2 py-1.5">
      <span className="text-signal-green/40">{label}</span>
      <span className={color}>{value}</span>
    </div>
  );
}
