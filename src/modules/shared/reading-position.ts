// Where a reader left off in a long piece of writing: the shape the journal
// (SHAN-597) and the blog (SHAN-705) both save. One validator, so the two
// surfaces cannot drift apart on what a position is.
import { z } from "zod";
import { dropLoneSurrogates } from "./validators";

export interface ReadingAnchor {
  /** Index of the text block on the reading line, in document order. */
  block: number;
  /** How far down that block the reading line sat, as a fraction of its height. */
  offset: number;
  /** The block's opening words, to find it again if an edit moved it. */
  text: string;
}

export const readingSaveBody = z
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

export const readingListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
