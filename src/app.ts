import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { journalRoutes } from "@/modules/journal/routes";
import { elementRoutes } from "@/modules/elements/routes";
import { locationRoutes } from "@/modules/location/routes";
import { rngRoutes } from "@/modules/rng-capitalist/routes";
import { authRoutes } from "@/modules/auth/routes";

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
app.route("/api/auth", authRoutes);
app.route("/api/journal", journalRoutes);
app.route("/api/elements", elementRoutes);
app.route("/api/location", locationRoutes);
app.route("/api/rng", rngRoutes);

// ---------------------------------------------------------------------------
// Admin — manual trigger for ingestion + journal generation
// ---------------------------------------------------------------------------
app.post("/api/admin/generate/:date", async (c) => {
  const adminToken = process.env.ADMIN_TOKEN;
  if (adminToken && c.req.header("Authorization") !== `Bearer ${adminToken}`) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const date = c.req.param("date");
  // Fire and forget — respond immediately, run generation in background
  // Railway has a 30s gateway timeout so we can't wait for Claude + embeddings
  const { ingestActivities } = await import("@/cron/ingest");
  const { runDailyGeneration } = await import("@/cron/generate-daily");
  ingestActivities(date)
    .then((ingested) => {
      console.log(`[admin] Ingested ${ingested} activities for ${date}`);
      return runDailyGeneration(date);
    })
    .then(() => console.log(`[admin] Journal entry generated for ${date}`))
    .catch((err) => console.error(`[admin] Generation failed for ${date}:`, err));
  return c.json({ ok: true, date, status: "generation_started" });
});

// Debug: ingest only (fast, should finish within 30s)
app.get("/api/admin/ingest/:date", async (c) => {
  const date = c.req.param("date");
  try {
    const { ingestActivities } = await import("@/cron/ingest");
    const ingested = await ingestActivities(date);
    return c.json({ ok: true, date, ingested });
  } catch (err: any) {
    return c.json({ error: err.message, stack: err.stack?.split("\n").slice(0, 5) }, 500);
  }
});

// Debug: generate only (may timeout at gateway but runs in background)
app.get("/api/admin/generate-only/:date", async (c) => {
  const date = c.req.param("date");
  const { runDailyGeneration } = await import("@/cron/generate-daily");
  runDailyGeneration(date)
    .then(() => console.log(`[admin] Generated entry for ${date}`))
    .catch((err) => console.error(`[admin] Generation failed:`, err.message, err.stack));
  return c.json({ ok: true, date, status: "generation_started_bg" });
});

export default app;
