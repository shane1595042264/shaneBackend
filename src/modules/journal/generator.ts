import { generateText } from "@/modules/shared/llm";
import { embed } from "@/modules/shared/embeddings";
import { findSimilarEntries, findRelevantFacts } from "@/modules/shared/vector-search";
import { getLatestVoiceProfile } from "@/modules/journal/voice-profile";
import { db } from "@/db/client";
import { activities, diaryEntries, summaries } from "@/db/schema";
import type { NormalizedActivity } from "@/modules/integrations/types";
import { batchReverseGeocode } from "@/modules/integrations/geocode";
import { eq, desc, and, lte, gte } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GenerationContext {
  date: string;
  activitiesText: string;
  yearlySummary: string | null;
  monthlySummary: string | null;
  weeklySummary: string | null;
  yesterdayEntry: string | null;
  similarEntries: Array<{ date: string; content: string }>;
  relevantFacts: string[];
}

// ---------------------------------------------------------------------------
// Location ping clustering
// ---------------------------------------------------------------------------

export interface LocationCluster {
  centroidLat: number;
  centroidLon: number;
  startTime: string;
  endTime: string;
  pingCount: number;
  durationMinutes: number;
}

/**
 * Haversine distance between two lat/lon points in meters.
 */
function haversineMeters(
  lat1: number, lon1: number,
  lat2: number, lon2: number
): number {
  const R = 6_371_000; // Earth radius in meters
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Cluster consecutive location pings that are within `radiusMeters` of the
 * running centroid into distinct stops. Returns clusters sorted by start time,
 * filtered to stops where the user spent at least `minMinutes`.
 */
export function clusterLocationPings(
  pings: NormalizedActivity[],
  radiusMeters = 200,
  minMinutes = 5
): LocationCluster[] {
  if (pings.length === 0) return [];

  // Sort by timestamp
  const sorted = [...pings].sort(
    (a, b) =>
      new Date(a.data.timestamp as string).getTime() -
      new Date(b.data.timestamp as string).getTime()
  );

  const clusters: LocationCluster[] = [];
  let clusterLats = [sorted[0].data.latitude as number];
  let clusterLons = [sorted[0].data.longitude as number];
  let clusterStart = sorted[0].data.timestamp as string;
  let clusterEnd = sorted[0].data.timestamp as string;

  for (let i = 1; i < sorted.length; i++) {
    const lat = sorted[i].data.latitude as number;
    const lon = sorted[i].data.longitude as number;
    const centroidLat = clusterLats.reduce((s, v) => s + v, 0) / clusterLats.length;
    const centroidLon = clusterLons.reduce((s, v) => s + v, 0) / clusterLons.length;

    if (haversineMeters(centroidLat, centroidLon, lat, lon) <= radiusMeters) {
      // Same cluster
      clusterLats.push(lat);
      clusterLons.push(lon);
      clusterEnd = sorted[i].data.timestamp as string;
    } else {
      // Finalize previous cluster
      const dur =
        (new Date(clusterEnd).getTime() - new Date(clusterStart).getTime()) /
        60_000;
      clusters.push({
        centroidLat: clusterLats.reduce((s, v) => s + v, 0) / clusterLats.length,
        centroidLon: clusterLons.reduce((s, v) => s + v, 0) / clusterLons.length,
        startTime: clusterStart,
        endTime: clusterEnd,
        pingCount: clusterLats.length,
        durationMinutes: Math.round(dur),
      });
      // Start new cluster
      clusterLats = [lat];
      clusterLons = [lon];
      clusterStart = sorted[i].data.timestamp as string;
      clusterEnd = sorted[i].data.timestamp as string;
    }
  }

  // Finalize last cluster
  const dur =
    (new Date(clusterEnd).getTime() - new Date(clusterStart).getTime()) /
    60_000;
  clusters.push({
    centroidLat: clusterLats.reduce((s, v) => s + v, 0) / clusterLats.length,
    centroidLon: clusterLons.reduce((s, v) => s + v, 0) / clusterLons.length,
    startTime: clusterStart,
    endTime: clusterEnd,
    pingCount: clusterLats.length,
    durationMinutes: Math.round(dur),
  });

  return clusters.filter((c) => c.durationMinutes >= minMinutes);
}

// ---------------------------------------------------------------------------
// Calendar event filtering
// ---------------------------------------------------------------------------

const PLACEHOLDER_TITLES = new Set([
  "untitled",
  "untitled event",
  "placeholder",
  "(no title)",
  "busy",
  "no title",
]);

/**
 * Returns true if a calendar event has no meaningful title (placeholder/empty).
 */
export function isPlaceholderCalendarEvent(act: NormalizedActivity): boolean {
  if (act.source !== "google_calendar") return false;
  const title = ((act.data.title as string) ?? (act.data.summary as string) ?? "").trim();
  return title === "" || PLACEHOLDER_TITLES.has(title.toLowerCase());
}

/**
 * Detect data quality issues in activities for debug notes.
 * Returns an array of human-readable issue descriptions.
 */
export function detectActivityDataIssues(acts: NormalizedActivity[]): string[] {
  const issues: string[] = [];

  const calendarEvents = acts.filter((a) => a.source === "google_calendar");
  const placeholders = calendarEvents.filter(isPlaceholderCalendarEvent);

  if (placeholders.length > 0) {
    issues.push(
      `${placeholders.length} calendar event(s) had no meaningful title and were excluded from journal generation. ` +
      `This may indicate a non-public calendar or events from a different account.`
    );
  }

  return issues;
}

// ---------------------------------------------------------------------------
// formatActivitiesForPrompt
// ---------------------------------------------------------------------------

/**
 * Formats a list of NormalizedActivity records grouped by source into a
 * human-readable text block suitable for inclusion in a generation prompt.
 * Async because location pings may need reverse geocoding.
 */
export async function formatActivitiesForPrompt(
  acts: NormalizedActivity[],
  date: string
): Promise<string> {
  if (acts.length === 0) {
    return `No activities recorded for ${date}.`;
  }

  const bySource: Record<string, NormalizedActivity[]> = {
    google_maps: [],
    strava: [],
    github: [],
    google_calendar: [],
    twitch: [],
    wechat: [],
    discord: [],
  };

  for (const act of acts) {
    if (bySource[act.source]) {
      bySource[act.source].push(act);
    }
  }

  const sections: string[] = [];

  // --- Locations (Google Maps / OwnTracks) ---
  if (bySource.google_maps.length > 0) {
    const placeVisits = bySource.google_maps.filter((a) => a.type === "place_visit" || a.type === "visit");
    const placeEvents = bySource.google_maps.filter((a) => a.type === "place_enter" || a.type === "place_leave");
    const locationPings = bySource.google_maps.filter((a) => a.type === "location_ping");

    const lines: string[] = [];

    // Named place visits (from Google Takeout)
    for (const a of placeVisits) {
      const name = (a.data.name as string) ?? "Unknown place";
      const address = a.data.address ? ` (${a.data.address as string})` : "";
      lines.push(`  - ${name}${address}`);
    }

    // Waypoint transitions from OwnTracks (entered/left named places)
    for (const a of placeEvents) {
      const name = (a.data.name as string) ?? "Unknown place";
      const event = a.type === "place_enter" ? "Arrived at" : "Left";
      const time = new Date(a.data.timestamp as string).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
      lines.push(`  - ${event} ${name} at ${time}`);
    }

    // Raw location pings — cluster into stops and reverse geocode
    if (locationPings.length > 0 && placeVisits.length === 0 && placeEvents.length === 0) {
      const clusters = clusterLocationPings(locationPings);

      if (clusters.length > 0) {
        // Reverse geocode each cluster centroid (max 10 to respect rate limits)
        const toGeocode = clusters.slice(0, 10);
        const placeNames = await batchReverseGeocode(
          toGeocode.map((c) => ({ latitude: c.centroidLat, longitude: c.centroidLon }))
        );

        for (let i = 0; i < toGeocode.length; i++) {
          const c = toGeocode[i];
          const startFmt = new Date(c.startTime).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
          const endFmt = new Date(c.endTime).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
          const durLabel =
            c.durationMinutes >= 60
              ? `${Math.floor(c.durationMinutes / 60)}h ${c.durationMinutes % 60}m`
              : `${c.durationMinutes}m`;
          lines.push(`  - ${placeNames[i]} (${startFmt}–${endFmt}, ${durLabel})`);
        }
      } else {
        // All pings were transient (no stops >= 5 min) — brief summary
        lines.push(`  - Moved through the area without extended stops`);
      }
    }

    if (lines.length > 0) {
      sections.push(`Locations:\n${lines.join("\n")}`);
    }
  }

  // --- Workouts (Strava) ---
  if (bySource.strava.length > 0) {
    const lines = bySource.strava.map((a) => {
      const name = (a.data.name as string) ?? a.type;
      const distMeters = a.data.distanceMeters as number | undefined;
      const km =
        distMeters !== undefined && distMeters > 0
          ? ` — ${(distMeters / 1000).toFixed(1)} km`
          : "";
      const movingSecs = a.data.movingTimeSeconds as number | undefined;
      const time =
        movingSecs !== undefined && movingSecs > 0
          ? ` in ${Math.floor(movingSecs / 60)}m ${movingSecs % 60}s`
          : "";
      return `  - ${name}${km}${time}`;
    });
    sections.push(`Workouts / exercise (Strava):\n${lines.join("\n")}`);
  }

  // --- Commits (GitHub) ---
  if (bySource.github.length > 0) {
    const lines = bySource.github.map((a) => {
      const repo = (a.data.repo as string) ?? "unknown repo";
      const message = (a.data.message as string) ?? "(no message)";
      return `  - [${repo}] ${message}`;
    });
    sections.push(`Code commits (GitHub):\n${lines.join("\n")}`);
  }

  // --- Calendar events (Google Calendar) ---
  if (bySource.google_calendar.length > 0) {
    const meaningful = bySource.google_calendar.filter(
      (a) => !isPlaceholderCalendarEvent(a)
    );
    if (meaningful.length > 0) {
      const lines = meaningful.map((a) => {
        const title = (a.data.title as string) ?? (a.data.summary as string) ?? "Untitled event";
        const start = (a.data.startTime ?? a.data.start) as string | undefined;
        const end = (a.data.endTime ?? a.data.end) as string | undefined;
        const startStr = start ? ` at ${start}` : "";
        const endStr = end ? `–${end}` : "";
        return `  - ${title}${startStr}${endStr}`;
      });
      sections.push(`Calendar events (Google Calendar):\n${lines.join("\n")}`);
    }
  }

  // --- Streams (Twitch) ---
  if (bySource.twitch.length > 0) {
    const lines = bySource.twitch.map((a) => {
      const title = (a.data.title as string) ?? "Untitled stream";
      const secs = a.data.durationSeconds as number | undefined;
      const duration =
        secs !== undefined
          ? ` — ${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`
          : "";
      const views =
        a.data.viewCount !== undefined
          ? ` (${a.data.viewCount} views)`
          : "";
      return `  - ${title}${duration}${views}`;
    });
    sections.push(`Streams (Twitch):\n${lines.join("\n")}`);
  }

  // --- Messages (WeChat) ---
  if (bySource.wechat.length > 0) {
    // Group by chat, summarize message counts and key content
    const byChat: Record<string, NormalizedActivity[]> = {};
    for (const a of bySource.wechat) {
      const chat = (a.data.chat as string) ?? "Unknown";
      if (!byChat[chat]) byChat[chat] = [];
      byChat[chat].push(a);
    }

    const lines: string[] = [];
    for (const [chat, msgs] of Object.entries(byChat)) {
      const selfMsgs = msgs.filter((m) => m.data.sender === "self");
      const otherMsgs = msgs.filter((m) => m.data.sender !== "self");

      // Show a summary line per chat
      const parts: string[] = [`${msgs.length} messages in "${chat}"`];
      if (selfMsgs.length > 0) parts.push(`sent ${selfMsgs.length}`);
      if (otherMsgs.length > 0) parts.push(`received ${otherMsgs.length}`);
      lines.push(`  - ${parts.join(", ")}`);

      // Include up to 5 of Shane's own messages as content highlights
      const highlights = selfMsgs.slice(0, 5);
      for (const h of highlights) {
        const content = (h.data.content as string) ?? "";
        const preview = content.length > 100 ? content.slice(0, 100) + "..." : content;
        lines.push(`    > "${preview}"`);
      }
    }
    sections.push(`Messages (WeChat):\n${lines.join("\n")}`);
  }

  // --- Messages (Discord) ---
  if (bySource.discord.length > 0) {
    const lines: string[] = [];
    const channelGroups: Record<string, NormalizedActivity[]> = {};
    for (const a of bySource.discord) {
      const channelId = (a.data.channelId as string) ?? "unknown";
      if (!channelGroups[channelId]) channelGroups[channelId] = [];
      channelGroups[channelId].push(a);
    }

    for (const [channelId, msgs] of Object.entries(channelGroups)) {
      lines.push(`  - ${msgs.length} messages in channel ${channelId}`);
      // Include up to 5 message previews
      const previews = msgs.slice(0, 5);
      for (const m of previews) {
        const content = (m.data.content as string) ?? "";
        if (!content) continue;
        const preview = content.length > 120 ? content.slice(0, 120) + "..." : content;
        lines.push(`    > "${preview}"`);
      }
    }
    sections.push(`Messages (Discord):\n${lines.join("\n")}`);
  }

  return sections.join("\n\n");
}

// ---------------------------------------------------------------------------
// Anti-repetition: banned phrases and extraction
// ---------------------------------------------------------------------------

/**
 * Phrases that appear too frequently across generated entries and should be
 * avoided. Kept lowercase for case-insensitive matching.
 */
const BANNED_PHRASES = [
  "rich tapestry of experiences",
  "rich tapestry",
  "tapestry of experiences",
  "the stillness of the morning",
  "reminding me of the importance of balance",
  "importance of balance",
  "each contributing to my personal growth and well-being",
  "personal growth and well-being",
  "blend together to create",
  "a sense of fulfillment and engagement",
  "fulfillment and engagement",
  "the beauty of simplicity",
  "a renewed sense of purpose",
  "the way the light filtered through",
  "the gentle breeze",
  "digital weeds",
  "digital ghosts",
  "mark time without substance",
  "the beauty of the world around me",
  "the small details that often go unnoticed",
  "i am reminded of",
  "i am grateful for",
  "as i reflect on",
  "as i look back on the day",
  "as the day drew to a close",
  "as the day progressed",
  "has been a day marked by",
  "has been a day of",
];

/**
 * Extract distinctive multi-word phrases (3+ words) from a text that the model
 * should avoid reusing. Returns up to `max` phrases.
 */
export function extractPhrasesToAvoid(text: string, max = 8): string[] {
  if (!text) return [];

  // Strip data markers before extracting
  const clean = text
    .replace(/\[\[data:\w+\|[^\]]*\]\]/g, "")
    .replace(/\n/g, " ")
    .trim();

  // Split into sentences, grab distinctive longer phrases (6+ words from middle of sentences)
  const sentences = clean.split(/[.!?]+/).filter((s) => s.trim().length > 30);
  const phrases: string[] = [];

  for (const sentence of sentences) {
    const words = sentence.trim().split(/\s+/);
    if (words.length >= 6) {
      // Take a phrase from the middle portion of each sentence
      const start = Math.floor(words.length * 0.2);
      const end = Math.min(start + 5, words.length);
      const phrase = words.slice(start, end).join(" ").toLowerCase().replace(/[,;:]/g, "");
      if (phrase.length > 15) {
        phrases.push(phrase);
      }
    }
  }

  // Deduplicate and limit
  return [...new Set(phrases)].slice(0, max);
}

// ---------------------------------------------------------------------------
// buildGenerationPrompt
// ---------------------------------------------------------------------------

/**
 * Assembles all context layers into a single generation prompt for Claude.
 */
export function buildGenerationPrompt(ctx: GenerationContext): string {
  const parts: string[] = [];

  parts.push(`You are writing a personal journal entry for ${ctx.date}.`);

  // Activities
  parts.push(`## Today's Activities\n${ctx.activitiesText}`);

  // Summaries
  if (ctx.yearlySummary) {
    parts.push(`## Yearly Context\n${ctx.yearlySummary}`);
  }
  if (ctx.monthlySummary) {
    parts.push(`## Monthly Context\n${ctx.monthlySummary}`);
  }
  if (ctx.weeklySummary) {
    parts.push(`## Weekly Context\n${ctx.weeklySummary}`);
  }

  // Yesterday's entry
  if (ctx.yesterdayEntry) {
    parts.push(`## Yesterday's Entry\n${ctx.yesterdayEntry}`);
  }

  // Similar past entries
  if (ctx.similarEntries.length > 0) {
    const entriesBlock = ctx.similarEntries
      .map((e) => `### ${e.date}\n${e.content}`)
      .join("\n\n");
    parts.push(`## Similar Past Entries\n${entriesBlock}`);
  }

  // Relevant facts
  if (ctx.relevantFacts.length > 0) {
    const factsBlock = ctx.relevantFacts.map((f) => `- ${f}`).join("\n");
    parts.push(`## Relevant Facts About Me\n${factsBlock}`);
  }

  // Build the anti-repetition section
  const phrasesToAvoid: string[] = [...BANNED_PHRASES];
  if (ctx.yesterdayEntry) {
    phrasesToAvoid.push(...extractPhrasesToAvoid(ctx.yesterdayEntry));
  }
  for (const entry of ctx.similarEntries) {
    phrasesToAvoid.push(...extractPhrasesToAvoid(entry.content, 4));
  }
  // Deduplicate
  const uniquePhrases = [...new Set(phrasesToAvoid)];
  const bannedList = uniquePhrases.map((p) => `  - "${p}"`).join("\n");

  // Final instruction
  parts.push(
    `## Instruction
Write a personal journal entry for ${ctx.date}. Follow your voice and style from the system prompt.

Rules:
1. Weave today's activities naturally into reflective prose. Multiple paragraphs are encouraged when the day has rich data.
2. CRITICAL — every data reference MUST use exactly this format with ALL THREE parts:
   [[data:TYPE|DISPLAY_TEXT|JSON_OBJECT]]
   The format has exactly 3 sections separated by | pipes:
   - TYPE: one of strava, github, location, calendar, twitch, wechat, discord
   - DISPLAY_TEXT: human-readable text shown to the user
   - JSON_OBJECT: a valid JSON object with the raw data (REQUIRED, never omit this)

   Correct examples:
   [[data:strava|ran 5.2km in 24:32|{"distance_km":5.2,"duration":"24:32","type":"run"}]]
   [[data:github|pushed 3 commits to PersonalWebsite|{"count":3,"repo":"PersonalWebsite"}]]
   [[data:location|spent the afternoon in Midtown|{"name":"Midtown","duration_min":180}]]
   [[data:calendar|had a team standup at 10am|{"title":"Team standup","time":"10:00"}]]

   WRONG (missing JSON — do NOT do this):
   [[data:strava|ran 5km]]
   [[data:github|3 commits]]

3. NEVER use em dashes (—). Use commas, periods, or "and" instead.
4. Write in first person. Let the data ground the narrative but allow reflection, observations, and personal meaning to emerge.
5. If any data category has no meaningful content (e.g., no titled events), SKIP it entirely. Never mention "untitled" or "placeholder" events.
6. MINIMUM 100 words, aim for 150-400 words. Even quiet days deserve 2-3 paragraphs of reflection, personal observations, or inner thoughts. Never produce a single-sentence data summary. If the day was quiet, reflect on what that stillness meant, what you noticed, or how it contrasted with busier days.
7. VARIETY IS CRITICAL. Do NOT repeat phrases from yesterday's entry or similar past entries above. Each entry must feel fresh. Specifically:
   - NEVER open with "Today, [date], has been a day of..." or "As I reflect on..." — vary your opening every time.
   - NEVER close with a generic summary paragraph about gratitude, balance, or personal growth.
   - Use concrete, specific observations instead of abstract platitudes.
   - If you catch yourself writing a phrase that sounds like it could appear in any journal entry, replace it with something unique to THIS day.
8. BANNED PHRASES — do NOT use any of these (or close variants):
${bannedList}`
  );

  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// generateDailyEntry
// ---------------------------------------------------------------------------

/**
 * Full pipeline: fetch context from DB, call Claude, embed result, store entry.
 */
export async function generateDailyEntry(
  date: string
): Promise<{ content: string; voiceProfileVersion: number }> {
  // 1. Get today's activities from DB
  const rawActivities = await db
    .select()
    .from(activities)
    .where(eq(activities.date, date));

  const todayActivities: NormalizedActivity[] = rawActivities.map((row) => ({
    date: row.date,
    source: row.source as NormalizedActivity["source"],
    type: row.type,
    data: row.data as Record<string, unknown>,
  }));

  // 2. Get latest voice profile
  const voiceProfile = await getLatestVoiceProfile();
  const voiceProfileVersion = voiceProfile?.version ?? 0;
  const systemPrompt =
    voiceProfile?.profileText ??
    "You are a thoughtful diarist writing personal journal entries in first person.";

  // 3. Get summaries (yearly, monthly, weekly)
  const [yearStart, yearEnd] = getYearRange(date);
  const [monthStart, monthEnd] = getMonthRange(date);
  const [weekStart, weekEnd] = getWeekRange(date);

  const [yearlyRows, monthlyRows, weeklyRows] = await Promise.all([
    db
      .select({ content: summaries.content })
      .from(summaries)
      .where(
        and(
          eq(summaries.level, "yearly"),
          eq(summaries.startDate, yearStart),
          eq(summaries.endDate, yearEnd)
        )
      )
      .limit(1),
    db
      .select({ content: summaries.content })
      .from(summaries)
      .where(
        and(
          eq(summaries.level, "monthly"),
          eq(summaries.startDate, monthStart),
          eq(summaries.endDate, monthEnd)
        )
      )
      .limit(1),
    db
      .select({ content: summaries.content })
      .from(summaries)
      .where(
        and(
          eq(summaries.level, "weekly"),
          eq(summaries.startDate, weekStart),
          eq(summaries.endDate, weekEnd)
        )
      )
      .limit(1),
  ]);

  const yearlySummary = yearlyRows[0]?.content ?? null;
  const monthlySummary = monthlyRows[0]?.content ?? null;
  const weeklySummary = weeklyRows[0]?.content ?? null;

  // 4. Get yesterday's entry
  const yesterday = getYesterday(date);
  const yesterdayRows = await db
    .select({ content: diaryEntries.content })
    .from(diaryEntries)
    .where(eq(diaryEntries.date, yesterday))
    .limit(1);
  const yesterdayEntry = yesterdayRows[0]?.content ?? null;

  // 5. Vector search for 5 similar entries (excluding today)
  const activitiesText = await formatActivitiesForPrompt(todayActivities, date);
  const queryEmbedding = await embed(activitiesText);

  const similarRows = await findSimilarEntries(queryEmbedding, 5, date);
  const similarEntries = (
    similarRows as Array<{ date: string; content: string }>
  ).map((row) => ({ date: row.date, content: row.content }));

  // 6. Vector search for relevant facts
  const factRows = await findRelevantFacts(queryEmbedding, 5);
  const relevantFacts = (
    factRows as Array<{ fact_text: string }>
  ).map((row) => row.fact_text);

  // 7. Detect data quality issues for debug notes
  const debugNotes = detectActivityDataIssues(todayActivities);

  // 8. Build prompt
  const ctx: GenerationContext = {
    date,
    activitiesText,
    yearlySummary,
    monthlySummary,
    weeklySummary,
    yesterdayEntry,
    similarEntries,
    relevantFacts,
  };
  const prompt = buildGenerationPrompt(ctx);

  // 9. Call Claude Sonnet with voice profile as system prompt
  const { text: rawContent, modelUsed } = await generateText({
    system: systemPrompt,
    prompt,
    model: "claude-sonnet-4-20250514",
    maxTokens: 2048,
  });

  // 9b. Fix malformed data markers (e.g. missing JSON third part)
  let content = fixDataMarkers(rawContent);

  const metadata: Record<string, unknown> = {
    model: modelUsed,
    generatedAt: new Date().toISOString(),
    activitiesCount: todayActivities.length,
  };
  if (debugNotes.length > 0) {
    metadata.debugNotes = debugNotes;
  }

  // 9c. Word count validation — retry once if too short
  const wordCount = content.split(/\s+/).filter(Boolean).length;
  if (wordCount < 80) {
    const retryPrompt = prompt + "\n\nIMPORTANT: Your previous attempt was only " + wordCount + " words. This is too short. Write at LEAST 100 words. Even if the day was quiet, reflect on what the stillness meant, describe your surroundings, share inner thoughts, or contrast with recent busier days. Never produce a single-sentence data dump.";
    const { text: retryRaw, modelUsed: retryModel } = await generateText({
      system: systemPrompt,
      prompt: retryPrompt,
      model: "claude-sonnet-4-20250514",
      maxTokens: 2048,
    });
    const retryContent = fixDataMarkers(retryRaw);
    const retryWordCount = retryContent.split(/\s+/).filter(Boolean).length;
    if (retryWordCount > wordCount) {
      content = retryContent;
      metadata.retried = true;
      metadata.model = retryModel;
    }
  }

  // 10. Embed the result, store in diary_entries
  const contentEmbedding = await embed(content);

  await db
    .insert(diaryEntries)
    .values({
      date,
      content,
      embedding: contentEmbedding,
      voiceProfileVersion,
      generationMetadata: metadata,
    })
    .onConflictDoUpdate({
      target: diaryEntries.date,
      set: {
        content,
        embedding: contentEmbedding,
        voiceProfileVersion,
        updatedAt: new Date(),
      },
    });

  return { content, voiceProfileVersion };
}

// ---------------------------------------------------------------------------
// regenerateDailyEntry — Claude-only, no fallback
// ---------------------------------------------------------------------------

/**
 * Re-generates a journal entry for the given date using Claude only (no
 * fallback to Gemini/Groq). Throws if Claude API is unavailable.
 * Used to upgrade low-quality entries that were originally generated by
 * fallback models.
 */
export async function regenerateDailyEntry(
  date: string
): Promise<{ content: string; voiceProfileVersion: number; modelUsed: string }> {
  // 1. Get today's activities from DB
  const rawActivities = await db
    .select()
    .from(activities)
    .where(eq(activities.date, date));

  const todayActivities: NormalizedActivity[] = rawActivities.map((row) => ({
    date: row.date,
    source: row.source as NormalizedActivity["source"],
    type: row.type,
    data: row.data as Record<string, unknown>,
  }));

  // 2. Get latest voice profile
  const voiceProfile = await getLatestVoiceProfile();
  const voiceProfileVersion = voiceProfile?.version ?? 0;
  const systemPrompt =
    voiceProfile?.profileText ??
    "You are a thoughtful diarist writing personal journal entries in first person.";

  // 3. Get summaries
  const [yearStart, yearEnd] = getYearRange(date);
  const [monthStart, monthEnd] = getMonthRange(date);
  const [weekStart, weekEnd] = getWeekRange(date);

  const [yearlyRows, monthlyRows, weeklyRows] = await Promise.all([
    db.select({ content: summaries.content }).from(summaries)
      .where(and(eq(summaries.level, "yearly"), eq(summaries.startDate, yearStart), eq(summaries.endDate, yearEnd))).limit(1),
    db.select({ content: summaries.content }).from(summaries)
      .where(and(eq(summaries.level, "monthly"), eq(summaries.startDate, monthStart), eq(summaries.endDate, monthEnd))).limit(1),
    db.select({ content: summaries.content }).from(summaries)
      .where(and(eq(summaries.level, "weekly"), eq(summaries.startDate, weekStart), eq(summaries.endDate, weekEnd))).limit(1),
  ]);

  // 4. Get yesterday's entry
  const yesterday = getYesterday(date);
  const yesterdayRows = await db
    .select({ content: diaryEntries.content })
    .from(diaryEntries)
    .where(eq(diaryEntries.date, yesterday))
    .limit(1);

  // 5. Vector search for similar entries
  const activitiesText = await formatActivitiesForPrompt(todayActivities, date);
  const queryEmbedding = await embed(activitiesText);
  const similarRows = await findSimilarEntries(queryEmbedding, 5, date);
  const similarEntries = (similarRows as Array<{ date: string; content: string }>)
    .map((row) => ({ date: row.date, content: row.content }));

  // 6. Relevant facts
  const factRows = await findRelevantFacts(queryEmbedding, 5);
  const relevantFacts = (factRows as Array<{ fact_text: string }>)
    .map((row) => row.fact_text);

  // 7. Build prompt & generate with Claude only (noFallback)
  const ctx: GenerationContext = {
    date,
    activitiesText,
    yearlySummary: yearlyRows[0]?.content ?? null,
    monthlySummary: monthlyRows[0]?.content ?? null,
    weeklySummary: weeklyRows[0]?.content ?? null,
    yesterdayEntry: yesterdayRows[0]?.content ?? null,
    similarEntries,
    relevantFacts,
  };
  const prompt = buildGenerationPrompt(ctx);

  const { text: rawContent, modelUsed } = await generateText({
    system: systemPrompt,
    prompt,
    model: "claude-sonnet-4-20250514",
    maxTokens: 2048,
    noFallback: true,
  });

  let content = fixDataMarkers(rawContent);

  const metadata: Record<string, unknown> = {
    model: modelUsed,
    generatedAt: new Date().toISOString(),
    activitiesCount: todayActivities.length,
    regenerated: true,
  };

  // 7b. Word count validation — retry once if too short
  const wordCount = content.split(/\s+/).filter(Boolean).length;
  if (wordCount < 80) {
    const retryPrompt = prompt + "\n\nIMPORTANT: Your previous attempt was only " + wordCount + " words. This is too short. Write at LEAST 100 words. Even if the day was quiet, reflect on what the stillness meant, describe your surroundings, share inner thoughts, or contrast with recent busier days. Never produce a single-sentence data dump.";
    const { text: retryRaw, modelUsed: retryModel } = await generateText({
      system: systemPrompt,
      prompt: retryPrompt,
      model: "claude-sonnet-4-20250514",
      maxTokens: 2048,
      noFallback: true,
    });
    const retryContent = fixDataMarkers(retryRaw);
    const retryWordCount = retryContent.split(/\s+/).filter(Boolean).length;
    if (retryWordCount > wordCount) {
      content = retryContent;
      metadata.retried = true;
      metadata.model = retryModel;
    }
  }

  // 8. Embed and store
  const contentEmbedding = await embed(content);

  await db
    .insert(diaryEntries)
    .values({
      date,
      content,
      embedding: contentEmbedding,
      voiceProfileVersion,
      generationMetadata: metadata,
    })
    .onConflictDoUpdate({
      target: diaryEntries.date,
      set: {
        content,
        embedding: contentEmbedding,
        voiceProfileVersion,
        generationMetadata: metadata,
        updatedAt: new Date(),
      },
    });

  return { content, voiceProfileVersion, modelUsed };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getYesterday(date: string): string {
  const d = new Date(date);
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

function getYearRange(date: string): [string, string] {
  const year = date.slice(0, 4);
  return [`${year}-01-01`, `${year}-12-31`];
}

function getMonthRange(date: string): [string, string] {
  const [year, month] = date.split("-");
  const start = `${year}-${month}-01`;
  const lastDay = new Date(Number(year), Number(month), 0).getDate();
  const end = `${year}-${month}-${String(lastDay).padStart(2, "0")}`;
  return [start, end];
}

function getWeekRange(date: string): [string, string] {
  const d = new Date(date);
  const day = d.getDay(); // 0 = Sunday
  const diffToMonday = (day === 0 ? -6 : 1 - day);
  const monday = new Date(d);
  monday.setDate(d.getDate() + diffToMonday);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  return [
    monday.toISOString().slice(0, 10),
    sunday.toISOString().slice(0, 10),
  ];
}

/**
 * Fix malformed [[data:TYPE|DISPLAY|JSON]] markers in LLM output.
 * Some models (e.g. Llama via Groq) omit the JSON third part.
 * This repairs 2-part markers into valid 3-part ones.
 */
export function fixDataMarkers(text: string): string {
  return text.replace(
    /\[\[data:(\w+)\|([^\]|]+?)(?:\|(\{[^}]*\}))?\]\]/g,
    (_match, type: string, display: string, json?: string) => {
      if (json) {
        // Already has all 3 parts — keep as-is
        return `[[data:${type}|${display}|${json}]]`;
      }
      // Missing JSON part — synthesize a reasonable one from the display text
      const fallbackJson = JSON.stringify({ summary: display.trim() });
      return `[[data:${type}|${display}|${fallbackJson}]]`;
    }
  );
}
