import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { elementConfig } from "@/db/schema";

const elementRoutes = new Hono();

// GET / — list all elements
elementRoutes.get("/", async (c) => {
  const elements = await db.select().from(elementConfig);
  return c.json({ elements });
});

const updateElementSchema = z.object({
  name: z.string().max(100).optional(),
  category: z.string().max(50).optional(),
  type: z.enum(["internal", "external"]).optional(),
  route: z.string().max(255).optional(),
  url: z.string().max(512).optional(),
  status: z.enum(["active", "coming-soon", "disabled"]).optional(),
  description: z.string().optional(),
});

const symbolParamSchema = z.object({
  symbol: z.string().min(1).max(3),
});

// PUT /:symbol — update an element by symbol
elementRoutes.put(
  "/:symbol",
  zValidator("param", symbolParamSchema),
  zValidator("json", updateElementSchema),
  async (c) => {
    const { symbol } = c.req.valid("param");
    const body = c.req.valid("json");

    const existing = await db
      .select({ id: elementConfig.id })
      .from(elementConfig)
      .where(eq(elementConfig.symbol, symbol))
      .limit(1);

    if (existing.length === 0) {
      return c.json({ error: "Element not found" }, 404);
    }

    const updated = await db
      .update(elementConfig)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(elementConfig.symbol, symbol))
      .returning();

    return c.json({ element: updated[0] });
  }
);

export { elementRoutes };
