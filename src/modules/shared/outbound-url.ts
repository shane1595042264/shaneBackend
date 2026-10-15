/**
 * Outbound fetches of URLs a user typed (SHAN-582).
 *
 * Courses (classify-on-create) and the RNG scraper fetch whatever URL the
 * caller sends, from inside the Railway container. Two things made that
 * dangerous: z.string().url() accepts any scheme, and Bun's fetch reads
 * file:// URLs, so a course at file:///proc/self/environ fed the process
 * environment to the classifier and published its summary; and nothing kept
 * the fetch off loopback, link-local, RFC 1918 or the Railway private network
 * (the shared Postgres and the supersync service live there).
 *
 * - httpUrlSchema: the zod shape for a stored/fetched URL. http(s) only.
 * - safeFetch: refuses non-public hosts, re-checks every redirect hop itself
 *   (redirect: "follow" would let a public URL 302 inward unchecked), and
 *   bounds the whole exchange with a timeout and a byte cap on the body.
 *
 * DNS is resolved here and again by fetch, so a host that rebinds between the
 * two lookups can still slip through. Closing that needs pinning the socket to
 * the checked address, which Bun's fetch has no hook for; the check still
 * stops every static internal name and literal address.
 */
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { z } from "zod";

export class BlockedUrlError extends Error {}

function isHttpUrl(s: string): boolean {
  try {
    const proto = new URL(s).protocol;
    return proto === "http:" || proto === "https:";
  } catch {
    return false;
  }
}

export const httpUrlSchema = z
  .string()
  .trim()
  .url("Must be a valid URL")
  .max(2048, "URL too long")
  .refine(isHttpUrl, { message: "URL must use http or https" });

const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], // "this network", 0.0.0.0 reaches localhost
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // CGNAT, also Railway's private network
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local, cloud metadata
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 3], // multicast + reserved + broadcast
] as const) {
  blocked.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96], // NAT64, embeds an IPv4 address
  ["2002::", 16], // 6to4, embeds an IPv4 address
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["ff00::", 8], // multicast
] as const) {
  blocked.addSubnet(net, prefix, "ipv6");
}

/** The IPv4 address inside an IPv4-mapped IPv6 address, else null. */
function mappedIPv4(ip: string): string | null {
  const m = ip.toLowerCase().match(/^(?:0{0,4}:){0,5}:?ffff:(.+)$/);
  if (!m) return null;
  const tail = m[1];
  if (isIP(tail) === 4) return tail;
  const hex = tail.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (!hex) return null;
  const hi = parseInt(hex[1], 16);
  const lo = parseInt(hex[2], 16);
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

/** True when an IP literal is routable on the public internet. */
export function isPublicAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return !blocked.check(ip, "ipv4");
  if (family === 6) {
    const v4 = mappedIPv4(ip);
    if (v4) return !blocked.check(v4, "ipv4");
    return !blocked.check(ip, "ipv6");
  }
  return false;
}

const BLOCKED_SUFFIXES = [".localhost", ".internal", ".local"];

/** Throws BlockedUrlError unless `url` is http(s) on a public host. */
export async function assertPublicUrl(url: URL): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new BlockedUrlError(`Blocked scheme ${url.protocol}`);
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!host || host === "localhost" || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) {
    throw new BlockedUrlError(`Blocked host ${host}`);
  }
  if (isIP(host)) {
    if (!isPublicAddress(host)) throw new BlockedUrlError(`Blocked address ${host}`);
    return;
  }
  let addresses: { address: string }[];
  try {
    addresses = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new BlockedUrlError(`Could not resolve ${host}`);
  }
  if (addresses.length === 0 || addresses.some((a) => !isPublicAddress(a.address))) {
    throw new BlockedUrlError(`Blocked host ${host}`);
  }
}

export interface SafeFetchOptions {
  headers?: Record<string, string>;
  timeoutMs: number;
  /** Body bytes kept; anything past this is dropped, not an error. */
  maxBytes: number;
  maxRedirects?: number;
}

export interface SafeFetchResult {
  ok: boolean;
  status: number;
  statusText: string;
  /** The URL the body came from, after redirects. */
  url: string;
  body: string;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    const keep = value.subarray(0, maxBytes - total);
    chunks.push(keep);
    total += keep.length;
  }
  await reader.cancel().catch(() => {});
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.length;
  }
  return new TextDecoder().decode(bytes);
}

/**
 * GET a user-supplied URL without letting it reach anything private. Throws
 * BlockedUrlError for a refused host (any hop), and the underlying fetch error
 * for timeouts and network failures; callers map both to their own generic
 * message. Non-2xx responses are returned, not thrown, like fetch.
 */
export async function safeFetch(input: string, opts: SafeFetchOptions): Promise<SafeFetchResult> {
  const maxRedirects = opts.maxRedirects ?? 5;
  const signal = AbortSignal.timeout(opts.timeoutMs);
  let current: URL;
  try {
    current = new URL(input);
  } catch {
    throw new BlockedUrlError("Invalid URL");
  }

  for (let hop = 0; ; hop++) {
    await assertPublicUrl(current);
    const res = await fetch(current, { headers: opts.headers, redirect: "manual", signal });
    const location = res.headers.get("location");
    if (REDIRECT_STATUSES.has(res.status) && location) {
      await res.body?.cancel().catch(() => {});
      if (hop >= maxRedirects) throw new BlockedUrlError("Too many redirects");
      current = new URL(location, current);
      continue;
    }
    return {
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      url: current.toString(),
      body: await readCapped(res, opts.maxBytes),
    };
  }
}
