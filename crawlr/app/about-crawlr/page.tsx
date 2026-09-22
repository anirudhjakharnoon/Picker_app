import Link from "next/link";
import {
  buildUserAgent,
  DEFAULT_MAX_PAGES,
  MAX_PAGES_HARD_CAP,
  DEFAULT_RATE_LIMIT_RPS,
  RATE_LIMIT_RPS_HARD_CAP,
} from "@/lib/constants";

export const metadata = {
  title: "About CRAWLR's crawler — CRAWLR",
};

export default function AboutCrawlrPage() {
  const userAgent = buildUserAgent(process.env.NEXT_PUBLIC_SITE_URL ?? "https://crawlr.example");

  return (
    <div className="mx-auto min-h-screen max-w-2xl px-6 py-16 font-mono text-sm leading-relaxed text-signal-green/80">
      <h1 className="mb-6 font-display text-2xl font-bold text-signal-green">About CRAWLR&apos;s crawler</h1>

      <p className="mb-4">
        This page exists because our crawler identifies itself with a User-Agent that links here:
      </p>
      <pre className="mb-6 overflow-x-auto border border-signal-green/20 bg-void-900/60 p-3 text-xs text-signal-cyan">
        {userAgent}
      </pre>

      <h2 className="mb-2 mt-8 font-display text-lg text-signal-green">What it does</h2>
      <p className="mb-4">
        CRAWLR is a user-initiated, on-demand content-extraction tool. A person pastes a URL, chooses a
        bounded scope (a single page, a page and its direct links, or a whole domain up to a hard page
        cap), and CRAWLR fetches and parses the resulting static HTML — nothing more.
      </p>

      <h2 className="mb-2 mt-8 font-display text-lg text-signal-green">What it will never do</h2>
      <ul className="mb-4 list-inside list-disc space-y-1">
        <li>Execute JavaScript or render pages — it parses raw HTML/DOM only.</li>
        <li>Bypass logins, paywalls, or CAPTCHAs.</li>
        <li>Ignore robots.txt — disallowed URLs are never fetched, only logged as skipped.</li>
        <li>Re-host images or video — every asset links straight back to its source.</li>
        <li>Spoof headers, rotate IPs, or otherwise evade detection or blocking.</li>
      </ul>

      <h2 className="mb-2 mt-8 font-display text-lg text-signal-green">How it behaves</h2>
      <ul className="mb-4 list-inside list-disc space-y-1">
        <li>
          Rate limit: {DEFAULT_RATE_LIMIT_RPS} requests/second per domain by default, hard-capped at{" "}
          {RATE_LIMIT_RPS_HARD_CAP} requests/second regardless of configuration.
        </li>
        <li>
          Page cap: {DEFAULT_MAX_PAGES} pages per run by default, hard-capped at {MAX_PAGES_HARD_CAP}.
        </li>
        <li>A single concurrent connection per domain at a time.</li>
        <li>Every crawl target is validated against SSRF: no private, loopback, or link-local IPs.</li>
      </ul>

      <h2 className="mb-2 mt-8 font-display text-lg text-signal-green">Blocking CRAWLR</h2>
      <p className="mb-4">
        Add a <code className="text-signal-cyan">Disallow</code> rule for this User-Agent (or for{" "}
        <code className="text-signal-cyan">*</code>) in your robots.txt and we will honor it on every
        subsequent run.
      </p>

      <Link href="/" className="mt-8 inline-block text-signal-cyan hover:underline">
        ← Back to CRAWLR
      </Link>
    </div>
  );
}
