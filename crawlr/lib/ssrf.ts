/**
 * SSRF safety module.
 *
 * Every server-side fetch this app makes to an *untrusted, user-supplied* URL
 * (crawl targets, robots.txt, sitemap.xml, image fetches for the ZIP bundle)
 * MUST go through `safeFetch()` in this file. Do not call the global `fetch`
 * directly on user input anywhere else in the codebase.
 *
 * Threats mitigated:
 *  - Non-http(s) schemes (file:, gopher:, ftp:, data:, etc).
 *  - Requests to private/loopback/link-local/multicast/reserved IP ranges,
 *    including the cloud metadata address 169.254.169.254 specifically.
 *  - DNS rebinding: the IP we validate is the exact IP we connect to (pinned
 *    via a custom `lookup` on the Node http(s) client) - we never re-resolve
 *    the hostname between the safety check and the actual socket connect.
 *  - Open redirects to unsafe targets: every redirect hop is manually
 *    followed and independently re-validated (scheme, port, DNS, IP range).
 *  - Unbounded response time / size: hard timeout and byte cap, aborting the
 *    stream mid-flight if exceeded.
 *  - Non-standard ports: only 80/443 are allowed unless the *original*
 *    user-supplied URL explicitly specified a different port.
 */

import * as http from "node:http";
import * as https from "node:https";
import { promises as dns } from "node:dns";
import * as net from "node:net";
import {
  DEFAULT_ALLOWED_PORTS,
  FETCH_TIMEOUT_MS,
  MAX_REDIRECTS,
  MAX_RESPONSE_BYTES,
} from "./constants";

export type SsrfErrorCode =
  | "invalid_url"
  | "invalid_scheme"
  | "invalid_port"
  | "dns_resolution_failed"
  | "unsafe_ip"
  | "too_many_redirects"
  | "redirect_missing_location"
  | "timeout"
  | "response_too_large"
  | "fetch_failed";

export class SsrfError extends Error {
  readonly code: SsrfErrorCode;

  constructor(message: string, code: SsrfErrorCode) {
    super(message);
    this.name = "SsrfError";
    this.code = code;
  }
}

export interface SafeFetchOptions {
  method?: "GET" | "HEAD";
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  headers?: Record<string, string>;
}

export interface SafeFetchResult {
  /** The final URL after following redirects, as a string. */
  finalUrl: string;
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  /** True if the body was truncated because maxBytes was reached (only for callers that opt into truncation instead of erroring - unused today, reserved). */
  truncated: boolean;
}

interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

// ---------------------------------------------------------------------------
// IPv4 range checks
// ---------------------------------------------------------------------------

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    result = (result << 8) | n;
  }
  return result >>> 0;
}

function ipv4InCidr(ip: string, cidr: string): boolean {
  const [range, bitsStr] = cidr.split("/");
  const bits = Number(bitsStr);
  const ipInt = ipv4ToInt(ip);
  const rangeInt = ipv4ToInt(range as string);
  if (ipInt === null || rangeInt === null) return false;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipInt & mask) === (rangeInt & mask);
}

/**
 * IPv4 ranges we refuse to connect to: private, loopback, link-local
 * (including the 169.254.169.254 cloud metadata address), multicast,
 * documentation/benchmark reserved ranges, and CGNAT space.
 */
const IPV4_BLOCKED_CIDRS = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.0.2.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/4",
  "240.0.0.0/4",
  "255.255.255.255/32",
];

function isBlockedIpv4(ip: string): boolean {
  return IPV4_BLOCKED_CIDRS.some((cidr) => ipv4InCidr(ip, cidr));
}

// ---------------------------------------------------------------------------
// IPv6 range checks (full 128-bit parsing so compressed/mixed notations and
// IPv4-mapped addresses can't sneak past a naive string-prefix check).
// ---------------------------------------------------------------------------

function parseIpv6(ip: string): bigint | null {
  let addr = ip;
  if (addr.startsWith("[") && addr.endsWith("]")) addr = addr.slice(1, -1);

  // Handle IPv4-mapped / embedded tail, e.g. ::ffff:192.168.1.1
  let ipv4Tail: string | null = null;
  const lastColon = addr.lastIndexOf(":");
  if (lastColon !== -1 && addr.slice(lastColon + 1).includes(".")) {
    ipv4Tail = addr.slice(lastColon + 1);
    const asInt = ipv4ToInt(ipv4Tail);
    if (asInt === null) return null;
    const hex = asInt.toString(16).padStart(8, "0");
    addr = `${addr.slice(0, lastColon + 1)}${hex.slice(0, 4)}:${hex.slice(4)}`;
  }

  const doubleColonParts = addr.split("::");
  if (doubleColonParts.length > 2) return null;

  let head: string[] = doubleColonParts[0] ? doubleColonParts[0].split(":").filter((s) => s !== "") : [];
  let tail: string[] = doubleColonParts.length === 2 && doubleColonParts[1]
    ? doubleColonParts[1].split(":").filter((s) => s !== "")
    : [];

  if (doubleColonParts.length === 1) {
    head = addr.split(":");
    if (head.length !== 8) return null;
    tail = [];
  } else {
    const missing = 8 - (head.length + tail.length);
    if (missing < 0) return null;
  }

  const groups = doubleColonParts.length === 2
    ? [...head, ...Array(8 - head.length - tail.length).fill("0"), ...tail]
    : head;

  if (groups.length !== 8) return null;

  let value = 0n;
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    value = (value << 16n) | BigInt(parseInt(g, 16));
  }
  return value;
}

function ipv6InCidr(ip: string, cidr: string): boolean {
  const [range, bitsStr] = cidr.split("/");
  const bits = BigInt(Number(bitsStr));
  const ipVal = parseIpv6(ip);
  const rangeVal = parseIpv6(range as string);
  if (ipVal === null || rangeVal === null) return false;
  if (bits === 0n) return true;
  const shift = 128n - bits;
  const mask = shift >= 128n ? 0n : (((1n << bits) - 1n) << shift);
  return (ipVal & mask) === (rangeVal & mask);
}

const IPV6_BLOCKED_CIDRS = [
  "::1/128", // loopback
  "::/128", // unspecified
  "64:ff9b::/96", // NAT64 well-known prefix
  "100::/64", // discard-only
  "2001:db8::/32", // documentation
  "fc00::/7", // unique local
  "fe80::/10", // link-local
  "ff00::/8", // multicast
];

function isBlockedIpv6(ip: string): boolean {
  const val = parseIpv6(ip);
  if (val === null) return true; // unparsable -> fail closed

  // Unwrap IPv4-mapped addresses (::ffff:a.b.c.d) and re-check under IPv4
  // rules, since e.g. ::ffff:169.254.169.254 must be blocked too.
  if ((val >> 32n) === 0xffffn) {
    const mapped = val & 0xffffffffn;
    const a = Number((mapped >> 24n) & 0xffn);
    const b = Number((mapped >> 16n) & 0xffn);
    const c = Number((mapped >> 8n) & 0xffn);
    const d = Number(mapped & 0xffn);
    return isBlockedIpv4(`${a}.${b}.${c}.${d}`);
  }

  return IPV6_BLOCKED_CIDRS.some((cidr) => ipv6InCidr(ip, cidr));
}

/**
 * Returns true if `ip` must never be connected to by this app.
 * Fails closed: anything unparsable is treated as unsafe.
 */
export function isBlockedIp(ip: string, family: 4 | 6): boolean {
  if (family === 4) return isBlockedIpv4(ip);
  return isBlockedIpv6(ip);
}

// ---------------------------------------------------------------------------
// URL / scheme / port validation
// ---------------------------------------------------------------------------

export function parseAndValidateScheme(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new SsrfError(`Malformed URL: ${rawUrl}`, "invalid_url");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new SsrfError(`Scheme not allowed: ${parsed.protocol}`, "invalid_scheme");
  }
  return parsed;
}

/**
 * Port is allowed if it's 80/443, or if it exactly matches a port the
 * *original* user-supplied URL explicitly wrote out (URL.port is '' when the
 * URL relies on the scheme's default, so an explicit value here means the
 * user actually typed `:PORT`).
 */
export function isAllowedPort(url: URL, originalExplicitPort: string): boolean {
  const port = url.port === "" ? (url.protocol === "https:" ? "443" : "80") : url.port;
  const portNum = Number(port);
  if ((DEFAULT_ALLOWED_PORTS as readonly number[]).includes(portNum)) return true;
  if (originalExplicitPort !== "" && port === originalExplicitPort) return true;
  return false;
}

/**
 * `URL#hostname` keeps the `[...]` brackets for IPv6 literals (per Node's
 * implementation), but `net.isIP`, `dns.lookup`, and socket connect options
 * all expect the bracket-free form. Strip them before using any of those.
 */
export function stripBrackets(hostname: string): string {
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    return hostname.slice(1, -1);
  }
  return hostname;
}

async function resolveAllAddresses(rawHostname: string): Promise<ResolvedAddress[]> {
  const hostname = stripBrackets(rawHostname);
  const literalFamily = net.isIP(hostname);
  if (literalFamily) {
    return [{ address: hostname, family: literalFamily as 4 | 6 }];
  }
  try {
    const results = await dns.lookup(hostname, { all: true, verbatim: true });
    return results.map((r) => ({ address: r.address, family: r.family as 4 | 6 }));
  } catch {
    throw new SsrfError(`DNS resolution failed for ${hostname}`, "dns_resolution_failed");
  }
}

/**
 * Resolves a hostname and validates every returned address is safe. Returns
 * the vetted address list (never empty on success) so the caller can pin the
 * connection to one of them.
 */
export async function resolveAndValidateHost(hostname: string): Promise<ResolvedAddress[]> {
  const addresses = await resolveAllAddresses(hostname);
  if (addresses.length === 0) {
    throw new SsrfError(`No addresses resolved for ${hostname}`, "dns_resolution_failed");
  }
  for (const { address, family } of addresses) {
    if (isBlockedIp(address, family)) {
      throw new SsrfError(
        `Resolved address ${address} for ${hostname} is in a blocked range`,
        "unsafe_ip",
      );
    }
  }
  return addresses;
}

/**
 * Full pre-flight validation for a single URL hop: scheme, port, DNS
 * resolution, and IP-range safety. Returns the vetted address to pin the
 * connection to (prefers IPv4 for predictability).
 */
export async function validateUrlHop(
  url: URL,
  originalExplicitPort: string,
): Promise<ResolvedAddress> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SsrfError(`Scheme not allowed: ${url.protocol}`, "invalid_scheme");
  }
  if (!isAllowedPort(url, originalExplicitPort)) {
    throw new SsrfError(`Port not allowed: ${url.port || "(default)"}`, "invalid_port");
  }
  const addresses = await resolveAndValidateHost(url.hostname);
  return addresses.find((a) => a.family === 4) ?? addresses[0]!;
}

// ---------------------------------------------------------------------------
// The actual safe fetch, with manual redirect following and IP pinning.
// ---------------------------------------------------------------------------

export interface RawHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  location: string | null;
}

export type PerformRequestFn = (
  url: URL,
  pinnedAddress: ResolvedAddress,
  method: "GET" | "HEAD",
  headers: Record<string, string>,
  timeoutMs: number,
  maxBytes: number,
) => Promise<RawHttpResponse>;

function requestOnce(
  url: URL,
  pinnedAddress: ResolvedAddress,
  method: "GET" | "HEAD",
  headers: Record<string, string>,
  timeoutMs: number,
  maxBytes: number,
): Promise<RawHttpResponse> {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === "https:" ? https : http;
    const connectHostname = stripBrackets(url.hostname);
    // Host header should include the port only when it's non-default.
    const hostHeader = url.port ? url.host : url.hostname;

    const req = transport.request(
      {
        protocol: url.protocol,
        hostname: connectHostname,
        host: connectHostname,
        servername: connectHostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method,
        headers: { ...headers, Host: hostHeader },
        // Pin the connection to the exact address we already vetted, instead
        // of letting Node re-resolve the hostname at connect time (which is
        // exactly the TOCTOU gap DNS-rebinding attacks rely on).
        lookup: (_hostname, _opts, callback) => {
          callback(null, pinnedAddress.address, pinnedAddress.family);
        },
        timeout: timeoutMs,
      } as http.RequestOptions,
      (res) => {
        const chunks: Buffer[] = [];
        let received = 0;
        let destroyed = false;

        res.on("data", (chunk: Buffer) => {
          if (destroyed) return;
          received += chunk.length;
          if (received > maxBytes) {
            destroyed = true;
            res.destroy();
            reject(new SsrfError("Response exceeded max size", "response_too_large"));
            return;
          }
          chunks.push(chunk);
        });

        res.on("end", () => {
          if (destroyed) return;
          const normalizedHeaders: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            if (typeof v === "string") normalizedHeaders[k.toLowerCase()] = v;
            else if (Array.isArray(v)) normalizedHeaders[k.toLowerCase()] = v.join(", ");
          }
          resolve({
            status: res.statusCode ?? 0,
            headers: normalizedHeaders,
            body: Buffer.concat(chunks),
            location: normalizedHeaders.location ?? null,
          });
        });

        res.on("error", (err) => {
          if (!destroyed) reject(new SsrfError(`Response stream error: ${err.message}`, "fetch_failed"));
        });
      },
    );

    req.on("timeout", () => {
      req.destroy();
      reject(new SsrfError("Request timed out", "timeout"));
    });

    req.on("error", (err) => {
      reject(new SsrfError(`Request failed: ${err.message}`, "fetch_failed"));
    });

    // Belt-and-suspenders hard deadline: the `timeout` option above only
    // fires on socket *idle* time, so a slow-drip response could otherwise
    // stay "active" indefinitely. This timer bounds total request time.
    const hardDeadline = setTimeout(() => {
      req.destroy();
      reject(new SsrfError("Request exceeded hard deadline", "timeout"));
    }, timeoutMs);
    req.on("close", () => clearTimeout(hardDeadline));

    req.end();
  });
}

/**
 * SSRF-safe fetch. Validates scheme/port/DNS/IP-range before every hop
 * (including redirects), pins each connection to its vetted IP, enforces a
 * timeout and a max response size.
 *
 * `performRequest` is an internal seam (defaults to the real HTTP transport)
 * so tests can exercise the redirect/timeout/size-cap/per-hop-revalidation
 * logic without opening real sockets - it never bypasses the scheme/port/DNS/
 * IP-range validation above it, which always runs for real.
 */
export async function safeFetch(
  rawUrl: string,
  options: SafeFetchOptions = {},
  performRequest: PerformRequestFn = requestOnce,
): Promise<SafeFetchResult> {
  const method = options.method ?? "GET";
  const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? MAX_RESPONSE_BYTES;
  const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS;

  const originalUrl = parseAndValidateScheme(rawUrl);
  const originalExplicitPort = originalUrl.port;

  let currentUrl = originalUrl;
  let hops = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const pinned = await validateUrlHop(currentUrl, originalExplicitPort);
    const result = await performRequest(
      currentUrl,
      pinned,
      method,
      options.headers ?? {},
      timeoutMs,
      maxBytes,
    );

    const isRedirect = [301, 302, 303, 307, 308].includes(result.status);
    if (!isRedirect) {
      return {
        finalUrl: currentUrl.toString(),
        status: result.status,
        headers: result.headers,
        body: result.body,
        truncated: false,
      };
    }

    hops += 1;
    if (hops > maxRedirects) {
      throw new SsrfError(`Too many redirects (>${maxRedirects})`, "too_many_redirects");
    }
    if (!result.location) {
      throw new SsrfError("Redirect response missing Location header", "redirect_missing_location");
    }

    currentUrl = new URL(result.location, currentUrl);
  }
}

/**
 * Lightweight check usable before doing any network I/O, e.g. to reject
 * obviously-bad input at the API boundary before it hits the fetch pipeline.
 */
export function isSyntacticallySafeUrl(rawUrl: string): boolean {
  try {
    parseAndValidateScheme(rawUrl);
    return true;
  } catch {
    return false;
  }
}
