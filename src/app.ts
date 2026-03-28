import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { journalRoutes } from "@/modules/journal/routes";
import { elementRoutes } from "@/modules/elements/routes";
import { locationRoutes } from "@/modules/location/routes";

const app = new Hono();

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
app.use("*", logger());

app.use(
  "*",
  cors({
    origin: process.env.CORS_ORIGIN ?? "*",
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  })
);

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------
app.get("/health", (c) => {
  return c.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ---------------------------------------------------------------------------
// API routes
// ---------------------------------------------------------------------------
app.route("/api/journal", journalRoutes);
app.route("/api/elements", elementRoutes);
app.route("/api/location", locationRoutes);

// ---------------------------------------------------------------------------
// Admin — manual trigger for ingestion + journal generation
// ---------------------------------------------------------------------------
app.post("/api/admin/generate/:date", async (c) => {
  const adminToken = process.env.ADMIN_TOKEN;
  if (adminToken && c.req.header("Authorization") !== `Bearer ${adminToken}`) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const date = c.req.param("date");
  const { ingestActivities } = await import("@/cron/ingest");
  const { runDailyGeneration } = await import("@/cron/generate-daily");
  const ingested = await ingestActivities(date);
  await runDailyGeneration(date);
  return c.json({ ok: true, date, ingested });
});

export default app;
