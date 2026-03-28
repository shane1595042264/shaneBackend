export function extractOgImage(html: string): string | null {
  const match = html.match(/<meta\s+(?:[^>]*?\s+)?property=["']og:image["']\s+content=["']([^"']+)["']/i)
    || html.match(/<meta\s+(?:[^>]*?\s+)?content=["']([^"']+)["']\s+property=["']og:image["']/i);
  return match ? match[1] : null;
}

export function truncateHtml(html: string, maxLength: number = 10000): string {
  let cleaned = html.replace(/<script[\s\S]*?<\/script>/gi, "");
  cleaned = cleaned.replace(/<style[\s\S]*?<\/style>/gi, "");
  if (cleaned.length <= maxLength) return cleaned;
  return cleaned.slice(0, maxLength);
}

export interface ScrapedProduct {
  ogImage: string | null;
  html: string;
}

export async function scrapeProductUrl(url: string): Promise<ScrapedProduct> {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml",
    },
    redirect: "follow",
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch URL: ${response.status} ${response.statusText}`);
  }
  const html = await response.text();
  return { ogImage: extractOgImage(html), html: truncateHtml(html) };
}
