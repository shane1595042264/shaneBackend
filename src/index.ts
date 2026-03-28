import app from "@/app";
import { startCronJobs } from "./cron/scheduler";

const port = Number(process.env.PORT) || 3001;

startCronJobs();

const server = Bun.serve({
  port,
  fetch: app.fetch,
});

console.log(`Server running on http://localhost:${server.port}`);

// Run schema push after server starts (env vars are guaranteed available here)
if (process.env.DATABASE_URL) {
  Bun.spawn(["bunx", "drizzle-kit", "push", "--force"], {
    cwd: process.cwd(),
    env: process.env,
    stdout: "inherit",
    stderr: "inherit",
    onExit(proc, exitCode) {
      if (exitCode === 0) {
        console.log("[startup] Schema push completed");
      } else {
        console.error("[startup] Schema push failed (exit code:", exitCode, ")");
      }
    },
  });
}

export default server;
