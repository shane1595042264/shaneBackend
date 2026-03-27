import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { journalRoutes } from "@/modules/journal/routes";
import { elementRoutes } from "@/modules/elements/routes";

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

export default app;
