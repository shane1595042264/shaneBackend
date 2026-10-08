// SHAN-553: a NUL byte anywhere in a request used to reach Postgres, which
// cannot store 0x00 in text/jsonb, and come back as a 500.
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { rejectNul, findNul } from "@/modules/shared/reject-nul";

function makeApp() {
  const app = new Hono();
  app.use("*", rejectNul);
  app.get("/items/:slug", (c) => c.json({ slug: c.req.param("slug"), q: c.req.query("q") ?? null }));
  app.post("/json", async (c) => c.json({ received: await c.req.json() }));
  app.post("/form", async (c) => {
    const form = await c.req.formData();
    return c.json({ name: form.get("name") });
  });
  return app;
}

function postJson(app: Hono, body: string, contentType = "application/json") {
  return app.request("/json", { method: "POST", headers: { "Content-Type": contentType }, body });
}

describe("findNul", () => {
  it("returns null for clean values of every JSON type", () => {
    expect(findNul({ a: "x", b: [1, true, null, { c: "y" }] })).toBeNull();
    expect(findNul("plain")).toBeNull();
    expect(findNul(42)).toBeNull();
  });

  it("reports the dot-joined path of the first offending string", () => {
    expect(findNul({ notes: [{ text: "ok" }, { text: "a\0b" }] })).toBe("notes.1.text");
  });

  it("reports the root as an empty path", () => {
    expect(findNul("\0")).toBe("");
  });

  it("catches a NUL in an object key, which jsonb rejects too", () => {
    expect(findNul({ meta: { "k\0": 1 } })).toBe("meta.k\\u0000");
  });
});

describe("rejectNul", () => {
  it("400s a %00 in the query string", async () => {
    const res = await makeApp().request("/items/abc?q=%00");

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Validation failed: url: Contains a NUL byte, which cannot be stored",
      details: [{ path: "url", message: "Contains a NUL byte, which cannot be stored" }],
    });
  });

  it("400s a %00 in a path parameter, upper or lower case hex", async () => {
    expect((await makeApp().request("/items/a%00b")).status).toBe(400);
    expect((await makeApp().request("/items/abc?q=x%00")).status).toBe(400);
  });

  it("lets a double-encoded %2500 through, since it decodes to the text %00", async () => {
    const res = await makeApp().request("/items/abc?q=%2500");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ slug: "abc", q: "%00" });
  });

  it("400s a JSON body with a NUL in a nested string and names the field", async () => {
    const res = await postJson(makeApp(), JSON.stringify({ entry: { body: "hi\u0000there" } }));

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.details).toEqual([{ path: "entry.body", message: "Contains a NUL byte, which cannot be stored" }]);
  });

  it("checks +json content types as well", async () => {
    const res = await postJson(makeApp(), JSON.stringify(["\u0000"]), "application/merge-patch+json");
    expect(res.status).toBe(400);
  });

  it("does not mistake an escaped backslash followed by u0000 for a NUL", async () => {
    // The JSON text `"\\u0000"` is the six characters \u0000, which Postgres stores fine.
    const res = await postJson(makeApp(), '{"text":"\\\\u0000"}');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: { text: "\\u0000" } });
  });

  it("hands the handler the same parsed body after reading it", async () => {
    const body = { title: "ok", tags: ["a", "b"], n: 3 };
    const res = await postJson(makeApp(), JSON.stringify(body));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: body });
  });

  it("leaves malformed JSON for the route to answer", async () => {
    const app = new Hono();
    app.use("*", rejectNul);
    app.post("/json", async (c) => {
      try {
        await c.req.json();
        return c.json({ parsed: true });
      } catch {
        return c.json({ error: "route saw malformed JSON" }, 400);
      }
    });

    const res = await postJson(app, "{not json");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "route saw malformed JSON" });
  });

  it("never reads a multipart body, so the upload still parses", async () => {
    const form = new FormData();
    form.append("name", "photo");
    const res = await makeApp().request("/form", { method: "POST", body: form });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: "photo" });
  });
});
