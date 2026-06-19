import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { requireAuth, requireScope } from "./middleware";
import {
  clearUniversalTeaPin,
  getUniversalTeaPin,
  setUniversalTeaPin,
} from "./user-prefs";

type Vars = { Variables: { userId: string | null; tokenScopes: string[] | null } };
export const userPrefsRoutes = new Hono<Vars>();

// Same 4-digit numeric constraint as the per-entry pin. Universal pins live
// in the same keyspace so the brute-force surface doesn't widen.
const pinBody = z.object({
  pin: z.string().regex(/^\d{4}$/, "PIN must be 4 digits"),
});

// GET returns presence only — never the pin itself. The settings UI uses
// this to decide whether to render "Set" vs "Clear" copy. Pin exfil via GET
// would defeat the purpose of the gate; the author already has the pin in
// localStorage on the device they set it from.
userPrefsRoutes.get("/tea-universal-pin", requireAuth, async (c) => {
  const userId = c.get("userId") as string;
  const pin = await getUniversalTeaPin(userId);
  return c.json({ isSet: pin !== null });
});

// PUT sets or rotates the universal pin. Scoped to entries:write so a PAT
// that can already manage tea entries can also manage the unlock pref;
// granting any narrower scope wouldn't materially reduce blast radius since
// entries:write already lets a PAT read/write the underlying content.
userPrefsRoutes.put(
  "/tea-universal-pin",
  requireAuth,
  requireScope("entries:write"),
  zValidator("json", pinBody),
  async (c) => {
    const userId = c.get("userId") as string;
    const { pin } = c.req.valid("json");
    await setUniversalTeaPin(userId, pin);
    return c.json({ isSet: true });
  },
);

userPrefsRoutes.delete(
  "/tea-universal-pin",
  requireAuth,
  requireScope("entries:write"),
  async (c) => {
    const userId = c.get("userId") as string;
    await clearUniversalTeaPin(userId);
    return c.json({ isSet: false });
  },
);
