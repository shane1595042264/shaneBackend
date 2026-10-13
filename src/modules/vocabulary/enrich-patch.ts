import type { EnrichedVocab } from "./ai-enricher";

/**
 * The column set an enrich pass writes onto an existing vocab_words row.
 *
 * Only fields the enricher actually produced are included (SHAN-570). The
 * enrich routes read the row, wait seconds on the LLM, then update it; filling
 * a blank answer from that earlier read would write a stale copy over any edit
 * saved while the call ran. Leaving the key out keeps whatever is stored now.
 */
export function enrichPatch(enriched: EnrichedVocab) {
  const patch: Partial<EnrichedVocab> & { aiMetadata: { enrichedAt: string }; updatedAt: Date } = {
    aiMetadata: { enrichedAt: new Date().toISOString() },
    updatedAt: new Date(),
  };
  if (enriched.definition) patch.definition = enriched.definition;
  if (enriched.pronunciation) patch.pronunciation = enriched.pronunciation;
  if (enriched.partOfSpeech) patch.partOfSpeech = enriched.partOfSpeech;
  if (enriched.exampleSentence) patch.exampleSentence = enriched.exampleSentence;
  if (enriched.labels.length > 0) patch.labels = enriched.labels;
  return patch;
}
