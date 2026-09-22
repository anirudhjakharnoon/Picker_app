"use client";

import { useEffect, useState } from "react";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import type { CrawlJobRow } from "@/lib/types";

const STATUS_DOT: Record<CrawlJobRow["status"], string> = {
  queued: "#4b5f57",
  probing: "#22e8ff",
  running: "#5cff9d",
  completed: "#5cff9d",
  failed: "#ff3b5c",
  aborted: "#ffb020",
};

interface HistoryDrawerProps {
  refreshToken: number;
  onSelectJob: (jobId: string) => void;
  activeJobId: string | null;
}

export function HistoryDrawer({ refreshToken, onSelectJob, activeJobId }: HistoryDrawerProps) {
  const [open, setOpen] = useState(false);
  const [jobs, setJobs] = useState<CrawlJobRow[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    const supabase = getSupabaseBrowserClient();
    supabase
      .from("crawl_jobs")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(20)
      .then(({ data }) => {
        if (!cancelled) {
          setJobs((data as CrawlJobRow[] | null) ?? []);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, refreshToken]);

  return (
    <div className="border-t border-signal-green/15">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-4 py-2.5 font-mono text-[11px] uppercase tracking-widest text-signal-green/50 hover:text-signal-green"
      >
        <span>{open ? "▾" : "▸"} Run history</span>
        <span className="text-signal-green/30">$ history --anon</span>
      </button>
      {open && (
        <div className="max-h-56 overflow-y-auto border-t border-signal-green/10">
          {loading && <p className="px-4 py-3 font-mono text-xs text-signal-green/30">loading…</p>}
          {!loading && jobs.length === 0 && (
            <p className="px-4 py-3 font-mono text-xs text-signal-green/30">No runs yet.</p>
          )}
          {!loading &&
            jobs.map((job) => (
              <button
                key={job.id}
                onClick={() => onSelectJob(job.id)}
                className={`flex w-full items-center gap-2 border-b border-signal-green/5 px-4 py-2 text-left font-mono text-[11px] hover:bg-signal-green/5 ${
                  job.id === activeJobId ? "bg-signal-green/10" : ""
                }`}
              >
                <span
                  className="h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ backgroundColor: STATUS_DOT[job.status] }}
                />
                <span className="flex-1 truncate text-signal-green/70">{job.target_url}</span>
                <span className="shrink-0 text-signal-green/30">
                  {new Date(job.created_at).toLocaleDateString()}
                </span>
              </button>
            ))}
        </div>
      )}
    </div>
  );
}
