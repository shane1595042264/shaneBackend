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
import { isoDate } from "@/modules/shared/validators";
import { readingListQuery, readingSaveBody } from "@/modules/shared/reading-position";
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

const dateParam = z.object({ date: isoDate });

journalReadingRoutes.get("/", zValidator("query", readingListQuery), async (c) => {
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
  zValidator("json", readingSaveBody),
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
