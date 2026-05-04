import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { journalRoutes } from "@/modules/journal/routes";
import { elementRoutes } from "@/modules/elements/routes";
import { locationRoutes } from "@/modules/location/routes";
import { rngRoutes } from "@/modules/rng-capitalist/routes";
import { authRoutes } from "@/modules/auth/routes";
import { vocabularyRoutes } from "@/modules/vocabulary/routes";
import { knowledgeRoutes } from "@/modules/knowledge/routes";
import { slotRoutes } from "@/modules/slot-assignments/routes";
import { wechatRoutes } from "@/modules/integrations/wechat-routes";
import { activitiesRoutes } from "@/modules/activities/routes";

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
    allowHeaders: ["Content-Type", "Authorization", "If-Match"],
    credentials: true,
  })
);

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------
app.get("/health", async (c) => {
  try {
    const { getPool } = await import("@/db/client");
    await getPool().query("SELECT 1");
    return c.json({ status: "ok", timestamp: new Date().toISOString() });
  } catch (err) {
    console.error("Health check DB failure:", err);
    return c.json({ status: "unhealthy", timestamp: new Date().toISOString(), error: "database connection failed" }, 503);
  }
});

// ---------------------------------------------------------------------------
// API routes
// ---------------------------------------------------------------------------
app.route("/api/auth", authRoutes);
app.route("/api/journal", journalRoutes);
app.route("/api/activities", activitiesRoutes);
app.route("/api/elements", elementRoutes);
app.route("/api/location", locationRoutes);
app.route("/api/rng", rngRoutes);
app.route("/api/vocabulary", vocabularyRoutes);
app.route("/api/knowledge", knowledgeRoutes);
app.route("/api/slot-assignments", slotRoutes);
app.route("/api/integrations/wechat", wechatRoutes);

// ---------------------------------------------------------------------------
// Admin — migrate vocabulary tables
// ---------------------------------------------------------------------------
app.post("/api/admin/migrate-vocabulary", async (c) => {
  const adminToken = process.env.ADMIN_TOKEN;
  if (adminToken && c.req.header("Authorization") !== `Bearer ${adminToken}`) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  try {
    const { getPool } = await import("@/db/client");
    const pool = getPool();
    await pool.query(`
      CREATE TABLE IF NOT EXISTS vocab_words (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        word VARCHAR(255) NOT NULL,
        language VARCHAR(50) NOT NULL,
        definition TEXT,
        pronunciation VARCHAR(255),
        part_of_speech VARCHAR(50),
        example_sentence TEXT,
        labels JSONB DEFAULT '[]'::jsonb,
        ai_metadata JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS vocab_words_language_idx ON vocab_words (language);
      CREATE INDEX IF NOT EXISTS vocab_words_created_at_idx ON vocab_words (created_at);

      CREATE TABLE IF NOT EXISTS vocab_connections (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        from_word_id UUID NOT NULL REFERENCES vocab_words(id) ON DELETE CASCADE,
        to_word_id UUID NOT NULL REFERENCES vocab_words(id) ON DELETE CASCADE,
        connection_type VARCHAR(50) NOT NULL,
        note TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS vocab_connections_from_idx ON vocab_connections (from_word_id);
      CREATE INDEX IF NOT EXISTS vocab_connections_to_idx ON vocab_connections (to_word_id);
      CREATE UNIQUE INDEX IF NOT EXISTS vocab_connections_unique ON vocab_connections (from_word_id, to_word_id, connection_type);
    `);
    // Add category column if missing (migration for knowledge feature)
    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='vocab_words' AND column_name='category') THEN
          ALTER TABLE vocab_words ADD COLUMN category VARCHAR(100) NOT NULL DEFAULT 'vocabulary';
          CREATE INDEX IF NOT EXISTS vocab_words_category_idx ON vocab_words (category);
        END IF;
      END $$;
    `);
    return c.json({ ok: true, message: "Vocabulary/Knowledge tables created" });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// ---------------------------------------------------------------------------
// Admin — manual trigger for ingestion
// NOTE (Task 6.2): generate/:date and generate-only/:date endpoints removed;
// they depended on decommissioned generate-daily cron module.
// ---------------------------------------------------------------------------
const adminDateParamSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD format"),
});

// Debug: ingest only (fast, should finish within 30s)
app.get("/api/admin/ingest/:date", zValidator("param", adminDateParamSchema), async (c) => {
  const adminToken = process.env.ADMIN_TOKEN;
  if (adminToken && c.req.header("Authorization") !== `Bearer ${adminToken}`) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const { date } = c.req.valid("param");
  try {
    const { ingestActivities } = await import("@/cron/ingest");
    const ingested = await ingestActivities(date);
    return c.json({ ok: true, date, ingested });
  } catch (err: any) {
    console.error(`[admin] Ingest failed for ${date}:`, err);
    return c.json({ error: err.message }, 500);
  }
});

// Debug: test LLM fallback chain
app.get("/api/admin/test-llm", async (c) => {
  const adminToken = process.env.ADMIN_TOKEN;
  if (adminToken && c.req.header("Authorization") !== `Bearer ${adminToken}`) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  try {
    const { generateText } = await import("@/modules/shared/llm");
    const result = await generateText({
      system: "You are a helpful assistant.",
      prompt: "Say hello in one sentence.",
      maxTokens: 50,
    });
    return c.json({ ok: true, text: result.text, usage: result.usage });
  } catch (err: any) {
    console.error(`[admin] test-llm failed:`, err);
    return c.json({ error: err.message }, 500);
  }
});

export default app;
