"use client";

import { useMemo } from "react";
import { QUEUE_STATUS_COLOR, QUEUE_STATUS_LABEL } from "./ui/statusColors";
import type { CrawlQueueRow } from "@/lib/types";

const MAX_RENDERED_NODES = 400;

/**
 * The Split HUD's hero visual: every discovered page as a node that pops in
 * as soon as it's queued, and re-colors live as its crawl_queue.status
 * changes (queued -> fetching -> done/skipped/error). A node field rather
 * than a force-directed graph-with-edges - deliberately simple so it stays
 * smooth even with hundreds of nodes and needs no physics simulation.
 */
export function LinkGraph({ nodes }: { nodes: CrawlQueueRow[] }) {
  const sorted = useMemo(() => [...nodes].sort((a, b) => a.id - b.id), [nodes]);
  const visible = sorted.slice(-MAX_RENDERED_NODES);
  const hiddenCount = sorted.length - visible.length;

  const counts = useMemo(() => {
    const acc: Record<string, number> = { pending: 0, fetching: 0, done: 0, skipped: 0, error: 0 };
    for (const n of nodes) acc[n.status] = (acc[n.status] ?? 0) + 1;
    return acc;
  }, [nodes]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b border-signal-green/15 px-4 py-2.5 font-mono text-[11px] uppercase tracking-widest">
        {(Object.keys(QUEUE_STATUS_LABEL) as Array<keyof typeof QUEUE_STATUS_LABEL>).map((status) => (
          <span key={status} className="flex items-center gap-1.5 text-signal-green/50">
            <span
              className="h-2 w-2 rounded-full"
              style={{ backgroundColor: QUEUE_STATUS_COLOR[status] }}
            />
            {QUEUE_STATUS_LABEL[status]} · {counts[status] ?? 0}
          </span>
        ))}
      </div>

      <div className="relative flex-1 overflow-auto p-4">
        {nodes.length === 0 ? (
          <EmptyGraph />
        ) : (
          <div className="flex flex-wrap content-start gap-2">
            {visible.map((node) => (
              <GraphNode key={node.id} node={node} />
            ))}
            {hiddenCount > 0 && (
              <span className="flex h-8 items-center px-2 font-mono text-[11px] text-signal-green/40">
                +{hiddenCount} more
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function GraphNode({ node }: { node: CrawlQueueRow }) {
  const color = QUEUE_STATUS_COLOR[node.status];
  const isFetching = node.status === "fetching";
  let label = node.url;
  try {
    const u = new URL(node.url);
    label = u.pathname === "" ? "/" : u.pathname;
  } catch {
    // keep full url as label
  }

  return (
    <div
      title={`${node.url} — ${QUEUE_STATUS_LABEL[node.status]}${node.http_status ? ` (${node.http_status})` : ""}`}
      className="animate-node-pop relative flex h-8 w-8 items-center justify-center border text-[9px]"
      style={{ borderColor: `${color}55`, backgroundColor: `${color}14`, color }}
    >
      {isFetching && (
        <span
          className="absolute inset-0 animate-pulse-ring rounded-sm border"
          style={{ borderColor: color }}
          aria-hidden="true"
        />
      )}
      <span className="relative z-10 truncate px-0.5 font-mono leading-none" aria-hidden="true">
        ●
      </span>
      <span className="sr-only">{label}</span>
    </div>
  );
}

function EmptyGraph() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 font-mono text-xs text-signal-green/30">
      <span className="text-3xl">◌</span>
      <span>Awaiting run — the link graph populates live once a crawl starts.</span>
    </div>
  );
}
