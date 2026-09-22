/**
 * TypeScript mirrors of the exact Postgres schema in
 * supabase/migrations/0001_init.sql. Keep these in lockstep with the SQL -
 * this is the only place the shape of a DB row should be described in code.
 */

export type CrawlScope = "page" | "linked" | "site";
export type ContentType = "text" | "images" | "video";
export type JobStatus = "queued" | "probing" | "running" | "completed" | "failed" | "aborted";
export type QueueStatus = "pending" | "fetching" | "done" | "skipped" | "error";
export type SkipReason = "robots" | "depth" | "offsite" | "cap" | "duplicate" | "non_html" | "fetch_error";
export type AssetType = "image" | "video" | "video_embed";
export type EventKind = "fetch" | "extract" | "queue" | "skip" | "error" | "done";

export type CrawlJobRow = {
  id: string;
  owner: string;
  created_at: string;
  target_url: string;
  root_domain: string;
  scope: CrawlScope;
  content_types: ContentType[];
  status: JobStatus;
  max_pages: number;
  max_depth: number;
  rate_limit_rps: number;
  pages_crawled: number;
  pages_skipped: number;
  pages_errored: number;
  images_found: number;
  videos_found: number;
  text_bytes: number;
  robots_disallowed: number;
  started_at: string | null;
  finished_at: string | null;
  last_ticked_at: string | null;
  error_message: string | null;
  md_storage_path: string | null;
  md_size_bytes: number | null;
};

export type CrawlQueueRow = {
  id: number;
  job_id: string;
  url: string;
  normalized_url: string;
  depth: number;
  status: QueueStatus;
  discovered_from: string | null;
  http_status: number | null;
  skip_reason: SkipReason | null;
  fetched_at: string | null;
};

export type CrawlPageRow = {
  id: number;
  job_id: string;
  url: string;
  title: string | null;
  markdown: string | null;
  word_count: number | null;
  fetched_at: string;
};

export type CrawlAssetRow = {
  id: number;
  job_id: string;
  page_url: string;
  asset_type: AssetType;
  asset_url: string;
  alt_text: string | null;
  mime_type: string | null;
  discovered_at: string;
};

export type RobotsCacheRow = {
  domain: string;
  robots_txt: string | null;
  sitemap_urls: string[] | null;
  fetched_at: string;
  expires_at: string;
};

export type CrawlEventRow = {
  id: number;
  job_id: string;
  at: string;
  kind: EventKind;
  message: string;
};

export type JobRateLimitRow = {
  owner: string;
  window_start: string;
  job_count: number;
};

/** Row shape returned by the `try_consume_job_quota` RPC. */
export type JobQuotaResult = {
  allowed: boolean;
  retry_after_seconds: number;
};

export type BumpJobCountersArgs = {
  p_job_id: string;
  p_pages_crawled?: number;
  p_pages_skipped?: number;
  p_pages_errored?: number;
  p_images_found?: number;
  p_videos_found?: number;
  p_text_bytes?: number;
  p_robots_disallowed?: number;
};

export type Database = {
  public: {
    Tables: {
      crawl_jobs: {
        Row: CrawlJobRow;
        Insert: Partial<CrawlJobRow> &
          Pick<CrawlJobRow, "owner" | "target_url" | "root_domain" | "scope" | "content_types">;
        Update: Partial<CrawlJobRow>;
        Relationships: [];
      };
      crawl_queue: {
        Row: CrawlQueueRow;
        Insert: Partial<CrawlQueueRow> & Pick<CrawlQueueRow, "job_id" | "url" | "normalized_url">;
        Update: Partial<CrawlQueueRow>;
        Relationships: [];
      };
      crawl_pages: {
        Row: CrawlPageRow;
        Insert: Partial<CrawlPageRow> & Pick<CrawlPageRow, "job_id" | "url">;
        Update: Partial<CrawlPageRow>;
        Relationships: [];
      };
      crawl_assets: {
        Row: CrawlAssetRow;
        Insert: Partial<CrawlAssetRow> &
          Pick<CrawlAssetRow, "job_id" | "page_url" | "asset_type" | "asset_url">;
        Update: Partial<CrawlAssetRow>;
        Relationships: [];
      };
      robots_cache: {
        Row: RobotsCacheRow;
        Insert: Partial<RobotsCacheRow> & Pick<RobotsCacheRow, "domain" | "expires_at">;
        Update: Partial<RobotsCacheRow>;
        Relationships: [];
      };
      crawl_events: {
        Row: CrawlEventRow;
        Insert: Partial<CrawlEventRow> & Pick<CrawlEventRow, "job_id" | "kind" | "message">;
        Update: Partial<CrawlEventRow>;
        Relationships: [];
      };
      job_rate_limits: {
        Row: JobRateLimitRow;
        Insert: Partial<JobRateLimitRow> & Pick<JobRateLimitRow, "owner">;
        Update: Partial<JobRateLimitRow>;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: {
      try_consume_job_quota: {
        Args: { p_owner: string; p_max_jobs?: number; p_window_seconds?: number };
        Returns: JobQuotaResult[];
      };
      bump_job_counters: {
        Args: BumpJobCountersArgs;
        Returns: undefined;
      };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};
