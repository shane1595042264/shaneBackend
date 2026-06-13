import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { optionalAuth, requireAuth, requireScope } from "@/modules/auth/middleware";
import { getUserTimezone } from "@/modules/auth/user-prefs";
import {
  containsInFlightUpload,
  IN_FLIGHT_UPLOAD_MESSAGE,
} from "@/modules/shared/validators";
import {
  createTeaEntry,
  deleteTeaEntry,
  getTeaEntryById,
  listTeaEntriesForAuthor,
  updateTeaEntry,
  verifyPin,
} from "./repo";

const noInFlightUpload = (v: string) => !containsInFlightUpload(v);

type Vars = { Variables: { userId: string | null; tokenScopes: string[] | null } };
export const teaEntriesRoutes = new Hono<Vars>();

// Strict 4-digit numeric PIN. We keep this tight in both create and verify
// so an attacker can't expand the keyspace by submitting longer/alpha PINs.
const pinSchema = z.string().regex(/^\d{4}$/, "PIN must be 4 digits");

const createBody = z.object({
  title: z.string().max(255).optional().nullable(),
  content: z
    .string()
    .min(1)
    .refine(noInFlightUpload, { message: IN_FLIGHT_UPLOAD_MESSAGE }),
  pin: pinSchema,
});

const idParam = z.object({ id: z.string().uuid() });

teaEntriesRoutes.post(
  "/",
  requireAuth,
  requireScope("entries:write"),
  zValidator("json", createBody),
  async (c) => {
    const userId = c.get("userId") as string;
    const { title, content, pin } = c.req.valid("json");
    const authorTimezone = await getUserTimezone(userId);
    const entry = await createTeaEntry({
      authorId: userId,
      authorTimezone,
      title: title ?? null,
      content,
      pin,
    });
    return c.json(
      {
        entry: {
          id: entry.id,
          authorId: entry.authorId,
          authorTimezone: entry.authorTimezone,
          title: entry.title,
          content: entry.content,
          createdAt: entry.createdAt,
          updatedAt: entry.updatedAt,
        },
      },
      201,
    );
  },
);

teaEntriesRoutes.get("/", requireAuth, async (c) => {
  const userId = c.get("userId") as string;
  const entries = await listTeaEntriesForAuthor(userId);
  return c.json({ entries });
});

// Per-post auth: the author always gets the full row (content + pin display).
// Non-authors must supply the matching 4-digit PIN in X-Tea-Pin; on success we
// return only the content (never the pin). Anonymous viewers go down the same
// PIN path as a signed-in non-author — knowing the entry id is the gate.
teaEntriesRoutes.get(
  "/:id",
  optionalAuth,
  zValidator("param", idParam),
  async (c) => {
    const { id } = c.req.valid("param");
    const userId = c.get("userId");
    const row = await getTeaEntryById(id);
    if (!row) return c.json({ error: "Not found" }, 404);

    if (userId && row.authorId === userId) {
      // Author response includes the PIN so the read page can render the
      // asterisks-and-toggle UI. Non-author paths NEVER return the PIN.
      return c.json({
        entry: {
          id: row.id,
          authorId: row.authorId,
          authorTimezone: row.authorTimezone,
          title: row.title,
          content: row.content,
          pin: row.pin,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        },
        isAuthor: true,
      });
    }

    const submittedPin = c.req.header("X-Tea-Pin") ?? "";
    if (!/^\d{4}$/.test(submittedPin)) {
      return c.json({ error: "PIN required" }, 401);
    }
    if (!verifyPin(submittedPin, row.pin)) {
      return c.json({ error: "Incorrect PIN" }, 403);
    }
    return c.json({
      entry: {
        id: row.id,
        authorId: row.authorId,
        authorTimezone: row.authorTimezone,
        title: row.title,
        content: row.content,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      },
      isAuthor: false,
    });
  },
);

// Author-only partial update. Body must include at least one field; a no-op
// PATCH is rejected so we never round-trip an empty UPDATE. 404 on author
// mismatch — same response as a missing id, so we don't leak existence.
const patchBody = z
  .object({
    title: z.string().max(255).optional().nullable(),
    content: z
      .string()
      .min(1)
      .refine(noInFlightUpload, { message: IN_FLIGHT_UPLOAD_MESSAGE })
      .optional(),
    pin: pinSchema.optional(),
  })
  .refine(
    (b) => b.title !== undefined || b.content !== undefined || b.pin !== undefined,
    { message: "At least one field is required" },
  );

teaEntriesRoutes.patch(
  "/:id",
  requireAuth,
  requireScope("entries:write"),
  zValidator("param", idParam),
  zValidator("json", patchBody),
  async (c) => {
    const userId = c.get("userId") as string;
    const { id } = c.req.valid("param");
    const patch = c.req.valid("json");
    const row = await updateTeaEntry(id, userId, patch);
    if (!row) return c.json({ error: "Not found or not author" }, 404);
    // Author is the one editing; mirror the GET-author response (PIN included).
    return c.json({
      entry: {
        id: row.id,
        authorId: row.authorId,
        authorTimezone: row.authorTimezone,
        title: row.title,
        content: row.content,
        pin: row.pin,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      },
      isAuthor: true,
    });
  },
);

teaEntriesRoutes.delete(
  "/:id",
  requireAuth,
  requireScope("entries:write"),
  zValidator("param", idParam),
  async (c) => {
    const userId = c.get("userId") as string;
    const { id } = c.req.valid("param");
    const ok = await deleteTeaEntry(id, userId);
    return ok ? c.body(null, 204) : c.json({ error: "Not found or not author" }, 404);
  },
);
