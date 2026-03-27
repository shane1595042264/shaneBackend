import { Hono } from "hono";

const elementRoutes = new Hono();

// Placeholder – routes will be implemented in Task 6
elementRoutes.get("/", (c) => {
  return c.json({ message: "Elements API – coming soon" });
});

export { elementRoutes };
