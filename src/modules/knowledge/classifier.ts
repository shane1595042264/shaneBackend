import { generateText } from "@/modules/shared/llm";

export interface ClassificationSource {
  app: string | null;
  book: string | null;
  author: string | null;
  location: string | null;
  rawContext: string | null;
}

export interface ClassificationResult {
  category: string;
  word: string;
  language: string;
  definition: string;
  pronunciation: string;
  partOfSpeech: string;
  exampleSentence: string;
  labels: string[];
  source: ClassificationSource | null;
}

/**
 * Uses Claude to classify a free-form note into a knowledge category
 * and extract structured fields for storage.
 */
export async function classifyNote(
  text: string
): Promise<ClassificationResult> {
  const result = await generateText({
    system: `You are a knowledge classifier. Given a free-form note, you must:
1. Determine which category this knowledge belongs to
2. Extract structured metadata for storage
3. Detect provenance (where this knowledge came from) if mentioned

Categories (use lowercase):
- "vocabulary" — language learning (words, phrases, translations)
- "coding" — programming concepts, syntax, patterns, tools
- "general" — anything else (science, history, life tips, etc.)

Return ONLY valid JSON matching this schema:
{"category":"...","word":"...","language":"...","definition":"...","pronunciation":"...","partOfSpeech":"...","exampleSentence":"...","labels":["..."],"source":null|{"app":"...","book":"...","author":"...","location":"...","rawContext":"..."}}

Rules by category:
- vocabulary: "word" = the foreign word/phrase, "language" = the language (english/chinese/spanish/etc.), "definition" = English meaning, "pronunciation" = IPA or romanization, "partOfSpeech" = grammatical type, "exampleSentence" = usage in original language, "labels" = topical tags
- coding: "word" = the concept/keyword (e.g. "void return type"), "language" = programming language or "general", "definition" = concise explanation, "pronunciation" = "" (empty), "partOfSpeech" = one of "keyword","concept","pattern","function","operator","type", "exampleSentence" = code example or usage, "labels" = topical tags like ["typescript","functions"]
- general: "word" = the concept/fact title, "language" = "general", "definition" = concise explanation, "pronunciation" = "" (empty), "partOfSpeech" = "concept", "exampleSentence" = an example or context, "labels" = topical tags

Source extraction rules:
- If the input mentions a book, author, app (like Nibbler, Kindle, etc.), page, chapter, or place where this concept was encountered, populate "source" with the relevant fields (any subset of app/book/author/location). Always also set "rawContext" to the original input text.
- If the input has no provenance signal, return "source": null.
- Do NOT guess sources. Only include fields the input explicitly mentions.`,
    prompt: `Here are examples:

Note: "today I learned that gracias means thank you in Spanish"
{"category":"vocabulary","word":"gracias","language":"spanish","definition":"Thank you; an expression of gratitude","pronunciation":"/ˈɡɾa.θjas/","partOfSpeech":"interjection","exampleSentence":"Muchas gracias por tu ayuda.","labels":["daily-life","greetings"],"source":null}

Note: "void doesn't make the function do nothing. It just specifies the return type"
{"category":"coding","word":"void return type","language":"typescript","definition":"void specifies that a function does not return a value; it describes the return type, not the function's behavior","pronunciation":"","partOfSpeech":"type","exampleSentence":"function logMessage(msg: string): void { console.log(msg); }","labels":["typescript","functions","types"],"source":null}

Note: "The speed of light is approximately 299,792,458 meters per second"
{"category":"general","word":"Speed of light","language":"general","definition":"The speed of light in vacuum is exactly 299,792,458 meters per second (about 186,282 miles per second)","pronunciation":"","partOfSpeech":"concept","exampleSentence":"Light from the Sun takes about 8 minutes and 20 seconds to reach Earth.","labels":["physics","constants"],"source":null}

Note: "Read this in War and Peace, ch. 3: дворецкий = butler"
{"category":"vocabulary","word":"дворецкий","language":"russian","definition":"butler; head male servant of a household","pronunciation":"dvorétskij","partOfSpeech":"noun","exampleSentence":"Дворецкий встретил гостей у двери.","labels":["household","servants","19th-century"],"source":{"book":"War and Peace","location":"ch. 3","rawContext":"Read this in War and Peace, ch. 3: дворецкий = butler"}}

Now classify this note:
Note: "${text.replace(/"/g, '\\"')}"`,
    model: "claude-haiku-4-5-20251001",
    maxTokens: 512,
  });

  const cleaned = result.text
    .replace(/```json\n?/g, "")
    .replace(/```\n?/g, "")
    .trim();

  try {
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : cleaned);

    const rawSource = parsed.source;
    let source: ClassificationSource | null = null;
    if (rawSource && typeof rawSource === "object") {
      source = {
        app: typeof rawSource.app === "string" ? rawSource.app : null,
        book: typeof rawSource.book === "string" ? rawSource.book : null,
        author: typeof rawSource.author === "string" ? rawSource.author : null,
        location: typeof rawSource.location === "string" ? rawSource.location : null,
        rawContext:
          typeof rawSource.rawContext === "string" ? rawSource.rawContext : null,
      };
      const hasAny = Object.values(source).some((v) => v !== null);
      if (!hasAny) source = null;
    }

    return {
      category: parsed.category || "general",
      word: parsed.word || text.slice(0, 100),
      language: parsed.language || "general",
      definition: parsed.definition || "",
      pronunciation: parsed.pronunciation || "",
      partOfSpeech: parsed.partOfSpeech || parsed.part_of_speech || "",
      exampleSentence:
        parsed.exampleSentence || parsed.example_sentence || "",
      labels: Array.isArray(parsed.labels) ? parsed.labels : [],
      source,
    };
  } catch {
    // Fallback: store as general knowledge with no provenance
    return {
      category: "general",
      word: text.slice(0, 100),
      language: "general",
      definition: text,
      pronunciation: "",
      partOfSpeech: "concept",
      exampleSentence: "",
      labels: [],
      source: null,
    };
  }
}
