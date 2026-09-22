/**
 * Registrable-domain helpers used to decide "same site" for link scoping,
 * queueing, and rate-limit bucketing. Backed by `tldts`, which ships an
 * offline public-suffix-list snapshot (no network calls at runtime), so
 * `blog.example.co.uk` and `shop.example.co.uk` are correctly recognized as
 * the same site while `example.com` and `example.co.uk` are not.
 */

import { getDomain, parse } from "tldts";

/**
 * Returns the registrable domain (eTLD+1) for a URL or hostname, e.g.
 * "www.blog.example.co.uk" -> "example.co.uk". Returns null if it can't be
 * determined (e.g. bare IP literals - those are compared by exact hostname
 * instead, see `isSameRegistrableDomain`).
 */
export function registrableDomain(input: string): string | null {
  try {
    const hostname = input.includes("://") ? new URL(input).hostname : input;
    const parsed = parse(hostname);
    if (parsed.isIp) return hostname;
    return getDomain(hostname);
  } catch {
    return null;
  }
}

/**
 * True if both URLs share the same registrable domain (or, for IP-literal
 * hosts, the exact same host).
 */
export function isSameRegistrableDomain(urlA: string, urlB: string): boolean {
  const a = registrableDomain(urlA);
  const b = registrableDomain(urlB);
  if (a === null || b === null) return false;
  return a === b;
}
