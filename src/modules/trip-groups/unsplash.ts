/**
 * Minimal Unsplash search client for itinerary-day photo fallback
 * (SHAN-275). Per Unsplash API terms photos are hotlinked (urls.regular)
 * with attribution, never copied into our DB.
 */
export interface UnsplashHit {
  url: string;
  attribution: string;
}

export async function searchUnsplashPhoto(query: string): Promise<UnsplashHit | null> {
  const key = process.env.UNSPLASH_ACCESS_KEY;
  if (!key) {
    throw new Error("UNSPLASH_ACCESS_KEY not set — cannot fetch fallback photos");
  }
  const url = new URL("https://api.unsplash.com/search/photos");
  url.searchParams.set("query", query);
  url.searchParams.set("per_page", "1");
  url.searchParams.set("orientation", "landscape");

  const res = await fetch(url, {
    headers: { Authorization: `Client-ID ${key}`, "Accept-Version": "v1" },
  });
  if (!res.ok) {
    throw new Error(`Unsplash API error ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const data = (await res.json()) as {
    results?: { urls?: { regular?: string }; user?: { name?: string } }[];
  };
  const hit = data.results?.[0];
  if (!hit?.urls?.regular) return null;
  return {
    url: hit.urls.regular,
    attribution: `Photo by ${hit.user?.name ?? "Unknown"} on Unsplash`,
  };
}
