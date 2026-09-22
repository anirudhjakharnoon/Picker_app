import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  clampRatePerSecond,
  TokenBucket,
  getDomainRateLimiter,
  resetRateLimiterRegistry,
} from "../lib/rateLimiter";
import { DEFAULT_RATE_LIMIT_RPS, RATE_LIMIT_RPS_HARD_CAP } from "../lib/constants";

describe("clampRatePerSecond", () => {
  it("passes through a valid rate under the hard cap", () => {
    expect(clampRatePerSecond(3)).toBe(3);
  });

  it("hard-caps a rate above the server ceiling regardless of client input", () => {
    expect(clampRatePerSecond(1000)).toBe(RATE_LIMIT_RPS_HARD_CAP);
    expect(clampRatePerSecond(RATE_LIMIT_RPS_HARD_CAP + 0.01)).toBe(RATE_LIMIT_RPS_HARD_CAP);
  });

  it("falls back to the default for invalid input", () => {
    expect(clampRatePerSecond(0)).toBe(DEFAULT_RATE_LIMIT_RPS);
    expect(clampRatePerSecond(-5)).toBe(DEFAULT_RATE_LIMIT_RPS);
    expect(clampRatePerSecond(NaN)).toBe(DEFAULT_RATE_LIMIT_RPS);
  });
});

describe("TokenBucket", () => {
  it("allows an immediate take when tokens are available", async () => {
    const bucket = new TokenBucket(5);
    expect(bucket.msUntilNextToken()).toBe(0);
    await bucket.take();
  });

  it("computes a positive wait once the bucket is drained", () => {
    const start = 1_000_000;
    const bucket = new TokenBucket(2, start); // capacity 2, refill 0.002 tokens/ms
    // Drain both tokens without advancing time.
    bucket["tokens"] = 0;
    const wait = bucket.msUntilNextToken(start);
    expect(wait).toBeGreaterThan(0);
    // At 2 rps, one token every 500ms.
    expect(wait).toBeCloseTo(500, -1);
  });

  it("refills over elapsed time up to capacity", () => {
    const start = 1_000_000;
    const bucket = new TokenBucket(4, start);
    bucket["tokens"] = 0;
    const waitAt250ms = bucket.msUntilNextToken(start + 125); // 4rps -> 0.5 tokens after 125ms
    expect(waitAt250ms).toBeGreaterThan(0);
    const waitAt300ms = bucket.msUntilNextToken(start + 300); // 1.2 tokens after 300ms -> ready
    expect(waitAt300ms).toBe(0);
  });

  it("never exceeds capacity even after a long idle period", () => {
    const start = 1_000_000;
    const bucket = new TokenBucket(3, start);
    const farFuture = start + 10 * 60 * 1000;
    expect(bucket.msUntilNextToken(farFuture)).toBe(0);
    bucket["tokens"] = Math.min(bucket["tokens"], 999); // sanity: no runaway growth
    expect(bucket["tokens"]).toBeLessThanOrEqual(3);
  });

  it("actually sleeps when take() is called on a drained bucket", async () => {
    // Real (short) timers, to avoid fake-timer/async-await interleaving
    // pitfalls: at 20rps a token refills every 50ms, so this stays fast.
    const bucket = new TokenBucket(20);
    bucket["tokens"] = 0;

    const startedAt = Date.now();
    await bucket.take();
    const elapsedMs = Date.now() - startedAt;

    expect(elapsedMs).toBeGreaterThanOrEqual(40);
    expect(elapsedMs).toBeLessThan(500);
  });
});

describe("getDomainRateLimiter", () => {
  beforeEach(() => resetRateLimiterRegistry());
  afterEach(() => resetRateLimiterRegistry());

  it("returns the same bucket instance for the same domain", () => {
    const a = getDomainRateLimiter("example.com", 3);
    const b = getDomainRateLimiter("example.com", 3);
    expect(a).toBe(b);
  });

  it("returns independent buckets for different domains", () => {
    const a = getDomainRateLimiter("example.com", 3);
    const b = getDomainRateLimiter("other.com", 3);
    expect(a).not.toBe(b);
  });
});
