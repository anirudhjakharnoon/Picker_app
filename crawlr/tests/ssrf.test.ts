import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import * as http from "node:http";
import type { AddressInfo } from "node:net";

// Mocked-transport tests below use fake hostnames like "hop1.example" that
// don't exist in real DNS. Resolve them to a fixed public-looking address so
// those tests exercise the redirect/port/timeout logic deterministically and
// offline, without touching real DNS or sockets. Real IP literals (e.g.
// 169.254.169.254 used in the "unsafe redirect target" test) bypass DNS
// entirely via net.isIP and are unaffected by this mock.
vi.mock("node:dns", async () => {
  const actual = await vi.importActual<typeof import("node:dns")>("node:dns");
  return {
    ...actual,
    promises: {
      ...actual.promises,
      lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]),
    },
  };
});

import {
  isBlockedIp,
  isAllowedPort,
  parseAndValidateScheme,
  stripBrackets,
  safeFetch,
  SsrfError,
  type RawHttpResponse,
} from "../lib/ssrf";

describe("parseAndValidateScheme", () => {
  it("accepts http and https", () => {
    expect(parseAndValidateScheme("http://example.com/").protocol).toBe("http:");
    expect(parseAndValidateScheme("https://example.com/").protocol).toBe("https:");
  });

  it.each(["file:///etc/passwd", "ftp://example.com/", "javascript:alert(1)", "data:text/plain,hi", "gopher://example.com/"])(
    "rejects non-http(s) scheme: %s",
    (url) => {
      expect(() => parseAndValidateScheme(url)).toThrow(SsrfError);
    },
  );

  it("rejects malformed URLs", () => {
    expect(() => parseAndValidateScheme("not a url")).toThrow(SsrfError);
  });
});

describe("stripBrackets", () => {
  it("strips IPv6 brackets", () => {
    expect(stripBrackets("[::1]")).toBe("::1");
  });
  it("leaves plain hostnames alone", () => {
    expect(stripBrackets("example.com")).toBe("example.com");
  });
});

describe("isBlockedIp - IPv4", () => {
  it.each([
    ["127.0.0.1", "loopback"],
    ["127.255.255.255", "loopback range"],
    ["10.0.0.1", "private class A"],
    ["10.255.255.255", "private class A edge"],
    ["172.16.0.1", "private class B start"],
    ["172.31.255.255", "private class B end"],
    ["192.168.1.1", "private class C"],
    ["169.254.169.254", "cloud metadata address"],
    ["169.254.0.1", "link-local"],
    ["0.0.0.0", "unspecified"],
    ["100.64.0.1", "CGNAT shared address space"],
    ["192.0.2.1", "TEST-NET-1"],
    ["198.51.100.1", "TEST-NET-2"],
    ["203.0.113.1", "TEST-NET-3"],
    ["198.18.0.1", "benchmarking"],
    ["224.0.0.1", "multicast"],
    ["240.0.0.1", "reserved"],
    ["255.255.255.255", "broadcast"],
  ])("blocks %s (%s)", (ip) => {
    expect(isBlockedIp(ip, 4)).toBe(true);
  });

  it.each([
    ["8.8.8.8", "public DNS"],
    ["1.1.1.1", "public DNS"],
    ["93.184.216.34", "public web host"],
    ["172.15.255.255", "just outside private range"],
    ["172.32.0.0", "just outside private range"],
  ])("allows %s (%s)", (ip) => {
    expect(isBlockedIp(ip, 4)).toBe(false);
  });
});

describe("isBlockedIp - IPv6", () => {
  it.each([
    ["::1", "loopback"],
    ["::", "unspecified"],
    ["fe80::1", "link-local"],
    ["fe80::abcd:1234", "link-local"],
    ["fc00::1", "unique local"],
    ["fd00::1", "unique local"],
    ["ff02::1", "multicast"],
    ["::ffff:127.0.0.1", "IPv4-mapped loopback"],
    ["::ffff:169.254.169.254", "IPv4-mapped cloud metadata"],
    ["::ffff:10.0.0.1", "IPv4-mapped private"],
    ["2001:db8::1", "documentation range"],
  ])("blocks %s (%s)", (ip) => {
    expect(isBlockedIp(ip, 6)).toBe(true);
  });

  it.each([
    ["2001:4860:4860::8888", "Google public DNS"],
    ["2606:4700:4700::1111", "Cloudflare public DNS"],
    ["::ffff:8.8.8.8", "IPv4-mapped public"],
  ])("allows %s (%s)", (ip) => {
    expect(isBlockedIp(ip, 6)).toBe(false);
  });
});

describe("isAllowedPort", () => {
  it("allows default ports with no explicit original port", () => {
    expect(isAllowedPort(new URL("http://example.com/"), "")).toBe(true);
    expect(isAllowedPort(new URL("https://example.com/"), "")).toBe(true);
  });

  it("rejects a non-standard port when the original URL had none", () => {
    expect(isAllowedPort(new URL("http://example.com:8080/"), "")).toBe(false);
  });

  it("allows a non-standard port only if it matches the original explicit port", () => {
    expect(isAllowedPort(new URL("http://example.com:8080/"), "8080")).toBe(true);
    expect(isAllowedPort(new URL("http://example.com:9090/"), "8080")).toBe(false);
  });
});

describe("URL parser neutralizes IP-obfuscation tricks", () => {
  it.each([
    ["http://2130706433/", "127.0.0.1"], // decimal
    ["http://0x7f000001/", "127.0.0.1"], // hex
    ["http://0177.0.0.1/", "127.0.0.1"], // octal
    ["http://127.1/", "127.0.0.1"], // short form
  ])("normalizes %s to %s, which is then blocked", (raw, expectedIp) => {
    const url = parseAndValidateScheme(raw);
    expect(url.hostname).toBe(expectedIp);
    expect(isBlockedIp(url.hostname, 4)).toBe(true);
  });
});

describe("safeFetch - end-to-end blocking of real loopback targets", () => {
  let server: http.Server;
  let port: number;

  beforeEach(async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("should never be reached");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("rejects a request to a real local server bound to loopback, even though the explicit port matches the original URL", async () => {
    // The port is allowed (it's explicit in the original URL, matching
    // itself), so this proves the IP-range check - not just the port check -
    // is what blocks it.
    const err = await safeFetch(`http://127.0.0.1:${port}/`, {}).catch((e) => e);
    expect(err).toBeInstanceOf(SsrfError);
    expect((err as SsrfError).code).toBe("unsafe_ip");
  });
});

describe("safeFetch - redirect chain, timeout, and size cap (mocked transport)", () => {
  function mockResponse(overrides: Partial<RawHttpResponse>): RawHttpResponse {
    return {
      status: 200,
      headers: {},
      body: Buffer.from(""),
      location: null,
      ...overrides,
    };
  }

  it("follows a redirect chain to a safe target and returns the final response", async () => {
    const performRequest = vi
      .fn()
      .mockResolvedValueOnce(mockResponse({ status: 302, location: "https://hop2.example/" }))
      .mockResolvedValueOnce(mockResponse({ status: 200, body: Buffer.from("final content") }));

    const result = await safeFetch("https://hop1.example/", {}, performRequest);
    expect(result.finalUrl).toBe("https://hop2.example/");
    expect(result.body.toString()).toBe("final content");
    expect(performRequest).toHaveBeenCalledTimes(2);
  });

  it("re-validates each redirect hop and rejects a redirect to a private IP", async () => {
    const performRequest = vi
      .fn()
      .mockResolvedValueOnce(mockResponse({ status: 302, location: "http://169.254.169.254/latest/meta-data" }));

    await expect(safeFetch("https://hop1.example/", {}, performRequest)).rejects.toMatchObject({
      code: "unsafe_ip",
    });
  });

  it("caps the number of redirects followed", async () => {
    const performRequest = vi.fn().mockImplementation(async (url: URL) =>
      mockResponse({ status: 302, location: `${url.toString()}?n=${Math.random()}` }),
    );

    await expect(
      safeFetch("https://hop1.example/", { maxRedirects: 2 }, performRequest),
    ).rejects.toMatchObject({ code: "too_many_redirects" });
    // 1 initial request + 2 allowed redirect hops = 3 calls before giving up
    expect(performRequest.mock.calls.length).toBe(3);
  });

  it("rejects a redirect response missing a Location header", async () => {
    const performRequest = vi.fn().mockResolvedValueOnce(mockResponse({ status: 302, location: null }));
    await expect(safeFetch("https://hop1.example/", {}, performRequest)).rejects.toMatchObject({
      code: "redirect_missing_location",
    });
  });

  it("propagates timeout errors from the transport", async () => {
    const performRequest = vi.fn().mockRejectedValueOnce(new SsrfError("timed out", "timeout"));
    await expect(safeFetch("https://hop1.example/", {}, performRequest)).rejects.toMatchObject({
      code: "timeout",
    });
  });

  it("propagates response-too-large errors from the transport", async () => {
    const performRequest = vi
      .fn()
      .mockRejectedValueOnce(new SsrfError("too big", "response_too_large"));
    await expect(safeFetch("https://hop1.example/", {}, performRequest)).rejects.toMatchObject({
      code: "response_too_large",
    });
  });

  it("only allows a non-default port across redirects if the ORIGINAL url had it explicitly", async () => {
    const performRequest = vi
      .fn()
      .mockResolvedValueOnce(mockResponse({ status: 302, location: "https://hop2.example:8443/" }));

    // original had no explicit port -> redirect to :8443 must be rejected
    await expect(safeFetch("https://hop1.example/", {}, performRequest)).rejects.toMatchObject({
      code: "invalid_port",
    });
  });

  it("allows a redirect to keep the same explicit non-default port as the original URL", async () => {
    const performRequest = vi
      .fn()
      .mockResolvedValueOnce(mockResponse({ status: 302, location: "https://hop2.example:8443/next" }))
      .mockResolvedValueOnce(mockResponse({ status: 200, body: Buffer.from("ok") }));

    const result = await safeFetch("https://hop1.example:8443/", {}, performRequest);
    expect(result.body.toString()).toBe("ok");
  });
});
