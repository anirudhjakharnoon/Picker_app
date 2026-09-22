"use client";

import { useEffect, useRef, useState } from "react";
import { getSupabaseBrowserClient } from "../supabase/client";
import type { CrawlAssetRow, CrawlEventRow, CrawlJobRow, CrawlQueueRow } from "../types";

const FLUSH_INTERVAL_MS = 600;
const MAX_EVENTS_KEPT = 500;

export interface JobRealtimeState {
  job: CrawlJobRow | null;
  events: CrawlEventRow[];
  assets: CrawlAssetRow[];
  queueNodes: CrawlQueueRow[];
}

/**
 * Subscribes to this job's Realtime changefeeds (crawl_jobs, crawl_events,
 * crawl_assets, crawl_queue) and republishes them into React state at most
 * once every FLUSH_INTERVAL_MS, so a fast crawl's burst of events can't
 * turn into a Realtime-driven render storm (per the design spec: "update
 * UI state at most every 500ms-1s even if events arrive faster").
 */
export function useJobRealtime(jobId: string | null): JobRealtimeState {
  const [job, setJob] = useState<CrawlJobRow | null>(null);
  const [events, setEvents] = useState<CrawlEventRow[]>([]);
  const [assets, setAssets] = useState<CrawlAssetRow[]>([]);
  const [queueNodes, setQueueNodes] = useState<CrawlQueueRow[]>([]);

  const jobBufferRef = useRef<CrawlJobRow | null>(null);
  const eventsBufferRef = useRef<CrawlEventRow[]>([]);
  const assetsBufferRef = useRef<CrawlAssetRow[]>([]);
  const queueBufferRef = useRef<Map<number, CrawlQueueRow>>(new Map());

  useEffect(() => {
    setJob(null);
    setEvents([]);
    setAssets([]);
    setQueueNodes([]);
    jobBufferRef.current = null;
    eventsBufferRef.current = [];
    assetsBufferRef.current = [];
    queueBufferRef.current = new Map();

    if (!jobId) return;

    const supabase = getSupabaseBrowserClient();
    let cancelled = false;

    void (async () => {
      const [jobRes, eventsRes, assetsRes, queueRes] = await Promise.all([
        supabase.from("crawl_jobs").select("*").eq("id", jobId).maybeSingle(),
        supabase.from("crawl_events").select("*").eq("job_id", jobId).order("id", { ascending: true }).limit(MAX_EVENTS_KEPT),
        supabase.from("crawl_assets").select("*").eq("job_id", jobId).order("id", { ascending: true }).limit(5000),
        supabase.from("crawl_queue").select("*").eq("job_id", jobId).order("id", { ascending: true }).limit(2000),
      ]);
      if (cancelled) return;
      if (jobRes.data) setJob(jobRes.data as CrawlJobRow);
      setEvents((eventsRes.data as CrawlEventRow[] | null) ?? []);
      setAssets((assetsRes.data as CrawlAssetRow[] | null) ?? []);
      setQueueNodes((queueRes.data as CrawlQueueRow[] | null) ?? []);
    })();

    const channel = supabase
      .channel(`job-${jobId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "crawl_jobs", filter: `id=eq.${jobId}` },
        (payload) => {
          jobBufferRef.current = payload.new as CrawlJobRow;
        },
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "crawl_events", filter: `job_id=eq.${jobId}` },
        (payload) => {
          eventsBufferRef.current.push(payload.new as CrawlEventRow);
        },
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "crawl_assets", filter: `job_id=eq.${jobId}` },
        (payload) => {
          assetsBufferRef.current.push(payload.new as CrawlAssetRow);
        },
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "crawl_queue", filter: `job_id=eq.${jobId}` },
        (payload) => {
          const row = (payload.new ?? payload.old) as CrawlQueueRow | undefined;
          if (row) queueBufferRef.current.set(row.id, row);
        },
      )
      .subscribe();

    const flush = setInterval(() => {
      if (jobBufferRef.current) {
        const next = jobBufferRef.current;
        jobBufferRef.current = null;
        setJob(next);
      }
      if (eventsBufferRef.current.length > 0) {
        const batch = eventsBufferRef.current;
        eventsBufferRef.current = [];
        setEvents((prev) => [...prev, ...batch].slice(-MAX_EVENTS_KEPT));
      }
      if (assetsBufferRef.current.length > 0) {
        const batch = assetsBufferRef.current;
        assetsBufferRef.current = [];
        setAssets((prev) => [...prev, ...batch]);
      }
      if (queueBufferRef.current.size > 0) {
        const updates = queueBufferRef.current;
        queueBufferRef.current = new Map();
        setQueueNodes((prev) => {
          const map = new Map(prev.map((r) => [r.id, r]));
          for (const [id, row] of updates) map.set(id, row);
          return Array.from(map.values());
        });
      }
    }, FLUSH_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(flush);
      void supabase.removeChannel(channel);
    };
  }, [jobId]);

  return { job, events, assets, queueNodes };
}
