import app from "@/app";
import { startCronJobs } from "./cron/scheduler";
import { runStartupMigrations } from "@/db/migrate";

const port = Number(process.env.PORT) || 3001;

// Apply Drizzle migrations BEFORE serving traffic. If migrate fails or the
// schema sanity check finds missing tables, we crash the container — Railway
// will mark the deploy unhealthy instead of silently serving 500s (the
// SHAN-159 footgun that drizzle-kit push --force has left us with three
// times now: vocab_words.source, journal_appends, knowledge_comments).
try {
  await runStartupMigrations();
} catch (err) {
  console.error("[startup] Refusing to start server. Reason:", err);
  process.exit(1);
}

startCronJobs();

const server = Bun.serve({
  port,
  fetch: app.fetch,
});

console.log(`Server running on http://localhost:${server.port}`);

export default server;
