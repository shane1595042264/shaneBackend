/**
 * Game art search for the scoreboard element (SHAN-435).
 *
 * Source: game-icons.net's ~4000 CC BY 3.0 SVG icons, listed via the
 * game-icons/icons GitHub repo tree (cached in memory, 24h TTL, stale
 * served on upstream failure) and fetched raw from
 * raw.githubusercontent.com. We never store or serve third-party SVG
 * markup: fetchIconPath extracts only the <path d> data (background
 * square stripped) plus the viewBox, and that text is what persists.
 * Mirrors the free-API-proxy pattern in skincare/search.ts.
 */

export interface IconCandidate {
  slug: string;
  previewUrl: string;
}

const TREE_URL =
  "https://api.github.com/repos/game-icons/icons/git/trees/master?recursive=1";
const RAW_BASE = "https://raw.githubusercontent.com/game-icons/icons/master";
const TREE_TTL_MS = 24 * 60 * 60_000;
const TIMEOUT_MS = 8000;
const MAX_RESULTS = 12;
// author/name, lowercase alnum + hyphens (game-icons naming). Blocks
// traversal and markup before the slug ever reaches a URL.
const SLUG_RE = /^[a-z0-9-]+\/[a-z0-9-]+$/;
// "M0 0h512v512H0z" with whitespace stripped and lowercased, matching how
// candidate paths are normalized before comparison below.
const BACKGROUND_D = "m00h512v512h0z";

let treeCache: { slugs: string[]; expiresAt: number } | null = null;

// Query-token expansions for games whose obvious name doesn't match the
// icon's filename. Values are extra tokens scored alongside the originals.
const SYNONYMS: Record<string, string[]> = {
  pool: ["8-ball", "billiard", "cue"],
  billiards: ["8-ball", "cue"],
  snooker: ["8-ball", "cue"],
  pingpong: ["ping-pong"],
  foosball: ["soccer", "table"],
  darts: ["dart"],
  cards: ["card", "poker"],
  poker: ["poker", "card"],
  football: ["american-football", "soccer"],
  bocce: ["petanque"],
};

async function getTree(): Promise<string[]> {
  const now = Date.now();
  if (treeCache && treeCache.expiresAt > now) return treeCache.slugs;
  try {
    const headers: Record<string, string> = {
      "User-Agent": "ShaneLiPersonalWebsite/1.0",
    };
    if (process.env.GITHUB_TOKEN) {
      headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    }
    const res = await fetch(TREE_URL, {
      headers,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`GitHub tree fetch failed: ${res.status}`);
    const data = (await res.json()) as {
      tree?: { path: string; type: string }[];
    };
    const slugs = (data.tree ?? [])
      .filter(
        (t) =>
          t.type === "blob" &&
          t.path.endsWith(".svg") &&
          t.path.split("/").length === 2,
      )
      .map((t) => t.path.slice(0, -4));
    if (slugs.length === 0) throw new Error("GitHub tree was empty");
    treeCache = { slugs, expiresAt: now + TREE_TTL_MS };
    return slugs;
  } catch (err) {
    // Serve stale rather than failing the add-game flow on a GitHub blip.
    if (treeCache) return treeCache.slugs;
    throw err;
  }
}

function queryTokens(query: string): string[] {
  const base = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
  const expanded = new Set(base);
  for (const t of base) {
    for (const syn of SYNONYMS[t] ?? []) {
      for (const part of syn.split("-")) {
        if (part.length > 1) expanded.add(part);
      }
      expanded.add(syn);
    }
  }
  return [...expanded];
}

export async function searchIcons(query: string): Promise<IconCandidate[]> {
  const tokens = queryTokens(query);
  if (tokens.length === 0) return [];
  const slugs = await getTree();
  const scored: { slug: string; name: string; score: number }[] = [];
  for (const slug of slugs) {
    const name = slug.split("/")[1];
    const nameTokens = name.split("-");
    let score = 0;
    for (const qt of tokens) {
      if (name === qt) score += 100;
      else if (nameTokens.includes(qt)) score += 40;
      else if (nameTokens.some((nt) => nt.startsWith(qt))) score += 20;
      else if (name.includes(qt)) score += 10;
    }
    if (score > 0) scored.push({ slug, name, score });
  }
  scored.sort((a, b) => b.score - a.score || a.name.length - b.name.length);
  return scored.slice(0, MAX_RESULTS).map((s) => ({
    slug: s.slug,
    previewUrl: `${RAW_BASE}/${s.slug}.svg`,
  }));
}

export async function fetchIconPath(
  slug: string,
): Promise<{ path: string; viewBox: string; slug: string }> {
  if (!SLUG_RE.test(slug)) throw new Error("Invalid icon slug");
  const res = await fetch(`${RAW_BASE}/${slug}.svg`, {
    headers: { "User-Agent": "ShaneLiPersonalWebsite/1.0" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Icon fetch failed: ${res.status}`);
  const svg = await res.text();
  const viewBox = svg.match(/viewBox="([^"]+)"/)?.[1] ?? "0 0 512 512";
  const paths = [...svg.matchAll(/<path\b[^>]*?\sd="([^"]+)"/g)]
    .map((m) => m[1])
    .filter((d) => d.replace(/\s+/g, "").toLowerCase() !== BACKGROUND_D);
  if (paths.length === 0) throw new Error("No path data in icon");
  return { path: paths.join(" "), viewBox, slug };
}

/** Test-only: clear the tree cache. */
export function __resetIconCache() {
  treeCache = null;
}

/** Test-only: seed the tree cache; expired=true exercises stale-serve. */
export function __setTreeCache(slugs: string[], expired = false) {
  treeCache = { slugs, expiresAt: expired ? 0 : Date.now() + TREE_TTL_MS };
}
