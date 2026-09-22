"use client";

import { useState } from "react";
import { Panel } from "./ui/Panel";
import { Button } from "./ui/Button";
import { Chip } from "./ui/Chip";
import {
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_PAGES,
  DEFAULT_RATE_LIMIT_RPS,
  MAX_DEPTH_HARD_CAP,
  MAX_PAGES_HARD_CAP,
  RATE_LIMIT_RPS_HARD_CAP,
} from "@/lib/constants";
import type { ContentType, CrawlScope } from "@/lib/types";

const SCOPE_OPTIONS: Array<{ value: CrawlScope; label: string; hint: string }> = [
  { value: "page", label: "This page only", hint: "depth 0 — just this URL" },
  { value: "linked", label: "Page + linked pages", hint: "depth 1 — same-domain links from this page" },
  { value: "site", label: "Entire website", hint: "BFS across the whole domain, capped" },
];

const CONTENT_OPTIONS: Array<{ value: ContentType; label: string }> = [
  { value: "text", label: "Text" },
  { value: "images", label: "Images" },
  { value: "video", label: "Video" },
];

interface ScopeContentPanelProps {
  scope: CrawlScope;
  onScopeChange: (scope: CrawlScope) => void;
  contentTypes: ContentType[];
  onContentTypesChange: (types: ContentType[]) => void;
  onBack: () => void;
  onRun: (advanced: { maxPages: number; maxDepth: number; rateLimitRps: number }) => void;
  submitting: boolean;
  errorMessage: string | null;
}

export function ScopeContentPanel({
  scope,
  onScopeChange,
  contentTypes,
  onContentTypesChange,
  onBack,
  onRun,
  submitting,
  errorMessage,
}: ScopeContentPanelProps) {
  const [ack, setAck] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [maxPages, setMaxPages] = useState(DEFAULT_MAX_PAGES);
  const [maxDepth, setMaxDepth] = useState(DEFAULT_MAX_DEPTH);
  const [rateLimitRps, setRateLimitRps] = useState(DEFAULT_RATE_LIMIT_RPS);

  function toggleContentType(type: ContentType) {
    if (contentTypes.includes(type)) {
      onContentTypesChange(contentTypes.filter((t) => t !== type));
    } else {
      onContentTypesChange([...contentTypes, type]);
    }
  }

  const canRun = contentTypes.length > 0 && ack && !submitting;

  return (
    <Panel eyebrow="Step 02" title="Scope & Content" glow>
      <div className="flex flex-col gap-5">
        <fieldset>
          <legend className="mb-2 text-[11px] uppercase tracking-widest text-signal-green/50">
            How far should we crawl?
          </legend>
          <div className="flex flex-col gap-2">
            {SCOPE_OPTIONS.map((opt) => (
              <label
                key={opt.value}
                className="flex cursor-pointer items-start gap-3 border border-signal-green/15 bg-void-950/50 px-3 py-2 hover:border-signal-green/40"
              >
                <input
                  type="radio"
                  name="scope"
                  className="mt-1 accent-signal-green"
                  checked={scope === opt.value}
                  onChange={() => onScopeChange(opt.value)}
                />
                <span>
                  <span className="block font-mono text-sm text-signal-green">{opt.label}</span>
                  <span className="block font-mono text-[11px] text-signal-green/40">{opt.hint}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset>
          <legend className="mb-2 text-[11px] uppercase tracking-widest text-signal-green/50">
            What should we extract?
          </legend>
          <div className="flex flex-wrap gap-2">
            {CONTENT_OPTIONS.map((opt) => (
              <Chip key={opt.value} active={contentTypes.includes(opt.value)} onClick={() => toggleContentType(opt.value)}>
                {opt.label}
              </Chip>
            ))}
          </div>
        </fieldset>

        <div>
          <button
            type="button"
            onClick={() => setShowAdvanced((v) => !v)}
            className="font-mono text-[11px] uppercase tracking-widest text-signal-cyan/70 hover:text-signal-cyan"
          >
            {showAdvanced ? "▾" : "▸"} Advanced limits
          </button>
          {showAdvanced && (
            <div className="mt-3 grid grid-cols-3 gap-3">
              <NumberField
                label="Max pages"
                value={maxPages}
                min={1}
                max={MAX_PAGES_HARD_CAP}
                onChange={setMaxPages}
              />
              <NumberField
                label="Max depth"
                value={maxDepth}
                min={0}
                max={MAX_DEPTH_HARD_CAP}
                onChange={setMaxDepth}
              />
              <NumberField
                label="Req/s"
                value={rateLimitRps}
                min={1}
                max={RATE_LIMIT_RPS_HARD_CAP}
                onChange={setRateLimitRps}
              />
            </div>
          )}
        </div>

        <label className="flex cursor-pointer items-start gap-2 border border-signal-amber/25 bg-signal-amber/5 px-3 py-2.5">
          <input
            type="checkbox"
            checked={ack}
            onChange={(e) => setAck(e.target.checked)}
            className="mt-0.5 accent-signal-amber"
          />
          <span className="font-mono text-[11px] leading-relaxed text-signal-amber/90">
            I confirm this target is public, non-authenticated content. CRAWLR will not bypass logins,
            paywalls, or CAPTCHAs, and I&apos;m responsible for having the right to crawl it.
          </span>
        </label>

        {errorMessage && (
          <div className="border border-signal-red/30 bg-signal-red/5 px-3 py-2 font-mono text-xs text-signal-red">
            ERROR · {errorMessage}
          </div>
        )}

        <div className="flex justify-between">
          <Button onClick={onBack} disabled={submitting}>
            ← Back
          </Button>
          <Button
            variant="primary"
            disabled={!canRun}
            onClick={() => onRun({ maxPages, maxDepth, rateLimitRps })}
          >
            {submitting ? "Starting…" : "Run ▸"}
          </Button>
        </div>
      </div>
    </Panel>
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-widest text-signal-green/40">{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Math.min(max, Math.max(min, Number(e.target.value) || min)))}
        className="border border-signal-green/20 bg-void-950/80 px-2 py-1.5 font-mono text-xs text-signal-green outline-none focus:border-signal-green"
      />
    </label>
  );
}
