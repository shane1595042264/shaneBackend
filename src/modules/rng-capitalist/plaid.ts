import { Configuration, PlaidApi, PlaidEnvironments, Products, CountryCode } from "plaid";
import { db } from "@/db/client";
import { rngPlaidTokens, rngMonthlySpend } from "@/db/schema";
import { desc, eq } from "drizzle-orm";

const config = new Configuration({
  basePath: PlaidEnvironments[process.env.PLAID_ENV || "sandbox"],
  baseOptions: {
    headers: {
      "PLAID-CLIENT-ID": process.env.PLAID_CLIENT_ID || "",
      "PLAID-SECRET": process.env.PLAID_SECRET || "",
    },
  },
});

const plaidClient = new PlaidApi(config);

export async function createLinkToken(): Promise<string> {
  const response = await plaidClient.linkTokenCreate({
    user: { client_user_id: "shane" },
    client_name: "RNG Capitalist",
    products: [Products.Transactions],
    country_codes: [CountryCode.Us],
    language: "en",
  });
  return response.data.link_token;
}

export async function exchangePublicToken(publicToken: string): Promise<void> {
  const response = await plaidClient.itemPublicTokenExchange({ public_token: publicToken });
  await db.insert(rngPlaidTokens).values({
    accessToken: response.data.access_token,
    itemId: response.data.item_id,
  });
}

async function getAccessToken(): Promise<string | null> {
  const result = await db.select({ accessToken: rngPlaidTokens.accessToken }).from(rngPlaidTokens).orderBy(desc(rngPlaidTokens.createdAt)).limit(1);
  return result[0]?.accessToken || null;
}

export async function getCurrentBalance(): Promise<number | null> {
  const accessToken = await getAccessToken();
  if (!accessToken) return null;
  const response = await plaidClient.accountsBalanceGet({ access_token: accessToken });
  const account = response.data.accounts.find((a) => a.type === "depository") || response.data.accounts[0];
  return account?.balances.current ?? null;
}

export async function getLastMonthSpend(): Promise<number | null> {
  const now = new Date();
  const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const yearMonth = `${lastMonth.getFullYear()}-${String(lastMonth.getMonth() + 1).padStart(2, "0")}`;
  const cached = await db.select({ totalSpend: rngMonthlySpend.totalSpend }).from(rngMonthlySpend).where(eq(rngMonthlySpend.yearMonth, yearMonth)).limit(1);
  if (cached[0]) return Number(cached[0].totalSpend);
  return await fetchAndCacheMonthlySpend(yearMonth);
}

export async function fetchAndCacheMonthlySpend(yearMonth: string): Promise<number | null> {
  const accessToken = await getAccessToken();
  if (!accessToken) return null;
  const [year, month] = yearMonth.split("-").map(Number);
  const startDate = `${year}-${String(month).padStart(2, "0")}-01`;
  const endOfMonth = new Date(year, month, 0);
  const endDate = `${year}-${String(month).padStart(2, "0")}-${String(endOfMonth.getDate()).padStart(2, "0")}`;
  const response = await plaidClient.transactionsGet({ access_token: accessToken, start_date: startDate, end_date: endDate, options: { count: 500 } });
  const totalSpend = response.data.transactions.filter((t) => t.amount > 0).reduce((sum, t) => sum + t.amount, 0);
  await db.insert(rngMonthlySpend).values({ yearMonth, totalSpend: String(totalSpend.toFixed(2)) }).onConflictDoNothing();
  return totalSpend;
}

export function isPlaidConfigured(): boolean {
  return !!(process.env.PLAID_CLIENT_ID && process.env.PLAID_SECRET);
}
