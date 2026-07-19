import { z } from "zod";
import { generateText } from "@/modules/shared/llm";

/**
 * AI itinerary consolidation (SHAN-272, Phase 3 of SHAN-266). Takes the
 * group's raw idea fragments plus any previously generated itinerary and
 * asks the LLM for a structured day-by-day draft. Direct write, no PR
 * flow yet — that lands in Phase 4.
 */

// Upper bounds (SHAN-403): itinerarySchema also validates the user-facing
// PUT /:slug/itinerary write body, so every user-supplied field needs a cap
// to block oversized/abusive payloads. Limits are generous enough for any
// legitimate multi-country trip; all other consumers use safeParse, so
// tightening these only rejects oversized WRITES with a clean 400.
const activitySchema = z.object({
  time: z.string().max(50).nullable(),
  title: z.string().min(1).max(500),
  notes: z.string().max(2000).nullable(),
});

// Meals are timeline fixtures, not events (SHAN-282): every day has
// breakfast/lunch/dinner slots; the value is the assigned place to eat
// (or null when unassigned).
const mealsSchema = z
  .object({
    breakfast: z.string().max(300).nullable().optional().default(null),
    lunch: z.string().max(300).nullable().optional().default(null),
    dinner: z.string().max(300).nullable().optional().default(null),
  })
  .optional()
  .default({ breakfast: null, lunch: null, dinner: null });

const daySchema = z.object({
  day: z.number().int().min(1),
  title: z.string().min(1).max(300),
  // Calendar date "YYYY-MM-DD" when the ideas pin the trip to real dates
  // (SHAN-277); null when the trip is still floating.
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional()
    .default(null),
  location: z.string().max(300).nullable(),
  // Country grouping for the collapsible sections (SHAN-277).
  country: z.string().max(120).nullable().optional().default(null),
  meals: mealsSchema,
  activities: z.array(activitySchema).max(100),
});

export const itinerarySchema = z.object({
  summary: z.string().min(1).max(5000),
  days: z.array(daySchema).min(1).max(60),
});

export type TripItinerary = z.infer<typeof itinerarySchema>;

export interface ConsolidateInput {
  groupTitle: string;
  ideas: { authorName: string | null; body: string }[];
  existingItinerary: TripItinerary | null;
}

const SYSTEM_PROMPT = `You are a travel-planning assistant. You receive a trip group's raw idea fragments (restaurants, neighborhoods, activities, logistics, vibes) and optionally a previously drafted itinerary. Produce a coherent day-by-day itinerary that incorporates as many ideas as sensibly fit.

Return ONLY valid JSON matching this schema:
{"summary":"...","days":[{"day":1,"title":"...","date":"2026-07-25"|null,"location":"..."|null,"country":"..."|null,"meals":{"breakfast":"..."|null,"lunch":"..."|null,"dinner":"..."|null},"activities":[{"time":"09:00"|null,"title":"...","notes":"..."|null}]}]}

Rules:
- "summary": 1-3 sentences describing the overall trip shape.
- "days": 1-based, consecutive. Pick a sensible trip length from the ideas (default 3-5 days if unclear).
- "date": calendar date "YYYY-MM-DD" for the day. If the ideas mention real dates (e.g. "Jul 25", "7/25", "from the 25th to the 30th"), anchor day 1 to the earliest mentioned date and number the rest consecutively. If no dates are mentioned anywhere, use null for all days — do NOT invent dates.
- "location": the city/area the day centers on, or null.
- "country": the country that day belongs to (e.g. "Greece", "Italy"), or null if unknown. Consecutive days in the same country should use the exact same country string so they group together.
- "meals": breakfast/lunch/dinner are fixed timeline slots, NOT activities. When the ideas mention restaurants, cafes, or food places, assign them as the place for the matching meal (e.g. "lunch":"Ta Karamanlidika tou Fani"). Use null when nothing fits. Never create an activity for a plain meal - reserve activities for sights, transit, and experiences.
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

/** JSON.stringify with recursively sorted keys. Postgres jsonb does not
 * preserve key order, so comparing a stored itinerary against a freshly
 * generated one needs order-independent serialization. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Day numbers whose content differs between the group's current itinerary
 * and a proposed one (days added or removed count as changed). Used for
 * pending-suggestion conflict detection (SHAN-273): two pending
 * suggestions conflict when their changedDays intersect.
 */
export function computeChangedDays(
  base: TripItinerary | null,
  proposed: TripItinerary,
): number[] {
  if (!base) return proposed.days.map((d) => d.day).sort((a, b) => a - b);
  const baseByDay = new Map(base.days.map((d) => [d.day, stableStringify(d)]));
  const propByDay = new Map(proposed.days.map((d) => [d.day, stableStringify(d)]));
  const all = new Set([...baseByDay.keys(), ...propByDay.keys()]);
  const changed: number[] = [];
  for (const day of all) {
    if (baseByDay.get(day) !== propByDay.get(day)) changed.push(day);
  }
  return changed.sort((a, b) => a - b);
}
