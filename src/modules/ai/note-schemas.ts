// SHAN-596: the shapes every inline note shares, wherever it is stored
// (journal_comments for the journal, reader_notes for blog posts and
// knowledge cards).

import { z } from "zod";
import { dropLoneSurrogates } from "@/modules/shared/validators";
import { AI_PROVIDERS, type AiProvider } from "./detect";

/**
 * Where a note is pinned. `target` names the part of the page; see SHAN-577.
 * Lone surrogates are dropped as on journal anchors (SHAN-578): the client
 * cuts context at 64 UTF-16 units, which can split an emoji, and jsonb
 * rejects the half.
 */
export const anchorSchema = (target: z.ZodTypeAny) =>
  z
    .object({
      target,
      quote: z.string().transform(dropLoneSurrogates).pipe(z.string().trim().min(1).max(1000)),
      prefix: z.string().max(64).default("").transform(dropLoneSurrogates),
      suffix: z.string().max(64).default("").transform(dropLoneSurrogates),
    })
    .strict();

/**
 * How a note came to be. Absent for a typed note; {kind: "ai", provider,
 * model} for an Explain answer, which the client shows with its model's name
 * and checks before spending tokens on a selection it has already explained.
 */
export const noteMetaSchema = z
  .object({
    kind: z.literal("ai"),
    provider: z.enum(AI_PROVIDERS as [AiProvider, ...AiProvider[]]),
    model: z.string().trim().min(1).max(120),
  })
  .strict();
