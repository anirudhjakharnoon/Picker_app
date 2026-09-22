"use client";

import { useState } from "react";
import { Panel } from "./ui/Panel";
import { Button } from "./ui/Button";
import { probeTarget } from "@/lib/api";
import type { ProbeResult } from "@/lib/probe";

interface TargetPanelProps {
  url: string;
  onUrlChange: (url: string) => void;
  onContinue: () => void;
  probeResult: ProbeResult | null;
  onProbeResult: (result: ProbeResult | null) => void;
}

function isLikelyUrl(value: string): boolean {
  try {
    const u = new URL(value.trim());
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

export function TargetPanel({ url, onUrlChange, onContinue, probeResult, onProbeResult }: TargetPanelProps) {
  const [probing, setProbing] = useState(false);
  const [probeError, setProbeError] = useState<string | null>(null);

  const valid = isLikelyUrl(url);

  async function handleProbe() {
    if (!valid) return;
    setProbing(true);
    setProbeError(null);
    onProbeResult(null);
    try {
      const result = await probeTarget(url.trim(), "page");
      onProbeResult(result);
      if (!result.ok) setProbeError(result.error);
    } catch (err) {
      setProbeError(err instanceof Error ? err.message : "Probe failed.");
    } finally {
      setProbing(false);
    }
  }

  return (
    <Panel eyebrow="Step 01" title="Target" glow>
      <div className="flex flex-col gap-4">
        <div>
          <label htmlFor="target-url" className="mb-1.5 block text-[11px] uppercase tracking-widest text-signal-green/50">
            URL to extract
          </label>
          <div className="flex gap-2">
            <input
              id="target-url"
              type="url"
              inputMode="url"
              placeholder="https://example.com/article"
              value={url}
              onChange={(e) => onUrlChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && valid && !probing) void handleProbe();
              }}
              className="flex-1 border border-signal-green/25 bg-void-950/80 px-3 py-2 font-mono text-sm text-signal-green placeholder:text-signal-green/25 outline-none focus:border-signal-green focus:shadow-glow"
            />
            <Button onClick={handleProbe} disabled={!valid || probing} aria-busy={probing}>
              {probing ? "Probing…" : "Probe"}
            </Button>
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-signal-green/40">
            Static HTML extraction only — JS-rendered content may come back incomplete. We never bypass
            logins, paywalls, or CAPTCHAs.
          </p>
        </div>

        {probing && (
          <div className="border border-signal-green/15 bg-void-950/60 px-3 py-2 font-mono text-xs text-signal-green/60">
            <span className="animate-pulse">▍</span> RESOLVING · robots.txt · same-origin links…
          </div>
        )}

        {probeError && !probing && (
          <div className="border border-signal-red/30 bg-signal-red/5 px-3 py-2 font-mono text-xs text-signal-red">
            ERROR · {probeError}
          </div>
        )}

        {probeResult?.ok && !probing && (
          <div className="grid grid-cols-2 gap-2 border border-signal-green/15 bg-void-950/60 px-3 py-2.5 font-mono text-xs">
            <ReadoutRow label="Status" value={probeResult.reachable ? `${probeResult.httpStatus} OK` : "UNREACHABLE"} />
            <ReadoutRow label="Links found" value={String(probeResult.sameOriginLinkCount)} />
            <ReadoutRow
              label="robots.txt"
              value={probeResult.robots.allowedAtRoot ? "ALLOWED" : "DISALLOWED"}
              tone={probeResult.robots.allowedAtRoot ? "ok" : "warn"}
            />
            <ReadoutRow label="Sitemaps" value={String(probeResult.robots.sitemapCount)} />
          </div>
        )}

        <div className="flex justify-end">
          <Button variant="primary" onClick={onContinue} disabled={!valid}>
            Continue →
          </Button>
        </div>
      </div>
    </Panel>
  );
}

function ReadoutRow({ label, value, tone }: { label: string; value: string; tone?: "ok" | "warn" }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-signal-green/40">{label}</span>
      <span
        className={
          tone === "warn" ? "text-signal-amber" : tone === "ok" ? "text-signal-green" : "text-signal-cyan"
        }
      >
        {value}
      </span>
    </div>
  );
}
