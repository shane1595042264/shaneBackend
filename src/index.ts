import app from "@/app";

const port = Number(process.env.PORT) || 3001;

const server = Bun.serve({
  port,
  fetch: app.fetch,
});

console.log(`Server running on http://localhost:${server.port}`);

export default server;
