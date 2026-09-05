// tests/modules/shared/zod-validator.test.ts
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { z } from "zod";
import {
  zValidator,
  validationHook,
  formatValidationIssues,
} from "@/modules/shared/zod-validator";

describe("formatValidationIssues", () => {
  it("dot-joins nested paths and keeps the zod message verbatim", () => {
    const schema = z.object({ notes: z.array(z.object({ text: z.string() })) });
    const result = schema.safeParse({ notes: [{ text: 42 }] });
    expect(result.success).toBe(false);
    expect(formatValidationIssues((result as { error: unknown }).error)).toEqual([
      { path: "notes.0.text", message: "Expected string, received number" },
    ]);
  });

  it("omits `path` for object-level errors", () => {
    const schema = z.object({ a: z.string() }).refine(() => false, "nope");
    const result = schema.safeParse({ a: "x" });
    expect(formatValidationIssues((result as { error: unknown }).error)).toEqual([
      { message: "nope" },
    ]);
  });

  it("returns [] for anything that isn't a zod error", () => {
    expect(formatValidationIssues(undefined)).toEqual([]);
    expect(formatValidationIssues(new Error("boom"))).toEqual([]);
  });
});

describe("validationHook", () => {
  it("passes through on success", () => {
    const c = { json: () => new Response() } as never;
    expect(validationHook({ success: true }, c)).toBeUndefined();
  });
});

describe("zValidator", () => {
  const app = new Hono();
  const querySchema = z.object({
    limit: z.coerce.number().int().min(1).max(100).default(10),
  });
  app.get("/items", zValidator("query", querySchema), (c) =>
    c.json({ limit: c.req.valid("query").limit })
  );

  it("still passes valid input through to the handler", async () => {
    const res = await app.request("/items?limit=5");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ limit: 5 });
  });

  it("returns 400 with the standard { error, details } envelope", async () => {
    const res = await app.request("/items?limit=abc");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; details: unknown[] };
    // The regression this guards: the upstream default emitted
    // { success: false, error: { issues, name: "ZodError" } } with no top-level
    // error string, so clients reading `err.error` got an object.
    expect(typeof body.error).toBe("string");
    expect(body.error).toContain("limit");
    expect(body.details).toEqual([
      { path: "limit", message: "Expected number, received nan" },
    ]);
    expect(body).not.toHaveProperty("success");
  });

  it("summarizes at most 5 issues but reports every one in details", async () => {
    const wide = new Hono();
    const shape = Object.fromEntries(
      Array.from({ length: 7 }, (_, i) => [`f${i}`, z.string()])
    );
    wide.post("/wide", zValidator("json", z.object(shape)), (c) => c.json({ ok: true }));

    const res = await wide.request("/wide", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; details: unknown[] };
    expect(body.details).toHaveLength(7);
    expect(body.error).toContain("(+2 more)");
  });

  it("honors a call site's own hook instead of the default", async () => {
    const custom = new Hono();
    custom.get(
      "/custom",
      zValidator("query", z.object({ q: z.string().min(3) }), (result, c) =>
        result.success ? undefined : c.json({ error: "custom" }, 422)
      ),
      (c) => c.json({ ok: true })
    );
    const res = await custom.request("/custom?q=a");
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "custom" });
  });
});
