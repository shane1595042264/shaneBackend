// SHAN-582: user-supplied URLs must never reach the container's own files or
// the private network, on the first hop or any redirect.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockLookup } = vi.hoisted(() => ({ mockLookup: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: mockLookup }));

import {
  BlockedUrlError,
  httpUrlSchema,
  isPublicAddress,
  safeFetch,
} from "@/modules/shared/outbound-url";

const PUBLIC = [{ address: "93.184.216.34", family: 4 }];
const opts = { timeoutMs: 5000, maxBytes: 1024 };

const realFetch = global.fetch;
beforeEach(() => {
  vi.clearAllMocks();
  mockLookup.mockResolvedValue(PUBLIC);
});
afterEach(() => {
  global.fetch = realFetch;
});

describe("httpUrlSchema", () => {
  it.each(["https://example.com/a", "http://example.com", "  https://example.com/x  "])(
    "accepts %s",
    (u) => {
      expect(httpUrlSchema.safeParse(u).success).toBe(true);
    },
  );

  it.each(["file:///proc/self/environ", "javascript:alert(1)", "data:text/html,hi", "ftp://x.test", "not a url"])(
    "rejects %s",
    (u) => {
      expect(httpUrlSchema.safeParse(u).success).toBe(false);
    },
  );
});

describe("isPublicAddress", () => {
  it.each(["93.184.216.34", "8.8.8.8", "2606:4700::6810:85e5"])("public: %s", (ip) => {
    expect(isPublicAddress(ip)).toBe(true);
  });

  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "255.255.255.255",
    "::1",
    "::",
    "fd12:3456::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "::ffff:a00:1",
    "64:ff9b::a00:1",
    "not-an-ip",
  ])("blocked: %s", (ip) => {
    expect(isPublicAddress(ip)).toBe(false);
  });
});

describe("safeFetch", () => {
  it("returns the body of a public page", async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response("<h1>ok</h1>", { status: 200 })) as any;
    const res = await safeFetch("https://example.com/c", opts);
    expect(res).toMatchObject({ ok: true, status: 200, body: "<h1>ok</h1>" });
    expect((global.fetch as any).mock.calls[0][1].redirect).toBe("manual");
  });

  it.each([
    "http://localhost:8080/health",
    "http://postgres.railway.internal:5432/",
    "http://printer.local/",
    "http://127.0.0.1/",
    "http://[::1]/",
    "http://2130706433/",
    "http://169.254.169.254/latest/meta-data/",
    "file:///proc/self/environ",
  ])("refuses %s without fetching", async (u) => {
    global.fetch = vi.fn() as any;
    await expect(safeFetch(u, opts)).rejects.toBeInstanceOf(BlockedUrlError);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("refuses a public name that resolves to a private address", async () => {
    mockLookup.mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.5", family: 4 },
    ]);
    global.fetch = vi.fn() as any;
    await expect(safeFetch("https://sneaky.example/", opts)).rejects.toBeInstanceOf(BlockedUrlError);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("refuses a host that does not resolve", async () => {
    mockLookup.mockRejectedValue(new Error("ENOTFOUND"));
    global.fetch = vi.fn() as any;
    await expect(safeFetch("https://nowhere.example/", opts)).rejects.toBeInstanceOf(BlockedUrlError);
  });

  it("follows a public redirect and re-checks the next hop", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "/final" } }))
      .mockResolvedValueOnce(new Response("done", { status: 200 })) as any;
    const res = await safeFetch("https://example.com/start", opts);
    expect(res.body).toBe("done");
    expect(res.url).toBe("https://example.com/final");
    expect(mockLookup).toHaveBeenCalledTimes(2);
  });

  it("refuses a redirect into the private network", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, { status: 301, headers: { location: "http://169.254.169.254/" } }),
      ) as any;
    await expect(safeFetch("https://example.com/start", opts)).rejects.toBeInstanceOf(BlockedUrlError);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("refuses a redirect to file://", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "file:///etc/passwd" } })) as any;
    await expect(safeFetch("https://example.com/start", opts)).rejects.toBeInstanceOf(BlockedUrlError);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("gives up after too many redirects", async () => {
    global.fetch = vi.fn(async () => new Response(null, { status: 302, headers: { location: "/again" } })) as any;
    await expect(
      safeFetch("https://example.com/loop", { ...opts, maxRedirects: 2 }),
    ).rejects.toBeInstanceOf(BlockedUrlError);
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });

  it("truncates the body at maxBytes", async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response("x".repeat(5000), { status: 200 })) as any;
    const res = await safeFetch("https://example.com/big", opts);
    expect(res.body.length).toBe(1024);
  });

  it("returns non-2xx responses instead of throwing", async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response("nope", { status: 404 })) as any;
    const res = await safeFetch("https://example.com/missing", opts);
    expect(res).toMatchObject({ ok: false, status: 404 });
  });
});
