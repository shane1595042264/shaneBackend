// src/modules/courses/classifier.ts
//
// Fetches a course page and asks Claude Haiku for structured catalog
// metadata. fetchCourseText throws CourseFetchError (the route maps it
// to 502) because a course IS its URL; classifyCourse never throws, it
// falls back to safe defaults so registration is never blocked on the
// LLM (house pattern, see modules/knowledge/classifier.ts).
import { generateText } from "@/modules/shared/llm";
import {
  COURSE_CATEGORIES,
  COURSE_DIFFICULTIES,
  type CourseCategory,
  type CourseDifficulty,
} from "./repo";

export class CourseFetchError extends Error {}

const FETCH_TIMEOUT_MS = 10_000;
const MAX_TEXT_CHARS = 8_000;

export interface CourseClassification {
  title: string;
  description: string | null;
  category: CourseCategory;
  difficulty: CourseDifficulty;
  durationMinutes: number | null;
  tags: string[];
}

/** "pi2-heist" from ".../courses/pi2-heist/" -> "Pi2 heist". */
export function fallbackTitleFromUrl(url: string): string {
  try {
    const segments = new URL(url).pathname.split("/").filter(Boolean);
    const last = segments[segments.length - 1];
    if (!last) return "Untitled course";
    const words = last.replace(/[-_]+/g, " ").trim();
    if (!words) return "Untitled course";
    return (words.charAt(0).toUpperCase() + words.slice(1)).slice(0, 200);
  } catch {
    return "Untitled course";
  }
}

export function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

export async function fetchCourseText(url: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { Accept: "text/html,*/*" },
    });
  } catch {
    throw new CourseFetchError("Could not reach the course page");
  }
  if (!res.ok) throw new CourseFetchError(`Course page returned ${res.status}`);
  const body = await res.text();
  const text = stripHtml(body).slice(0, MAX_TEXT_CHARS);
  if (!text) throw new CourseFetchError("Course page has no readable text");
  return text;
}

export async function classifyCourse(
  text: string,
  url: string,
): Promise<CourseClassification> {
  const fallback: CourseClassification = {
    title: fallbackTitleFromUrl(url),
    description: null,
    category: "other",
    difficulty: "intermediate",
    durationMinutes: null,
    tags: [],
  };
  try {
    const result = await generateText({
      system: `You are a course-catalog classifier. Given the text of an online course or lecture page, extract catalog metadata.

Categories (pick exactly one, lowercase): ${COURSE_CATEGORIES.join(", ")}
Difficulty (pick exactly one): ${COURSE_DIFFICULTIES.join(", ")} ("intro" = no prerequisites, "intermediate" = some background assumed, "advanced" = specialist material)

Return ONLY valid JSON matching this schema:
{"title":"...","description":"...","category":"...","difficulty":"...","durationMinutes":28,"tags":["..."]}

Rules:
- "title": the course's own title, cleaned up, max 120 chars.
- "description": 1-2 sentences summarizing what the course teaches, plain text.
- "durationMinutes": total stated length in minutes, or null if the page does not state one. Never guess.
- "tags": 3-8 short lowercase topical tags.`,
      prompt: `Example:
Page text: "The Heist: finding the integral of sin x over x. Four acts, 28 minutes. Requires calculus. Contour integration, Jordan's lemma."
{"title":"The Heist","description":"A guided derivation of the sin x over x integral using contour integration.","category":"math","difficulty":"advanced","durationMinutes":28,"tags":["complex analysis","contour integration","integrals"]}

Now classify this course:
Course URL: ${url}
Page text: "${text.replace(/"/g, '\\"')}"`,
      model: "claude-haiku-4-5-20251001",
      maxTokens: 512,
    });

    const cleaned = result.text
      .replace(/```json\n?/g, "")
      .replace(/```\n?/g, "")
      .trim();
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : cleaned);

    const category: CourseCategory = (COURSE_CATEGORIES as readonly string[]).includes(
      parsed.category,
    )
      ? parsed.category
      : "other";
    const difficulty: CourseDifficulty = (
      COURSE_DIFFICULTIES as readonly string[]
    ).includes(parsed.difficulty)
      ? parsed.difficulty
      : "intermediate";
    const durationMinutes =
      typeof parsed.durationMinutes === "number" &&
      Number.isFinite(parsed.durationMinutes) &&
      parsed.durationMinutes > 0
        ? Math.round(parsed.durationMinutes)
        : null;
    const tags = Array.isArray(parsed.tags)
      ? parsed.tags
          .filter((t: unknown): t is string => typeof t === "string")
          .map((t: string) => t.trim().toLowerCase())
          .filter((t: string) => t.length > 0 && t.length <= 40)
          .slice(0, 8)
      : [];
    const title =
      typeof parsed.title === "string" && parsed.title.trim()
        ? parsed.title.trim().slice(0, 200)
        : fallback.title;
    const description =
      typeof parsed.description === "string" && parsed.description.trim()
        ? parsed.description.trim().slice(0, 2000)
        : null;

    return { title, description, category, difficulty, durationMinutes, tags };
  } catch {
    return fallback;
  }
}
