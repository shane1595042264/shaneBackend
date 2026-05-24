import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { requireAuth, requireScope, optionalAuth } from "@/modules/auth/middleware";
import { extractTitle } from "./title";
import { createTrip, listTrips, getTripBySlug, updateTripBySlug, deleteTripBySlug } from "./repo";

export const tripsRoutes = new Hono();

// JSON path: { html, title? } — for Claude / curl uploads.
const jsonBody = z.object({
  html: z.string().min(1).max(10 * 1024 * 1024),
  title: z.string().min(1).max(200).optional(),
  filename: z.string().min(1).max(255).optional(),
});

const slugParam = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/),
});

/**
 * POST /api/trips
 *
 * Two flavors based on Content-Type:
 *  - multipart/form-data with field `file` (.html upload from a dropzone)
 *  - application/json: { html, title?, filename? }
 *
 * Title precedence: explicit body field > <title> tag > first <h1> > "Untitled".
 */
tripsRoutes.post("/", requireAuth, requireScope("trips:write"), async (c) => {
  const userId = c.get("userId") as string;
  const contentType = c.req.header("Content-Type") ?? "";

  let html: string;
  let providedTitle: string | undefined;
  let sourceFilename: string | null = null;

  if (contentType.includes("multipart/form-data")) {
    const form = await c.req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return c.json({ error: "Missing 'file' in multipart upload" }, 400);
    }
    if (file.size > 10 * 1024 * 1024) {
      return c.json({ error: "File too large (max 10MB)" }, 413);
    }
    html = await file.text();
    sourceFilename = file.name || null;
    const titleField = form.get("title");
    if (typeof titleField === "string" && titleField.trim()) {
      providedTitle = titleField.trim().slice(0, 200);
    }
  } else {
    const raw = await c.req.json().catch(() => null);
    const parsed = jsonBody.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: "Invalid JSON body", details: parsed.error.flatten() }, 400);
    }
    html = parsed.data.html;
    providedTitle = parsed.data.title;
    sourceFilename = parsed.data.filename ?? null;
  }

  const titleFromHtml = extractTitle(html);
  const filenameTitle = sourceFilename
    ? sourceFilename.replace(/\.html?$/i, "").replace(/[_-]+/g, " ").trim()
    : null;
  const title = providedTitle ?? titleFromHtml ?? filenameTitle ?? null;

  const trip = await createTrip({ ownerId: userId, title, html, sourceFilename });

  return c.json(
    {
      trip: {
        id: trip.id,
        slug: trip.slug,
        title: trip.title,
        sourceFilename: trip.sourceFilename,
        createdAt: trip.createdAt,
      },
    },
    201,
  );
});

/** GET /api/trips — list metadata only (no html, keeps payload small) */
tripsRoutes.get("/", optionalAuth, async (c) => {
  const trips = await listTrips();
  return c.json({ trips });
});

/** GET /api/trips/:slug — full row, including HTML */
tripsRoutes.get("/:slug", optionalAuth, zValidator("param", slugParam), async (c) => {
  const trip = await getTripBySlug(c.req.valid("param").slug);
  if (!trip) return c.json({ error: "Not found" }, 404);
  return c.json({ trip });
});

/**
 * PATCH /api/trips/:slug — owner-gated update. Same body shape as POST:
 *   - multipart with field `file` (replaces html + sourceFilename) and
 *     optional `title` (overrides extraction)
 *   - application/json: { html?, title?, filename? }
 *
 * Title precedence on update when html is replaced:
 *   explicit title in body > extracted from new html > current title (unchanged)
 *
 * Slug is never changed by PATCH — that's the whole point of having an
 * update endpoint vs. delete-then-recreate.
 */
tripsRoutes.patch("/:slug", requireAuth, requireScope("trips:write"), zValidator("param", slugParam), async (c) => {
  const userId = c.get("userId") as string;
  const slug = c.req.valid("param").slug;
  const contentType = c.req.header("Content-Type") ?? "";

  let html: string | undefined;
  let providedTitle: string | undefined;
  let sourceFilename: string | null | undefined;

  if (contentType.includes("multipart/form-data")) {
    const form = await c.req.formData();
    const file = form.get("file");
    if (file instanceof File) {
      if (file.size > 10 * 1024 * 1024) return c.json({ error: "File too large (max 10MB)" }, 413);
      html = await file.text();
      sourceFilename = file.name || null;
    }
    const titleField = form.get("title");
    if (typeof titleField === "string" && titleField.trim()) {
      providedTitle = titleField.trim().slice(0, 200);
    }
  } else {
    const raw = await c.req.json().catch(() => null);
    const parsed = z
      .object({
        html: z.string().min(1).max(10 * 1024 * 1024).optional(),
        title: z.string().min(1).max(200).optional(),
        filename: z.string().min(1).max(255).optional(),
      })
      .safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: "Invalid JSON body", details: parsed.error.flatten() }, 400);
    }
    html = parsed.data.html;
    providedTitle = parsed.data.title;
    if (parsed.data.filename !== undefined) sourceFilename = parsed.data.filename;
  }

  if (html === undefined && providedTitle === undefined && sourceFilename === undefined) {
    return c.json({ error: "Nothing to update — provide html, title, or filename" }, 400);
  }

  // Re-extract title when html is replaced but no explicit title was given.
  // Without this the old title would stick even after the content shifts.
  let titleToWrite: string | undefined;
  if (providedTitle !== undefined) {
    titleToWrite = providedTitle;
  } else if (html !== undefined) {
    const extracted = extractTitle(html);
    if (extracted) titleToWrite = extracted;
  }

  const updated = await updateTripBySlug(slug, userId, {
    html,
    title: titleToWrite,
    sourceFilename,
  });
  if (!updated) return c.json({ error: "Not found or not owner" }, 404);

  return c.json({
    trip: {
      id: updated.id,
      slug: updated.slug,
      title: updated.title,
      sourceFilename: updated.sourceFilename,
      updatedAt: updated.updatedAt,
    },
  });
});

/** DELETE /api/trips/:slug — owner only */
tripsRoutes.delete("/:slug", requireAuth, requireScope("trips:write"), zValidator("param", slugParam), async (c) => {
  const userId = c.get("userId") as string;
  const ok = await deleteTripBySlug(c.req.valid("param").slug, userId);
  return ok ? c.body(null, 204) : c.json({ error: "Not found or not owner" }, 404);
});
