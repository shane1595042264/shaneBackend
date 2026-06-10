import { z } from "zod";
import { generateText } from "@/modules/shared/llm";

/**
 * AI itinerary consolidation (SHAN-272, Phase 3 of SHAN-266). Takes the
 * group's raw idea fragments plus any previously generated itinerary and
 * asks the LLM for a structured day-by-day draft. Direct write, no PR
 * flow yet — that lands in Phase 4.
 */

const activitySchema = z.object({
  time: z.string().nullable(),
  title: z.string().min(1),
  notes: z.string().nullable(),
});

const daySchema = z.object({
  day: z.number().int().min(1),
  title: z.string().min(1),
  location: z.string().nullable(),
  activities: z.array(activitySchema),
});

export const itinerarySchema = z.object({
  summary: z.string().min(1),
  days: z.array(daySchema).min(1),
});

export type TripItinerary = z.infer<typeof itinerarySchema>;

export interface ConsolidateInput {
  groupTitle: string;
  ideas: { authorName: string | null; body: string }[];
  existingItinerary: TripItinerary | null;
}

const SYSTEM_PROMPT = `You are a travel-planning assistant. You receive a trip group's raw idea fragments (restaurants, neighborhoods, activities, logistics, vibes) and optionally a previously drafted itinerary. Produce a coherent day-by-day itinerary that incorporates as many ideas as sensibly fit.

Return ONLY valid JSON matching this schema:
{"summary":"...","days":[{"day":1,"title":"...","location":"..."|null,"activities":[{"time":"09:00"|null,"title":"...","notes":"..."|null}]}]}

Rules:
- "summary": 1-3 sentences describing the overall trip shape.
- "days": 1-based, consecutive. Pick a sensible trip length from the ideas (default 3-5 days if unclear).
- "location": the city/area the day centers on, or null.
- "activities": ordered within the day. "time" is a 24h "HH:MM" hint or null. "notes" carries practical detail (reservations, transit, who suggested it), or null.
- If a previous itinerary is provided, treat it as the base: preserve its structure where it still makes sense and weave new ideas in, rather than starting over.
- Group geographically close activities into the same day. Don't invent attractions nobody mentioned unless needed to bridge a day (mark those notes with "(suggested)").
- Output raw JSON only - no markdown fences, no commentary.`;

export async function consolidateItinerary(
  input: ConsolidateInput,
): Promise<{ itinerary: TripItinerary; modelUsed: string }> {
  const ideaLines = input.ideas
    .map((i, n) => `${n + 1}. [${i.authorName ?? "Anonymous"}] ${i.body}`)
    .join("\n");

  const existingBlock = input.existingItinerary
    ? `\n\nPreviously drafted itinerary (use as the base):\n${JSON.stringify(input.existingItinerary)}`
    : "";

  const result = await generateText({
    system: SYSTEM_PROMPT,
    prompt: `Trip group: "${input.groupTitle}"\n\nIdea fragments:\n${ideaLines}${existingBlock}`,
    maxTokens: 4096,
  });

  const cleaned = result.text
    .replace(/```json\n?/g, "")
    .replace(/```\n?/g, "")
    .trim();

  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonMatch ? jsonMatch[0] : cleaned);
  } catch {
    throw new Error(`AI returned unparseable itinerary JSON (model: ${result.modelUsed})`);
  }

  const validated = itinerarySchema.safeParse(parsed);
  if (!validated.success) {
    throw new Error(
      `AI itinerary failed schema validation (model: ${result.modelUsed}): ${validated.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
  }

  return { itinerary: validated.data, modelUsed: result.modelUsed };
}
