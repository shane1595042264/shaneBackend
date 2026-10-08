// SHAN-553: app-level wiring for rejectNul. The three prod URLs below all
// answered 500 before the middleware existed. The db is an empty object here,
// so a request that slipped past the middleware into a handler would throw
// instead of returning the asserted 400.
import { describe, it, expect, vi } from "vitest";

vi.mock("@/db/client", () => ({
  getPool: vi.fn(),
  getDb: () => ({}),
  pool: { get: vi.fn() },
  db: {},
}));
vi.mock("@/cron/ingest", () => ({ ingestActivities: vi.fn() }));
vi.mock("@/modules/shared/llm", () => ({ generateText: vi.fn() }));

const { default: app } = await import("@/app");

describe("SHAN-553: NUL bytes are a 400 on real routes", () => {
  it.each(["/api/blog/posts?q=%00", "/api/blog/posts?tag=%00", "/api/courses/%00"])(
    "%s",
    async (url) => {
      const res = await app.request(url);

      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/^Validation failed: url: /);
    }
  );

  it("keeps the 400 readable to a browser", async () => {
    const res = await app.request("/api/courses/%00", { headers: { Origin: "https://shanejli.com" } });

    expect(res.status).toBe(400);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeTruthy();
  });
});
