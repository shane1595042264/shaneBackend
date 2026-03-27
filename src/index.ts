import app from "@/app";
import { startCronJobs } from "./cron/scheduler";

const port = Number(process.env.PORT) || 3001;

startCronJobs();

const server = Bun.serve({
  port,
  fetch: app.fetch,
});

console.log(`Server running on http://localhost:${server.port}`);

export default server;
