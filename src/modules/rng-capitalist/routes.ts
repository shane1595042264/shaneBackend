import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { db } from "@/db/client";
import { rngDecisions, rngBanList } from "@/db/schema";
import { desc, gt } from "drizzle-orm";
import { scrapeProductUrl } from "./scraper";
import { classifyProduct } from "./classifier";
import { generateText } from "@/modules/shared/llm";
import { calculateThreshold, rollD20, determineVerdict } from "./engine";
import { createLinkToken, exchangePublicToken, getCurrentBalance, getLastMonthSpend, isPlaidConfigured } from "./plaid";

export const rngRoutes = new Hono();

const evaluateSchema = z.object({
  url: z.string().optional(),
  product_name: z.string().optional(),
  price: z.number().optional(),
  override_balance: z.number().optional(),
  override_last_month_spend: z.number().optional(),
}).refine((d) => d.url || (d.product_name && d.price), {
  message: "Provide either a URL or product_name + price",
});

rngRoutes.post("/evaluate", zValidator("json", evaluateSchema), async (c) => {
  const body = c.req.valid("json");

  let classified: { productName: string; price: number; genericCategory: string; isEntertainment: boolean };
  let avatarUrl: string | null = null;
  const url = body.url || null;

  if (body.product_name && body.price) {
    // Manual input — classify by name only
    const result = await generateText({
      system: "You classify products. Return ONLY valid JSON.",
      prompt: `Classify this product:
Name: "${body.product_name}"
Price: $${body.price}

Return JSON: {"generic_category":"...","is_entertainment":true/false}
generic_category: short 1-3 word category (e.g., "sex toy", "gaming console")
is_entertainment: true if entertainment/luxury/want, false if necessity`,
      model: "claude-haiku-4-5-20251001",
      maxTokens: 128,
    });
    const cleaned = result.text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    let parsed: any;
    try {
      const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(jsonMatch ? jsonMatch[0] : cleaned);
    } catch {
      parsed = { generic_category: "unknown", is_entertainment: true };
    }
    classified = {
      productName: body.product_name,
      price: body.price,
      genericCategory: (parsed.generic_category || "unknown").toLowerCase(),
      isEntertainment: parsed.is_entertainment !== false,
    };
  } else {
    // URL scrape + AI classify
    let scraped;
    try {
      scraped = await scrapeProductUrl(body.url!);
      avatarUrl = scraped.ogImage;
    } catch (err: any) {
      return c.json({ error: `Failed to fetch URL: ${err.message}`, needs_manual: true }, 400);
    }

    try {
      classified = await classifyProduct(scraped.html);
    } catch (err: any) {
      return c.json({ error: err.message, needs_manual: true }, 400);
    }

    // If AI returned price 0 or negative, the scrape likely failed (CAPTCHA, blocked, etc.)
    if (classified.price <= 0) {
      return c.json({
        error: "Could not determine the product price from this page. Please enter the details manually.",
        needs_manual: true,
      }, 400);
    }
  }

  // Use manual overrides if provided, otherwise fetch from Plaid
  const balance = body.override_balance ?? await getCurrentBalance();
  const lastMonthSpend = body.override_last_month_spend ?? await getLastMonthSpend();
  if (balance === null || lastMonthSpend === null) {
    return c.json({ error: "Bank not connected and no manual override provided." }, 400);
  }
  const remainingBudget = balance - lastMonthSpend;
  const activeBan = await db.select().from(rngBanList).where(gt(rngBanList.expiresAt, new Date())).then((bans) => bans.find((b) => b.genericCategory === classified.genericCategory));
  const isBanned = !!activeBan;
  const threshold = classified.isEntertainment ? calculateThreshold(classified.price, remainingBudget) : null;
  const roll = classified.isEntertainment && !isBanned && threshold !== null && threshold > 0 && threshold <= 20 ? rollD20() : null;
  const verdict = determineVerdict({ isEntertainment: classified.isEntertainment, isBanned, threshold: threshold ?? 0, roll: roll ?? 0 });
  const [decision] = await db.insert(rngDecisions).values({
    url, productName: classified.productName, price: String(classified.price.toFixed(2)),
    genericCategory: classified.genericCategory, isEntertainment: classified.isEntertainment,
    avatarUrl, balanceAtTime: String(balance.toFixed(2)),
    remainingBudget: String(remainingBudget.toFixed(2)), threshold, roll, result: verdict,
  }).returning();
  let bannedUntil: string | null = null;
  if (verdict === "denied") {
    const expiresAt = new Date(); expiresAt.setDate(expiresAt.getDate() + 30);
    await db.insert(rngBanList).values({ genericCategory: classified.genericCategory, expiresAt, sourceDecisionId: decision.id });
    bannedUntil = expiresAt.toISOString();
  }
  if (verdict === "banned" && activeBan) bannedUntil = activeBan.expiresAt.toISOString();
  return c.json({
    product_name: classified.productName, price: classified.price, generic_category: classified.genericCategory,
    is_entertainment: classified.isEntertainment, avatar_url: avatarUrl, balance, last_month_spend: lastMonthSpend,
    remaining_budget: remainingBudget, threshold, roll, result: verdict, banned_until: bannedUntil,
  });
});

rngRoutes.get("/budget", async (c) => {
  const balance = await getCurrentBalance();
  const lastMonthSpend = await getLastMonthSpend();
  return c.json({ connected: balance !== null, balance, last_month_spend: lastMonthSpend, remaining_budget: balance !== null && lastMonthSpend !== null ? balance - lastMonthSpend : null });
});

rngRoutes.get("/history", async (c) => {
  const decisions = await db.select().from(rngDecisions).orderBy(desc(rngDecisions.createdAt)).limit(100);
  return c.json({ decisions: decisions.map((d) => ({ ...d, price: Number(d.price), balanceAtTime: d.balanceAtTime ? Number(d.balanceAtTime) : null, remainingBudget: d.remainingBudget ? Number(d.remainingBudget) : null })) });
});

rngRoutes.get("/bans", async (c) => {
  const bans = await db.select().from(rngBanList).where(gt(rngBanList.expiresAt, new Date())).orderBy(desc(rngBanList.expiresAt));
  return c.json({ bans });
});

rngRoutes.post("/plaid/link-token", async (c) => {
  if (!isPlaidConfigured()) return c.json({ error: "Plaid not configured" }, 500);
  const linkToken = await createLinkToken();
  return c.json({ link_token: linkToken });
});

const exchangeSchema = z.object({ public_token: z.string() });
rngRoutes.post("/plaid/exchange", zValidator("json", exchangeSchema), async (c) => {
  const { public_token } = c.req.valid("json");
  await exchangePublicToken(public_token);
  return c.json({ ok: true });
});
