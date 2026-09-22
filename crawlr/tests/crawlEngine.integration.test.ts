import { describe, expect, it, vi, beforeEach } from "vitest";
import { runTick } from "../lib/crawlEngine";
import { resetRateLimiterRegistry } from "../lib/rateLimiter";
import * as ssrfModule from "../lib/ssrf";
import { FakeSupabase } from "./helpers/fakeSupabase";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../lib/types";

const PAGE_HTML = `<!doctype html>
<html>
<head><title>Ocean Currents 101</title></head>
<body>
  <nav><a href="/">Home</a></nav>
  <article>
    <h1>Ocean Currents 101</h1>
    <p>Ocean currents move enormous volumes of water around the planet, driven by wind, the rotation of the
    Earth, and differences in water density caused by temperature and salinity, shaping climate patterns across
    every continent they touch.</p>
    <p>The Gulf Stream alone transports more water than all of the world's rivers combined, carrying warmth from
    the tropics up toward Northern Europe and keeping winters there far milder than their latitude would otherwise
    suggest.</p>
    <img src="/images/gulf-stream.png" alt="Gulf Stream map" />
    <video controls><source src="/videos/currents.mp4" type="video/mp4" /></video>
    <iframe src="https://www.youtube.com/embed/abc123"></iframe>
    <a href="/related/tides">Related: tides</a>
  </article>
  <footer>copyright</footer>
</body>
</html>`;

function makeJobRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "job-1",
    owner: "owner-1",
    created_at: new Date().toISOString(),
    target_url: "https://example.com/ocean-currents",
    root_domain: "example.com",
    scope: "page",
    content_types: ["text", "images", "video"],
    status: "running",
    max_pages: 500,
    max_depth: 3,
    rate_limit_rps: 50, // fast for tests
    pages_crawled: 0,
    pages_skipped: 0,
    pages_errored: 0,
    images_found: 0,
    videos_found: 0,
    text_bytes: 0,
    robots_disallowed: 0,
    started_at: new Date().toISOString(),
    finished_at: null,
    last_ticked_at: null,
    error_message: null,
    md_storage_path: null,
    md_size_bytes: null,
    ...overrides,
  };
}

function makeQueueRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 1,
    job_id: "job-1",
    url: "https://example.com/ocean-currents",
    normalized_url: "https://example.com/ocean-currents",
    depth: 0,
    status: "pending",
    discovered_from: null,
    http_status: null,
    skip_reason: null,
    fetched_at: null,
    ...overrides,
  };
}

describe("runTick - full small crawl integration (scope='page', mocked fetch)", () => {
  beforeEach(() => {
    resetRateLimiterRegistry();
    vi.restoreAllMocks();
  });

  it("crawls the single seed page, extracts text+images+video, and finalizes the job", async () => {
    vi.spyOn(ssrfModule, "safeFetch").mockImplementation(async (url: string) => {
      if (url.includes("robots.txt")) {
        return {
          finalUrl: url,
          status: 404,
          headers: {} as Record<string, string>,
          body: Buffer.from(""),
          truncated: false,
        };
      }
      return {
        finalUrl: url,
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
        body: Buffer.from(PAGE_HTML),
        truncated: false,
      };
    });

    const fake = new FakeSupabase({
      crawl_jobs: [makeJobRow()],
      crawl_queue: [makeQueueRow()],
    });

    const selfFetch = vi.fn();

    const result = await runTick(
      fake as unknown as SupabaseClient<Database>,
      "job-1",
      "https://crawlr.example",
      { selfFetch },
    );

    expect(result.finished).toBe(true);
    expect(result.status).toBe("completed");

    // Text extraction landed in crawl_pages.
    const pages = fake.getAll("crawl_pages");
    expect(pages).toHaveLength(1);
    expect(pages[0]?.title).toBe("Ocean Currents 101");
    expect(String(pages[0]?.markdown)).toContain("Gulf Stream");
    expect(String(pages[0]?.markdown)).not.toContain("copyright");

    // Image + video + embed assets landed in crawl_assets.
    const assets = fake.getAll("crawl_assets");
    expect(assets.find((a) => a.asset_type === "image" && a.asset_url === "https://example.com/images/gulf-stream.png")).toBeTruthy();
    expect(assets.find((a) => a.asset_type === "video" && a.asset_url === "https://example.com/videos/currents.mp4")).toBeTruthy();
    expect(assets.find((a) => a.asset_type === "video_embed")).toBeTruthy();

    // The queue row is marked done.
    const queueRows = fake.getAll("crawl_queue");
    expect(queueRows[0]?.status).toBe("done");
    expect(queueRows[0]?.http_status).toBe(200);

    // scope='page' must NOT enqueue the discovered /related/tides link.
    expect(queueRows).toHaveLength(1);

    // Counters were bumped atomically via RPC.
    const bumpCalls = fake.rpcCalls.filter((c) => c.name === "bump_job_counters");
    expect(bumpCalls).toHaveLength(1);
    expect((bumpCalls[0]?.args as { p_pages_crawled: number }).p_pages_crawled).toBe(1);

    // The final job row reflects completion + export metadata.
    const jobs = fake.getAll("crawl_jobs");
    expect(jobs[0]?.status).toBe("completed");
    expect(jobs[0]?.md_storage_path).toBe("job-1/output.md");
    expect(typeof jobs[0]?.md_size_bytes).toBe("number");
    expect((jobs[0]?.md_size_bytes as number)).toBeGreaterThan(0);

    // The assembled Markdown document was uploaded to Storage.
    const uploaded = fake.uploadedFiles.get("job-1/output.md");
    expect(uploaded).toBeTruthy();
    const doc = uploaded?.data.toString("utf-8") ?? "";
    expect(doc).toContain("# CRAWLR Export");
    expect(doc).toContain("Ocean Currents 101");
    expect(doc).toContain("Gulf Stream");

    // Because the job finished within this tick, no continuation was needed.
    expect(selfFetch).not.toHaveBeenCalled();
  });

  it("logs a crawl_events row for the page and a 'done' event on completion", async () => {
    vi.spyOn(ssrfModule, "safeFetch").mockImplementation(async (url: string) => {
      if (url.includes("robots.txt")) {
        return { finalUrl: url, status: 404, headers: {} as Record<string, string>, body: Buffer.from(""), truncated: false };
      }
      return {
        finalUrl: url,
        status: 200,
        headers: { "content-type": "text/html" },
        body: Buffer.from(PAGE_HTML),
        truncated: false,
      };
    });

    const fake = new FakeSupabase({
      crawl_jobs: [makeJobRow({ content_types: ["text"] })],
      crawl_queue: [makeQueueRow()],
    });

    await runTick(fake as unknown as SupabaseClient<Database>, "job-1", "https://crawlr.example", {
      selfFetch: vi.fn(),
    });

    const events = fake.getAll("crawl_events");
    expect(events.some((e) => e.kind === "extract")).toBe(true);
    expect(events.some((e) => e.kind === "done")).toBe(true);
  });

  it("skips a robots-disallowed page without fetching it", async () => {
    const fetchSpy = vi.spyOn(ssrfModule, "safeFetch").mockImplementation(async (url: string) => {
      if (url.includes("robots.txt")) {
        return {
          finalUrl: url,
          status: 200,
          headers: {} as Record<string, string>,
          body: Buffer.from("User-agent: *\nDisallow: /ocean-currents"),
          truncated: false,
        };
      }
      throw new Error("should never fetch a disallowed page");
    });

    const fake = new FakeSupabase({
      crawl_jobs: [makeJobRow()],
      crawl_queue: [makeQueueRow()],
    });

    const result = await runTick(fake as unknown as SupabaseClient<Database>, "job-1", "https://crawlr.example", {
      selfFetch: vi.fn(),
    });

    expect(result.finished).toBe(true);
    const queueRows = fake.getAll("crawl_queue");
    expect(queueRows[0]?.status).toBe("skipped");
    expect(queueRows[0]?.skip_reason).toBe("robots");
    expect(fake.getAll("crawl_pages")).toHaveLength(0);

    const bumpCalls = fake.rpcCalls.filter((c) => c.name === "bump_job_counters");
    expect((bumpCalls[0]?.args as { p_robots_disallowed: number }).p_robots_disallowed).toBe(1);

    // safeFetch was only ever called for robots.txt, never the page itself.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when the job is not in 'running' status", async () => {
    const fake = new FakeSupabase({
      crawl_jobs: [makeJobRow({ status: "aborted" })],
      crawl_queue: [makeQueueRow()],
    });

    const result = await runTick(fake as unknown as SupabaseClient<Database>, "job-1", "https://crawlr.example");

    expect(result.ranAtAll).toBe(false);
    expect(fake.getAll("crawl_queue")[0]?.status).toBe("pending");
  });

  it("triggers a self-fetch continuation when the frontier is not yet empty and time remains", async () => {
    vi.spyOn(ssrfModule, "safeFetch").mockImplementation(async (url: string) => {
      if (url.includes("robots.txt")) {
        return { finalUrl: url, status: 404, headers: {} as Record<string, string>, body: Buffer.from(""), truncated: false };
      }
      return {
        finalUrl: url,
        status: 200,
        headers: { "content-type": "text/html" },
        body: Buffer.from(PAGE_HTML),
        truncated: false,
      };
    });

    const fake = new FakeSupabase({
      crawl_jobs: [makeJobRow({ scope: "site" })],
      crawl_queue: [
        makeQueueRow({ id: 1, url: "https://example.com/page-1", normalized_url: "https://example.com/page-1" }),
        makeQueueRow({ id: 2, url: "https://example.com/page-2", normalized_url: "https://example.com/page-2" }),
      ],
    });

    const selfFetch = vi.fn();
    // Force the batch size ceiling to leave the second seeded row pending by
    // claiming only 1 at a time isn't configurable here, so instead assert
    // on the "site" scope discovering + enqueueing new links, which keeps
    // the frontier non-empty after this tick.
    const result = await runTick(fake as unknown as SupabaseClient<Database>, "job-1", "https://crawlr.example", {
      selfFetch,
    });

    expect(result.finished).toBe(false);
    expect(selfFetch).toHaveBeenCalledWith("job-1");

    // /related/tides was discovered from both pages and enqueued (deduped).
    const queueRows = fake.getAll("crawl_queue");
    expect(queueRows.some((r) => r.normalized_url === "https://example.com/related/tides")).toBe(true);
  });
});
