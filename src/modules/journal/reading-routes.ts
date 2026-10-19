// src/modules/journal/reading-routes.ts
//
// SHAN-597: reading positions, mounted at /api/journal/reading.
//
// Its own router, mounted in app.ts, rather than more routes on journalRoutes:
// it is browser-session only, and every journal route test mocks the auth
// middleware with only optionalAuth/requireAuth/requireScope, so importing
// requireBrowserSession into journal/routes.ts would break them all at import.
import { Hono } from "hono";
import { z } from "zod";
import { requireAuth, requireBrowserSession, type AuthVars } from "@/modules/auth/middleware";
import { zValidator } from "@/modules/shared/zod-validator";
import { dropLoneSurrogates, isoDate } from "@/modules/shared/validators";
import { requireJournalMembership } from "./access-middleware";
import {
  entryIdForDate,
  getReadingPosition,
  listReadingPositions,
  saveReadingPosition,
} from "./reading-repo";

export const journalReadingRoutes = new Hono<{ Variables: AuthVars }>();

// A reading position belongs to a person reading in a browser; an agent has
// nothing to save. Membership too: you can only be partway through an entry
// you are allowed to read.
journalReadingRoutes.use(
  "*",
  requireAuth,
  requireBrowserSession("Reading positions"),
  requireJournalMembership
);

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const dateParam = z.object({ date: isoDate });

const saveBody = z
  .object({
    progress: z.number().min(0).max(1),
    anchor: z
      .object({
        block: z.number().int().min(0).max(100_000),
        // Past 1 when the reading line sits in a gap below the block (a
        // diagram, an image the block list skips); capped well above that.
        offset: z.number().min(0).max(100),
        // The client cuts this from the page, which can split a surrogate
        // pair, and Postgres refuses a lone surrogate inside jsonb (SHAN-578).
        text: z.string().max(200).transform(dropLoneSurrogates),
      })
      .strict(),
  })
  .strict();

journalReadingRoutes.get("/", zValidator("query", listQuery), async (c) => {
  const { limit } = c.req.valid("query");
  const positions = await listReadingPositions(c.get("userId")!, limit);
  return c.json({ positions });
});

journalReadingRoutes.get("/:date", zValidator("param", dateParam), async (c) => {
  const { date } = c.req.valid("param");
  const position = await getReadingPosition(c.get("userId")!, date);
  return c.json({ position });
});

journalReadingRoutes.put(
  "/:date",
  zValidator("param", dateParam),
  zValidator("json", saveBody),
  async (c) => {
    const { date } = c.req.valid("param");
    const body = c.req.valid("json");
    const entryId = await entryIdForDate(date);
    if (!entryId) return c.json({ error: "Not found" }, 404);
    const position = await saveReadingPosition({
      userId: c.get("userId")!,
      entryId,
      date,
      progress: body.progress,
      anchor: body.anchor,
    });
    return c.json({ position });
  }
);
