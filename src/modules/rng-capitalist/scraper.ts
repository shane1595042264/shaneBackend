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

function isAmazonUrl(url: string): boolean {
  return /amazon\.(com|co\.|ca|de|fr|it|es)/i.test(url);
}

/** Extract ASIN from Amazon URL — it's in /dp/ASIN or /gp/product/ASIN */
function extractAsin(url: string): string | null {
  const match = url.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i);
  return match ? match[1] : null;
}

export interface ScrapedProduct {
  ogImage: string | null;
  html: string;
}

export async function scrapeProductUrl(url: string): Promise<ScrapedProduct> {
  // Amazon needs mobile UA to get product data in the HTML
  const isAmazon = isAmazonUrl(url);
  let fetchUrl = url;

  // For Amazon, use the clean short URL with ASIN
  if (isAmazon) {
    const asin = extractAsin(url);
    if (asin) fetchUrl = `https://www.amazon.com/dp/${asin}`;
  }

  const userAgent = isAmazon
    ? "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
    : "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

  const response = await fetch(fetchUrl, {
    headers: {
      "User-Agent": userAgent,
      "Accept": "text/html,application/xhtml+xml",
      "Accept-Language": "en-US,en;q=0.9",
    },
    redirect: "follow",
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch URL: ${response.status} ${response.statusText}`);
  }

  const html = await response.text();

  // For Amazon, try to extract price directly from HTML using multiple strategies
  let amazonHint = "";
  if (isAmazon) {
    // Detect bot-block / CAPTCHA pages — fail fast instead of sending garbage to AI
    if (
      html.includes("captcha") && html.includes("Type the characters you see") ||
      html.includes("Sorry, we just need to make sure you're not a robot") ||
      html.includes("api-services-support@amazon.com")
    ) {
      throw new Error("Amazon is blocking automated requests. Please enter the product details manually.");
    }

    // Try multiple price extraction patterns (Amazon changes their markup frequently)
    const pricePatterns = [
      /"priceAmount"\s*:\s*([\d.]+)/,                          // JSON-LD price
      /"price"\s*:\s*"?([\d.]+)"?/,                            // generic JSON price
      /class="a-price-whole"[^>]*>([\d,]+)/,                   // desktop price element
      /data-a-color="price"[^>]*>[^$]*\$([\d,.]+)/,            // price display
      /"buyingPrice"\s*:\s*([\d.]+)/,                           // buying price
      /corePriceDisplay_desktop.*?\$([\d,.]+)/s,                // core price display
      /"priceToPay"[^}]*?"value"\s*:\s*"?([\d.]+)/,            // price to pay
    ];

    let extractedPrice: string | null = null;
    for (const pattern of pricePatterns) {
      const m = html.match(pattern);
      if (m) {
        const val = parseFloat(m[1].replace(/,/g, ""));
        if (val > 0) { extractedPrice = String(val); break; }
      }
    }

    const titleMatch = html.match(/<title>(?:Amazon\.com:\s*)?([^<]+)<\/title>/i);
    if (extractedPrice || titleMatch) {
      amazonHint = "\n\nEXTRACTED DATA (use this if available):\n";
      if (titleMatch) amazonHint += `Product title from page: ${titleMatch[1].trim()}\n`;
      if (extractedPrice) amazonHint += `Price from page data: $${extractedPrice}\n`;
    }
  }

  return {
    ogImage: extractOgImage(html),
    html: truncateHtml(html) + amazonHint,
  };
}
