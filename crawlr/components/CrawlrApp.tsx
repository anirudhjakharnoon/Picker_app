"use client";

import { useEffect, useState } from "react";
import { ProgressRail, type AppPhase } from "./ProgressRail";
import { TargetPanel } from "./TargetPanel";
import { ScopeContentPanel } from "./ScopeContentPanel";
import { LinkGraph } from "./LinkGraph";
import { EventLog } from "./EventLog";
import { CounterGrid } from "./CounterGrid";
import { ResultPanel } from "./ResultPanel";
import { HistoryDrawer } from "./HistoryDrawer";
import { Button } from "./ui/Button";
import { Panel } from "./ui/Panel";
import { useAnonymousSession } from "@/lib/hooks/useAnonymousSession";
import { useJobRealtime } from "@/lib/hooks/useJobRealtime";
import { createJob, abortJob } from "@/lib/api";
import type { ProbeResult } from "@/lib/probe";
import type { ContentType, CrawlScope } from "@/lib/types";

const TERMINAL_STATUSES = new Set(["completed", "failed", "aborted"]);

export function CrawlrApp() {
  const { ready } = useAnonymousSession();

  const [phase, setPhase] = useState<AppPhase>("target");
  const [url, setUrl] = useState("");
  const [probeResult, setProbeResult] = useState<ProbeResult | null>(null);
  const [scope, setScope] = useState<CrawlScope>("page");
  const [contentTypes, setContentTypes] = useState<ContentType[]>(["text"]);
  const [jobId, setJobId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [historyRefreshToken, setHistoryRefreshToken] = useState(0);
  const [aborting, setAborting] = useState(false);

  const { job, events, assets, queueNodes } = useJobRealtime(jobId);

  useEffect(() => {
    if (job && TERMINAL_STATUSES.has(job.status) && phase === "running") {
      setPhase("result");
    }
  }, [job, phase]);

  function resetToTarget() {
    setPhase("target");
    setUrl("");
    setProbeResult(null);
    setScope("page");
    setContentTypes(["text"]);
    setJobId(null);
    setRunError(null);
  }

  async function handleRun(advanced: { maxPages: number; maxDepth: number; rateLimitRps: number }) {
    setSubmitting(true);
    setRunError(null);
    try {
      const result = await createJob({
        url: url.trim(),
        scope,
        contentTypes,
        ackPermission: true,
        ...advanced,
      });
      setJobId(result.id);
      setPhase("running");
      setHistoryRefreshToken((t) => t + 1);
    } catch (err) {
      setRunError(err instanceof Error ? err.message : "Failed to start crawl.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleAbort() {
    if (!jobId) return;
    setAborting(true);
    try {
      await abortJob(jobId);
    } catch {
      // Realtime will reflect the true state regardless.
    } finally {
      setAborting(false);
    }
  }

  function handleSelectHistoryJob(id: string) {
    setJobId(id);
    setPhase("running");
  }

  return (
    <div className="flex min-h-screen flex-col">
      <ProgressRail phase={phase} />

      <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-4 p-4">
        {!ready && (
          <p className="font-mono text-xs text-signal-green/40">Establishing anonymous session…</p>
        )}

        {phase === "target" && (
          <div className="mx-auto w-full max-w-xl">
            <TargetPanel
              url={url}
              onUrlChange={setUrl}
              onContinue={() => setPhase("setup")}
              probeResult={probeResult}
              onProbeResult={setProbeResult}
            />
          </div>
        )}

        {phase === "setup" && (
          <div className="mx-auto w-full max-w-xl">
            <ScopeContentPanel
              scope={scope}
              onScopeChange={setScope}
              contentTypes={contentTypes}
              onContentTypesChange={setContentTypes}
              onBack={() => setPhase("target")}
              onRun={handleRun}
              submitting={submitting}
              errorMessage={runError}
            />
          </div>
        )}

        {phase === "running" && (
          <div className="grid flex-1 grid-cols-1 gap-4 lg:grid-cols-[360px_1fr]">
            <div className="flex flex-col gap-4">
              <Panel eyebrow="Target" title="Live Run">
                <div className="flex flex-col gap-3">
                  <p className="truncate font-mono text-xs text-signal-green/60">{job?.target_url ?? url}</p>
                  {job ? (
                    <CounterGrid job={job} />
                  ) : (
                    <p className="font-mono text-xs text-signal-green/30">Connecting…</p>
                  )}
                  <Button variant="danger" onClick={handleAbort} disabled={aborting || job?.status !== "running"}>
                    {aborting ? "Aborting…" : "Abort run"}
                  </Button>
                </div>
              </Panel>
            </div>

            <div className="flex flex-col gap-4">
              <Panel className="flex-[2]" eyebrow="Live" title="Link Graph">
                <div className="h-72">
                  <LinkGraph nodes={queueNodes} />
                </div>
              </Panel>
              <Panel className="flex-1" eyebrow="Feed" title="Event Log">
                <div className="h-56">
                  <EventLog events={events} />
                </div>
              </Panel>
            </div>
          </div>
        )}

        {phase === "result" && job && (
          <div className="mx-auto w-full max-w-4xl">
            <ResultPanel job={job} assets={assets} onNewCrawl={resetToTarget} />
          </div>
        )}
      </main>

      <HistoryDrawer refreshToken={historyRefreshToken} onSelectJob={handleSelectHistoryJob} activeJobId={jobId} />
    </div>
  );
}
