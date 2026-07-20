/**
 * Product search proxy for the skincare add form's Amazon-style autofill.
 *
 * Source: Open Beauty Facts (openbeautyfacts.org) — a free, open cosmetics
 * catalog, no API key, sister project to Open Food Facts. We hit the legacy
 * `cgi/search.pl` full-text endpoint (the v2 `/api/v2/search` does not rank
 * free-text terms and returns near-random rows). Mirrors the free-API-proxy
 * pattern in integrations/geocode.ts (OSM Nominatim + User-Agent header).
 *
 * Contract: always resolves. Any upstream failure/timeout/parse error yields
 * an empty list so the frontend degrades to manual entry — never a 5xx.
 */

export interface ProductSuggestion {
  name: string;
  brand: string | null;
  imageUrl: string | null;
}

interface OBFProduct {
  product_name?: string | null;
  brands?: string | null;
  image_front_small_url?: string | null;
  image_front_url?: string | null;
  code?: string | null;
}

const OBF_SEARCH_URL = "https://world.openbeautyfacts.org/cgi/search.pl";
const TIMEOUT_MS = 5000;
const MAX_RESULTS = 8;
const CACHE_TTL_MS = 10 * 60_000;
// Hard cap on cached queries. Expiry is only checked on read, so without a cap
// a distinct query that is never searched again lingers forever — an unbounded
// leak on a long-running Railway instance. 500 distinct autofill terms is far
// more than this personal site ever holds live yet keeps the map tiny.
const MAX_CACHE_ENTRIES = 500;

// Normalized-query -> { results, expiresAt }. In-memory only (single Railway
// instance); a restart drops the cache, which is fine — it's a latency
// optimization, not a correctness requirement.
const cache = new Map<string, { results: ProductSuggestion[]; expiresAt: number }>();

/**
 * Insert a cache entry while keeping the map bounded. delete-then-set refreshes
 * insertion order so it tracks write-recency (a re-cached query moves to the
 * back). When over capacity, sweep expired entries first, then FIFO-evict the
 * oldest-inserted keys until back under the cap.
 */
function cacheSet(query: string, results: ProductSuggestion[], now: number): void {
  cache.delete(query);
  cache.set(query, { results, expiresAt: now + CACHE_TTL_MS });
  if (cache.size <= MAX_CACHE_ENTRIES) return;

  for (const [key, entry] of cache) {
    if (cache.size <= MAX_CACHE_ENTRIES) break;
    if (entry.expiresAt <= now) cache.delete(key);
  }
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function normalizeQuery(q: string): string {
  return q.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Map a raw OBF row to a suggestion, dropping rows with no usable name.
 * Brands is a comma-joined string upstream; we keep the first brand only.
 */
function toSuggestion(p: OBFProduct): ProductSuggestion | null {
  const name = (p.product_name ?? "").trim();
  if (!name) return null;
  const brand = (p.brands ?? "").split(",")[0]?.trim() || null;
  const imageUrl = (p.image_front_small_url ?? p.image_front_url ?? "").trim() || null;
  return { name, brand, imageUrl };
}

/**
 * De-dupe by (lowercased name + brand) so the near-identical rows OBF returns
 * for the same product across locales collapse to one suggestion.
 */
function dedupe(items: ProductSuggestion[]): ProductSuggestion[] {
  const seen = new Set<string>();
  const out: ProductSuggestion[] = [];
  for (const item of items) {
    const key = `${item.name.toLowerCase()}|${(item.brand ?? "").toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

export async function searchProducts(rawQuery: string): Promise<ProductSuggestion[]> {
  const query = normalizeQuery(rawQuery);
  if (query.length < 2) return [];

  const now = Date.now();
  const cached = cache.get(query);
  if (cached && cached.expiresAt > now) return cached.results;

  let results: ProductSuggestion[] = [];
  try {
    const params = new URLSearchParams({
      search_terms: query,
      json: "1",
      page_size: String(MAX_RESULTS * 2), // over-fetch; dedupe then trim
      fields: "product_name,brands,image_front_small_url,image_front_url,code",
    });
    const res = await fetch(`${OBF_SEARCH_URL}?${params.toString()}`, {
      headers: { "User-Agent": "ShaneLiPersonalWebsite/1.0" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.ok) {
      const data = (await res.json()) as { products?: OBFProduct[] };
      const mapped = (data.products ?? [])
        .map(toSuggestion)
        .filter((s): s is ProductSuggestion => s !== null);
      results = dedupe(mapped).slice(0, MAX_RESULTS);
    }
  } catch {
    // Timeout, network error, or bad JSON — degrade to manual entry.
    results = [];
  }

  // Only cache non-empty results: a transient upstream blip shouldn't pin an
  // empty list for 10 minutes when the next keystroke might succeed.
  if (results.length > 0) {
    cacheSet(query, results, now);
  }
  return results;
}

/** Test-only: clear the in-memory cache between cases. */
export function __resetSearchCache() {
  cache.clear();
}

/** Test-only: current number of cached entries (for bound assertions). */
export function __cacheSize() {
  return cache.size;
}

/** Test-only: expose the cap so tests don't hardcode the magic number. */
export const __MAX_CACHE_ENTRIES = MAX_CACHE_ENTRIES;
