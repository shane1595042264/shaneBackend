import { Hono } from "hono";

const journalRoutes = new Hono();

// Placeholder – routes will be implemented in Task 6
journalRoutes.get("/", (c) => {
  return c.json({ message: "Journal API – coming soon" });
});

export { journalRoutes };
