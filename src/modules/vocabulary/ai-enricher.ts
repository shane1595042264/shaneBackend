import { generateText } from "@/modules/shared/llm";

export interface EnrichedVocab {
  definition: string;
  pronunciation: string;
  partOfSpeech: string;
  exampleSentence: string;
  labels: string[];
}

/**
 * Uses Claude Haiku with 3-shot prompting to auto-generate vocabulary fields.
 * Returns a consistently structured object for rendering.
 */
export async function enrichWord(
  word: string,
  language: string
): Promise<EnrichedVocab> {
  const result = await generateText({
    system: `You enrich vocabulary words with structured metadata. Return ONLY valid JSON matching this exact schema:
{"definition":"...","pronunciation":"...","partOfSpeech":"...","exampleSentence":"...","labels":["..."]}

Rules:
- definition: concise definition in English (even if the word is in another language)
- pronunciation: IPA or romanization (pinyin for Chinese, romaji for Japanese, etc.)
- partOfSpeech: one of "noun", "verb", "adjective", "adverb", "preposition", "conjunction", "pronoun", "interjection", "phrase"
- exampleSentence: a natural sentence using the word in its original language
- labels: 1-4 topical labels like ["food","daily-life"] or ["academic","science"]`,
    prompt: `Here are 3 examples:

Word: "ephemeral" (english)
{"definition":"Lasting for a very short time","pronunciation":"/ɪˈfem.ər.əl/","partOfSpeech":"adjective","exampleSentence":"The beauty of cherry blossoms is ephemeral, lasting only a few days.","labels":["literary","time"]}

Word: "吃" (chinese)
{"definition":"To eat; to consume food","pronunciation":"chī","partOfSpeech":"verb","exampleSentence":"我们一起去吃晚饭吧。","labels":["food","daily-life"]}

Word: "biblioteca" (spanish)
{"definition":"Library; a place where books are kept for reading or borrowing","pronunciation":"/bi.bli.o.ˈte.ka/","partOfSpeech":"noun","exampleSentence":"Voy a la biblioteca para estudiar.","labels":["education","places"]}

Now enrich this word:
Word: "${word}" (${language})`,
    model: "claude-haiku-4-5-20251001",
    maxTokens: 256,
  });

  const cleaned = result.text
    .replace(/```json\n?/g, "")
    .replace(/```\n?/g, "")
    .trim();

  try {
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : cleaned);
    return {
      definition: parsed.definition || "",
      pronunciation: parsed.pronunciation || "",
      partOfSpeech: parsed.partOfSpeech || parsed.part_of_speech || "",
      exampleSentence:
        parsed.exampleSentence || parsed.example_sentence || "",
      labels: Array.isArray(parsed.labels) ? parsed.labels : [],
    };
  } catch {
    return {
      definition: "",
      pronunciation: "",
      partOfSpeech: "",
      exampleSentence: "",
      labels: [],
    };
  }
}
