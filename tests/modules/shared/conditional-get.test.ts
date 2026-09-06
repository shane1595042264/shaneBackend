import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { conditionalGet } from "@/modules/shared/conditional-get";

function makeApp() {
  const app = new Hono();
  app.use("*", conditionalGet);
  app.get("/json", (c) => c.json({ entries: [1, 2, 3] }));
  app.get("/other-json", (c) => c.json({ entries: [9] }));
  app.get("/created", (c) => c.json({ ok: true }, 201));
  app.get("/missing", (c) => c.json({ error: "Not Found" }, 404));
  app.get("/text", (c) => c.text("plain"));
  app.get("/own-etag", (c) => c.json({ ok: true }, 200, { ETag: '"handler-owned"' }));
  app.get("/own-cache-control", (c) =>
    c.json({ ok: true }, 200, { "Cache-Control": "public, max-age=60" })
  );
  app.post("/json", (c) => c.json({ ok: true }));
  return app;
}

async function etagOf(app: Hono, path = "/json"): Promise<string> {
  const res = await app.request(path);
  const etag = res.headers.get("ETag");
  if (!etag) throw new Error(`no ETag on ${path}`);
  return etag;
}

describe("conditionalGet", () => {
  it("tags a 200 JSON GET with a weak ETag and a revalidating Cache-Control", async () => {
    const app = makeApp();
    const res = await app.request("/json");

    expect(res.status).toBe(200);
    expect(res.headers.get("ETag")).toMatch(/^W\/"[A-Za-z0-9_-]+"$/);
    expect(res.headers.get("Cache-Control")).toBe("private, no-cache");
    expect(await res.json()).toEqual({ entries: [1, 2, 3] });
  });

  it("is deterministic for the same body and differs for a different one", async () => {
    const app = makeApp();
    expect(await etagOf(app)).toBe(await etagOf(app));
    expect(await etagOf(app)).not.toBe(await etagOf(app, "/other-json"));
  });

  it("answers a matching If-None-Match with an empty 304", async () => {
    const app = makeApp();
    const etag = await etagOf(app);

    const res = await app.request("/json", { headers: { "If-None-Match": etag } });

    expect(res.status).toBe(304);
    expect(res.headers.get("ETag")).toBe(etag);
    expect(res.headers.get("Cache-Control")).toBe("private, no-cache");
    // A 304 must not describe a body it does not carry.
    expect(res.headers.get("Content-Type")).toBeNull();
    expect(res.headers.get("Content-Length")).toBeNull();
    expect(await res.text()).toBe("");
  });

  it("matches a strong tag against the weak one it issued, and `*`", async () => {
    const app = makeApp();
    const etag = await etagOf(app);
    const strong = etag.replace(/^W\//, "");

    expect((await app.request("/json", { headers: { "If-None-Match": strong } })).status).toBe(304);
    expect((await app.request("/json", { headers: { "If-None-Match": "*" } })).status).toBe(304);
  });

  it("matches any member of a comma-separated If-None-Match list", async () => {
    const app = makeApp();
    const etag = await etagOf(app);

    const res = await app.request("/json", {
      headers: { "If-None-Match": `W/"stale-one", ${etag}, W/"stale-two"` },
    });

    expect(res.status).toBe(304);
  });

  it("serves the full body when If-None-Match is stale", async () => {
    const app = makeApp();

    const res = await app.request("/json", { headers: { "If-None-Match": 'W/"stale"' } });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ entries: [1, 2, 3] });
  });

  it("leaves non-200, non-JSON, and non-GET responses untouched", async () => {
    const app = makeApp();

    for (const path of ["/created", "/missing", "/text"]) {
      expect((await app.request(path)).headers.get("ETag")).toBeNull();
    }
    const posted = await app.request("/json", { method: "POST" });
    expect(posted.headers.get("ETag")).toBeNull();
  });

  it("defers to a handler that set its own ETag or Cache-Control", async () => {
    const app = makeApp();

    const owned = await app.request("/own-etag");
    expect(owned.headers.get("ETag")).toBe('"handler-owned"');
    expect(owned.headers.get("Cache-Control")).toBeNull();

    const cached = await app.request("/own-cache-control");
    expect(cached.headers.get("ETag")).toMatch(/^W\//);
    expect(cached.headers.get("Cache-Control")).toBe("public, max-age=60");
  });
});
