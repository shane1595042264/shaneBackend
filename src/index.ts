import app from "@/app";
import { startCronJobs } from "./cron/scheduler";

const port = Number(process.env.PORT) || 3001;

startCronJobs();

const server = Bun.serve({
  port,
  fetch: app.fetch,
});

console.log(`Server running on http://localhost:${server.port}`);

// Migrate vector columns from 1536 to 384 dimensions (one-time migration)
if (process.env.DATABASE_URL) {
  import("@/db/client").then(({ getPool }) => {
    const pool = getPool();
    Promise.all([
      pool.query("ALTER TABLE diary_entries ALTER COLUMN embedding TYPE vector(384) USING NULL"),
      pool.query("ALTER TABLE summaries ALTER COLUMN embedding TYPE vector(384) USING NULL"),
      pool.query("ALTER TABLE learned_facts ALTER COLUMN embedding TYPE vector(384) USING NULL"),
    ])
      .then(() => console.log("[startup] Vector columns migrated to 384 dimensions"))
      .catch((err) => {
        // Ignore if already correct dimension or column doesn't exist
        if (!err.message.includes("already")) {
          console.error("[startup] Vector migration note:", err.message);
        }
      });
  });
}

export default server;
