// src/modules/journal/access-routes.ts
//
// Invite-only journal access API (SHAN-474, Phase 1 of SHAN-472). Mounted at
// /api/journal/access by routes.ts.
//
// Every route here is browser-session only. PATs are rejected on purpose: the
// same reasoning as requireAdmin() in auth/middleware.ts — an agent token that
// could grant itself journal access would defeat the invite list entirely.
import { Hono } from "hono";
import { z } from "zod";
import { createMiddleware } from "hono/factory";
import { zValidator } from "@/modules/shared/zod-validator";
import { requireAuth, optionalAuth, type AuthVars } from "@/modules/auth/middleware";
import { trimmedOptional } from "@/modules/shared/validators";
import {
  approveRequest,
  createOrRefreshRequest,
  getAccessFor,
  grantAccessByEmail,
  listMembers,
  listRequests,
  rejectRequest,
  revokeAccess,
} from "./access-repo";

type Vars = { Variables: AuthVars };

export const journalAccessRoutes = new Hono<Vars>();

const uuidParam = z.object({ id: z.string().uuid() });
const userIdParam = z.object({ userId: z.string().uuid() });

/** Reject PATs. Access management is a human, browser-session action. */
const browserOnly = createMiddleware<Vars>(async (c, next) => {
  if (c.get("tokenScopes") !== null) {
    return c.json({ error: "Journal access management requires a browser session, not a PAT" }, 403);
  }
  await next();
});

const requireJournalOwner = createMiddleware<Vars>(async (c, next) => {
  const state = await getAccessFor(c.get("userId"));
  if (state.role !== "owner") return c.json({ error: "Journal owner access required" }, 403);
  await next();
});

// Signed-out callers get the same shape with nulls rather than a 401, so the
// journal page can render one "you need access" screen for both cases.
journalAccessRoutes.get("/me", optionalAuth, async (c) => {
  const state = await getAccessFor(c.get("userId"));
  return c.json(state);
});

// ------------------------------------------------------------------
// requests (any signed-in user)
// ------------------------------------------------------------------

const requestBody = z.object({ message: trimmedOptional(500) });

journalAccessRoutes.post(
  "/requests",
  requireAuth,
  browserOnly,
  zValidator("json", requestBody),
  async (c) => {
    const userId = c.get("userId") as string;
    const state = await getAccessFor(userId);
    if (state.role) return c.json({ error: "You already have access to the journal" }, 409);

    const { message } = c.req.valid("json");
    const { request, created } = await createOrRefreshRequest(userId, message ?? null);
    return c.json({ request }, created ? 201 : 200);
  },
);

// ------------------------------------------------------------------
// owner-only management
// ------------------------------------------------------------------

const requestsQuery = z.object({
  status: z.enum(["pending", "approved", "rejected"]).optional(),
});

journalAccessRoutes.get(
  "/requests",
  requireAuth,
  browserOnly,
  requireJournalOwner,
  zValidator("query", requestsQuery),
  async (c) => c.json({ requests: await listRequests(c.req.valid("query").status) }),
);

journalAccessRoutes.post(
  "/requests/:id/approve",
  requireAuth,
  browserOnly,
  requireJournalOwner,
  zValidator("param", uuidParam),
  async (c) => {
    const row = await approveRequest(c.req.valid("param").id, c.get("userId") as string);
    if (!row) return c.json({ error: "No pending request with that id" }, 404);
    return c.json({ request: row });
  },
);

journalAccessRoutes.post(
  "/requests/:id/reject",
  requireAuth,
  browserOnly,
  requireJournalOwner,
  zValidator("param", uuidParam),
  async (c) => {
    const row = await rejectRequest(c.req.valid("param").id, c.get("userId") as string);
    if (!row) return c.json({ error: "No pending request with that id" }, 404);
    return c.json({ request: row });
  },
);

journalAccessRoutes.get(
  "/members",
  requireAuth,
  browserOnly,
  requireJournalOwner,
  async (c) => c.json({ members: await listMembers() }),
);

const inviteBody = z.object({ email: z.string().trim().email().max(255) });

journalAccessRoutes.post(
  "/members",
  requireAuth,
  browserOnly,
  requireJournalOwner,
  zValidator("json", inviteBody),
  async (c) => {
    const user = await grantAccessByEmail(c.req.valid("json").email, c.get("userId") as string);
    // Identity comes from Google OAuth, so we can only invite somebody who has
    // signed in at least once. 404 tells the owner to have them log in first.
    if (!user) {
      return c.json({ error: "No account has signed in with that email yet" }, 404);
    }
    return c.json({ member: user }, 201);
  },
);

journalAccessRoutes.delete(
  "/members/:userId",
  requireAuth,
  browserOnly,
  requireJournalOwner,
  zValidator("param", userIdParam),
  async (c) => {
    const removed = await revokeAccess(c.req.valid("param").userId);
    // revokeAccess only deletes role="member" rows, so a miss here is either an
    // unknown user or an attempt to revoke the owner. Both are a 404.
    if (!removed) return c.json({ error: "Not a journal member" }, 404);
    return c.body(null, 204);
  },
);
