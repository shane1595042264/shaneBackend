import { Hono } from "hono";
import { z } from "zod";
import { requireAuth, requireBrowserSession } from "@/modules/auth/middleware";
import { uuidId } from "@/modules/shared/validators";
import { zValidator } from "@/modules/shared/zod-validator";
import { AI_PROVIDERS, PROVIDER_LABEL, type AiProvider } from "./detect";
import * as repo from "./repo";
import { ExplainError, KeyCheckError, addKey, explain, recheckKey } from "./service";

/**
 * SHAN-596: bring-your-own-key AI. Every route here acts on, or spends from,
 * the caller's own provider account, so all of them are browser-session only:
 * a PAT is a credential handed to scripts and agents, and none of those should
 * be able to read which keys exist, add one, or run up a bill on one.
 */
export const aiRoutes = new Hono();

aiRoutes.use("*", requireAuth, requireBrowserSession("AI keys and Explain"));

const providerEnum = z.enum(AI_PROVIDERS as [AiProvider, ...AiProvider[]]);
const idParam = z.object({ id: uuidId("Invalid id") });

aiRoutes.get("/keys", async (c) => {
  const userId = c.get("userId") as string;
  const [keys, settings] = await Promise.all([repo.listKeys(userId), repo.getSettings(userId)]);
  return c.json({ keys: keys.map(repo.publicKey), settings, providers: PROVIDER_LABEL });
});

aiRoutes.post(
  "/keys",
  zValidator("json", z.object({ key: z.string().trim().min(1).max(400) }).strict()),
  async (c) => {
    const userId = c.get("userId") as string;
    try {
      const row = await addKey(userId, c.req.valid("json").key);
      return c.json({ key: repo.publicKey(row) }, 201);
    } catch (err) {
      if (err instanceof KeyCheckError) {
        const status = err.code === "unknown_provider" ? 400 : err.code === "unreachable" ? 502 : 422;
        return c.json({ error: err.message, code: err.code }, status);
      }
      throw err;
    }
  }
);

aiRoutes.patch(
  "/keys/:id",
  zValidator("param", idParam),
  zValidator("json", z.object({ preferredModel: z.string().max(120).nullable() }).strict()),
  async (c) => {
    const userId = c.get("userId") as string;
    const { id } = c.req.valid("param");
    const { preferredModel } = c.req.valid("json");
    const row = await repo.getKey(userId, id);
    if (!row) return c.json({ error: "Key not found" }, 404);
    const models = Array.isArray(row.models) ? (row.models as string[]) : [];
    if (preferredModel !== null && !models.includes(preferredModel)) {
      return c.json({ error: "That model is not available to this key" }, 400);
    }
    // The model list checked above belongs to this exact key; if it was
    // replaced or deleted since, the choice no longer applies.
    const updated = await repo.updateKey(userId, id, { preferredModel }, row.keySealed);
    if (!updated) return c.json({ error: "This key changed while you were choosing. Reload and pick again." }, 409);
    return c.json({ key: repo.publicKey(updated) });
  }
);

aiRoutes.post("/keys/:id/check", zValidator("param", idParam), async (c) => {
  const userId = c.get("userId") as string;
  const updated = await recheckKey(userId, c.req.valid("param").id);
  if (!updated) return c.json({ error: "Key not found" }, 404);
  return c.json({ key: repo.publicKey(updated) });
});

aiRoutes.delete("/keys/:id", zValidator("param", idParam), async (c) => {
  const userId = c.get("userId") as string;
  const ok = await repo.deleteKey(userId, c.req.valid("param").id);
  return ok ? c.body(null, 204) : c.json({ error: "Key not found" }, 404);
});

aiRoutes.patch(
  "/settings",
  zValidator(
    "json",
    z
      .object({
        preferredProvider: providerEnum.nullable().optional(),
        notesToKnowledge: z.boolean().optional(),
      })
      .strict()
  ),
  async (c) => {
    const userId = c.get("userId") as string;
    const settings = await repo.saveSettings(userId, c.req.valid("json"));
    return c.json({ settings });
  }
);

const explainBody = z
  .object({
    quote: z.string().trim().min(1).max(600),
    before: z.string().max(2000).default(""),
    after: z.string().max(2000).default(""),
    title: z.string().trim().max(300).optional(),
    heading: z.string().trim().max(300).optional(),
    surface: z.enum(["journal", "blog", "knowledge"]),
  })
  .strict();

aiRoutes.post("/explain", zValidator("json", explainBody), async (c) => {
  const userId = c.get("userId") as string;
  try {
    return c.json(await explain(userId, c.req.valid("json")));
  } catch (err) {
    if (err instanceof ExplainError) {
      return c.json(
        { error: err.message, code: err.code, kind: err.kind ?? null },
        err.code === "no_key" ? 409 : 502
      );
    }
    throw err;
  }
});

aiRoutes.get(
  "/usage",
  zValidator("query", z.object({ days: z.coerce.number().int().min(1).max(365).default(30) })),
  async (c) => {
    const userId = c.get("userId") as string;
    return c.json(await repo.usageSummary(userId, c.req.valid("query").days));
  }
);
