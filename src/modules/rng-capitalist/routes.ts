import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { db } from "@/db/client";
import { rngDecisions, rngBanList } from "@/db/schema";
import { desc, gt } from "drizzle-orm";
import { scrapeProductUrl } from "./scraper";
import { classifyProduct } from "./classifier";
import { calculateThreshold, rollD20, determineVerdict } from "./engine";
import { createLinkToken, exchangePublicToken, getCurrentBalance, getLastMonthSpend, isPlaidConfigured } from "./plaid";

export const rngRoutes = new Hono();

const evaluateSchema = z.object({ url: z.string().url() });

rngRoutes.post("/evaluate", zValidator("json", evaluateSchema), async (c) => {
  const { url } = c.req.valid("json");

  let scraped;
  try {
    scraped = await scrapeProductUrl(url);
  } catch (err: any) {
    return c.json({ error: `Failed to fetch URL: ${err.message}` }, 400);
  }

  let classified;
  try {
    classified = await classifyProduct(scraped.html);
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }

  const balance = await getCurrentBalance();
  const lastMonthSpend = await getLastMonthSpend();
  if (balance === null || lastMonthSpend === null) {
    return c.json({ error: "Bank not connected. Please connect via Plaid first." }, 400);
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
    avatarUrl: scraped.ogImage, balanceAtTime: String(balance.toFixed(2)),
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
    is_entertainment: classified.isEntertainment, avatar_url: scraped.ogImage, balance, last_month_spend: lastMonthSpend,
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
