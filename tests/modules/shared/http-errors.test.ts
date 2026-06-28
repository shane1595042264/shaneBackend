import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { notFoundHandler, errorHandler } from "@/modules/shared/http-errors";

const app = new Hono();
app.get("/boom", () => {
  throw new Error("kaboom");
});
app.get("/http-boom", () => {
  throw new HTTPException(403, { message: "nope" });
});
app.notFound(notFoundHandler);
app.onError(errorHandler);

let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  errSpy.mockRestore();
});

describe("notFoundHandler", () => {
  it("returns a JSON 404 with the requested path for unmatched routes", async () => {
    const res = await app.request("/does-not-exist");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ error: "Not Found", path: "/does-not-exist" });
  });
});

describe("errorHandler", () => {
  it("returns a JSON 500 and logs for an uncaught error", async () => {
    const res = await app.request("/boom");
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ error: "Internal Server Error" });
    expect(errSpy).toHaveBeenCalled();
  });

  it("honors a thrown HTTPException status and message as JSON", async () => {
    const res = await app.request("/http-boom");
    expect(res.status).toBe(403);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ error: "nope" });
  });
});
