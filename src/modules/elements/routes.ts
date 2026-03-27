import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { elementConfig } from "@/db/schema";

const elementRoutes = new Hono();

// GET / — list all elements
elementRoutes.get("/", async (c) => {
  const elements = await db.select().from(elementConfig);
  return c.json({ elements });
});

// PUT /:symbol — update an element by symbol
elementRoutes.put("/:symbol", async (c) => {
  const symbol = c.req.param("symbol");
  const body = await c.req.json();

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
});

export { elementRoutes };
