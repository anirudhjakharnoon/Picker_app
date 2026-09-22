import type { ContentType, CrawlScope } from "./types";

const VALID_SCOPES: CrawlScope[] = ["page", "linked", "site"];
const VALID_CONTENT_TYPES: ContentType[] = ["text", "images", "video"];

export function isValidScope(value: unknown): value is CrawlScope {
  return typeof value === "string" && (VALID_SCOPES as string[]).includes(value);
}

export function isValidContentTypes(value: unknown): value is ContentType[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((v) => typeof v === "string" && (VALID_CONTENT_TYPES as string[]).includes(v))
  );
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}
