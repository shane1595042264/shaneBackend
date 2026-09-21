import { Hono } from "hono";
import { zValidator } from "@/modules/shared/zod-validator";
import { z } from "zod";
import { optionalAuth, requireScope } from "@/modules/auth/middleware";
import { encodeKeysetCursor, keysetCursorParam } from "@/modules/shared/keyset";
import { extractTitle } from "./title";
import {
  createTrip,
  findDuplicateTrip,
  listTrips,
  getTripBySlug,
  updateTripBySlug,
  deleteTripBySlug,
} from "./repo";

export const tripsRoutes = new Hono();

// JSON path for curl / programmatic uploads.
const jsonCreateBody = z.object({
  html: z.string().min(1).max(10 * 1024 * 1024),
  title: z.string().min(1).max(200).optional(),
  filename: z.string().min(1).max(255).optional(),
  // SHAN-514: opt out of duplicate detection and create a second copy anyway.
  force: z.boolean().optional(),
});

const jsonPatchBody = z.object({
  html: z.string().min(1).max(10 * 1024 * 1024).optional(),
  title: z.string().min(1).max(200).optional(),
  filename: z.string().min(1).max(255).optional(),
});

const slugParam = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/),
});

// Opt-in keyset pagination for the list endpoint. Both optional, so a
// bare GET /api/trips keeps returning the full list (nextCursor null).
const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  // Compound cursor (`<iso>_<id>`) for the last row of the previous page —
  // see modules/shared/keyset.ts for why the id half is load-bearing. The
  // shape is validated here so a malformed cursor is rejected with 400 rather
  // than silently swallowed downstream (which would resurface page 1). Bare
  // ISO cursors minted before SHAN-513 still parse.
  cursor: keysetCursorParam.optional(),
});

/**
 * Trips access policy:
 *  - POST: open / anonymous-friendly. Drop-an-HTML-file UX is preserved.
 *    Authed uploads stamp ownerId; anonymous uploads have ownerId === null.
 *  - GET (list + by slug): open.
 *  - PATCH /:slug, DELETE /:slug: gated on a per-trip basis.
 *      * If the trip has ownerId === null (anonymous upload), the
 *        free-for-all still applies — anyone (authed or not) can edit
 *        or delete it. This keeps the open-pastebin contract.
 *      * If the trip has ownerId !== null, only that owner can edit/delete.
 *        Anonymous callers and authed-but-non-owner callers get 403.
 *  - Browser sessions (JWT) bypass scope checks; PATs need the
 *    trips:write scope (enforced by requireScope below). Sandboxed iframes
 *    still contain whatever HTML lands.
 */

/**
 * POST /api/trips
 *
 * Two body shapes:
 *  - multipart/form-data with field `file` (.html upload from a dropzone)
 *  - application/json: { html, title?, filename?, force? }
 *
 * Title precedence: explicit body title > <title> > first <h1> > cleaned
 * filename > null.
 *
 * If the request is authed (browser session or PAT), the upload is
 * attributed to the user via owner_id. Anonymous uploads have owner_id
 * = null and display as "Anonymous" on the index.
 *
 * SHAN-514: an upload that duplicates an existing trip is refused with 409 and
 * `code: "duplicate_trip"`, carrying the existing trip so the caller can link
 * to it. Before this, a repeat upload was indistinguishable from a new trip:
 * generateUniqueSlug() read the slug collision as "add a random suffix", so
 * dropping the same file twice minted a second public URL with the same title
 * and both ended up in sitemap.xml. Pass `force` to create the copy anyway --
 * the open-pastebin contract is intact, it just stops being the accident.
 */
tripsRoutes.post("/", optionalAuth, async (c) => {
  const userId = c.get("userId") as string | null;
  const contentType = c.req.header("Content-Type") ?? "";

  let html: string;
  let providedTitle: string | undefined;
  let sourceFilename: string | null = null;
  let force = false;

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
    // Multipart fields are always strings, so the boolean has to be spelled out.
    const forceField = form.get("force");
    force = forceField === "true" || forceField === "1";
  } else {
    const raw = await c.req.json().catch(() => null);
    const parsed = jsonCreateBody.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: "Invalid JSON body", details: parsed.error.flatten() }, 400);
    }
    html = parsed.data.html;
    providedTitle = parsed.data.title;
    sourceFilename = parsed.data.filename ?? null;
    force = parsed.data.force ?? false;
  }

  const titleFromHtml = extractTitle(html);
  const filenameTitle = sourceFilename
    ? sourceFilename.replace(/\.html?$/i, "").replace(/[_-]+/g, " ").trim()
    : null;
  const title = providedTitle ?? titleFromHtml ?? filenameTitle ?? null;

  if (!force) {
    const existing = await findDuplicateTrip({ title, html });
    if (existing) {
      return c.json(
        {
          error: "This trip has already been uploaded",
          code: "duplicate_trip",
          existing: {
            slug: existing.slug,
            title: existing.title,
            createdAt: existing.createdAt,
          },
        },
        409,
      );
    }
  }

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

/**
 * GET /api/trips — list metadata only (no html, keeps payload small).
 *
 * Opt-in pagination: pass ?limit=N (1..100) and optionally ?cursor=<the
 * nextCursor from the previous page>. With no params the full list is
 * returned and nextCursor is null (legacy behavior). When a full page
 * (length === limit) comes back, nextCursor encodes the last row's createdAt
 * and id so the caller can fetch the next page without skipping a tie.
 */
tripsRoutes.get("/", zValidator("query", listQuery), async (c) => {
  const { limit, cursor } = c.req.valid("query");
  const trips = await listTrips({ limit, cursor });
  const last = trips[trips.length - 1];
  const nextCursor =
    limit && trips.length === limit ? encodeKeysetCursor(last.createdAt, last.id) : null;
  return c.json({ trips, nextCursor });
});

/** GET /api/trips/:slug — full row, including HTML */
tripsRoutes.get("/:slug", zValidator("param", slugParam), async (c) => {
  const trip = await getTripBySlug(c.req.valid("param").slug);
  if (!trip) return c.json({ error: "Not found" }, 404);
  return c.json({ trip });
});

/**
 * PATCH /api/trips/:slug — open update. Same body shape as POST:
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
tripsRoutes.patch(
  "/:slug",
  optionalAuth,
  requireScope("trips:write"),
  zValidator("param", slugParam),
  async (c) => {
    const slug = c.req.valid("param").slug;

    // Ownership check first — cheaper to fail fast on 403 than to parse the body.
    const existing = await getTripBySlug(slug);
    if (!existing) return c.json({ error: "Not found" }, 404);
    const userId = c.get("userId") as string | null;
    if (existing.ownerId !== null && existing.ownerId !== userId) {
      return c.json({ error: "Only the owner can edit this trip" }, 403);
    }

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
      const parsed = jsonPatchBody.safeParse(raw);
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

    const updated = await updateTripBySlug(slug, {
      html,
      title: titleToWrite,
      sourceFilename,
    });
    if (!updated) return c.json({ error: "Not found" }, 404);

    return c.json({
      trip: {
        id: updated.id,
        slug: updated.slug,
        title: updated.title,
        sourceFilename: updated.sourceFilename,
        updatedAt: updated.updatedAt,
      },
    });
  },
);

/**
 * DELETE /api/trips/:slug — anonymous trips stay open (anyone deletes);
 * authed trips are owner-only (403 otherwise).
 */
tripsRoutes.delete(
  "/:slug",
  optionalAuth,
  requireScope("trips:write"),
  zValidator("param", slugParam),
  async (c) => {
    const slug = c.req.valid("param").slug;
    const existing = await getTripBySlug(slug);
    if (!existing) return c.json({ error: "Not found" }, 404);
    const userId = c.get("userId") as string | null;
    if (existing.ownerId !== null && existing.ownerId !== userId) {
      return c.json({ error: "Only the owner can delete this trip" }, 403);
    }
    const ok = await deleteTripBySlug(slug);
    return ok ? c.body(null, 204) : c.json({ error: "Not found" }, 404);
  },
);
