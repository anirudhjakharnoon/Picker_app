import { describe, expect, it, vi, beforeEach } from "vitest";
import { parseRobotsTxt, buildRobotsRules, getRobotsRules } from "../lib/robots";
import * as ssrfModule from "../lib/ssrf";

describe("parseRobotsTxt + buildRobotsRules", () => {
  it("allows everything when the file is empty", () => {
    const rules = buildRobotsRules(parseRobotsTxt(""), "CrawlrBot/1.0");
    expect(rules.isAllowed("/anything")).toBe(true);
  });

  it("respects a wildcard group's Disallow", () => {
    const content = `
      User-agent: *
      Disallow: /private/
    `;
    const rules = buildRobotsRules(parseRobotsTxt(content), "CrawlrBot/1.0");
    expect(rules.isAllowed("/private/secret")).toBe(false);
    expect(rules.isAllowed("/public/page")).toBe(true);
  });

  it("prefers a bot-specific group over the wildcard group", () => {
    const content = `
      User-agent: *
      Disallow: /

      User-agent: CrawlrBot
      Disallow: /admin
      Allow: /
    `;
    const rules = buildRobotsRules(parseRobotsTxt(content), "CrawlrBot/1.0 (+https://x/about)");
    expect(rules.isAllowed("/anything")).toBe(true);
    expect(rules.isAllowed("/admin/panel")).toBe(false);
  });

  it("applies longest-match-wins between conflicting Allow/Disallow", () => {
    const content = `
      User-agent: *
      Disallow: /blog
      Allow: /blog/public
    `;
    const rules = buildRobotsRules(parseRobotsTxt(content), "CrawlrBot/1.0");
    expect(rules.isAllowed("/blog/private")).toBe(false);
    expect(rules.isAllowed("/blog/public/post-1")).toBe(true);
  });

  it("breaks ties between equal-length rules in favor of Allow", () => {
    const content = `
      User-agent: *
      Disallow: /x
      Allow: /x
    `;
    const rules = buildRobotsRules(parseRobotsTxt(content), "CrawlrBot/1.0");
    expect(rules.isAllowed("/x")).toBe(true);
  });

  it("supports wildcard (*) patterns", () => {
    const content = `
      User-agent: *
      Disallow: /*.pdf
    `;
    const rules = buildRobotsRules(parseRobotsTxt(content), "CrawlrBot/1.0");
    expect(rules.isAllowed("/files/report.pdf")).toBe(false);
    expect(rules.isAllowed("/files/report.html")).toBe(true);
  });

  it("supports the end-of-string ($) anchor", () => {
    const content = `
      User-agent: *
      Disallow: /page$
    `;
    const rules = buildRobotsRules(parseRobotsTxt(content), "CrawlrBot/1.0");
    expect(rules.isAllowed("/page")).toBe(false);
    expect(rules.isAllowed("/page/2")).toBe(true);
  });

  it("treats an empty Disallow value as no restriction", () => {
    const content = `
      User-agent: *
      Disallow:
    `;
    const rules = buildRobotsRules(parseRobotsTxt(content), "CrawlrBot/1.0");
    expect(rules.isAllowed("/anything")).toBe(true);
  });

  it("collects Sitemap directives regardless of grouping", () => {
    const content = `
      Sitemap: https://example.com/sitemap.xml
      User-agent: *
      Disallow: /admin
      Sitemap: https://example.com/sitemap-news.xml
    `;
    const { sitemaps } = parseRobotsTxt(content);
    expect(sitemaps).toEqual([
      "https://example.com/sitemap.xml",
      "https://example.com/sitemap-news.xml",
    ]);
  });

  it("ignores comments", () => {
    const content = `
      # this is a comment
      User-agent: * # inline comment
      Disallow: /secret # another comment
    `;
    const rules = buildRobotsRules(parseRobotsTxt(content), "CrawlrBot/1.0");
    expect(rules.isAllowed("/secret")).toBe(false);
    expect(rules.isAllowed("/open")).toBe(true);
  });
});

describe("getRobotsRules (caching + fetch failure handling)", () => {
  const domain = "example.com";

  function makeFakeSupabase(initialRow: Record<string, unknown> | null) {
    const upserted: Array<Record<string, unknown>> = [];
    const table = {
      select: () => table,
      eq: () => table,
      maybeSingle: async () => ({ data: initialRow }),
      upsert: async (row: Record<string, unknown>) => {
        upserted.push(row);
        return { data: row, error: null };
      },
    };
    return {
      from: () => table,
      _upserted: upserted,
    };
  }

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns cached rules without fetching when cache is fresh", async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const fakeSupabase = makeFakeSupabase({
      domain,
      robots_txt: "User-agent: *\nDisallow: /cached-block",
      sitemap_urls: [],
      fetched_at: new Date().toISOString(),
      expires_at: future,
    });
    const fetchSpy = vi.spyOn(ssrfModule, "safeFetch");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rules = await getRobotsRules(fakeSupabase as any, "https://example.com/page", "CrawlrBot/1.0");

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(rules.isAllowed("/cached-block")).toBe(false);
  });

  it("fetches, parses, and caches when there is no cache entry", async () => {
    const fakeSupabase = makeFakeSupabase(null);
    vi.spyOn(ssrfModule, "safeFetch").mockResolvedValue({
      finalUrl: "https://example.com/robots.txt",
      status: 200,
      headers: {},
      body: Buffer.from("User-agent: *\nDisallow: /fresh-block"),
      truncated: false,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rules = await getRobotsRules(fakeSupabase as any, "https://example.com/page", "CrawlrBot/1.0");

    expect(rules.isAllowed("/fresh-block")).toBe(false);
    expect(fakeSupabase._upserted).toHaveLength(1);
    expect(fakeSupabase._upserted[0]?.domain).toBe(domain);
  });

  it("treats a 404 as no robots.txt (allow all) and still caches", async () => {
    const fakeSupabase = makeFakeSupabase(null);
    vi.spyOn(ssrfModule, "safeFetch").mockResolvedValue({
      finalUrl: "https://example.com/robots.txt",
      status: 404,
      headers: {},
      body: Buffer.from(""),
      truncated: false,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rules = await getRobotsRules(fakeSupabase as any, "https://example.com/page", "CrawlrBot/1.0");

    expect(rules.isAllowed("/anything")).toBe(true);
    expect(fakeSupabase._upserted).toHaveLength(1);
  });

  it("fails CLOSED (disallow everything, no cache write) on a 5xx response", async () => {
    const fakeSupabase = makeFakeSupabase(null);
    vi.spyOn(ssrfModule, "safeFetch").mockResolvedValue({
      finalUrl: "https://example.com/robots.txt",
      status: 503,
      headers: {},
      body: Buffer.from(""),
      truncated: false,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rules = await getRobotsRules(fakeSupabase as any, "https://example.com/page", "CrawlrBot/1.0");

    expect(rules.isAllowed("/anything")).toBe(false);
    expect(fakeSupabase._upserted).toHaveLength(0);
  });

  it("fails CLOSED on a network/SSRF error, without caching", async () => {
    const fakeSupabase = makeFakeSupabase(null);
    vi.spyOn(ssrfModule, "safeFetch").mockRejectedValue(new Error("timeout"));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rules = await getRobotsRules(fakeSupabase as any, "https://example.com/page", "CrawlrBot/1.0");

    expect(rules.isAllowed("/anything")).toBe(false);
    expect(fakeSupabase._upserted).toHaveLength(0);
  });
});
