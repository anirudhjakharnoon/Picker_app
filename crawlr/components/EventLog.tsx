"use client";

import { useEffect, useRef } from "react";
import type { CrawlEventRow } from "@/lib/types";

const KIND_COLOR: Record<CrawlEventRow["kind"], string> = {
  fetch: "text-signal-cyan",
  extract: "text-signal-green",
  queue: "text-signal-green/50",
  skip: "text-signal-amber",
  error: "text-signal-red",
  done: "text-signal-green",
};

export function EventLog({ events }: { events: CrawlEventRow[] }) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [events.length]);

  return (
    <div
      ref={scrollRef}
      className="h-full overflow-y-auto bg-void-950/70 p-3 font-mono text-[11px] leading-relaxed"
    >
      {events.length === 0 && <p className="text-signal-green/30">$ awaiting first event…</p>}
      {events.map((event) => (
        <p key={event.id} className="flex gap-2">
          <span className="shrink-0 text-signal-green/25">
            {new Date(event.at).toLocaleTimeString([], { hour12: false })}
          </span>
          <span className={`shrink-0 uppercase ${KIND_COLOR[event.kind]}`}>[{event.kind}]</span>
          <span className="text-signal-green/75">{event.message}</span>
        </p>
      ))}
    </div>
  );
}
