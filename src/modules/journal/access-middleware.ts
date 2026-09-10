// src/modules/journal/access-middleware.ts
//
// The invite-only gate itself (SHAN-475, Phase 2 of SHAN-472). Phase 1 built
// the membership tables and the request/approve API; this is what finally makes
// them mean something.
//
// Applied to every route in journal/routes.ts, reads included, immediately
// after whichever auth middleware that route already runs — so `userId` is
// resolved by the time we look membership up. Two routes deliberately skip it:
//
//   - /api/journal/access/*  is the door; it cannot be behind itself.
//   - GET /api/journal/images/:id  is fetched by an <img> tag, which sends no
//     Authorization header. Gating it would break inline images for members
//     too. The ids are unguessable uuids, so an image URL is a capability.
//
// PATs are NOT special-cased. A PAT resolves to the user who minted it, so an
// agent inherits exactly its owner's membership: invite the human and their
// agents work, revoke the human and their agents stop. This is the opposite of
// the /access routes, which reject PATs outright — an agent must never be able
// to grant itself access, but reading on its owner's behalf is the whole point.
import { createMiddleware } from "hono/factory";
import type { AuthVars } from "@/modules/auth/middleware";
import { hasJournalAccess } from "./access-repo";

/** Machine-readable marker so the frontend can tell "no access" from "no auth". */
export const JOURNAL_ACCESS_DENIED_CODE = "journal_access_required";

export const requireJournalMembership = createMiddleware<{ Variables: AuthVars }>(
  async (c, next) => {
    // 403 rather than 401 for signed-out callers too: the caller is not being
    // asked to authenticate differently, they are being told this journal is
    // not theirs to read. The frontend gate reads GET /access/me for the
    // nuance and renders sign-in vs. request-access from that.
    if (!(await hasJournalAccess(c.get("userId") ?? null))) {
      return c.json(
        { error: "Journal access required", code: JOURNAL_ACCESS_DENIED_CODE },
        403,
      );
    }
    await next();
  },
);
