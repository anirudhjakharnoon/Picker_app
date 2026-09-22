/**
 * Per-domain token-bucket rate limiter.
 *
 * A crawl job only ever targets one root_domain (scope is "page", "linked",
 * or "site" - all confined to `crawl_jobs.root_domain`), so "per-domain"
 * pacing is applied within each tick invocation's own fetch loop, seeded
 * from that job's `rate_limit_rps` (itself clamped to the hard cap below
 * regardless of what the client requested). Buckets are kept in a
 * module-level, per-process, per-domain map: since each tick is a fresh
 * serverless invocation, this bucket only paces requests *within* one
 * tick's batch (documented limitation - it does not persist state across
 * invocations, which the given schema has no dedicated column for; batch
 * size and rps together are chosen so sustained throughput across
 * back-to-back ticks still tracks the configured rate closely).
 */

import { DEFAULT_RATE_LIMIT_RPS, RATE_LIMIT_RPS_HARD_CAP } from "./constants";

/** Clamps a client-requested rate to the server-enforced hard cap. */
export function clampRatePerSecond(requestedRps: number): number {
  if (!Number.isFinite(requestedRps) || requestedRps <= 0) return DEFAULT_RATE_LIMIT_RPS;
  return Math.min(requestedRps, RATE_LIMIT_RPS_HARD_CAP);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class TokenBucket {
  private tokens: number;
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private lastRefillAtMs: number;

  constructor(requestsPerSecond: number, now: number = Date.now()) {
    const rps = clampRatePerSecond(requestsPerSecond);
    this.capacity = Math.max(1, rps);
    this.tokens = this.capacity;
    this.refillPerMs = rps / 1000;
    this.lastRefillAtMs = now;
  }

  private refill(now: number): void {
    const elapsed = now - this.lastRefillAtMs;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerMs);
    this.lastRefillAtMs = now;
  }

  /** Milliseconds until a token is available (0 if one is available now). */
  msUntilNextToken(now: number = Date.now()): number {
    this.refill(now);
    if (this.tokens >= 1) return 0;
    return Math.ceil((1 - this.tokens) / this.refillPerMs);
  }

  /** Consumes one token, sleeping first if none is currently available. */
  async take(): Promise<void> {
    const wait = this.msUntilNextToken();
    if (wait > 0) {
      await sleep(wait);
    }
    this.refill(Date.now());
    this.tokens = Math.max(0, this.tokens - 1);
  }
}

const bucketsByDomain = new Map<string, TokenBucket>();

export function getDomainRateLimiter(domain: string, requestsPerSecond: number): TokenBucket {
  const existing = bucketsByDomain.get(domain);
  if (existing) return existing;
  const bucket = new TokenBucket(requestsPerSecond);
  bucketsByDomain.set(domain, bucket);
  return bucket;
}

/** Test-only: clears the in-process bucket registry between test cases. */
export function resetRateLimiterRegistry(): void {
  bucketsByDomain.clear();
}
